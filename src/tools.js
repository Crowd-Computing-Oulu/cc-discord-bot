import axios from 'axios';
import * as cheerio from 'cheerio';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const pdfParse = _require('pdf-parse');
import mammoth from 'mammoth';
import { parse as csvParse } from 'csv-parse/sync';
import moment from 'moment-timezone';
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import db from './database.js';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execFileAsync = promisify(execFile);

const IMAGES_DIR = path.resolve('generated_images');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

const USER_FILES_DIR = path.resolve('user_files');
if (!fs.existsSync(USER_FILES_DIR)) fs.mkdirSync(USER_FILES_DIR, { recursive: true });

function getUserDir(userId) {
  const dir = path.join(USER_FILES_DIR, userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeUserPath(userId, filePath) {
  const base = getUserDir(userId);
  const resolved = path.resolve(base, filePath);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error('Path traversal not allowed');
  }
  return resolved;
}

const _OR_KEY = process.env.OPENROUTER_APIKEY;
const _OR_HEADERS = {
  Authorization: `Bearer ${_OR_KEY}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': 'https://github.com/Crowd-Computing-Oulu/cc-discord-bot',
  'X-Title': 'Sissy Discord Bot',
};

const { Reminder, RepeatReminder, ScheduledTask, ChannelSummary, BotMemory } = db;

// ─── Cron helpers ────────────────────────────────────────────────────────────

function parseCronSpec(spec) {
  const s = spec.toLowerCase().trim();
  if (s === 'daily') return '0 8 * * *';
  if (s === 'weekly') return '0 8 * * 1';
  if (s === 'monthly') return '0 8 1 * *';
  if (s === 'weekdays') return '0 8 * * 1-5';
  if (s === 'weekends') return '0 8 * * 0,6';
  if (/^[\d\*\/,\- ]+$/.test(spec) && spec.trim().split(/\s+/).length === 5) return spec.trim();
  if (s.includes('hour')) return '0 * * * *';
  return null;
}

function nextRunFromCron(cronExpr, after = new Date()) {
  const now = moment(after);
  const parts = cronExpr.split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, month, dow] = parts;
  const candidate = now.clone().minute(parseInt(min) || 0).second(0).millisecond(0);
  if (hour !== '*') candidate.hour(parseInt(hour));
  if (dom !== '*') {
    candidate.date(parseInt(dom));
    if (month !== '*') candidate.month(parseInt(month) - 1);
  }
  if (candidate.isSameOrBefore(now)) {
    if (dom !== '*') candidate.add(1, 'month');
    else if (dow !== '*') candidate.add(1, 'week');
    else if (hour !== '*') candidate.add(1, 'day');
    else candidate.add(1, 'hour');
  }
  return candidate.toDate();
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export const toolDefinitions = [
  // ── Reminders ──
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: 'Set a one-time reminder for a user. Posts a DM (and optionally a channel ping) at the specified time. Always confirm with the user what time you interpreted.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'What to remind the user about' },
          iso_datetime: { type: 'string', description: 'ISO 8601 datetime (Europe/Helsinki timezone) e.g. 2026-06-15T09:00:00' },
          user_id: { type: 'string', description: 'Discord user ID who receives the DM (defaults to requester)' },
          ping_user_id: { type: 'string', description: 'Discord user ID to @mention in the reminder message (optional)' },
          channel_id: { type: 'string', description: 'Channel to post a public reminder ping in (optional, in addition to DM)' },
        },
        required: ['title', 'iso_datetime'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_repeating_reminder',
      description: 'Set a repeating reminder. repeat_spec: daily, weekly, monthly, weekdays, weekends, hourly, or a 5-part cron expression.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          repeat_spec: { type: 'string', description: 'daily, weekly, monthly, weekdays, weekends, hourly, or cron expr like "0 9 * * 1"' },
          user_id: { type: 'string' },
          ping_user_id: { type: 'string' },
          channel_id: { type: 'string', description: 'Channel to also post public ping (optional)' },
        },
        required: ['title', 'repeat_spec'],
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
          user_id: { type: 'string' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_reminder',
      description: 'Cancel a reminder by its ID.',
      parameters: {
        type: 'object',
        properties: {
          reminder_id: { type: 'number' },
          type: { type: 'string', enum: ['one_shot', 'repeating'] },
        },
        required: ['reminder_id', 'type'],
      },
    },
  },

  // ── Web / files ──
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web using DuckDuckGo. Returns titles, URLs, snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          num_results: { type: 'number', description: '1-10, default 5' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch and read the text content of a URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read text content of an attached file (PDF, DOCX, CSV, Markdown, TXT, JSON). Pass the Discord CDN URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          filename: { type: 'string', description: 'Original filename including extension' },
        },
        required: ['url', 'filename'],
      },
    },
  },

  // ── Scheduling ──
  {
    type: 'function',
    function: {
      name: 'delay_task',
      description: 'Schedule an AI task to run later and post result to a channel.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          iso_datetime: { type: 'string' },
          channel_id: { type: 'string' },
          user_id: { type: 'string' },
        },
        required: ['prompt', 'iso_datetime', 'channel_id', 'user_id'],
      },
    },
  },

  // ── Discord actions ──
  {
    type: 'function',
    function: {
      name: 'lookup_user',
      description: 'Find a Discord server member by name (display name, nickname, or username). Returns their user ID so you can use it with send_dm. Use this when you know someone\'s name but not their ID.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The name to search for (partial match is fine)' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_dm',
      description: 'Send a direct message to a Discord user.',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['user_id', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_channel',
      description: 'Read recent messages from a Discord channel.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: { type: 'string' },
          limit: { type: 'number', description: '1-100, default 30' },
        },
        required: ['channel_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_channels',
      description: 'List all accessible text channels in the server.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_messages',
      description: 'Search for messages containing a keyword across channels.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          channel_id: { type: 'string', description: 'Limit to specific channel (optional)' },
          limit_per_channel: { type: 'number', description: 'default 100' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'react_to_message',
      description: 'Add an emoji reaction to a Discord message.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: { type: 'string' },
          message_id: { type: 'string' },
          emoji: { type: 'string', description: 'Unicode emoji or custom emoji name, e.g. "👍" or "🔥"' },
        },
        required: ['channel_id', 'message_id', 'emoji'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pin_message',
      description: 'Pin a message in a Discord channel.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: { type: 'string' },
          message_id: { type: 'string' },
        },
        required: ['channel_id', 'message_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'post_embed',
      description: 'Post a rich Discord embed card to a channel. Use for structured info, announcements, paper summaries, etc.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string', description: 'Main body text (markdown supported)' },
          color: { type: 'string', description: 'Hex color string e.g. "#5865F2" (optional, defaults to blurple)' },
          url: { type: 'string', description: 'URL the title links to (optional)' },
          fields: {
            type: 'array',
            description: 'Optional list of fields',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: { type: 'string' },
                inline: { type: 'boolean' },
              },
              required: ['name', 'value'],
            },
          },
          footer: { type: 'string', description: 'Footer text (optional)' },
          thumbnail_url: { type: 'string', description: 'Small image in top-right (optional)' },
        },
        required: ['channel_id', 'title', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_poll',
      description: 'Post a poll to a Discord channel. Users vote by clicking buttons. Results are tracked with reactions.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: { type: 'string' },
          question: { type: 'string' },
          options: {
            type: 'array',
            description: '2-4 poll options',
            items: { type: 'string' },
          },
        },
        required: ['channel_id', 'question', 'options'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_server_stats',
      description: 'Get statistics about the Discord server: member count, channel count, recent activity.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  // ── Channel memory ──
  {
    type: 'function',
    function: {
      name: 'summarise_and_store_history',
      description: 'Summarise the recent message history of a channel and store it for long-term memory.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: { type: 'string' },
          limit: { type: 'number', description: 'max 200, default 100' },
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
          channel_id: { type: 'string' },
        },
        required: ['channel_id'],
      },
    },
  },

  // ── Bot persistent memory ──
  {
    type: 'function',
    function: {
      name: 'memory_write',
      description: 'Write or update a persistent memory entry. Use to remember facts about people, projects, preferences, ongoing discussions, or anything worth keeping. Key should be short and descriptive like "daniel_thesis_topic" or "group_reading_schedule".',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Unique identifier for this memory (snake_case, descriptive)' },
          value: { type: 'string', description: 'What to remember. Be specific and complete.' },
          category: { type: 'string', enum: ['people', 'projects', 'facts', 'preferences', 'events', 'other'], description: 'Category to group memories' },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_read',
      description: 'Read a specific memory entry by key.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_list',
      description: 'List all stored memory entries, optionally filtered by category. Use this to recall what you know before answering questions about the group.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['people', 'projects', 'facts', 'preferences', 'events', 'other'], description: 'Filter by category (optional)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_delete',
      description: 'Delete a memory entry by key.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
        },
        required: ['key'],
      },
    },
  },

  // ── Image generation ──
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate an image from a text prompt, save it to persistent storage, and optionally post it immediately. Works in DMs too — omit channel_id to just save it for later. Use send_image to deliver a saved image to anyone.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          channel_id: { type: 'string', description: 'Channel to post the image in immediately (optional — omit to save without posting)' },
          user_id: { type: 'string', description: 'DM this user the image immediately (optional)' },
        },
        required: ['prompt'],
      },
    },
  },

  // ── Academic paper tools ──
  {
    type: 'function',
    function: {
      name: 'arxiv_search',
      description: 'Search arXiv for academic papers. Returns title, authors, abstract, arXiv ID.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          num_results: { type: 'number', description: '1-10, default 5' },
          sort_by: { type: 'string', enum: ['relevance', 'lastUpdatedDate', 'submittedDate'], description: 'default: relevance' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'semantic_scholar_search',
      description: 'Search Semantic Scholar for academic papers. Good for citation counts and broader coverage.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          num_results: { type: 'number', description: '1-10, default 5' },
          fields_of_study: { type: 'string', description: 'e.g. "Computer Science,Human-Computer Interaction"' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_paper',
      description: 'Look up a specific paper by DOI, arXiv ID, or URL. Returns full metadata.',
      parameters: {
        type: 'object',
        properties: {
          identifier: { type: 'string', description: 'DOI, arXiv ID, or URL' },
        },
        required: ['identifier'],
      },
    },
  },

  // ── Filesystem ──
  {
    type: 'function',
    function: {
      name: 'fs_write',
      description: 'Write (or overwrite) a file in the user\'s personal file storage. Use this to save notes, scripts, data, or any text content.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Relative path within the user\'s storage, e.g. "notes.txt" or "scripts/hello.py"' },
          content: { type: 'string', description: 'Text content to write' },
          user_id: { type: 'string', description: 'Owner of the file' },
        },
        required: ['file_path', 'content', 'user_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_read',
      description: 'Read a file from the user\'s personal file storage.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          user_id: { type: 'string' },
        },
        required: ['file_path', 'user_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_list',
      description: 'List files and folders in the user\'s personal file storage (or a subdirectory of it).',
      parameters: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Relative subdirectory to list (optional, defaults to root)' },
          user_id: { type: 'string' },
        },
        required: ['user_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_delete',
      description: 'Delete a file from the user\'s personal file storage.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          user_id: { type: 'string' },
        },
        required: ['file_path', 'user_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fs_upload',
      description: 'Upload a file from the user\'s personal storage to a Discord channel or DM.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Relative path in the user\'s storage' },
          user_id: { type: 'string' },
          channel_id: { type: 'string', description: 'Channel to post the file in (optional)' },
          dm_user_id: { type: 'string', description: 'User to DM the file to (optional)' },
          caption: { type: 'string', description: 'Optional message to accompany the file' },
        },
        required: ['file_path', 'user_id'],
      },
    },
  },

  // ── Python ──
  {
    type: 'function',
    function: {
      name: 'python_run',
      description: 'Write a Python script to the user\'s file storage and execute it. Returns stdout and stderr. The script runs in a 30-second timeout sandbox. matplotlib, pandas, numpy, scipy, seaborn, scikit-learn, Pillow, requests, and more are pre-installed. If a package is missing, use pip_install first. matplotlib runs headless (Agg backend) — use plt.savefig() to save plots, never plt.show(). The working directory is the user\'s own file storage so relative paths work.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Python source code to run' },
          file_name: { type: 'string', description: 'Script filename to save as, e.g. "analysis.py" (defaults to "script.py")' },
          user_id: { type: 'string' },
        },
        required: ['code', 'user_id'],
      },
    },
  },

  // ── pip install ──
  {
    type: 'function',
    function: {
      name: 'pip_install',
      description: 'Install one or more Python packages at runtime using pip. Use this when a python_run script fails with a ModuleNotFoundError. Packages persist for the lifetime of the container.',
      parameters: {
        type: 'object',
        properties: {
          packages: {
            type: 'array',
            description: 'List of package names to install, e.g. ["networkx", "wordcloud"]',
            items: { type: 'string' },
          },
        },
        required: ['packages'],
      },
    },
  },

  // ── Vision / OCR ──
  {
    type: 'function',
    function: {
      name: 'read_images',
      description: 'Extract all readable text and structured data from one or more images using vision AI. Use this to OCR screenshots, workout logs, receipts, whiteboards, charts, etc. Pass Discord CDN image URLs. Returns extracted text for each image.',
      parameters: {
        type: 'object',
        properties: {
          image_urls: {
            type: 'array',
            description: 'List of image URLs (Discord CDN or any public URL)',
            items: { type: 'string' },
          },
          prompt: { type: 'string', description: 'What to extract or focus on, e.g. "extract workout duration and total weight volume" (optional, defaults to extracting all text/data)' },
        },
        required: ['image_urls'],
      },
    },
  },

  // ── Fun / utility ──
  {
    type: 'function',
    function: {
      name: 'roll_dice',
      description: 'Roll dice. Supports standard notation like "2d6", "1d20", "3d8+4". Posts result to channel as an embed.',
      parameters: {
        type: 'object',
        properties: {
          notation: { type: 'string', description: 'Dice notation e.g. "2d6", "1d20+5", "4d6kh3" (keep highest 3)' },
          channel_id: { type: 'string', description: 'Channel to post result in' },
          reason: { type: 'string', description: 'What the roll is for (optional)' },
        },
        required: ['notation', 'channel_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather and forecast for a city. Posts a formatted embed.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City name, e.g. "Oulu, Finland"' },
          channel_id: { type: 'string', description: 'Channel to post weather embed in' },
        },
        required: ['location', 'channel_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_images',
      description: 'List previously generated images stored by Sissy. Returns IDs and prompts so you can pick one to send.',
      parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'Max number of images to list (default 10)' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_image',
      description: 'Send a previously generated image (by ID from list_images) to a channel or a user via DM.',
      parameters: {
        type: 'object',
        properties: {
          image_id: { type: 'integer', description: 'ID from list_images' },
          channel_id: { type: 'string', description: 'Channel to post in (optional)' },
          user_id: { type: 'string', description: 'User to DM the image to (optional)' },
        },
        required: ['image_id'],
      },
    },
  },
];

// ─── Tool executor ────────────────────────────────────────────────────────────

export async function executeTool(name, args, discordClient, requestingUserId) {
  switch (name) {
    case 'set_reminder': return await toolSetReminder({ ...args, user_id: args.user_id || requestingUserId }, discordClient);
    case 'set_repeating_reminder': return await toolSetRepeatingReminder({ ...args, user_id: args.user_id || requestingUserId }, discordClient);
    case 'list_reminders': return await toolListReminders({ user_id: args.user_id || requestingUserId });
    case 'cancel_reminder': return await toolCancelReminder(args);
    case 'web_search': return await toolWebSearch(args);
    case 'fetch_url': return await toolFetchUrl(args);
    case 'read_file': return await toolReadFile(args);
    case 'delay_task': return await toolDelayTask(args);
    case 'lookup_user': return await toolLookupUser(args, discordClient);
    case 'send_dm': return await toolSendDm(args, discordClient);
    case 'read_channel': return await toolReadChannel(args, discordClient);
    case 'list_channels': return await toolListChannels(args, discordClient);
    case 'search_messages': return await toolSearchMessages(args, discordClient);
    case 'react_to_message': return await toolReactToMessage(args, discordClient);
    case 'pin_message': return await toolPinMessage(args, discordClient);
    case 'post_embed': return await toolPostEmbed(args, discordClient);
    case 'create_poll': return await toolCreatePoll(args, discordClient);
    case 'get_server_stats': return await toolGetServerStats(args, discordClient);
    case 'summarise_and_store_history': return await toolSummariseAndStore(args, discordClient);
    case 'get_channel_summary': return await toolGetChannelSummary(args);
    case 'memory_write': return await toolMemoryWrite(args);
    case 'memory_read': return await toolMemoryRead(args);
    case 'memory_list': return await toolMemoryList(args);
    case 'memory_delete': return await toolMemoryDelete(args);
    case 'generate_image': return await toolGenerateImage(args, discordClient);
    case 'list_images': return await toolListImages(args);
    case 'send_image': return await toolSendImage(args, discordClient);
    case 'arxiv_search': return await toolArxivSearch(args);
    case 'semantic_scholar_search': return await toolSemanticScholarSearch(args);
    case 'lookup_paper': return await toolLookupPaper(args);
    case 'roll_dice': return await toolRollDice(args, discordClient);
    case 'get_weather': return await toolGetWeather(args, discordClient);
    case 'fs_write': return await toolFsWrite({ ...args, user_id: args.user_id || requestingUserId });
    case 'fs_read': return await toolFsRead({ ...args, user_id: args.user_id || requestingUserId });
    case 'fs_list': return await toolFsList({ ...args, user_id: args.user_id || requestingUserId });
    case 'fs_delete': return await toolFsDelete({ ...args, user_id: args.user_id || requestingUserId });
    case 'fs_upload': return await toolFsUpload({ ...args, user_id: args.user_id || requestingUserId }, discordClient);
    case 'python_run': return await toolPythonRun({ ...args, user_id: args.user_id || requestingUserId });
    case 'read_images': return await toolReadImages(args);
    case 'pip_install': return await toolPipInstall(args);
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ─── Reminder tools ───────────────────────────────────────────────────────────

async function toolSetReminder({ title, iso_datetime, user_id, ping_user_id, channel_id }, discordClient) {
  const remindAt = moment.tz(iso_datetime, 'Europe/Helsinki').toDate();
  if (isNaN(remindAt)) return { error: 'Invalid datetime format. Use ISO 8601 like 2026-06-15T09:00:00' };
  await Reminder.create({ userId: user_id, title, remindAt, pingUserId: ping_user_id || null, channelId: channel_id || null });

  // Post a Discord confirmation embed if we have a channel
  if (channel_id && discordClient) {
    try {
      const ch = await discordClient.channels.fetch(channel_id);
      if (ch?.isTextBased()) {
        const embed = new EmbedBuilder()
          .setColor('#F0A500')
          .setTitle('🔔 Reminder set')
          .setDescription(`**${title}**`)
          .addFields({ name: 'When', value: moment(remindAt).tz('Europe/Helsinki').format('ddd D MMM YYYY [at] HH:mm z'), inline: true })
          .setFooter({ text: `For user ${user_id}` });
        await ch.send({ embeds: [embed] });
      }
    } catch (_) {}
  }

  return { success: true, message: `Reminder set for ${moment(remindAt).tz('Europe/Helsinki').format('ddd D MMM YYYY HH:mm z')}` };
}

async function toolSetRepeatingReminder({ title, repeat_spec, user_id, ping_user_id, channel_id }) {
  const cronExpr = parseCronSpec(repeat_spec);
  if (!cronExpr) return { error: `Could not parse repeat spec: ${repeat_spec}. Use: daily, weekly, monthly, weekdays, weekends, hourly, or a cron expression.` };
  const nextRunAt = nextRunFromCron(cronExpr) || new Date(Date.now() + 86400000);
  await RepeatReminder.create({ userId: user_id, title, cronExpr, pingUserId: ping_user_id || null, channelId: channel_id || null, nextRunAt });
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

// ─── Web / file tools ─────────────────────────────────────────────────────────

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

// ─── Discord action tools ─────────────────────────────────────────────────────

async function toolLookupUser({ name }, discordClient) {
  const query = name.toLowerCase();
  const results = [];
  for (const guild of discordClient.guilds.cache.values()) {
    const members = await guild.members.fetch();
    for (const member of members.values()) {
      const displayName = (member.displayName || '').toLowerCase();
      const username = (member.user.username || '').toLowerCase();
      if (displayName.includes(query) || username.includes(query)) {
        results.push({ id: member.user.id, username: member.user.username, displayName: member.displayName });
      }
    }
  }
  if (results.length === 0) return { error: `No member found matching "${name}"` };
  return { matches: results };
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
    attachments: m.attachments.size > 0 ? [...m.attachments.values()].map(a => ({ name: a.name, url: a.url })) : undefined,
  }));
  return { channel: channel.name, messages: msgs };
}

async function toolListChannels(_, discordClient) {
  const result = [];
  for (const guild of discordClient.guilds.cache.values()) {
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
        const matchesText = m.cleanContent.toLowerCase().includes(q);
        const hasAttachment = m.attachments.size > 0 && [...m.attachments.values()].some(a => a.name?.toLowerCase().includes(q));
        if (matchesText || hasAttachment) {
          found.push({
            channel: channel.name,
            channel_id: channel.id,
            author: m.author.username,
            content: m.cleanContent,
            timestamp: m.createdAt.toISOString(),
            attachments: m.attachments.size > 0 ? [...m.attachments.values()].map(a => ({ name: a.name, url: a.url })) : undefined,
          });
        }
      }
    } catch (_) {}
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

async function toolReactToMessage({ channel_id, message_id, emoji }, discordClient) {
  const channel = await discordClient.channels.fetch(channel_id);
  if (!channel?.isTextBased()) return { error: 'Channel not found' };
  const message = await channel.messages.fetch(message_id);
  if (!message) return { error: 'Message not found' };
  await message.react(emoji);
  return { success: true, emoji };
}

async function toolPinMessage({ channel_id, message_id }, discordClient) {
  const channel = await discordClient.channels.fetch(channel_id);
  if (!channel?.isTextBased()) return { error: 'Channel not found' };
  const message = await channel.messages.fetch(message_id);
  if (!message) return { error: 'Message not found' };
  await message.pin();
  return { success: true, pinned: message_id };
}

async function toolPostEmbed({ channel_id, title, description, color, url, fields, footer, thumbnail_url }, discordClient) {
  const channel = await discordClient.channels.fetch(channel_id);
  if (!channel?.isTextBased()) return { error: 'Channel not found' };

  const hexColor = color ? parseInt(color.replace('#', ''), 16) : 0x5865F2;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(hexColor);

  if (url) embed.setURL(url);
  if (footer) embed.setFooter({ text: footer });
  if (thumbnail_url) embed.setThumbnail(thumbnail_url);
  if (fields && fields.length > 0) {
    embed.addFields(fields.map(f => ({ name: f.name, value: f.value, inline: !!f.inline })));
  }

  await channel.send({ embeds: [embed] });
  return { success: true };
}

async function toolCreatePoll({ channel_id, question, options }, discordClient) {
  const channel = await discordClient.channels.fetch(channel_id);
  if (!channel?.isTextBased()) return { error: 'Channel not found' };

  const clampedOptions = options.slice(0, 4);
  const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];

  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('📊 ' + question)
    .setDescription(clampedOptions.map((opt, i) => `${numberEmojis[i]} ${opt}`).join('\n'))
    .setFooter({ text: 'React below to vote!' });

  const msg = await channel.send({ embeds: [embed] });

  // Add reaction votes
  for (let i = 0; i < clampedOptions.length; i++) {
    await msg.react(numberEmojis[i]);
  }

  return { success: true, message_id: msg.id, options: clampedOptions };
}

async function toolGetServerStats(_, discordClient) {
  const results = [];
  for (const guild of discordClient.guilds.cache.values()) {
    const members = guild.memberCount;
    const channels = guild.channels.cache.filter(c => c.isTextBased && c.isTextBased()).size;
    const roles = guild.roles.cache.size;
    results.push({ guild: guild.name, members, text_channels: channels, roles });
  }
  return { servers: results };
}

// ─── Channel memory ───────────────────────────────────────────────────────────

async function toolSummariseAndStore({ channel_id, limit = 100 }, discordClient) {
  const channel = await discordClient.channels.fetch(channel_id);
  if (!channel || !channel.isTextBased()) return { error: 'Channel not found' };
  const count = Math.min(Math.max(1, limit), 200);
  const messages = await channel.messages.fetch({ limit: count });
  const rawText = [...messages.values()].reverse()
    .map(m => `${m.author.username}: ${m.cleanContent}`)
    .join('\n');

  const summary = await granitesSummarise(rawText, channel.name);
  await ChannelSummary.upsert({ channelId: channel_id, summary, messageCount: messages.size, updatedAt: new Date() });

  return { success: true, channel: channel.name, message_count: messages.size, summary };
}

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

// ─── Bot persistent memory ────────────────────────────────────────────────────

async function toolMemoryWrite({ key, value, category = 'other' }) {
  await BotMemory.upsert({ key, value, category, updatedAt: new Date() });
  return { success: true, key, category };
}

async function toolMemoryRead({ key }) {
  const row = await BotMemory.findByPk(key);
  if (!row) return { found: false, key };
  return { found: true, key, value: row.value, category: row.category, updatedAt: row.updatedAt };
}

async function toolMemoryList({ category } = {}) {
  const where = category ? { category } : {};
  const rows = await BotMemory.findAll({ where, order: [['category', 'ASC'], ['key', 'ASC']] });
  return {
    count: rows.length,
    memories: rows.map(r => ({ key: r.key, value: r.value, category: r.category, updatedAt: r.updatedAt })),
  };
}

async function toolMemoryDelete({ key }) {
  const row = await BotMemory.findByPk(key);
  if (!row) return { error: `No memory found with key: ${key}` };
  await row.destroy();
  return { success: true, deleted: key };
}

// ─── Image generation ─────────────────────────────────────────────────────────

async function toolGenerateImage({ prompt, channel_id, user_id }, discordClient) {
  let res;
  try {
    res = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'google/gemini-2.5-flash-image',
        messages: [{ role: 'user', content: prompt }],
      },
      { headers: _OR_HEADERS, timeout: 120000 }
    );
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 400) : e.message;
    console.error('[generate_image] API error:', e.response?.status, detail);
    return { error: `Image generation failed (${e.response?.status ?? 'network'}): ${detail}` };
  }

  const msg = res.data.choices[0].message;
  let imageData = null;
  let mimeType = 'image/png';

  if (msg.images && msg.images.length > 0) {
    const dataUrl = msg.images[0].image_url?.url || msg.images[0].url;
    const match = dataUrl?.match(/^data:([^;]+);base64,(.+)$/);
    if (match) { mimeType = match[1]; imageData = Buffer.from(match[2], 'base64'); }
  } else if (Array.isArray(msg.content)) {
    const imgPart = msg.content.find(p => p.type === 'image_url');
    const dataUrl = imgPart?.image_url?.url;
    const match = dataUrl?.match(/^data:([^;]+);base64,(.+)$/);
    if (match) { mimeType = match[1]; imageData = Buffer.from(match[2], 'base64'); }
  }

  if (!imageData) return { error: 'No image returned by model', raw: JSON.stringify(res.data).slice(0, 300) };

  const ext = mimeType.split('/')[1] || 'png';
  const filename = `${Date.now()}.${ext}`;
  const filePath = path.join(IMAGES_DIR, filename);
  fs.writeFileSync(filePath, imageData);

  const record = await db.GeneratedImage.create({ filePath, prompt, mimeType, createdAt: new Date() });

  const attachment = new AttachmentBuilder(imageData, { name: `generated.${ext}` });

  if (channel_id) {
    const channel = await discordClient.channels.fetch(channel_id);
    if (!channel?.isTextBased()) return { error: 'Channel not found' };
    await channel.send({ files: [attachment] });
  }

  if (user_id) {
    const user = await discordClient.users.fetch(user_id);
    await user.send({ files: [attachment] });
  }

  return { success: true, image_id: record.id, prompt, sent_to_channel: !!channel_id, sent_to_user: !!user_id };
}

async function toolListImages({ limit = 10 } = {}) {
  const rows = await db.GeneratedImage.findAll({ order: [['createdAt', 'DESC']], limit: Math.min(limit, 50) });
  return rows.map(r => ({ id: r.id, prompt: r.prompt, createdAt: r.createdAt }));
}

async function toolSendImage({ image_id, channel_id, user_id }, discordClient) {
  if (!channel_id && !user_id) return { error: 'Provide channel_id or user_id' };
  const record = await db.GeneratedImage.findByPk(image_id);
  if (!record) return { error: `No image found with id ${image_id}` };
  if (!fs.existsSync(record.filePath)) return { error: 'Image file missing from disk' };

  const ext = record.mimeType.split('/')[1] || 'png';
  const attachment = new AttachmentBuilder(record.filePath, { name: `generated.${ext}` });

  if (channel_id) {
    const channel = await discordClient.channels.fetch(channel_id);
    if (!channel?.isTextBased()) return { error: 'Channel not found' };
    await channel.send({ files: [attachment] });
  }

  if (user_id) {
    const user = await discordClient.users.fetch(user_id);
    await user.send({ files: [attachment] });
  }

  return { success: true, sent_to_channel: !!channel_id, sent_to_user: !!user_id };
}

// ─── Paper tools ──────────────────────────────────────────────────────────────

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

async function toolLookupPaper({ identifier }) {
  const id = identifier.trim();

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

  const doiMatch = id.match(/(?:doi\.org\/|^)(10\.\d{4,}\/\S+)/i);
  if (doiMatch) {
    const doi = doiMatch[1];
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
      const res = await axios.get(`https://doi.org/${doi}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'SissyBot/1.0' },
        timeout: 15000,
      });
      return { source: 'doi', doi, metadata: res.data, url: `https://doi.org/${doi}` };
    }
  }

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

  if (id.startsWith('http')) {
    return await toolFetchUrl({ url: id });
  }

  return { error: 'Could not identify the paper identifier type. Provide a DOI, arXiv ID, arXiv URL, Semantic Scholar URL, or Google Scholar URL.' };
}

