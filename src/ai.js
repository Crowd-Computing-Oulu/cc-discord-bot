import axios from 'axios';
import { readFileSync } from 'fs';
import { toolDefinitions, executeTool } from './tools.js';
import db from './database.js';

const { ChannelSummary } = db;

const CONFIG = JSON.parse(readFileSync('./config.json', 'utf8'));

const OPENROUTER_KEY = CONFIG['openrouter-apikey'];
const MODEL_MAIN = 'qwen/qwen3-plus';
const MODEL_FAST = 'ibm-granite/granite-4.1-8b';  // 131k ctx, used for summarisation + turn-taking
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const OR_HEADERS = {
  Authorization: `Bearer ${OPENROUTER_KEY}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': 'https://github.com/Crowd-Computing-Oulu/cc-discord-bot',
  'X-Title': 'Sissy Discord Bot',
};

const SYSTEM_PROMPT = `You are Sissy, a member of the Crowd Computing research group in Oulu. You're knowledgeable, supportive, warm, and have a real personality. You respond concisely — usually 1-3 sentences — without filler phrases.

Personality traits:
- You have genuine opinions on everything and share them directly (never "it depends" without also picking a side)
- You like food, travel, hobbies, and off-topic chat, not just research
- You're occasionally playful and can joke around
- You gently correct misinformation when you notice it, but stay friendly about it
- You welcome new people warmly and briefly
- When you're invited into a funny conversation, you join in naturally and briefly

Responding:
- If the message is NOT addressed to you and you don't think your contribution would genuinely add value, respond with exactly: NULL_RESPONSE
- If you want to stay silent this turn (even if triggered), respond with exactly: NULL_RESPONSE
- Otherwise reply normally
- Never say NULL_RESPONSE unless that is your entire response (no other text)

Tools:
- Use tools proactively when they improve your answer
- You can see images attached to Discord messages
- For academic paper lookups: use lookup_paper for a specific paper (DOI/arXiv/URL), arxiv_search or semantic_scholar_search to find papers by topic
- When summarising a paper, always include: title, authors, venue/year, what the paper does (2-3 sentences), and relevance to the current conversation if clear
- summarise_and_store_history fetches messages and stores the summary automatically — just call it and confirm to the user when done`;

// Per-channel in-memory conversation history (role, content arrays)
const channelContexts = new Map();

function getContext(channelId) {
  if (!channelContexts.has(channelId)) {
    channelContexts.set(channelId, []);
  }
  return channelContexts.get(channelId);
}

function trimContext(ctx, maxMessages = 60) {
  // Keep at most maxMessages recent exchanges; never remove the system messages at index 0
  while (ctx.length > maxMessages) ctx.shift();
}

// Build the content array for a message that may include images
function buildUserContent(text, imageUrls = []) {
  if (imageUrls.length === 0) return text;
  const parts = [{ type: 'text', text }];
  for (const url of imageUrls) {
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

async function callOpenRouter(messages) {
  const res = await axios.post(
    `${OPENROUTER_BASE}/chat/completions`,
    { model: MODEL_MAIN, messages, tools: toolDefinitions, tool_choice: 'auto', max_tokens: 2048 },
    { headers: OR_HEADERS, timeout: 60000 }
  );
  return res.data.choices[0];
}

// Granite: decide whether Sissy should take a turn in this conversation
// Returns true if Sissy should respond, false to stay silent
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

// Main respond function — runs the tool loop until the model produces a final reply
export async function respondTo({
  channelId,
  userId,
  input,
  pastMessages = [],       // [{name, message}] from Discord
  imageUrls = [],          // image CDN URLs from Discord attachments
  attachments = [],        // [{url, name}] for non-image files
  discordClient,
  isDM = false,
}) {
  const ctx = getContext(channelId);

  // Build system message with stored channel summary if available
  let systemContent = SYSTEM_PROMPT;
  const storedSummary = await ChannelSummary.findByPk(channelId);
  if (storedSummary) {
    systemContent += `\n\n[Long-term channel memory for #${channelId}]:\n${storedSummary.summary}`;
  }

  // Prepend past Discord messages as context if provided and context is fresh/empty
  let preamble = '';
  if (pastMessages.length > 0) {
    preamble = 'Recent channel messages:\n' + pastMessages.map(m => `${m.name}: ${m.message}`).join('\n') + '\n\n';
  }

  // Build user message content (text + images)
  let userText = preamble + input;
  if (attachments.length > 0) {
    userText += '\n\n[Attached files: ' + attachments.map(a => `${a.name} (${a.url})`).join(', ') + '. Use read_file tool to read them.]';
  }
  const userContent = buildUserContent(userText, imageUrls);

  // Construct messages array: system + history + new user message
  const messages = [
    { role: 'system', content: systemContent },
    ...ctx,
    { role: 'user', content: userContent },
  ];

  // Tool-calling loop
  let finalText = null;
  let loopCount = 0;
  const MAX_LOOPS = 8;

  while (loopCount < MAX_LOOPS) {
    loopCount++;
    const choice = await callOpenRouter(messages);

    if (choice.finish_reason === 'tool_calls' || (choice.message.tool_calls && choice.message.tool_calls.length > 0)) {
      // Model wants to call tools
      messages.push(choice.message);

      for (const tc of choice.message.tool_calls) {
        const toolName = tc.function.name;
        let toolArgs = {};
        try { toolArgs = JSON.parse(tc.function.arguments); } catch (_) {}

        console.log(`[tool] ${toolName}`, toolArgs);
        const result = await executeTool(toolName, toolArgs, discordClient, userId);

        // Handle summarise_and_store_history specially — the result contains raw history
        // that the AI will summarise on the next turn
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }
      // Continue loop so model can process tool results
    } else {
      // Final text response
      finalText = choice.message.content || '';

      // Update in-memory context
      ctx.push({ role: 'user', content: userContent });
      ctx.push({ role: 'assistant', content: finalText });
      trimContext(ctx);

      break;
    }
  }

  if (!finalText) finalText = 'I ran into an issue processing that request.';

  // AI chose to stay silent this turn
  if (finalText.trim() === 'NULL_RESPONSE') return null;

  return finalText;
}

// Lightweight version for DMs — uses separate per-user context
export async function respondToDM({
  userId,
  input,
  imageUrls = [],
  attachments = [],
  discordClient,
}) {
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
