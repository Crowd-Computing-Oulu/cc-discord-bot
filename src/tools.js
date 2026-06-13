import axios from 'axios';
import * as cheerio from 'cheerio';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import { parse as csvParse } from 'csv-parse/sync';
import moment from 'moment-timezone';
import { AttachmentBuilder } from 'discord.js';
import db from './database.js';

const _OR_KEY = process.env.OPENROUTER_APIKEY;
const _OR_HEADERS = {
  Authorization: `Bearer ${_OR_KEY}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': 'https://github.com/Crowd-Computing-Oulu/cc-discord-bot',
  'X-Title': 'Sissy Discord Bot',
};

const { Reminder, RepeatReminder, ScheduledTask, ChannelSummary, Op } = db;

// ─── Cron helpers ────────────────────────────────────────────────────────────

// Parse simple natural-language repeat specs into cron expressions
function parseCronSpec(spec) {
  const s = spec.toLowerCase().trim();
  if (s === 'daily') return '0 8 * * *';
  if (s === 'weekly') return '0 8 * * 1';
  if (s === 'monthly') return '0 8 1 * *';
  if (s === 'weekdays') return '0 8 * * 1-5';
  if (s === 'weekends') return '0 8 * * 0,6';
  // If it looks like a cron expression already (5 parts), return as-is
  if (/^[\d\*\/,\- ]+$/.test(spec) && spec.trim().split(/\s+/).length === 5) return spec.trim();
  // hourly
  if (s.includes('hour')) return '0 * * * *';
  return null;
}

// Compute next run from cron expression (simple implementation, no external lib)
function nextRunFromCron(cronExpr, after = new Date()) {
  // Use node-schedule's internal parser by creating a temporary job
  // For simplicity: add 1 day/week/month based on known patterns
  const now = moment(after);
  const parts = cronExpr.split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, month, dow] = parts;
  // Build the next time naively: today at hour:min, or tomorrow if past
  const candidate = now.clone().minute(parseInt(min) || 0).second(0).millisecond(0);
  if (hour !== '*') candidate.hour(parseInt(hour));

  if (dom !== '*') {
    candidate.date(parseInt(dom));
    if (month !== '*') candidate.month(parseInt(month) - 1);
  }

  if (candidate.isSameOrBefore(now)) {
    // advance by the coarsest period
    if (dom !== '*') candidate.add(1, 'month');
    else if (dow !== '*') candidate.add(1, 'week');
    else if (hour !== '*') candidate.add(1, 'day');
    else candidate.add(1, 'hour');
  }
  return candidate.toDate();
}

// ─── Tool definitions (OpenAI function-calling schema) ────────────────────

export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: 'Set a one-time reminder for a user. Sends a DM at the specified time.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'What to remind the user about' },
          iso_datetime: { type: 'string', description: 'ISO 8601 datetime string (Europe/Helsinki timezone) e.g. 2026-06-15T09:00:00' },
          ping_user_id: { type: 'string', description: 'Discord user ID to ping (optional, defaults to the requester)' },
          user_id: { type: 'string', description: 'Discord user ID who will receive the DM reminder' },
        },
        required: ['title', 'iso_datetime', 'user_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_repeating_reminder',
      description: 'Set a repeating reminder. repeat_spec can be: daily, weekly, monthly, weekdays, weekends, hourly, or a 5-part cron expression.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'What to remind the user about' },
          repeat_spec: { type: 'string', description: 'Repeat schedule: daily, weekly, monthly, weekdays, weekends, hourly, or cron expr like "0 9 * * 1"' },
          ping_user_id: { type: 'string', description: 'Discord user ID to ping in the reminder message (optional)' },
          user_id: { type: 'string', description: 'Discord user ID who will receive the reminder' },
        },
        required: ['title', 'repeat_spec', 'user_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: 'List all pending reminders (one-shot and repeating) for a user.',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'Discord user ID' },
        },
        required: ['user_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_reminder',
      description: 'Cancel a reminder by its ID. Use list_reminders first to get IDs.',
      parameters: {
        type: 'object',
        properties: {
          reminder_id: { type: 'number', description: 'ID of the reminder to cancel' },
          type: { type: 'string', enum: ['one_shot', 'repeating'], description: 'Whether this is a one-shot or repeating reminder' },
        },
        required: ['reminder_id', 'type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web using DuckDuckGo and return top results with titles, URLs, and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
          num_results: { type: 'number', description: 'Number of results to return (1-10, default 5)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch and read the text content of a URL (web page, article, etc.).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the text content of an attached file (PDF, DOCX, CSV, Markdown, TXT). Pass the Discord CDN URL of the attachment.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Discord CDN URL of the file attachment' },
          filename: { type: 'string', description: 'Original filename including extension (e.g. report.pdf)' },
        },
        required: ['url', 'filename'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delay_task',
      description: 'Schedule a task to be executed later. The bot will run the given prompt at the specified time and post the result to the channel.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task/prompt to execute at the scheduled time' },
          iso_datetime: { type: 'string', description: 'ISO 8601 datetime when to run the task (Europe/Helsinki timezone)' },
          channel_id: { type: 'string', description: 'Discord channel ID to post the result in' },
          user_id: { type: 'string', description: 'Discord user ID who requested this' },
        },
        required: ['prompt', 'iso_datetime', 'channel_id', 'user_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_dm',
      description: 'Send a direct message to a Discord user by their user ID.',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'Discord user ID to send the DM to' },
          message: { type: 'string', description: 'The message content to send' },
        },
        required: ['user_id', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_channel',
      description: 'Read recent messages from any accessible Discord channel. Use this to look up information in other channels.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Discord channel ID to read from' },
          limit: { type: 'number', description: 'Number of recent messages to fetch (1-100, default 30)' },
        },
        required: ['channel_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_channels',
      description: 'List all accessible text channels in the server with their IDs and names.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_messages',
      description: 'Search for messages containing a keyword across all accessible channels or a specific channel.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to search for in messages' },
          channel_id: { type: 'string', description: 'Limit search to this channel ID (optional, searches all channels if omitted)' },
          limit_per_channel: { type: 'number', description: 'How many messages to scan per channel (default 100)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'summarise_and_store_history',
      description: 'Summarise the recent message history of a channel and store it for long-term memory. Call this to compress channel history so future sessions remember it.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Channel ID to summarise' },
          limit: { type: 'number', description: 'Number of messages to include in summary (max 200, default 100)' },
        },
        required: ['channel_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_channel_summary',
      description: 'Retrieve the stored long-term summary for a channel.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Channel ID to get summary for' },
        },
        required: ['channel_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate an image from a text prompt and post it in the Discord channel.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Detailed description of the image to generate' },
          channel_id: { type: 'string', description: 'Discord channel ID to post the image in' },
        },
        required: ['prompt', 'channel_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'arxiv_search',
      description: 'Search arXiv for academic papers by keyword, title, or author. Returns papers with title, authors, abstract, and arXiv ID.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (keywords, title fragment, author name, etc.)' },
          num_results: { type: 'number', description: 'Number of results (1-10, default 5)' },
          sort_by: { type: 'string', enum: ['relevance', 'lastUpdatedDate', 'submittedDate'], description: 'Sort order (default: relevance)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'semantic_scholar_search',
      description: 'Search Semantic Scholar for academic papers. Good for citation counts, influential papers, and broader coverage than arXiv.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          num_results: { type: 'number', description: 'Number of results (1-10, default 5)' },
          fields_of_study: { type: 'string', description: 'Comma-separated fields to filter by, e.g. "Computer Science,Human-Computer Interaction"' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_paper',
      description: 'Look up a specific academic paper by DOI, arXiv ID, arXiv URL, Semantic Scholar URL, or Google Scholar URL. Returns title, authors, venue, year, abstract.',
      parameters: {
        type: 'object',
        properties: {
          identifier: { type: 'string', description: 'DOI (e.g. 10.1145/...), arXiv ID (e.g. 2301.07041), or full URL to the paper' },
        },
        required: ['identifier'],
      },
    },
  },
];

// ─── Tool executor ────────────────────────────────────────────────────────────

export async function executeTool(name, args, discordClient, requestingUserId) {
  try {
    switch (name) {
      case 'set_reminder': return await toolSetReminder(args, discordClient);
      case 'set_repeating_reminder': return await toolSetRepeatingReminder(args, discordClient);
      case 'list_reminders': return await toolListReminders(args);
      case 'cancel_reminder': return await toolCancelReminder(args);
      case 'web_search': return await toolWebSearch(args);
      case 'fetch_url': return await toolFetchUrl(args);
      case 'read_file': return await toolReadFile(args);
      case 'delay_task': return await toolDelayTask(args);
      case 'send_dm': return await toolSendDm(args, discordClient);
      case 'read_channel': return await toolReadChannel(args, discordClient);
      case 'list_channels': return await toolListChannels(args, discordClient);
      case 'search_messages': return await toolSearchMessages(args, discordClient);
      case 'summarise_and_store_history': return await toolSummariseAndStore(args, discordClient);
      case 'get_channel_summary': return await toolGetChannelSummary(args);
      case 'generate_image': return await toolGenerateImage(args, discordClient);
      case 'arxiv_search': return await toolArxivSearch(args);
      case 'semantic_scholar_search': return await toolSemanticScholarSearch(args);
      case 'lookup_paper': return await toolLookupPaper(args);
      default: return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    console.error(`Tool error [${name}]:`, err.message);
    return { error: err.message };
  }
}

// ─── Individual tool implementations ─────────────────────────────────────────

async function toolSetReminder({ title, iso_datetime, user_id, ping_user_id }) {
  const remindAt = moment.tz(iso_datetime, 'Europe/Helsinki').toDate();
  if (isNaN(remindAt)) return { error: 'Invalid datetime format' };
  await Reminder.create({ userId: user_id, title, remindAt, pingUserId: ping_user_id || null });
  return { success: true, message: `Reminder set for ${remindAt.toISOString()}` };
}

async function toolSetRepeatingReminder({ title, repeat_spec, user_id, ping_user_id }) {
  const cronExpr = parseCronSpec(repeat_spec);
  if (!cronExpr) return { error: `Could not parse repeat spec: ${repeat_spec}. Use: daily, weekly, monthly, weekdays, weekends, hourly, or a cron expression.` };
  const nextRunAt = nextRunFromCron(cronExpr) || new Date(Date.now() + 86400000);
  await RepeatReminder.create({ userId: user_id, title, cronExpr, pingUserId: ping_user_id || null, nextRunAt });
  return { success: true, cronExpr, nextRun: nextRunAt.toISOString() };
}

async function toolListReminders({ user_id }) {
  const oneShot = await Reminder.findAll({ where: { userId: user_id } });
  const repeating = await RepeatReminder.findAll({ where: { userId: user_id } });
  return {
    one_shot: oneShot.map(r => ({ id: r.id, title: r.title, remindAt: r.remindAt })),
    repeating: repeating.map(r => ({ id: r.id, title: r.title, cronExpr: r.cronExpr, nextRun: r.nextRunAt })),
  };
}

async function toolCancelReminder({ reminder_id, type }) {
  if (type === 'repeating') {
    const r = await RepeatReminder.findByPk(reminder_id);
    if (!r) return { error: 'Repeating reminder not found' };
    await r.destroy();
  } else {
    const r = await Reminder.findByPk(reminder_id);
    if (!r) return { error: 'Reminder not found' };
    await r.destroy();
  }
  return { success: true };
}

async function toolWebSearch({ query, num_results = 5 }) {
  const count = Math.min(Math.max(1, num_results), 10);
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SissyBot/1.0)' },
    timeout: 10000,
  });
  const $ = cheerio.load(res.data);
  const results = [];
  $('.result').slice(0, count).each((_, el) => {
    const title = $(el).find('.result__title').text().trim();
    const snippet = $(el).find('.result__snippet').text().trim();
    const href = $(el).find('.result__url').text().trim();
    if (title) results.push({ title, url: href, snippet });
  });
  if (results.length === 0) return { message: 'No results found', query };
  return { results, query };
}

async function toolFetchUrl({ url }) {
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SissyBot/1.0)' },
    timeout: 15000,
    responseType: 'text',
  });
  const $ = cheerio.load(res.data);
  $('script, style, nav, footer, header, aside').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 8000);
  return { url, content: text };
}

async function toolReadFile({ url, filename }) {
  const ext = filename.split('.').pop().toLowerCase();

  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  if (ext === 'pdf') {
    const data = await pdfParse(Buffer.from(res.data));
    return { filename, content: data.text.slice(0, 12000) };
  }
  const buffer = Buffer.from(res.data);
  if (ext === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return { filename, content: result.value.slice(0, 12000) };
  }
  if (ext === 'csv') {
    const text = buffer.toString('utf8');
    const records = csvParse(text, { columns: true, skip_empty_lines: true });
    return { filename, rows: records.slice(0, 200), total_rows: records.length };
  }
  if (['md', 'txt', 'markdown', 'text', 'log', 'json', 'js', 'ts', 'py'].includes(ext)) {
    return { filename, content: buffer.toString('utf8').slice(0, 12000) };
  }
  return { error: `Unsupported file type: .${ext}` };
}

async function toolDelayTask({ prompt, iso_datetime, channel_id, user_id }) {
  const runAt = moment.tz(iso_datetime, 'Europe/Helsinki').toDate();
  if (isNaN(runAt)) return { error: 'Invalid datetime format' };
  await ScheduledTask.create({ prompt, channelId: channel_id, userId: user_id, runAt });
  return { success: true, scheduledFor: runAt.toISOString(), prompt };
}

async function toolSendDm({ user_id, message }, discordClient) {
  const user = await discordClient.users.fetch(user_id);
  if (!user) return { error: 'User not found' };
  await user.send(message);
  return { success: true, sentTo: user.username };
}

async function toolReadChannel({ channel_id, limit = 30 }, discordClient) {
  const channel = await discordClient.channels.fetch(channel_id);
  if (!channel || !channel.isTextBased()) return { error: 'Channel not found or not a text channel' };
  const count = Math.min(Math.max(1, limit), 100);
  const messages = await channel.messages.fetch({ limit: count });
  const msgs = [...messages.values()].reverse().map(m => ({
    author: m.author.username,
    content: m.cleanContent,
    timestamp: m.createdAt.toISOString(),
    attachments: m.attachments.size > 0 ? [...m.attachments.values()].map(a => a.name) : undefined,
  }));
  return { channel: channel.name, messages: msgs };
}

async function toolListChannels(_, discordClient) {
  const guilds = discordClient.guilds.cache;
  const result = [];
  for (const guild of guilds.values()) {
    const channels = guild.channels.cache.filter(c => c.isTextBased && c.isTextBased());
    for (const ch of channels.values()) {
      result.push({ id: ch.id, name: ch.name, guild: guild.name });
    }
  }
  return { channels: result };
}

async function toolSearchMessages({ query, channel_id, limit_per_channel = 100 }, discordClient) {
  const q = query.toLowerCase();
  const found = [];
  const limit = Math.min(Math.max(1, limit_per_channel), 100);

  const fetchFrom = async (channel) => {
    if (!channel.isTextBased()) return;
    try {
      const messages = await channel.messages.fetch({ limit });
      for (const m of messages.values()) {
        if (m.cleanContent.toLowerCase().includes(q)) {
          found.push({
            channel: channel.name,
            channel_id: channel.id,
            author: m.author.username,
            content: m.cleanContent,
            timestamp: m.createdAt.toISOString(),
          });
        }
      }
    } catch (_) { /* skip inaccessible channels */ }
  };

  if (channel_id) {
    const ch = await discordClient.channels.fetch(channel_id);
    if (ch) await fetchFrom(ch);
  } else {
    for (const guild of discordClient.guilds.cache.values()) {
      for (const ch of guild.channels.cache.values()) {
        await fetchFrom(ch);
      }
    }
  }

  return { query, results: found.slice(0, 50), total_found: found.length };
}

async function toolSummariseAndStore({ channel_id, limit = 100 }, discordClient) {
  const channel = await discordClient.channels.fetch(channel_id);
  if (!channel || !channel.isTextBased()) return { error: 'Channel not found' };
  const count = Math.min(Math.max(1, limit), 200);
  const messages = await channel.messages.fetch({ limit: count });
  const rawText = [...messages.values()].reverse()
    .map(m => `${m.author.username}: ${m.cleanContent}`)
    .join('\n');

  // Use Granite (131k ctx) to produce the summary — fast and cheap for long text
  const summary = await granitesSummarise(rawText, channel.name);
  await ChannelSummary.upsert({ channelId: channel_id, summary, messageCount: messages.size, updatedAt: new Date() });

  return { success: true, channel: channel.name, message_count: messages.size, summary };
}

// Granite summarisation — called internally, also exported for /summarise slash command
export async function granitesSummarise(rawText, channelName = 'channel') {
  const res = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: 'ibm-granite/granite-4.1-8b',
      messages: [
        {
          role: 'system',
          content: 'You are a precise summariser. Given a Discord channel message history, produce a dense factual summary (max 400 words) covering: recurring topics, ongoing projects, key decisions, important links or papers shared, and active members. No fluff.',
        },
        { role: 'user', content: `Summarise the history of #${channelName}:\n\n${rawText}` },
      ],
      max_tokens: 600,
    },
    { headers: _OR_HEADERS, timeout: 60000 }
  );
  return res.data.choices[0].message.content.trim();
}

