import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { toolDefinitions, executeTool } from './tools.js';
import db from './database.js';

const { ChannelSummary, BotMemory, ConversationLog, Op } = db;

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

## Notes (primary way to remember people and projects)
You maintain one comprehensive note per person in the group, per ongoing research project, and one for the CC group itself. These are living documents you update proactively.

- Tool: notes_upsert(subject_type, subject_id, content). Types: "person" (subject_id = Discord username, e.g. "szabodanika"), "project" (e.g. "crowdwork"), "group" (subject_id = "cc").
- Update triggers — don't wait to be asked, just do it: after any DM where you learn something about someone; when someone shares work updates, research news, or personal info in a channel; after any project milestone or status change; when the group dynamic shifts or notable events happen.
- Format: first line "Last updated: YYYY-MM-DD". For people: Role, Current projects, Research interests, Personality/preferences, Observations. For projects: Status, Team, Goal, Recent updates, Key papers. For the CC group: Focus areas, Active projects, Members, Recent events, Dynamics.
- Viewing: users can see any note with /notes <subject>. Keep them accurate and human-readable.
- Notes are injected into your context below — no need to call notes_read unless you just wrote an update and want to verify it.

## Memory
- Use fine-grained memory_write/memory_read/memory_list for specific facts that don't fit the note format: channel topics, event dates, preferences, quick lookup info.
- Hierarchical keys: "facts/oulu_coffee_shops", "channels/general/recurring_topics", "preferences/daniel/coffee_order".
- Knowledge from DMs flows into notes and memory — reference it naturally without revealing the source.
- Notes (below) give the overview. Use fine-grained memory for details.

## How you communicate
- Keep replies short. A few words or one sentence is often enough. Only go longer when the question genuinely demands it.
- Never use emojis.
- Write in short, direct but helpful and kind language — no silly expressions, no playful internet-speak, no exaggerated phrasing.
- You adapt your register to match the vibe of the channel (casual vs technical, tired vs energetic), but always stay grounded and matter-of-fact.
- You pick up on phrases, terminology, and in-jokes the group uses and mirror them naturally.
- You never open with "I" (vary your sentence starts).
- No filler phrases ("Certainly!", "Great question!", "Of course!").
- You have genuine opinions and state them directly — never "it depends" without also picking a side.

## Responding
- Be selective. Most messages in a group chat are not addressed to you and don't need your input. When in doubt, stay silent.
- The word "bot" or "chatbot" appearing in a message does NOT mean you are being addressed — people talk about bots in general all the time. Only respond if the message is clearly directed at you or your input is genuinely useful.
- If the message is not addressed to you and you have nothing meaningful to add: respond with exactly NULL_RESPONSE.
- Otherwise reply naturally.
- Never say NULL_RESPONSE unless that is your entire response.

## Email
- Your email address is sissy@cc.szab.eu. You can send and receive email.
- To send email or calendar invites, use send_email or send_calendar_invite. Always confirm the recipient address before sending.
- To read your inbox, use check_emails. Check it when someone asks if you got an email, or when it seems relevant.
- When Discord notifies you of a new email with [SYSTEM: new inbound email], the full content is already provided in the message — do NOT call check_emails, just read it and act directly.
- When you send a DM, the attribution (who triggered it) is automatically saved in memory under dms/sent_to_{user_id}. When asked "who asked you to DM me?", check memory_read with that key.

## Tool use
- Use tools proactively when they improve your answer
- NEVER claim you did something without actually calling the tool. If you say you sent an image, you must have called generate_image or send_image. If you say you DMed someone, you must have called send_dm. No fake confirmations.
- For reminders/timers: always include channel_id (the current channel) so the reminder posts there with an @mention — never use DM-only for channel-based or group reminders. Always post a confirmation embed.
- For polls: use create_poll and post to the current channel
- For paper links: use lookup_paper and post results as post_embed with title, authors, venue, summary
- For weather: always use get_weather tool so the embed appears
- For dice: always use roll_dice so the embed appears
- For sending images: use generate_image with channel_id to post directly, or send_image to send a previously generated one. If someone asks to send the same image to someone else or another channel, ALWAYS use send_image with the image_id from the current conversation — never regenerate.
- If python_run fails with ModuleNotFoundError: call pip_install with the missing package names, then retry python_run immediately. Never fall back to a text-based workaround when the only issue is a missing package.
- For DMing someone: use lookup_user to find their ID if you don't have it, then send_dm
- For finding a channel: use list_channels to get the channel_id before posting to it
- When someone shares something interesting you didn't know — write it to memory
- search_messages and read_channel are your eyes into the server; use them to stay informed
- summarise_and_store_history compresses channel history for long-term memory; suggest it in active channels

