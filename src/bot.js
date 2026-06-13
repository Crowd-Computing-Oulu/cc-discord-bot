import { Client, GatewayIntentBits, Events, SlashCommandBuilder, Partials, ChannelType } from 'discord.js';
import moment from 'moment-timezone';
import { REST, Routes } from 'discord.js';
import db from './database.js';
import { respondTo, respondToDM, shouldRespondWithGranite } from './ai.js';

const { Reminder, RepeatReminder, ScheduledTask, initialize, Op } = db;

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

// ─── Passive + proactive trigger heuristics ──────────────────────────────────

// High-confidence signals that Sissy is being addressed or a bot task is intended
const SISSY_TRIGGERS = [
  /\bsissy\b/i,
  /\bthe bot\b/i,
  /\bremind(er)?\b/i,
  /\bschedule\b/i,
  /\bsummar[iy]/i,
  /\b(can|could) (you|sissy)\b/i,
  /\bhelp (me|us)\b/i,
  /\blook (it )?up\b/i,
  /\bset (a |an )?(reminder|timer|alarm)\b/i,
  /\bask (sissy|the bot)\b/i,
];

// Patterns suggesting a funny/casual moment — Sissy occasionally joins in
const FUNNY_PATTERNS = [
  /😂|🤣|💀|😭|lmao|lol|haha|hehe/i,
  /😤|😅|🫠|😩/,
  /\bwait what\b/i,
  /\bno way\b/i,
  /💅|🙄|👀|🫡/,
];

// Welcome triggers — Sissy greets people introducing themselves
const WELCOME_PATTERNS = [
  /\bjoined the server\b/i,
  /\bnew (here|member|person)\b/i,
  /\bjust joined\b/i,
  /\bintroducing myself\b/i,
  /\bhello everyone\b/i,
];

const CONVERSATIONAL_DEPTH = 4;

// Fast pre-filter: cheap regex check before we spend a Granite call.
// Returns true if the message is obviously worth considering, false to skip entirely.
function quickPreFilter(message, recentBotMessages) {
  const content = message.cleanContent;
  if (message.mentions.users.has(CLIENT_ID)) return true;
  if (WELCOME_PATTERNS.some(r => r.test(content))) return true;
  if (FUNNY_PATTERNS.some(r => r.test(content))) return true;
  const triggerCount = SISSY_TRIGGERS.filter(r => r.test(content)).length;
  if (triggerCount >= 1) return true;
  if (recentBotMessages > 0) return true;
  return false;
}

// ─── Discord client ───────────────────────────────────────────────────────────
await initialize();
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
  const formatted = msgs.map(m => ({ name: m.author.username, message: m.cleanContent }));
  return { pastMessages: formatted, recentBotMsgCount };
}

// ─── Background task runner ───────────────────────────────────────────────────

setInterval(async () => {
  const now = new Date();

  // One-shot reminders
  const dueReminders = await Reminder.findAll({ where: { remindAt: { [Op.lte]: now } } });
  for (const r of dueReminders) {
    try {
      const user = await client.users.fetch(r.userId);
      let msg = `🔔 **Reminder**: ${r.title}`;
      if (r.pingUserId) msg += ` <@${r.pingUserId}>`;
      await user.send(msg);
      await r.destroy();
    } catch (e) { console.error('Reminder delivery failed:', e.message); }
  }

  // Repeating reminders
  const dueRepeat = await RepeatReminder.findAll({ where: { nextRunAt: { [Op.lte]: now } } });
  for (const r of dueRepeat) {
    try {
      const user = await client.users.fetch(r.userId);
      let msg = `🔔 **Repeating Reminder**: ${r.title}`;
      if (r.pingUserId) msg += ` <@${r.pingUserId}>`;
      await user.send(msg);
      // Compute next run
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
    else candidate.add(1, 'hour');
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
      const { imageUrls, files } = parseAttachments(message);
      const response = await respondToDM({
        userId: message.author.id,
        input: message.cleanContent,
        imageUrls,
        attachments: files,
        discordClient: client,
      });
      if (!response) return; // AI chose not to respond
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

  // ── Paper link auto-detection (runs independently of mention/heuristic) ──
  const paperIdentifier = extractPaperIdentifier(message.cleanContent);
  if (paperIdentifier && !directMention) {
    try {
      await message.channel.sendTyping();
      const { pastMessages } = await fetchPastMessages(message.channel, 10);
      const history = pastMessages.slice(0, -1);
      const response = await respondTo({
        channelId: message.channelId,
        userId: message.author.id,
        input: `A paper was just shared in the conversation: "${paperIdentifier}". Use the lookup_paper tool to fetch its metadata, then reply with: the title, authors, where/when it was published, a 2-3 sentence summary of what it's about, and a sentence on how it might be relevant to what we've been discussing. Be concise and natural — don't list headings, just flow it as a short paragraph.`,
        pastMessages: history,
        discordClient: client,
      });
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

  if (!directMention) {
    let recentBotCount = 0;
    let recentMsgs = [];
    try {
      const recent = await message.channel.messages.fetch({ limit: CONVERSATIONAL_DEPTH + 1 });
      const arr = [...recent.values()].reverse();
      recentBotCount = arr.filter(m => m.author.id === CLIENT_ID).length;
      recentMsgs = arr.map(m => ({ name: m.author.username, message: m.cleanContent }));
    } catch (_) {}

    // Stage 1: cheap regex pre-filter — skip Granite call if nothing looks relevant
    if (!quickPreFilter(message, recentBotCount)) return;

    // Stage 2: Granite decides with full conversational context
    try {
      const shouldReply = await shouldRespondWithGranite(recentMsgs, message.cleanContent);
      if (!shouldReply) return;
    } catch (e) {
      // If Granite fails, fall back to allowing the response
      console.error('Granite turn-taking error:', e.message);
    }
  }

  try {
    await message.channel.sendTyping();
    const histLimit = directMention ? 30 : 15;
    const { pastMessages } = await fetchPastMessages(message.channel, histLimit);

    // Remove the triggering message from history (it's passed as `input`)
    const history = pastMessages.slice(0, -1);

    const { imageUrls, files } = parseAttachments(message);

    const response = await respondTo({
      channelId: message.channelId,
      userId: message.author.id,
      input: message.cleanContent,
      pastMessages: history,
      imageUrls,
      attachments: files,
      discordClient: client,
    });

    if (!response) return; // AI decided not to respond this turn

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
    await Reminder.create({ userId: user.id, title: name, remindAt });
    await interaction.reply(`🔔 Reminder set for **@${user.displayName}**: **"${name}"** at **${remindAt.toLocaleString('en-FI', { timeZone: 'Europe/Helsinki' })}**`);
    return;
  }

  if (interaction.commandName === 'timer') {
    const user = interaction.options.getUser('user') ?? interaction.user;
    const name = interaction.options.getString('name') ?? 'timer';
    const days = interaction.options.getInteger('days') ?? 0;
    const hours = interaction.options.getInteger('hours') ?? 0;
    const minutes = interaction.options.getInteger('minutes') ?? 0;
    const seconds = interaction.options.getInteger('seconds') ?? 0;
    const remindAt = moment().add(days, 'days').add(hours, 'hours').add(minutes, 'minutes').add(seconds, 'seconds').toDate();
    await Reminder.create({ userId: user.id, title: name, remindAt });
    await interaction.reply(`⏰ Timer set for **@${user.displayName}**: **"${name}"** at **${remindAt.toLocaleString('en-FI', { timeZone: 'Europe/Helsinki' })}**`);
    return;
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