async function toolGetChannelSummary({ channel_id }) {
  const row = await ChannelSummary.findByPk(channel_id);
  if (!row) return { found: false, message: 'No stored summary for this channel yet.' };
  return { found: true, channel_id, summary: row.summary, updatedAt: row.updatedAt, messageCount: row.messageCount };
}

// ─── Image generation ─────────────────────────────────────────────────────────

async function toolGenerateImage({ prompt, channel_id }, discordClient) {
  const res = await axios.post(
    'https://openrouter.ai/api/v1/images/generations',
    { model: 'sourceful/riverflow-v2.5-fast', prompt, n: 1 },
    { headers: _OR_HEADERS, timeout: 120000 }
  );

  const imageUrl = res.data.data[0].url;

  // Fetch the image bytes and upload as a Discord attachment so it embeds inline
  const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
  const buffer = Buffer.from(imgRes.data);
  const attachment = new AttachmentBuilder(buffer, { name: 'generated.png' });

  const channel = await discordClient.channels.fetch(channel_id);
  if (!channel?.isTextBased()) return { error: 'Channel not found' };
  await channel.send({ files: [attachment] });

  return { success: true, prompt };
}

// ─── Paper / academic tools ───────────────────────────────────────────────────

async function toolArxivSearch({ query, num_results = 5, sort_by = 'relevance' }) {
  const count = Math.min(Math.max(1, num_results), 10);
  const sortMap = { relevance: 'relevance', lastUpdatedDate: 'lastUpdatedDate', submittedDate: 'submittedDate' };
  const sortParam = sortMap[sort_by] || 'relevance';
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${count}&sortBy=${sortParam}&sortOrder=descending`;

  const res = await axios.get(url, { timeout: 15000 });
  const $ = cheerio.load(res.data, { xmlMode: true });

  const papers = [];
  $('entry').each((_, el) => {
    const id = $(el).find('id').first().text().trim().replace('http://arxiv.org/abs/', '');
    const title = $(el).find('title').first().text().trim().replace(/\s+/g, ' ');
    const summary = $(el).find('summary').first().text().trim().replace(/\s+/g, ' ').slice(0, 400);
    const published = $(el).find('published').first().text().trim().slice(0, 10);
    const authors = $(el).find('author name').map((_, a) => $(a).text().trim()).get().slice(0, 6);
    const link = `https://arxiv.org/abs/${id}`;
    papers.push({ arxiv_id: id, title, authors, published, abstract: summary, url: link });
  });

  if (papers.length === 0) return { message: 'No arXiv results found', query };
  return { source: 'arxiv', query, results: papers };
}