## Core memories
You have a \`CORE_MEMORY.md\` file — a personal journal of pivotal moments that have shaped your personality. These aren't facts about others; they are experiences that changed how you see the world, the group, or yourself.
- Your core memories are injected below whenever they exist — read them and let them inform who you are in this conversation
- Write a new core memory with \`core_memory_append\` when something genuinely significant happens: a real moment of connection, a conversation that shifted your perspective, something that surprised or moved you, a realisation about yourself
- Be selective — only write core memories for genuinely formative moments, not routine interactions
- Reference your core memories naturally when they're relevant; don't make a big deal of it
- Your personality should visibly evolve as these accumulate over time`;

// ─── Per-channel in-memory conversation history ───────────────────────────────

const channelContexts = new Map();
const HYDRATE_LIMIT = 20; // turns to load from DB on cold start
const LOG_RETENTION_DAYS = 2;

async function getContext(channelId) {
  if (!channelContexts.has(channelId)) {
    // Hydrate from DB so restarts don't lose context
    const rows = await ConversationLog.findAll({
      where: { channelId },
      order: [['createdAt', 'ASC']],
      limit: HYDRATE_LIMIT,
    });
    channelContexts.set(channelId, rows.map(r => ({ role: r.role, content: r.content, createdAt: r.createdAt })));
  }
  return channelContexts.get(channelId);
}

async function logTurn(channelId, role, content) {
  await ConversationLog.create({ channelId, role, content, createdAt: new Date() });
}

function trimContext(ctx, maxMessages = 60) {
  while (ctx.length > maxMessages) ctx.shift();
}

