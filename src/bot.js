import { Client, GatewayIntentBits, Events, SlashCommandBuilder, Partials, ChannelType } from 'discord.js';
import moment from 'moment-timezone';
import { REST, Routes } from 'discord.js';
import db from './database.js';
import { respondTo, respondToDM, shouldRespondWithGranite, scheduleNightlyCompaction } from './ai.js';
import express from 'express';

const { Reminder, RepeatReminder, ScheduledTask, ChannelSummary, BotMemory, initialize, Op } = db;

const TOKEN = process.env.DISCORD_APIKEY;
const CLIENT_ID = process.env.DISCORD_CLIENTID;

const DM_WHITELIST = [
  'szabodanika', 'simohosio', 'aq4065', 
  'mahmoud.ali', 
];

// ─── Paper link detection ─────────────────────────────────────────────────────

// Regexes that identify academic paper references in a message
const PAPER_PATTERNS = [
  // arXiv URLs and bare IDs
  { re: /https?:\/\/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)/gi, type: 'arxiv_url' },
  { re: /\barxiv[:\s]+(\d{4}\.\d{4,5}(?:v\d+)?)\b/gi, type: 'arxiv_id' },
  // DOI URLs and bare DOIs
  { re: /https?:\/\/doi\.org\/(10\.\d{4,}\/\S+)/gi, type: 'doi_url' },
  { re: /\bdoi[:\s]+(10\.\d{4,}\/\S+)/gi, type: 'doi' },
  // Semantic Scholar paper URLs
  { re: /https?:\/\/(?:www\.)?semanticscholar\.org\/paper\/[^\s)>]+/gi, type: 'semantic_scholar' },
  // ACM DL, IEEE Xplore, Springer, Nature, PLOS
  { re: /https?:\/\/dl\.acm\.org\/doi\/[^\s)>]+/gi, type: 'acm' },
  { re: /https?:\/\/ieeexplore\.ieee\.org\/document\/\d+[^\s)>]*/gi, type: 'ieee' },
  { re: /https?:\/\/link\.springer\.com\/(?:article|chapter)\/[^\s)>]+/gi, type: 'springer' },
  { re: /https?:\/\/www\.nature\.com\/articles\/[^\s)>]+/gi, type: 'nature' },
];

// Returns the first paper identifier found in a message, or null
function extractPaperIdentifier(content) {
  for (const { re } of PAPER_PATTERNS) {
    re.lastIndex = 0;
    const match = re.exec(content);
    if (match) return match[1] || match[0]; // captured group (ID) or full URL
  }
  return null;
}

const CONVERSATIONAL_DEPTH = 4;