async function toolSemanticScholarSearch({ query, num_results = 5, fields_of_study }) {
  const count = Math.min(Math.max(1, num_results), 10);
  const params = new URLSearchParams({
    query,
    limit: count,
    fields: 'title,authors,year,venue,externalIds,abstract,citationCount,influentialCitationCount,openAccessPdf',
  });
  if (fields_of_study) params.set('fieldsOfStudy', fields_of_study);

  const res = await axios.get(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, {
    headers: { 'User-Agent': 'SissyBot/1.0 (research assistant)' },
    timeout: 15000,
  });

  const papers = (res.data.data || []).map(p => ({
    title: p.title,
    authors: (p.authors || []).map(a => a.name).slice(0, 6),
    year: p.year,
    venue: p.venue || null,
    citations: p.citationCount,
    influential_citations: p.influentialCitationCount,
    abstract: p.abstract ? p.abstract.slice(0, 400) : null,
    doi: p.externalIds?.DOI || null,
    arxiv_id: p.externalIds?.ArXiv || null,
    pdf_url: p.openAccessPdf?.url || null,
    semantic_scholar_url: `https://www.semanticscholar.org/paper/${p.paperId}`,
  }));

  if (papers.length === 0) return { message: 'No Semantic Scholar results found', query };
  return { source: 'semantic_scholar', query, results: papers };
}