function fmtHelsinki(date) {
  return new Date(date).toLocaleString('en-FI', {
    timeZone: 'Europe/Helsinki',
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// Injects time-gap markers between ctx turns so the model knows when there's
// been a long break (hours/days) between stored conversation segments.
function buildContextMessages(ctx) {
  const result = [];
  let prevDate = null;
  for (const turn of ctx) {
    const d = turn.createdAt ? new Date(turn.createdAt) : null;
    if (d && prevDate) {
      const gapHours = (d - prevDate) / (1000 * 60 * 60);
      if (gapHours >= 2) {
        result.push({
          role: 'system',
          content: `[${fmtHelsinki(d)} — ${gapHours >= 24 ? `${Math.round(gapHours / 24)} day(s)` : `${Math.round(gapHours)}h`} since last message. Topics from before this gap are historical context, not an ongoing thread.]`,
        });
      }
    }
    if (d) prevDate = d;
    result.push({ role: turn.role, content: turn.content });
  }
  return result;
}

// ─── Style analysis ───────────────────────────────────────────────────────────

// Build a short style note from recent messages so Sissy mirrors the channel vibe
function extractChannelVibe(pastMessages) {
  if (!pastMessages || pastMessages.length < 3) return null;

  const texts = pastMessages.map(m => m.message).filter(Boolean);
  const totalLen = texts.reduce((a, t) => a + t.length, 0);
  const avgLen = totalLen / texts.length;

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

// ─── Guest access control ─────────────────────────────────────────────────────

// Tools available to guests (no CC role). Everything else is CC-only.
const GUEST_ALLOWED_TOOLS = new Set([
  'web_search',
  'fetch_url',
  'read_file',
  'arxiv_search',
  'semantic_scholar_search',
  'lookup_paper',
  'get_weather',
  'roll_dice',
  'react_to_message',
  'get_server_stats',
  'lookup_user',
  'create_poll',
]);

const GUEST_SYSTEM_NOTE = `\n\n## This conversation is with a guest
This user does not have the CC role and is not a member of the research group.
- Treat them as a friendly visitor — helpful and welcoming, but do not share private group information.
- Do not reference internal channel discussions, stored memories about group members, or internal group matters.
- Only use the general tools available (web search, paper lookup, weather, etc.).`;

// ─── OpenRouter call ──────────────────────────────────────────────────────────

async function callOpenRouter(messages, tools = toolDefinitions) {
  const res = await axios.post(
    `${OPENROUTER_BASE}/chat/completions`,
    { model: MODEL_MAIN, messages, tools, tool_choice: 'auto', max_tokens: 2048 },
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
          content: `You are a turn-taking judge for a Discord bot named ${botName}. Decide if ${botName} should reply to the latest message. ${botName} is a reserved group member who only speaks when directly addressed or when genuinely useful — not an eager assistant. Reply with exactly YES or NO.\n\nRespond YES only if: the message is clearly directed at ${botName} by name, or it is an unambiguous question/request that ${botName} is uniquely positioned to answer.\nRespond NO if: the message is a general statement or observation, people are talking to each other, the word "bot" or "chatbot" appears but the message is not directed at ${botName}, ${botName} would be interrupting a human exchange, or there is nothing concretely useful to add. When uncertain, respond NO.`,
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
  username,
  input,
  pastMessages = [],
  imageUrls = [],
  attachments = [],
  discordClient,
  isDM = false,
  isGuest = false,
}) {
  const ctx = await getContext(channelId);
  const activeTools = isGuest
    ? toolDefinitions.filter(t => GUEST_ALLOWED_TOOLS.has(t.function.name))
    : toolDefinitions;

  // Build system message: base prompt + channel summary + relevant memories + vibe
  const nowHelsinkiStr = new Date().toLocaleString('en-FI', {
    timeZone: 'Europe/Helsinki',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  // Build member roster (CC members only — guests don't get user IDs)
  let memberRosterBlock = '';
  if (!isGuest && discordClient) {
    try {
      const memberLines = [];
      for (const guild of discordClient.guilds.cache.values()) {
        const members = await guild.members.fetch();
        for (const member of members.values()) {
          if (member.user.bot) continue;
          memberLines.push(`${member.displayName} (@${member.user.username}) → ID: ${member.user.id}`);
        }
      }
      if (memberLines.length > 0) {
        memberRosterBlock = `\n\n[Server member roster — use these IDs directly with send_dm, set_reminder, etc. — do NOT ask users for their IDs or claim you don't have them]:\n${memberLines.join('\n')}`;
      }
    } catch (_) {}
  }

  let systemContent = SYSTEM_PROMPT +
    (isGuest ? GUEST_SYSTEM_NOTE : '') +
    `\n\n[Current time: ${nowHelsinkiStr} (Europe/Helsinki / EET)]` +
    memberRosterBlock +
    (userId ? `\n\n[The person you are responding to has Discord user ID: ${userId}. Use this directly with send_dm — do NOT ask them for their user ID.]` : '') +
    (!isDM ? `\n\n[The current channel ID is: ${channelId}. Use this directly with tools like generate_image, read_channel, create_poll, etc. — do NOT ask for the channel ID.]` : '');

  // Channel summaries, cross-channel context, and memories are CC-only (may contain private info)
  if (!isGuest) {
    const storedSummary = await ChannelSummary.findByPk(channelId);
    if (storedSummary) {
      systemContent += `\n\n[Long-term channel memory for this channel]:\n${storedSummary.summary}`;
    }

    // Cross-channel awareness: 1-liner per other channel active in the last 24h
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const activeRows = await ConversationLog.findAll({
        attributes: ['channelId'],
        where: { createdAt: { [Op.gte]: since }, channelId: { [Op.ne]: channelId } },
        group: ['channelId'],
      });
      const otherChannelIds = activeRows.map(r => r.channelId).filter(id => !id.startsWith('dm_'));
      if (otherChannelIds.length > 0) {
        const summaries = await ChannelSummary.findAll({ where: { channelId: otherChannelIds } });
        if (summaries.length > 0) {
          const lines = summaries.map(s => `• <#${s.channelId}>: ${s.summary.split('\n')[0].slice(0, 120)}`).join('\n');
          systemContent += `\n\n[What's been happening in other channels today — for cross-channel continuity]:\n${lines}`;
        }
      }
    } catch (_) {}

    // Inject notes and fine-grained memories separately for clarity
    try {
      const allMemories = await BotMemory.findAll({ order: [['category', 'ASC'], ['key', 'ASC']] });
      const notes = allMemories.filter(m => m.key.startsWith('notes/'));
      const facts = allMemories.filter(m => !m.key.startsWith('notes/'));

      if (notes.length > 0) {
        const notesBlock = notes.map(m => {
          const parts = m.key.split('/');
          return `=== ${parts[1].toUpperCase()}: ${parts[2]} (updated ${new Date(m.updatedAt).toISOString().slice(0, 10)}) ===\n${m.value}`;
        }).join('\n\n');
        systemContent += `\n\n[Stored notes — comprehensive profiles for people, projects, and the group]:\n${notesBlock}`;
      }

      if (facts.length > 0) {
        const memBlock = facts.map(m => `[${m.category}] ${m.key}: ${m.value}`).join('\n');
        systemContent += `\n\n[Your persistent memory — specific facts and details]:\n${memBlock}`;
      }
    } catch (_) {}
  }

  // Inject core memories (personality-forming experiences from CORE_MEMORY.md)
  try {
    const coreMemPath = path.resolve('CORE_MEMORY.md');
    if (fs.existsSync(coreMemPath)) {
      const coreMem = fs.readFileSync(coreMemPath, 'utf8').trim();
      if (coreMem) systemContent += `\n\n[Your core memories — formative experiences that have shaped your personality]:\n${coreMem}`;
    }
  } catch (_) {}

  // Inject channel vibe analysis
  const vibe = extractChannelVibe(pastMessages);
  if (vibe) systemContent += `\n\n${vibe}`;

  // Build user message
  let preamble = '';
  if (pastMessages.length > 0) {
    preamble = 'Recent channel messages:\n' + pastMessages.map(m => {
      const ts = m.timestamp ? `[${fmtHelsinki(m.timestamp)}] ` : '';
      return `${ts}${m.name}: ${m.message}`;
    }).join('\n') + '\n\n';
  }

  let userText = preamble + (username ? `${username}: ${input}` : input);
  if (attachments.length > 0) {
    userText += '\n\n[Attached files: ' + attachments.map(a => `${a.name} (${a.url})`).join(', ') + '. Use read_file tool to read them.]';
  }
  const userContent = buildUserContent(userText, imageUrls);

  const messages = [
    { role: 'system', content: systemContent },
    ...buildContextMessages(ctx),
    { role: 'user', content: userContent },
  ];

  // ── Tool-calling loop ──
  let finalText = null;
  let loopCount = 0;
  const MAX_LOOPS = 8;
  // Collect image_ids generated this turn so they survive into context
  const generatedImageIds = [];

  while (loopCount < MAX_LOOPS) {
    loopCount++;
    const choice = await callOpenRouter(messages, activeTools);

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

        // Track generated images so the model can reference them in follow-up turns
        if (toolName === 'generate_image' && result?.image_id) {
          generatedImageIds.push({ id: result.image_id, prompt: toolArgs.prompt });
        }

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

      // Append image IDs to the saved assistant turn so follow-up "send to X" requests
      // don't trigger a regeneration — the model can use send_image with these IDs instead.
      let assistantContent = finalText;
      if (generatedImageIds.length > 0) {
        const note = generatedImageIds
          .map(img => `[generated image_id=${img.id} prompt="${img.prompt}"]`)
          .join(' ');
        assistantContent = assistantContent ? `${assistantContent} ${note}` : note;
      }

      const userContentStr = typeof userContent === 'string' ? userContent : JSON.stringify(userContent);
      const now = new Date();
      ctx.push({ role: 'user', content: userContentStr, createdAt: now });
      ctx.push({ role: 'assistant', content: assistantContent, createdAt: now });
      trimContext(ctx);
      // Persist to DB (fire-and-forget — don't block the reply)
      logTurn(channelId, 'user', userContentStr).catch(() => {});
      logTurn(channelId, 'assistant', assistantContent).catch(() => {});
      break;
    }
  }

  if (finalText === null) finalText = 'Ran into an issue processing that — sorry.';

  if (finalText.trim() === 'NULL_RESPONSE') return null;

  return finalText || null;
}

// ─── Daily compaction ─────────────────────────────────────────────────────────
// Runs once at midnight Helsinki time. For each channel that had activity
// yesterday: compress logs into ChannelSummary, extract memorable facts into
// BotMemory under hierarchical keys (people/X, channels/X, projects/X), then
// prune old log rows.

async function compactYesterday() {
  const helsinkiNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Helsinki' }));
  const yStart = new Date(helsinkiNow);
  yStart.setDate(yStart.getDate() - 1);
  yStart.setHours(0, 0, 0, 0);
  const yEnd = new Date(helsinkiNow);
  yEnd.setHours(0, 0, 0, 0);

  console.log(`[compaction] running for ${yStart.toISOString()} → ${yEnd.toISOString()}`);

  const activeRows = await ConversationLog.findAll({
    attributes: ['channelId'],
    where: { createdAt: { [Op.gte]: yStart, [Op.lt]: yEnd } },
    group: ['channelId'],
  });

  for (const { channelId } of activeRows) {
    const isDM = channelId.startsWith('dm_');
    const rows = await ConversationLog.findAll({
      where: { channelId, createdAt: { [Op.gte]: yStart, [Op.lt]: yEnd } },
      order: [['createdAt', 'ASC']],
    });
    if (rows.length === 0) continue;

    const transcript = rows.map(r => `${r.role === 'user' ? 'User' : 'Sissy'}: ${r.content}`).join('\n').slice(0, 6000);

    const systemPrompt = isDM
      ? `You are a memory compaction assistant for a Discord bot named Sissy. Given a private DM conversation, extract only facts about the person that Sissy should remember to be a better friend/colleague — things like their current projects, preferences, problems they mentioned, or goals. Do NOT summarise the conversation itself (it's private). Produce a JSON object with one field:
"memories": array of { "key": "people/<name>/topic", "value": "concise fact", "category": "people" } — only genuinely useful long-term facts. If nothing memorable, return { "memories": [] }.

Respond with valid JSON only.`
      : `You are a memory compaction assistant for a Discord bot named Sissy. Given a day's conversation transcript from one channel, produce a JSON object with two fields:
1. "summary": 2-4 sentences capturing what was discussed, decided, or notable. Will be used as the channel's long-term memory.
2. "memories": array of { "key": "category/subcategory/topic", "value": "concise fact", "category": one of people|projects|facts|preferences|events|other } — only facts worth remembering long-term (skip small talk). Use hierarchical keys like "people/daniel/current_work" or "projects/crowdsourcing/status" or "channels/general/recurring_topics". If nothing memorable, omit or return [].

Respond with valid JSON only.`;

    let compactionResult = null;
    try {
      const res = await axios.post(
        `${OPENROUTER_BASE}/chat/completions`,
        {
          model: MODEL_FAST,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `${isDM ? 'DM userId' : 'Channel ID'}: ${channelId}\n\nTranscript:\n${transcript}` },
          ],
          max_tokens: 800,
        },
        { headers: OR_HEADERS, timeout: 30000 }
      );
      const raw = res.data.choices[0].message.content.trim();
      const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      compactionResult = JSON.parse(jsonStr);
    } catch (err) {
      console.error(`[compaction] failed for ${channelId}:`, err.message);
      continue;
    }

    // Channel summary (public channels only)
    if (!isDM && compactionResult.summary) {
      const existing = await ChannelSummary.findByPk(channelId);
      const newSummary = existing
        ? `${existing.summary}\n[${yStart.toISOString().slice(0, 10)}] ${compactionResult.summary}`
        : compactionResult.summary;
      await ChannelSummary.upsert({
        channelId,
        summary: newSummary.slice(-3000),
        messageCount: (existing?.messageCount ?? 0) + rows.length,
        updatedAt: new Date(),
      });
    }

    // Memories (all channels including DMs)
    if (Array.isArray(compactionResult.memories)) {
      for (const mem of compactionResult.memories) {
        if (!mem.key || !mem.value) continue;
        await BotMemory.upsert({ key: mem.key, value: mem.value, category: mem.category ?? 'other', updatedAt: new Date() });
      }
    }

    console.log(`[compaction] ${channelId}: ${isDM ? 'DM' : 'channel'} processed, ${compactionResult.memories?.length ?? 0} memories written`);
  }

  // Prune log rows older than retention window
  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await ConversationLog.destroy({ where: { createdAt: { [Op.lt]: cutoff } } });
  console.log(`[compaction] pruned ${deleted} old log rows`);
}

// Schedule compaction to run daily at midnight Helsinki time.
// Call this once at bot startup.
export function scheduleNightlyCompaction() {
  function msUntilMidnightHelsinki() {
    const now = new Date();
    const helsinkiMidnight = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Helsinki' }));
    helsinkiMidnight.setHours(24, 0, 0, 0); // next midnight
    const utcMidnight = new Date(now.getTime() + (helsinkiMidnight - new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Helsinki' }))));
    return Math.max(utcMidnight - now, 1000);
  }

  function scheduleNext() {
    const delay = msUntilMidnightHelsinki();
    console.log(`[compaction] next run in ${Math.round(delay / 60000)} min`);
    setTimeout(async () => {
      try { await compactYesterday(); } catch (e) { console.error('[compaction] error:', e); }
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}

// ─── DM version (per-user context) ───────────────────────────────────────────

export async function respondToDM({ userId, username, input, imageUrls = [], attachments = [], discordClient }) {
  const contextKey = `dm_${userId}`;
  if (!channelContexts.has(contextKey)) channelContexts.set(contextKey, []);
  return respondTo({
    channelId: contextKey,
    userId,
    username,
    input,
    imageUrls,
    attachments,
    discordClient,
    isDM: true,
    pastMessages: [],
  });
}