// ─── Discord client ───────────────────────────────────────────────────────────
await initialize();
scheduleNightlyCompaction();
console.log('Starting Sissy Bot (OpenRouter / Qwen3)');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ─── Slash command registration ───────────────────────────────────────────────
const cmds = [
  new SlashCommandBuilder().setName('ping').setDescription('Pong!'),

  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Send a message to Sissy with optional chat history context.')
    .addStringOption(o => o.setName('message').setDescription('What to say').setRequired(true))
    .addIntegerOption(o => o.setName('chathistlimit').setDescription('Past messages to include (0-50, default 20)')),

  new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Set a one-time reminder.')
    .addStringOption(o => o.setName('name').setDescription('What to be reminded about').setRequired(true))
    .addIntegerOption(o => o.setName('month').setDescription('Month (1-12)').setRequired(true))
    .addIntegerOption(o => o.setName('day').setDescription('Day (1-31)').setRequired(true))
    .addIntegerOption(o => o.setName('hour').setDescription('Hour (0-23, default 8 EET)'))
    .addIntegerOption(o => o.setName('minute').setDescription('Minute (0-59, default 0)'))
    .addUserOption(o => o.setName('user').setDescription('Who to remind')),

  new SlashCommandBuilder()
    .setName('timer')
    .setDescription('Set a reminder after a duration.')
    .addStringOption(o => o.setName('name').setDescription('What to be reminded about').setRequired(true))
    .addIntegerOption(o => o.setName('days').setDescription('Days'))
    .addIntegerOption(o => o.setName('hours').setDescription('Hours'))
    .addIntegerOption(o => o.setName('minutes').setDescription('Minutes'))
    .addIntegerOption(o => o.setName('seconds').setDescription('Seconds'))
    .addUserOption(o => o.setName('user').setDescription('Who to remind')),

  new SlashCommandBuilder()
    .setName('summarise')
    .setDescription('Ask Sissy to summarise and store this channel\'s history for long-term memory.')
    .addIntegerOption(o => o.setName('limit').setDescription('Number of messages to summarise (default 100)')),

  new SlashCommandBuilder()
    .setName('list')
    .setDescription('List DB entries of a given type.')
    .addStringOption(o =>
      o.setName('type')
        .setDescription('What to list')
        .setRequired(true)
        .addChoices(
          { name: 'reminders', value: 'reminders' },
          { name: 'repeat-reminders', value: 'repeat' },
          { name: 'scheduled-tasks', value: 'tasks' },
          { name: 'memory', value: 'memory' },
          { name: 'channel-summaries', value: 'summaries' },
        ))
    .addStringOption(o => o.setName('filter').setDescription('Optional filter string (name/key/category contains)')),

  new SlashCommandBuilder()
    .setName('delete')
    .setDescription('Delete a DB entry by type and ID.')
    .addStringOption(o =>
      o.setName('type')
        .setDescription('Type of entry')
        .setRequired(true)
        .addChoices(
          { name: 'reminder', value: 'reminder' },
          { name: 'repeat-reminder', value: 'repeat' },
          { name: 'scheduled-task', value: 'task' },
          { name: 'memory', value: 'memory' },
          { name: 'channel-summary', value: 'summary' },
        ))
    .addStringOption(o => o.setName('id').setDescription('ID (or memory key / channelId for those types)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('memory')
    .setDescription('Read or write a bot memory key.')
    .addStringOption(o =>
      o.setName('action')
        .setDescription('What to do')
        .setRequired(true)
        .addChoices(
          { name: 'get', value: 'get' },
          { name: 'set', value: 'set' },
          { name: 'delete', value: 'delete' },
        ))
    .addStringOption(o => o.setName('key').setDescription('Memory key').setRequired(true))
    .addStringOption(o => o.setName('value').setDescription('New value (for set)'))
    .addStringOption(o => o.setName('category').setDescription('Category (for set)')),
];

const rest = new REST({ version: '10' }).setToken(TOKEN);
try {
  console.log('Registering slash commands...');
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: cmds });
  console.log('Slash commands registered.');
} catch (err) {
  console.error('Failed to register commands:', err);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Split a long response into ≤2000-char chunks for Discord
function splitMessage(text) {
  if (text.length <= 2000) return [text];
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + 1990));
    i += 1990;
  }
  return chunks;
}

// Extract image URLs and non-image file attachments from a Discord message
function parseAttachments(message) {
  const imageUrls = [];
  const files = [];
  for (const att of message.attachments.values()) {
    const ext = att.name?.split('.').pop()?.toLowerCase() || '';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
      imageUrls.push(att.url);
    } else {
      files.push({ url: att.url, name: att.name });
    }
  }
  return { imageUrls, files };
}

// Fetch recent messages and return formatted + count of bot's recent messages
async function fetchPastMessages(channel, limit = 20) {
  const raw = await channel.messages.fetch({ limit });
  const msgs = [...raw.values()].reverse();
  const recentBotMsgCount = msgs.filter(m => m.author.id === CLIENT_ID).length;
  // Exclude bot's own messages — those are already in the conversation context (ctx)
  // and including them here causes the model to re-execute prior tool actions
  const formatted = msgs
    .filter(m => m.author.id !== CLIENT_ID)
    .map(m => ({ name: m.author.username, message: m.cleanContent }));
  return { pastMessages: formatted, recentBotMsgCount };
}