// ─── Fun / utility tools ──────────────────────────────────────────────────────

async function toolRollDice({ notation, channel_id, reason }, discordClient) {
  // Parse notation like "2d6", "1d20+5", "4d6kh3"
  const match = notation.trim().match(/^(\d+)d(\d+)(?:(kh|kl)(\d+))?([+-]\d+)?$/i);
  if (!match) return { error: `Could not parse dice notation: ${notation}. Use format like "2d6", "1d20+5", "4d6kh3"` };

  const numDice = parseInt(match[1]);
  const sides = parseInt(match[2]);
  const keepType = match[3]?.toLowerCase();
  const keepCount = match[4] ? parseInt(match[4]) : null;
  const modifier = match[5] ? parseInt(match[5]) : 0;

  if (numDice < 1 || numDice > 100) return { error: 'Number of dice must be 1-100' };
  if (sides < 2 || sides > 1000) return { error: 'Sides must be 2-1000' };

  const rolls = Array.from({ length: numDice }, () => Math.floor(Math.random() * sides) + 1);
  let kept = [...rolls];

  if (keepType && keepCount) {
    const sorted = [...rolls].sort((a, b) => a - b);
    if (keepType === 'kh') kept = sorted.slice(-keepCount);
    else kept = sorted.slice(0, keepCount);
  }

  const total = kept.reduce((a, b) => a + b, 0) + modifier;

  const channel = await discordClient.channels.fetch(channel_id);
  if (channel?.isTextBased()) {
    const modStr = modifier !== 0 ? (modifier > 0 ? `+${modifier}` : `${modifier}`) : '';
    const keepStr = keepType ? ` (keep ${keepType === 'kh' ? 'highest' : 'lowest'} ${keepCount})` : '';
    const embed = new EmbedBuilder()
      .setColor(total === numDice * sides + modifier ? '#FFD700' : total === numDice + modifier ? '#FF4444' : '#5865F2')
      .setTitle(`🎲 ${notation.toUpperCase()}`)
      .setDescription(reason ? `*${reason}*` : null)
      .addFields(
        { name: 'Rolls', value: rolls.map(r => kept.includes(r) ? `**${r}**` : `~~${r}~~`).join(' '), inline: true },
        { name: 'Total', value: `**${total}**${modStr ? ` (${kept.reduce((a,b)=>a+b,0)}${modStr})` : ''}`, inline: true },
      );
    if (keepStr) embed.setFooter({ text: keepStr });
    await channel.send({ embeds: [embed] });
  }

  return { success: true, rolls, kept, modifier, total, notation };
}

