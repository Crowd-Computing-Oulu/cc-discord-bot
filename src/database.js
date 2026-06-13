import { Sequelize, DataTypes, Op } from 'sequelize';

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: 'database.sqlite',
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
  initialize,
  Op,
};