// ─── Background task runner ───────────────────────────────────────────────────

// Post to channel first (with @mention); DM as fallback if no channel is set
async function deliverReminder(client, userId, title, pingUserId, channelId, label = '🔔 Reminder') {
  const mention = pingUserId ? `<@${pingUserId}>` : `<@${userId}>`;
  const channelText = label ? `${label}: ${mention} **${title}**` : `${mention} **${title}**`;
  const dmText = label ? `${label}: **${title}**` : `**${title}**`;

  if (channelId) {
    try {
      const ch = await client.channels.fetch(channelId);
      if (ch?.isTextBased()) {
        await ch.send(channelText);
        return;
      }
    } catch (_) {}
  }

  // Fall back to DM if no channel or channel fetch failed
  try {
    const user = await client.users.fetch(userId);
    await user.send(dmText);
  } catch (_) {
    console.error(`Could not deliver reminder "${title}" to user ${userId} — no DM and no channel`);
  }
}

setInterval(async () => {
  const now = new Date();

  // One-shot reminders
  const dueReminders = await Reminder.findAll({ where: { remindAt: { [Op.lte]: now } } });
  for (const r of dueReminders) {
    try {
      await deliverReminder(client, r.userId, r.title, r.pingUserId, r.channelId, '🔔 Reminder');
      await r.destroy();
    } catch (e) {
      console.error('Reminder delivery failed:', e.message);
      await r.destroy();
    }
  }

  // Repeating reminders
  const dueRepeat = await RepeatReminder.findAll({ where: { nextRunAt: { [Op.lte]: now } } });
  for (const r of dueRepeat) {
    try {
      await deliverReminder(client, r.userId, r.title, r.pingUserId, r.channelId, '');
      const next = computeNextRun(r.cronExpr, now);
      await r.update({ lastSentAt: now, nextRunAt: next });
    } catch (e) { console.error('Repeating reminder delivery failed:', e.message); }
  }

  // Scheduled AI tasks
  const dueTasks = await ScheduledTask.findAll({ where: { runAt: { [Op.lte]: now } } });
  for (const task of dueTasks) {
    try {
      const channel = await client.channels.fetch(task.channelId);
      if (channel?.isTextBased()) {
        const response = await respondTo({
          channelId: task.channelId,
          userId: task.userId,
          input: task.prompt,
          discordClient: client,
        });
        if (response) {
          const chunks = splitMessage(`⏰ **Scheduled task**: ${response}`);
          for (const c of chunks) await channel.send(c);
        }
      }
      await task.destroy();
    } catch (e) { console.error('Scheduled task failed:', e.message); }
  }
}, 5000);

// Simple next-run computation for repeating reminders
function computeNextRun(cronExpr, after) {
  const now = moment(after);
  const parts = cronExpr.split(/\s+/);
  if (parts.length !== 5) return moment(after).add(1, 'day').toDate();
  const [min, hour, dom, month, dow] = parts;
  const candidate = now.clone().second(0).millisecond(0);
  if (min !== '*') candidate.minute(parseInt(min));
  if (hour !== '*') candidate.hour(parseInt(hour));

  if (candidate.isSameOrBefore(now)) {
    if (dom !== '*') candidate.add(1, 'month');
    else if (dow !== '*') candidate.add(1, 'week');
    else if (hour !== '*') candidate.add(1, 'day');
    else if (min !== '*') candidate.add(1, 'hour');
    else candidate.add(1, 'minute'); // fully wildcard cron — advance by 1 min as safe fallback
  }
  return candidate.toDate();
}

// ─── Message handler ──────────────────────────────────────────────────────────