async function toolGetWeather({ location, channel_id }, discordClient) {
  // Use wttr.in JSON API (no key needed)
  const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
  let data;
  try {
    const res = await axios.get(url, { headers: { 'User-Agent': 'SissyBot/1.0' }, timeout: 10000 });
    data = res.data;
  } catch (err) {
    return { error: `Could not fetch weather for "${location}": ${err.message}` };
  }

  const current = data.current_condition?.[0];
  const nearest = data.nearest_area?.[0];
  const today = data.weather?.[0];
  const tomorrow = data.weather?.[1];

  if (!current) return { error: 'No weather data returned' };

  const tempC = current.temp_C;
  const feelsC = current.FeelsLikeC;
  const desc = current.weatherDesc?.[0]?.value || 'Unknown';
  const humidity = current.humidity;
  const windKmph = current.windspeedKmph;
  const cityName = nearest?.areaName?.[0]?.value || location;
  const countryName = nearest?.country?.[0]?.value || '';

  const todayMax = today?.maxtempC;
  const todayMin = today?.mintempC;
  const tomorrowMax = tomorrow?.maxtempC;
  const tomorrowMin = tomorrow?.mintempC;
  const tomorrowDesc = tomorrow?.hourly?.[4]?.weatherDesc?.[0]?.value || '';

  const weatherEmoji = desc.toLowerCase().includes('sun') || desc.toLowerCase().includes('clear') ? '☀️'
    : desc.toLowerCase().includes('cloud') ? '☁️'
    : desc.toLowerCase().includes('rain') ? '🌧️'
    : desc.toLowerCase().includes('snow') ? '❄️'
    : desc.toLowerCase().includes('thunder') ? '⛈️'
    : desc.toLowerCase().includes('fog') ? '🌫️'
    : '🌡️';

  const channel = await discordClient.channels.fetch(channel_id);
  if (channel?.isTextBased()) {
    const embed = new EmbedBuilder()
      .setColor('#87CEEB')
      .setTitle(`${weatherEmoji} Weather in ${cityName}${countryName ? ', ' + countryName : ''}`)
      .addFields(
        { name: 'Now', value: `${tempC}°C (feels ${feelsC}°C)\n${desc}`, inline: true },
        { name: 'Today', value: `↑ ${todayMax}°C  ↓ ${todayMin}°C`, inline: true },
        { name: 'Humidity / Wind', value: `${humidity}%  /  ${windKmph} km/h`, inline: true },
      );
    if (tomorrow) {
      embed.addFields({ name: 'Tomorrow', value: `↑ ${tomorrowMax}°C  ↓ ${tomorrowMin}°C  ${tomorrowDesc}`, inline: false });
    }
    embed.setFooter({ text: 'Source: wttr.in' });
    await channel.send({ embeds: [embed] });
  }

  return { success: true, location: cityName, temp_C: tempC, description: desc };
}