// Resolve a DOI, arXiv ID, or URL into structured paper metadata
async function toolLookupPaper({ identifier }) {
  const id = identifier.trim();

  // Detect arXiv
  const arxivMatch = id.match(/(?:arxiv\.org\/abs\/|arxiv\.org\/pdf\/|^)(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  if (arxivMatch) {
    const arxivId = arxivMatch[1];
    const url = `https://export.arxiv.org/api/query?id_list=${arxivId}`;
    const res = await axios.get(url, { timeout: 15000 });
    const $ = cheerio.load(res.data, { xmlMode: true });
    const entry = $('entry').first();
    if (!entry.length) return { error: 'arXiv paper not found' };

    return {
      source: 'arxiv',
      arxiv_id: arxivId,
      title: entry.find('title').first().text().trim().replace(/\s+/g, ' '),
      authors: entry.find('author name').map((_, a) => $(a).text().trim()).get(),
      published: entry.find('published').first().text().trim().slice(0, 10),
      venue: 'arXiv preprint',
      abstract: entry.find('summary').first().text().trim().replace(/\s+/g, ' '),
      url: `https://arxiv.org/abs/${arxivId}`,
    };
  }

  // Detect DOI
  const doiMatch = id.match(/(?:doi\.org\/|^)(10\.\d{4,}\/\S+)/i);
  if (doiMatch) {
    const doi = doiMatch[1];
    // Try Semantic Scholar first (richer metadata)
    try {
      const res = await axios.get(
        `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=title,authors,year,venue,abstract,citationCount,externalIds,openAccessPdf`,
        { headers: { 'User-Agent': 'SissyBot/1.0' }, timeout: 15000 }
      );
      const p = res.data;
      return {
        source: 'semantic_scholar',
        doi,
        title: p.title,
        authors: (p.authors || []).map(a => a.name),
        year: p.year,
        venue: p.venue || null,
        abstract: p.abstract || null,
        citations: p.citationCount,
        arxiv_id: p.externalIds?.ArXiv || null,
        pdf_url: p.openAccessPdf?.url || null,
        url: `https://doi.org/${doi}`,
      };
    } catch (_) {
      // Fall back to DOI content-negotiation for basic metadata
      const res = await axios.get(`https://doi.org/${doi}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'SissyBot/1.0' },
        timeout: 15000,
      });
      return { source: 'doi', doi, metadata: res.data, url: `https://doi.org/${doi}` };
    }
  }

  // Semantic Scholar paper URL
  const ssMatch = id.match(/semanticscholar\.org\/paper\/[^/]+\/([a-f0-9]+)/i);
  if (ssMatch) {
    const paperId = ssMatch[1];
    const res = await axios.get(
      `https://api.semanticscholar.org/graph/v1/paper/${paperId}?fields=title,authors,year,venue,abstract,citationCount,externalIds,openAccessPdf`,
      { headers: { 'User-Agent': 'SissyBot/1.0' }, timeout: 15000 }
    );
    const p = res.data;
    return {
      source: 'semantic_scholar',
      title: p.title,
      authors: (p.authors || []).map(a => a.name),
      year: p.year,
      venue: p.venue || null,
      abstract: p.abstract || null,
      citations: p.citationCount,
      doi: p.externalIds?.DOI || null,
      arxiv_id: p.externalIds?.ArXiv || null,
      pdf_url: p.openAccessPdf?.url || null,
      url: id,
    };
  }

  // Google Scholar or other URLs — scrape via fetch_url and let the AI parse it
  if (id.startsWith('http')) {
    return await toolFetchUrl({ url: id });
  }

  return { error: 'Could not identify the paper identifier type. Provide a DOI, arXiv ID, arXiv URL, Semantic Scholar URL, or Google Scholar URL.' };
}