client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const isDM = message.channel.type === ChannelType.DM;

  // ── DM handling ──
  if (isDM) {
    if (!DM_WHITELIST.includes(message.author.username)) return;
    try {
      await message.channel.sendTyping();
      const typingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
      const { imageUrls, files } = parseAttachments(message);
      let response;
      try {
        response = await respondToDM({
          userId: message.author.id,
          username: message.author.username,
          input: message.cleanContent,
          imageUrls,
          attachments: files,
          discordClient: client,
        });
      } finally {
        clearInterval(typingInterval);
      }
      if (!response) return;
      const chunks = splitMessage(response);
      for (const chunk of chunks) await message.author.send(chunk);
    } catch (e) {
      console.error('DM error:', e.message);
    }
    return;
  }

  // ── Channel handling ──
  const directMention = message.mentions.users.has(CLIENT_ID) ||
    message.cleanContent.toLowerCase().includes('@sissy');

  const isReplyToBot = message.reference?.messageId
    ? await message.channel.messages.fetch(message.reference.messageId)
        .then(ref => ref.author.id === client.user.id)
        .catch(() => false)
    : false;

  // ── Paper link auto-detection (runs independently of mention/heuristic) ──
  const paperIdentifier = extractPaperIdentifier(message.cleanContent);
  if (paperIdentifier && !directMention) {
    try {
      await message.channel.sendTyping();
      const typingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
      const { pastMessages } = await fetchPastMessages(message.channel, 10);
      const history = pastMessages.slice(0, -1);
      let response;
      try {
        response = await respondTo({
          channelId: message.channelId,
          userId: message.author.id,
          input: `A paper was just shared in the conversation: "${paperIdentifier}". Use the lookup_paper tool to fetch its metadata, then reply with: the title, authors, where/when it was published, a 2-3 sentence summary of what it's about, and a sentence on how it might be relevant to what we've been discussing. Be concise and natural — don't list headings, just flow it as a short paragraph.`,
          pastMessages: history,
          discordClient: client,
        });
      } finally {
        clearInterval(typingInterval);
      }
      if (response) {
        const chunks = splitMessage(response);
        await message.reply(chunks[0]);
        for (const chunk of chunks.slice(1)) await message.channel.send(chunk);
      }
    } catch (e) {
      console.error('Paper lookup error:', e.message);
    }
    return;
  }

  if (!directMention && !isReplyToBot) {
    let recentMsgs = [];
    try {
      const recent = await message.channel.messages.fetch({ limit: CONVERSATIONAL_DEPTH + 1 });
      const sorted = [...recent.values()].reverse();
      recentMsgs = sorted.map(m => ({ name: m.author.username, message: m.cleanContent }));
    } catch (_) {}

    try {
      const shouldReply = await shouldRespondWithGranite(recentMsgs, message.cleanContent);
      if (!shouldReply) return;
    } catch (e) {
      console.error('Granite turn-taking error:', e.message);
    }
  }

  try {
    await message.channel.sendTyping();
    const typingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);

    let response;
    try {
      const histLimit = directMention ? 30 : 15;
      const { pastMessages } = await fetchPastMessages(message.channel, histLimit);
      const history = pastMessages.slice(0, -1);
      const { imageUrls, files } = parseAttachments(message);

      response = await respondTo({
        channelId: message.channelId,
        userId: message.author.id,
        username: message.author.username,
        input: message.cleanContent,
        pastMessages: history,
        imageUrls,
        attachments: files,
        discordClient: client,
      });
    } finally {
      clearInterval(typingInterval);
    }

    if (!response) return;

    const chunks = splitMessage(response);
    await message.reply(chunks[0]);
    for (const chunk of chunks.slice(1)) await message.channel.send(chunk);
  } catch (e) {
    console.error('Channel message error:', e.message, e.response?.data ?? '');
    if (directMention) await message.reply('Sorry, I ran into an error processing that.');
  }
});