// ─── Filesystem tools ─────────────────────────────────────────────────────────

async function toolFsWrite({ file_path, content, user_id }) {
  try {
    const target = safeUserPath(user_id, file_path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    const size = Buffer.byteLength(content, 'utf8');
    return { success: true, file_path, size_bytes: size };
  } catch (e) {
    return { error: e.message };
  }
}

async function toolFsRead({ file_path, user_id }) {
  try {
    const target = safeUserPath(user_id, file_path);
    if (!fs.existsSync(target)) return { error: `File not found: ${file_path}` };
    const stat = fs.statSync(target);
    if (stat.isDirectory()) return { error: `${file_path} is a directory, not a file` };
    const content = fs.readFileSync(target, 'utf8');
    return { file_path, content: content.slice(0, 20000), truncated: content.length > 20000, size_bytes: stat.size };
  } catch (e) {
    return { error: e.message };
  }
}

async function toolFsList({ directory = '', user_id }) {
  try {
    const base = getUserDir(user_id);
    const target = directory ? safeUserPath(user_id, directory) : base;
    if (!fs.existsSync(target)) return { error: `Directory not found: ${directory || '/'}` };
    const entries = fs.readdirSync(target, { withFileTypes: true });
    const items = entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
      size_bytes: e.isFile() ? fs.statSync(path.join(target, e.name)).size : undefined,
    }));
    return { directory: directory || '/', items };
  } catch (e) {
    return { error: e.message };
  }
}

