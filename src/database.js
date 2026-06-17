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

// Persistent key-value memory the bot can read and write autonomously
const BotMemory = sequelize.define('BotMemory', {
  key: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
  value: { type: DataTypes.TEXT, allowNull: false },
  category: { type: DataTypes.STRING, allowNull: true },  // e.g. "people", "projects", "facts", "preferences"
  updatedAt: { type: DataTypes.DATE, allowNull: false },
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
});

// Persisted conversation turns — used to survive restarts and feed daily compaction
const ConversationLog = sequelize.define('ConversationLog', {
  channelId: { type: DataTypes.STRING, allowNull: false },
  role: { type: DataTypes.STRING, allowNull: false },       // 'user' | 'assistant'
  content: { type: DataTypes.TEXT, allowNull: false },
  createdAt: { type: DataTypes.DATE, allowNull: false },
}, {
  indexes: [{ fields: ['channelId', 'createdAt'] }],
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
  ConversationLog,
  GeneratedImage,
  InboundEmail,
  initialize,
  Op,
};
