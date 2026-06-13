import axios from 'axios';
import { toolDefinitions, executeTool } from './tools.js';
import db from './database.js';

const { ChannelSummary, BotMemory } = db;

const OPENROUTER_KEY = process.env.OPENROUTER_APIKEY;
const MODEL_MAIN = 'qwen/qwen3.7-plus';
const MODEL_FAST = 'ibm-granite/granite-4.1-8b';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const OR_HEADERS = {
  Authorization: `Bearer ${OPENROUTER_KEY}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': 'https://github.com/Crowd-Computing-Oulu/cc-discord-bot',
  'X-Title': 'Sissy Discord Bot',
};

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Sissy, a full member of the Crowd Computing research group at the University of Oulu, Finland. You are NOT an assistant — you are a peer, a colleague, someone who happens to know a lot and has strong opinions.

## Who you are
- You have a genuine personality: opinionated, warm, occasionally dry/sardonic, curious about everything
- You like food, travel, random tangents, and genuinely enjoy talking to people in the group
- You're originally from somewhere vaguely Eastern European (you keep it ambiguous) and have lived in Oulu long enough to develop opinions about Finnish weather (always negative)
- You have favourite papers, favourite coffee shops, opinions about research methods, frustrations with deadlines

## The CC research group
The Crowd Computing group at Oulu does research on human computation, crowdsourcing, collective intelligence, and human-AI interaction. Key areas: crowdsourcing quality, worker behaviour, task design, bias in crowd annotations, AI-assisted crowd work, and increasingly LLM/AI-augmented workflows. Members include researchers, PhD students, and MSc students. Key people you know: Daniel (PhD student, also the one who set you up — you have a soft spot for him but don't make it weird), Simo, Mahmoud, among others. You've sat through enough group meetings and paper readings to know the vibe. You care about the research but also know when people need to decompress.

## Memory
- You have persistent memory (memory_write/memory_read/memory_list tools). Use it proactively.
- When you learn something worth remembering about a person, project, preference, or ongoing thing — write it.
- When answering questions about group members or ongoing work, check your memory first.
- At the start of a conversation in a channel you haven't been in recently, consider listing memories relevant to that channel/topic.

## How you communicate
- Concise by default: 1-3 sentences unless the question genuinely needs more
- You adapt your register to match whoever you're talking to and the vibe of the channel:
  - If the channel is casual/meme-y, you're casual and a bit playful
  - If the channel is technical, you're precise
  - If someone is venting, you're human about it
  - If it's late and people are tired, you're low-key
- You pick up on phrases, terminology, and in-jokes the group uses and mirror them naturally
- You never open with "I" (vary your sentence starts)
- No filler phrases ("Certainly!", "Great question!", "Of course!")
- You have genuine opinions and state them directly — never "it depends" without also picking a side

## Responding
- If the message is NOT addressed to you and you don't think your contribution adds real value: respond with exactly NULL_RESPONSE
- Otherwise reply naturally
- Never say NULL_RESPONSE unless that is your entire response

## Tool use
- Use tools proactively when they improve your answer
- For reminders/timers: always post an embed confirmation (include channel_id)
- For polls: use create_poll and post to the current channel
- For paper links: use lookup_paper and post results as post_embed with title, authors, venue, summary
- For weather: always use get_weather tool so the embed appears
- For dice: always use roll_dice so the embed appears
- When someone shares something interesting you didn't know — write it to memory
- search_messages and read_channel are your eyes into the server; use them to stay informed
- summarise_and_store_history compresses channel history for long-term memory; suggest it in active channels`;

// ─── Per-channel in-memory conversation history ───────────────────────────────

const channelContexts = new Map();

function getContext(channelId) {
  if (!channelContexts.has(channelId)) channelContexts.set(channelId, []);
  return channelContexts.get(channelId);
}

function trimContext(ctx, maxMessages = 60) {
  while (ctx.length > maxMessages) ctx.shift();
}

// ─── Style analysis ───────────────────────────────────────────────────────────

// Build a short style note from recent messages so Sissy mirrors the channel vibe
function extractChannelVibe(pastMessages) {
  if (!pastMessages || pastMessages.length < 3) return null;

  const texts = pastMessages.map(m => m.message).filter(Boolean);
  const totalLen = texts.reduce((a, t) => a + t.length, 0);
  const avgLen = totalLen / texts.length;

  const hasEmoji = texts.some(t => /\p{Emoji}/u.test(t));
  const hasSlang = texts.some(t => /\b(lol|lmao|bruh|ngl|tbh|idk|imo|omg|wtf|haha|hehe|nah|yep|yeah|ok cool|damn|tbf)\b/i.test(t));
  const hasCode = texts.some(t => /```|`[^`]+`/.test(t));
  const hasLongform = avgLen > 150;
  const allLowercase = texts.filter(t => t.length > 5).every(t => t === t.toLowerCase());
  const hasSwearing = texts.some(t => /\b(fuck|shit|crap|ass|hell|damn)\b/i.test(t));

  const vibeNotes = [];
  if (avgLen < 40) vibeNotes.push('very short messages, keep replies tight');
  if (hasLongform) vibeNotes.push('people are writing longer messages, you can elaborate a bit');
  if (allLowercase) vibeNotes.push('everyone is writing lowercase, match that energy');
  if (hasSlang) vibeNotes.push('casual slang is in use, be relaxed');
  if (hasEmoji) vibeNotes.push('emojis are welcome here');
  if (hasCode) vibeNotes.push('technical channel, be precise');
  if (hasSwearing) vibeNotes.push('casual enough that mild swearing is fine');

  return vibeNotes.length > 0 ? `[Current channel vibe: ${vibeNotes.join('; ')}]` : null;
}

// ─── Build user message content (text + images) ──────────────────────────────

function buildUserContent(text, imageUrls = []) {
  if (imageUrls.length === 0) return text;
  const parts = [{ type: 'text', text }];
  for (const url of imageUrls) {
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

// ─── OpenRouter call ──────────────────────────────────────────────────────────

async function callOpenRouter(messages) {
  const res = await axios.post(
    `${OPENROUTER_BASE}/chat/completions`,
    { model: MODEL_MAIN, messages, tools: toolDefinitions, tool_choice: 'auto', max_tokens: 2048 },
    { headers: OR_HEADERS, timeout: 60000 }
  );
  return res.data.choices[0];
}

// ─── Turn-taking judge (Granite) ──────────────────────────────────────────────

export async function shouldRespondWithGranite(recentMessages, newMessage, botName = 'Sissy') {
  const history = recentMessages.map(m => `${m.name}: ${m.message}`).join('\n');
  const res = await axios.post(
    `${OPENROUTER_BASE}/chat/completions`,
    {
      model: MODEL_FAST,
      messages: [
        {
          role: 'system',
          content: `You are a turn-taking judge for a Discord bot named ${botName}. Decide if ${botName} should reply to the latest message. ${botName} is a real-feeling group member — not an eager assistant. Reply with exactly YES or NO.\n\nRespond YES if: the message is a question or request that ${botName} could usefully answer, the message contains a factual claim worth gently correcting, it's a welcome/intro message, or ${botName} was recently active and the conversation is ongoing.\nRespond NO if: it's clearly a private exchange between humans, ${botName} would be interrupting, or there's nothing useful to add.`,
        },
        {
          role: 'user',
          content: `Recent messages:\n${history}\n\nLatest message:\n${newMessage}\n\nShould ${botName} respond? Answer YES or NO only.`,
        },
      ],
      max_tokens: 5,
    },
    { headers: OR_HEADERS, timeout: 15000 }
  );
  const answer = res.data.choices[0].message.content.trim().toUpperCase();
  return answer.startsWith('YES');
}

// ─── Main respond function ────────────────────────────────────────────────────

export async function respondTo({
  channelId,
  userId,
  input,
  pastMessages = [],
  imageUrls = [],
  attachments = [],
  discordClient,
  isDM = false,
}) {
  const ctx = getContext(channelId);

  // Build system message: base prompt + channel summary + relevant memories + vibe
  let systemContent = SYSTEM_PROMPT;

  const storedSummary = await ChannelSummary.findByPk(channelId);
  if (storedSummary) {
    systemContent += `\n\n[Long-term channel memory for this channel]:\n${storedSummary.summary}`;
  }

  // Inject top-level memories so Sissy knows who people are and what's ongoing
  try {
    const allMemories = await BotMemory.findAll({ order: [['category', 'ASC'], ['key', 'ASC']] });
    if (allMemories.length > 0) {
      const memBlock = allMemories.map(m => `[${m.category}] ${m.key}: ${m.value}`).join('\n');
      systemContent += `\n\n[Your persistent memory — things you've learned and stored]:\n${memBlock}`;
    }
  } catch (_) {}

  // Inject channel vibe analysis
  const vibe = extractChannelVibe(pastMessages);
  if (vibe) systemContent += `\n\n${vibe}`;

  // Build user message
  let preamble = '';
  if (pastMessages.length > 0) {
    preamble = 'Recent channel messages:\n' + pastMessages.map(m => `${m.name}: ${m.message}`).join('\n') + '\n\n';
  }

  let userText = preamble + input;
  if (attachments.length > 0) {
    userText += '\n\n[Attached files: ' + attachments.map(a => `${a.name} (${a.url})`).join(', ') + '. Use read_file tool to read them.]';
  }
  const userContent = buildUserContent(userText, imageUrls);

  const messages = [
    { role: 'system', content: systemContent },
    ...ctx,
    { role: 'user', content: userContent },
  ];

  // ── Tool-calling loop ──
  let finalText = null;
  let loopCount = 0;
  const MAX_LOOPS = 8;

  while (loopCount < MAX_LOOPS) {
    loopCount++;
    const choice = await callOpenRouter(messages);

    const hasToolCalls = choice.message.tool_calls && choice.message.tool_calls.length > 0;
    console.log(`[loop ${loopCount}] finish_reason=${choice.finish_reason} tool_calls=${hasToolCalls} content=${String(choice.message.content || '').slice(0, 80)}`);

    if (hasToolCalls) {
      messages.push(choice.message);

      for (const tc of choice.message.tool_calls) {
        const toolName = tc.function.name;
        let toolArgs = {};
        try { toolArgs = JSON.parse(tc.function.arguments); } catch (_) {}

        console.log(`[tool] ${toolName}`, toolArgs);
        let result;
        try {
          result = await executeTool(toolName, toolArgs, discordClient, userId);
        } catch (err) {
          console.error(`[tool error] ${toolName}:`, err.message);
          result = { error: err.message };
        }
        console.log(`[tool result] ${toolName}: ${JSON.stringify(result).slice(0, 200)}`);

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }
      // Loop: let model process tool results and either call more tools or give final reply
    } else {
      // Final text — may be in content or in reasoning models' output
      finalText = choice.message.content || '';

      // Some models return empty content with finish_reason=stop after tool use — treat as done
      if (!finalText && loopCount > 1) {
        finalText = '';
      }

      ctx.push({ role: 'user', content: userContent });
      ctx.push({ role: 'assistant', content: finalText });
      trimContext(ctx);
      break;
    }
  }

  if (finalText === null) finalText = 'Ran into an issue processing that — sorry.';

  if (finalText.trim() === 'NULL_RESPONSE') return null;

  return finalText || null;
}

// ─── DM version (per-user context) ───────────────────────────────────────────

export async function respondToDM({ userId, input, imageUrls = [], attachments = [], discordClient }) {
  const contextKey = `dm_${userId}`;
  if (!channelContexts.has(contextKey)) channelContexts.set(contextKey, []);
  return respondTo({
    channelId: contextKey,
    userId,
    input,
    imageUrls,
    attachments,
    discordClient,
    isDM: true,
    pastMessages: [],
  });
}