async function toolFsDelete({ file_path, user_id }) {
  try {
    const target = safeUserPath(user_id, file_path);
    if (!fs.existsSync(target)) return { error: `File not found: ${file_path}` };
    const stat = fs.statSync(target);
    if (stat.isDirectory()) return { error: 'Cannot delete directories, only files' };
    fs.unlinkSync(target);
    return { success: true, deleted: file_path };
  } catch (e) {
    return { error: e.message };
  }
}

async function toolFsUpload({ file_path, user_id, channel_id, dm_user_id, caption }, discordClient) {
  if (!channel_id && !dm_user_id) return { error: 'Provide channel_id or dm_user_id' };
  try {
    const target = safeUserPath(user_id, file_path);
    if (!fs.existsSync(target)) return { error: `File not found: ${file_path}` };
    const attachment = new AttachmentBuilder(target, { name: path.basename(file_path) });
    const payload = { files: [attachment], content: caption || undefined };

    if (channel_id) {
      const channel = await discordClient.channels.fetch(channel_id);
      if (!channel?.isTextBased()) return { error: 'Channel not found or not text-based' };
      await channel.send(payload);
    }
    if (dm_user_id) {
      const user = await discordClient.users.fetch(dm_user_id);
      await user.send(payload);
    }
    return { success: true, file_path, sent_to_channel: !!channel_id, sent_to_dm: !!dm_user_id };
  } catch (e) {
    return { error: e.message };
  }
}