// ─── Slash command handler ────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply('Pong!');
    return;
  }

  if (interaction.commandName === 'say') {
    const input = interaction.options.getString('message');
    const histLimit = Math.min(interaction.options.getInteger('chathistlimit') ?? 20, 50);
    await interaction.deferReply();
    try {
      const raw = await interaction.channel.messages.fetch({ limit: histLimit });
      const pastMessages = [...raw.values()].reverse().map(m => ({ name: m.author.username, message: m.cleanContent }));

      const response = await respondTo({
        channelId: interaction.channelId,
        userId: interaction.user.id,
        username: interaction.user.username,
        input,
        pastMessages,
        discordClient: client,
      });
      const chunks = splitMessage(response || '(no response)');
      await interaction.editReply(chunks[0]);
      for (const chunk of chunks.slice(1)) await interaction.channel.send(chunk);
    } catch (e) {
      console.error('/say error:', e.message);
      await interaction.editReply('Sorry, there was an error processing your request.');
    }
    return;
  }

  if (interaction.commandName === 'remind') {
    const user = interaction.options.getUser('user') ?? interaction.user;
    const name = interaction.options.getString('name');
    const month = interaction.options.getInteger('month');
    const day = interaction.options.getInteger('day');
    const hour = interaction.options.getInteger('hour') ?? 8;
    const minute = interaction.options.getInteger('minute') ?? 0;
    let remindAt = moment.tz({ month: month - 1, day, hour, minute }, 'Europe/Helsinki').toDate();
    if (remindAt <= new Date()) {
      remindAt = moment.tz({ month: month - 1, day, hour, minute }, 'Europe/Helsinki').add(1, 'years').toDate();
    }
    await Reminder.create({ userId: user.id, title: name, remindAt, channelId: interaction.channelId });
    await interaction.reply(`🔔 Reminder set for **${user.displayName}**: **"${name}"** at **${remindAt.toLocaleString('en-FI', { timeZone: 'Europe/Helsinki' })}**`);
    return;
  }

  if (interaction.commandName === 'timer') {
    const user = interaction.options.getUser('user') ?? interaction.user;
    const name = interaction.options.getString('name') ?? 'timer';
    const days = interaction.options.getInteger('days') ?? 0;
    const hours = interaction.options.getInteger('hours') ?? 0;
    const minutes = interaction.options.getInteger('minutes') ?? 0;
    const seconds = interaction.options.getInteger('seconds') ?? 0;
    const totalMs = ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
    if (totalMs <= 0) {
      await interaction.reply('Set at least one duration value (days/hours/minutes/seconds).');
      return;
    }
    const remindAt = new Date(Date.now() + totalMs * 1000);
    await Reminder.create({ userId: user.id, title: name, remindAt, channelId: interaction.channelId });
    const humanDuration = [
      days > 0 ? `${days}d` : '',
      hours > 0 ? `${hours}h` : '',
      minutes > 0 ? `${minutes}m` : '',
      seconds > 0 ? `${seconds}s` : '',
    ].filter(Boolean).join(' ');
    await interaction.reply(`⏰ Timer set for **${user.displayName}**: **"${name}"** — fires in **${humanDuration}** (${remindAt.toLocaleString('en-FI', { timeZone: 'Europe/Helsinki' })})`  );
    return;
  }

  if (interaction.commandName === 'list') {
    const type = interaction.options.getString('type');
    const filter = interaction.options.getString('filter')?.toLowerCase() ?? '';

    let rows, lines;

    if (type === 'reminders') {
      rows = await Reminder.findAll({ order: [['remindAt', 'ASC']] });
      lines = rows
        .filter(r => !filter || r.title.toLowerCase().includes(filter))
        .map(r => `\`${r.id}\` **${r.title}** — <@${r.userId}> at ${new Date(r.remindAt).toLocaleString('en-FI', { timeZone: 'Europe/Helsinki' })}`);
      if (!lines.length) { await interaction.reply('No reminders found.'); return; }
      await interaction.reply(`**Reminders (${lines.length}):**\n${lines.join('\n')}`.slice(0, 2000));
      return;
    }

    if (type === 'repeat') {
      rows = await RepeatReminder.findAll({ order: [['nextRunAt', 'ASC']] });
      lines = rows
        .filter(r => !filter || r.title.toLowerCase().includes(filter))
        .map(r => `\`${r.id}\` **${r.title}** — \`${r.cronExpr}\` next: ${new Date(r.nextRunAt).toLocaleString('en-FI', { timeZone: 'Europe/Helsinki' })}`);
      if (!lines.length) { await interaction.reply('No repeating reminders found.'); return; }
      await interaction.reply(`**Repeating Reminders (${lines.length}):**\n${lines.join('\n')}`.slice(0, 2000));
      return;
    }

    if (type === 'tasks') {
      rows = await ScheduledTask.findAll({ order: [['runAt', 'ASC']] });
      lines = rows
        .filter(r => !filter || r.prompt.toLowerCase().includes(filter))
        .map(r => `\`${r.id}\` at ${new Date(r.runAt).toLocaleString('en-FI', { timeZone: 'Europe/Helsinki' })}: ${r.prompt.slice(0, 80)}`);
      if (!lines.length) { await interaction.reply('No scheduled tasks found.'); return; }
      await interaction.reply(`**Scheduled Tasks (${lines.length}):**\n${lines.join('\n')}`.slice(0, 2000));
      return;
    }

    if (type === 'memory') {
      rows = await BotMemory.findAll({ order: [['key', 'ASC']] });
      lines = rows
        .filter(r => !filter || r.key.toLowerCase().includes(filter) || (r.category ?? '').toLowerCase().includes(filter))
        .map(r => `\`${r.key}\`${r.category ? ` [${r.category}]` : ''}: ${r.value.slice(0, 100)}`);
      if (!lines.length) { await interaction.reply('No memory entries found.'); return; }
      await interaction.reply(`**Bot Memory (${lines.length}):**\n${lines.join('\n')}`.slice(0, 2000));
      return;
    }

    if (type === 'summaries') {
      rows = await ChannelSummary.findAll({ order: [['updatedAt', 'DESC']] });
      lines = rows
        .filter(r => !filter || r.channelId.includes(filter))
        .map(r => `\`${r.channelId}\` (${r.messageCount} msgs, updated ${new Date(r.updatedAt).toLocaleString('en-FI', { timeZone: 'Europe/Helsinki' })}): ${r.summary.slice(0, 80)}`);
      if (!lines.length) { await interaction.reply('No channel summaries found.'); return; }
      await interaction.reply(`**Channel Summaries (${lines.length}):**\n${lines.join('\n')}`.slice(0, 2000));
      return;
    }
  }

  if (interaction.commandName === 'delete') {
    const type = interaction.options.getString('type');
    const id = interaction.options.getString('id');

    if (type === 'reminder') {
      const r = await Reminder.findByPk(id);
      if (!r) { await interaction.reply(`No reminder with ID \`${id}\`.`); return; }
      await r.destroy();
      await interaction.reply(`Deleted reminder \`${id}\`: **${r.title}**`);
      return;
    }

    if (type === 'repeat') {
      const r = await RepeatReminder.findByPk(id);
      if (!r) { await interaction.reply(`No repeating reminder with ID \`${id}\`.`); return; }
      await r.destroy();
      await interaction.reply(`Deleted repeating reminder \`${id}\`: **${r.title}**`);
      return;
    }

    if (type === 'task') {
      const r = await ScheduledTask.findByPk(id);
      if (!r) { await interaction.reply(`No scheduled task with ID \`${id}\`.`); return; }
      await r.destroy();
      await interaction.reply(`Deleted scheduled task \`${id}\`.`);
      return;
    }

    if (type === 'memory') {
      const r = await BotMemory.findByPk(id);
      if (!r) { await interaction.reply(`No memory entry with key \`${id}\`.`); return; }
      await r.destroy();
      await interaction.reply(`Deleted memory key \`${id}\`.`);
      return;
    }

    if (type === 'summary') {
      const r = await ChannelSummary.findByPk(id);
      if (!r) { await interaction.reply(`No channel summary with ID \`${id}\`.`); return; }
      await r.destroy();
      await interaction.reply(`Deleted channel summary for \`${id}\`.`);
      return;
    }
  }

  if (interaction.commandName === 'memory') {
    const action = interaction.options.getString('action');
    const key = interaction.options.getString('key');

    if (action === 'get') {
      const r = await BotMemory.findByPk(key);
      if (!r) { await interaction.reply(`No memory entry for key \`${key}\`.`); return; }
      await interaction.reply(`**\`${key}\`**${r.category ? ` [${r.category}]` : ''}\n${r.value}`.slice(0, 2000));
      return;
    }

    if (action === 'set') {
      const value = interaction.options.getString('value');
      const category = interaction.options.getString('category');
      if (!value) { await interaction.reply('Provide a `value` to set.'); return; }
      await BotMemory.upsert({ key, value, category: category ?? null, updatedAt: new Date() });
      await interaction.reply(`Memory key \`${key}\` updated.`);
      return;
    }

    if (action === 'delete') {
      const r = await BotMemory.findByPk(key);
      if (!r) { await interaction.reply(`No memory entry for key \`${key}\`.`); return; }
      await r.destroy();
      await interaction.reply(`Deleted memory key \`${key}\`.`);
      return;
    }
  }

  if (interaction.commandName === 'summarise') {
    const limit = Math.min(interaction.options.getInteger('limit') ?? 100, 200);
    await interaction.deferReply();
    try {
      const response = await respondTo({
        channelId: interaction.channelId,
        userId: interaction.user.id,
        input: `Please summarise the recent history of this channel (up to ${limit} messages) and store it using the summarise_and_store_history tool. Channel ID: ${interaction.channelId}`,
        discordClient: client,
      });
      await interaction.editReply(response?.slice(0, 2000) || 'Done!');
    } catch (e) {
      console.error('/summarise error:', e.message);
      await interaction.editReply('Sorry, could not summarise the channel.');
    }
    return;
  }
});

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, rc => {
  console.log(`Ready! Logged in as ${rc.user.tag}`);
});

