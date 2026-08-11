import { Sequelize, DataTypes, Op } from 'sequelize';

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: process.env.DB_PATH || '/app/data/database.sqlite',
  logging: false
});

const User = sequelize.define('User', {
  userId: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false,
  }
});

const Reminder = sequelize.define('Reminder', {
  userId: { type: DataTypes.STRING, allowNull: false },
  title: { type: DataTypes.STRING, allowNull: false },
  remindAt: { type: DataTypes.DATE, allowNull: false },
  channelId: { type: DataTypes.STRING, allowNull: true },
  pingUserId: { type: DataTypes.STRING, allowNull: true },
});

const RepeatReminder = sequelize.define('RepeatReminder', {
  userId: { type: DataTypes.STRING, allowNull: false },
  title: { type: DataTypes.STRING, allowNull: false },
  cronExpr: { type: DataTypes.STRING, allowNull: false },
  channelId: { type: DataTypes.STRING, allowNull: true },
  pingUserId: { type: DataTypes.STRING, allowNull: true },
  lastSentAt: { type: DataTypes.DATE, allowNull: true },
  nextRunAt: { type: DataTypes.DATE, allowNull: false },
});

const ScheduledTask = sequelize.define('ScheduledTask', {
  prompt: { type: DataTypes.TEXT, allowNull: false },
  channelId: { type: DataTypes.STRING, allowNull: false },
  userId: { type: DataTypes.STRING, allowNull: false },
  runAt: { type: DataTypes.DATE, allowNull: false },
});

const ChannelSummary = sequelize.define('ChannelSummary', {
  channelId: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
  summary: { type: DataTypes.TEXT, allowNull: false },
  messageCount: { type: DataTypes.INTEGER, defaultValue: 0 },
  updatedAt: { type: DataTypes.DATE, allowNull: false },
});

// Persistent key-value memory the bot can read and write autonomously (global)
const BotMemory = sequelize.define('BotMemory', {
  key: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
  value: { type: DataTypes.TEXT, allowNull: false },
  category: { type: DataTypes.STRING, allowNull: true },  // e.g. "people", "projects", "facts", "preferences"
  updatedAt: { type: DataTypes.DATE, allowNull: false },
});

// Per-user memory facts extracted during daily compaction from that user's conversations
// Injected into any conversation involving that user (DMs or channels)
const UserMemory = sequelize.define('UserMemory', {
  userId: { type: DataTypes.STRING, allowNull: false },
  key: { type: DataTypes.STRING, allowNull: false },  // hierarchical: "projects/X", "preferences/coffee", etc.
  value: { type: DataTypes.TEXT, allowNull: false },
  category: { type: DataTypes.STRING, allowNull: true },
  updatedAt: { type: DataTypes.DATE, allowNull: false },
}, {
  indexes: [{ fields: ['userId'], unique: false }, { fields: ['userId', 'category'] }],
  primaryKey: false,
  uniqueKeys: { composite_key: { fields: ['userId', 'key'] } },
});

const GeneratedImage = sequelize.define('GeneratedImage', {
  filePath: { type: DataTypes.STRING, allowNull: false },
  prompt: { type: DataTypes.TEXT, allowNull: false },
  mimeType: { type: DataTypes.STRING, allowNull: false, defaultValue: 'image/png' },
  createdAt: { type: DataTypes.DATE, allowNull: false },
});

const InboundEmail = sequelize.define('InboundEmail', {
  fromAddress: { type: DataTypes.STRING, allowNull: false },
  fromName: { type: DataTypes.STRING, allowNull: true },
  subject: { type: DataTypes.STRING, allowNull: false },
  body: { type: DataTypes.TEXT, allowNull: false },
  receivedAt: { type: DataTypes.DATE, allowNull: false },
  read: { type: DataTypes.BOOLEAN, defaultValue: false },
  processed: { type: DataTypes.BOOLEAN, defaultValue: false },  // whether this email's facts were extracted to BotMemory
}, {
  indexes: [{ fields: ['receivedAt', 'processed'] }],
});

// Persisted conversation turns — used to survive restarts and feed daily compaction
const ConversationLog = sequelize.define('ConversationLog', {
  channelId: { type: DataTypes.STRING, allowNull: false },
  userId: { type: DataTypes.STRING, allowNull: true },  // who said this (null for Sissy's responses)
  role: { type: DataTypes.STRING, allowNull: false },       // 'user' | 'assistant'
  content: { type: DataTypes.TEXT, allowNull: false },
  createdAt: { type: DataTypes.DATE, allowNull: false },
}, {
  indexes: [{ fields: ['channelId', 'createdAt'] }, { fields: ['userId', 'createdAt'] }],
});

// A Discord user's consent grant from TeXposit (see app/integrations/ there).
// One row per Discord user; the token is the bearer credential TeXposit
// issued at consent time and can be revoked from TeXposit's Connected Apps
// page at any time, so every call to texposit.js re-checks it live rather
// than trusting this row to still be valid.
const TexpositLink = sequelize.define('TexpositLink', {
  userId: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
  token: { type: DataTypes.STRING, allowNull: false },
  scope: { type: DataTypes.STRING, allowNull: false }, // 'read' | 'read_write'
  connectedAt: { type: DataTypes.DATE, allowNull: false },
});

const initialize = async () => {
  await sequelize.sync({ alter: true });
};

export default {
  User,
  Reminder,
  RepeatReminder,
  ScheduledTask,
  ChannelSummary,
  BotMemory,
  UserMemory,
  ConversationLog,
  GeneratedImage,
  InboundEmail,
  TexpositLink,
  initialize,
  Op,
};