// ─── Python execution ─────────────────────────────────────────────────────────

async function toolPythonRun({ code, file_name = 'script.py', user_id }) {
  try {
    const scriptPath = safeUserPath(user_id, file_name);
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, code, 'utf8');

    const userDir = getUserDir(user_id);
    const result = await execFileAsync('python3', [scriptPath], {
      timeout: 30000,
      maxBuffer: 1024 * 512,
      cwd: userDir,
      env: {
        ...process.env,
        MPLBACKEND: 'Agg',
        MPLCONFIGDIR: userDir,
      },
    }).catch(err => ({
      stdout: err.stdout || '',
      stderr: err.stderr || err.message,
      exitCode: err.code ?? 1,
    }));

    const stdout = (result.stdout || '').slice(0, 8000);
    const stderr = (result.stderr || '').slice(0, 4000);
    const exitCode = result.exitCode ?? 0;

    return { success: exitCode === 0, file_name, exit_code: exitCode, stdout, stderr };
  } catch (e) {
    return { error: e.message };
  }
}

// ─── pip install ─────────────────────────────────────────────────────────────

async function toolPipInstall({ packages }) {
  if (!packages || packages.length === 0) return { error: 'No packages specified' };
  const safe = packages.map(p => p.replace(/[^a-zA-Z0-9._\-\[\]]/g, ''));
  try {
    const result = await execFileAsync('pip3', ['install', '--break-system-packages', ...safe], {
      timeout: 120000,
      maxBuffer: 1024 * 512,
    }).catch(err => ({
      stdout: err.stdout || '',
      stderr: err.stderr || err.message,
      exitCode: err.code ?? 1,
    }));
    const exitCode = result.exitCode ?? 0;
    const stdout = (result.stdout || '').slice(0, 4000);
    const stderr = (result.stderr || '').slice(0, 2000);
    return { success: exitCode === 0, packages: safe, exit_code: exitCode, stdout, stderr };
  } catch (e) {
    return { error: e.message };
  }
}

// ─── Vision / OCR ────────────────────────────────────────────────────────────

async function toolReadImages({ image_urls, prompt = 'Extract all text, numbers, and structured data visible in this image.' }) {
  if (!image_urls || image_urls.length === 0) return { error: 'No image URLs provided' };

  const results = [];
  for (const url of image_urls.slice(0, 10)) {
    try {
      const content = [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url } },
      ];
      const res = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: 'google/gemini-2.5-flash',
          messages: [{ role: 'user', content }],
          max_tokens: 1024,
        },
        { headers: _OR_HEADERS, timeout: 30000 }
      );
      const text = res.data.choices[0].message.content.trim();
      results.push({ url, extracted: text });
    } catch (e) {
      const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message;
      results.push({ url, error: detail });
    }
  }
  return { results };
}