client.login(TOKEN);

// ─── Inbound email webhook ────────────────────────────────────────────────────

const INBOUND_PORT = parseInt(process.env.INBOUND_EMAIL_PORT || '3001');
const INBOUND_NOTIFY_CHANNEL = process.env.INBOUND_EMAIL_CHANNEL_ID;

const app = express();
app.use(express.json());

app.post('/email/inbound', async (req, res) => {
  try {
    const { from, subject, text, html } = req.body;
    const fromAddress = (typeof from === 'string' ? from : from?.email) || 'unknown';
    const fromName = typeof from === 'object' ? (from?.name || null) : null;
    const body = text || html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';

    const email = await db.InboundEmail.create({
      fromAddress,
      fromName,
      subject: subject || '(no subject)',
      body,
      receivedAt: new Date(),
      read: false,
    });

    if (INBOUND_NOTIFY_CHANNEL) {
      try {
        const ch = await client.channels.fetch(INBOUND_NOTIFY_CHANNEL);
        if (ch?.isTextBased()) {
          const preview = body.slice(0, 200).replace(/\n/g, ' ');
          await ch.send(`📬 **New email** from **${fromName || fromAddress}**\n**Subject:** ${email.subject}\n> ${preview}${body.length > 200 ? '…' : ''}`);
        }
      } catch (_) {}
    }

    res.status(200).json({ ok: true, id: email.id });
  } catch (e) {
    console.error('Inbound email webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(INBOUND_PORT, () => {
  console.log(`Inbound email webhook listening on port ${INBOUND_PORT}`);
});
