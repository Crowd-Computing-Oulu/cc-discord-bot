import { Client, GatewayIntentBits, Events, SlashCommandBuilder, Partials, ChannelType} from 'discord.js';
import { readFileSync, writeFileSync } from 'fs';
import schedule from 'node-schedule';
import moment from 'moment-timezone';
import { REST, Routes } from 'discord.js';
import db from './database.js';
const { User, Reminder, initialize } = db;
import { Sequelize, DataTypes, Op } from 'sequelize';
import chatgpt from './chatgpt.js';

const CONFIG = JSON.parse(readFileSync('./config.json', 'utf8'));

db.initialize();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    'CHANNEL'
  ]
});

const TOKEN = CONFIG['discord-apikey'];
const CLIENT_ID = CONFIG['discord-clientid'];

console.log(`Starting Sissy Bot`);


// REGISTERING SLASH COMMANDS

const cmds = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription("Pong!"),
  new SlashCommandBuilder()
    .setName('say')
    .setDescription("Say something to Sissy and process chat history. (GPT 4.0)")
    .addStringOption(option =>
      option.setName('message')
        .setDescription('What do you want to tell Sissy?')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('chathistlimit')
        .setDescription('How many past messages should Sissy read? (0-100) Default: 10')),
  new SlashCommandBuilder()
    .setName('remind')
    .setDescription("Ask Sissy to remind you about something at a certain time.")
    .addStringOption(option =>
      option.setName('name')
        .setDescription('What you want to be reminded about')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('month')
        .setDescription('Month of the reminder as number (1-12)')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('day')
        .setDescription('Day of the reminder as number (1-31)')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('hour')
        .setDescription('Hour of the reminder as number (0-23). Default: 8 EET'))
    .addIntegerOption(option =>
      option.setName('minute')
        .setDescription('Minute of the reminder as number (0-59). Default: 0')
    )
    .addUserOption(option =>
      option.setName('user')
        .setDescription('Who the reminder should be sent to')
    ),
  new SlashCommandBuilder()
    .setName('timer')
    .setDescription("Ask Sissy to remind you about something after some time has lapsed")
    .addStringOption(option =>
      option.setName('name')
        .setDescription('What you want to be reminded about')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('days')
        .setDescription('Days'))
    .addIntegerOption(option =>
      option.setName('hours')
        .setDescription('Hours')
    )
    .addIntegerOption(option =>
      option.setName('minutes')
        .setDescription('Minutes')
    )
    .addIntegerOption(option =>
      option.setName('seconds')
        .setDescription('Seconds')
    )
    .addUserOption(option =>
      option.setName('user')
        .setDescription('Who the reminder should be sent to')
    ),
]

const rest = new REST({ version: '10' }).setToken(TOKEN);

try {
  console.log('Started refreshing application (/) commands.');

  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: cmds });

  console.log('Successfully reloaded application (/) commands.');
} catch (error) {
  console.error(error);
}

// BOT BEHAVIOUR 
client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

// Check for due reminders every second
setInterval(async () => {
  const now = new Date();
  const dueReminders = await Reminder.findAll({ where: { remindAt: { [Op.lte]: now } } });

  for (const reminder of dueReminders) {
    const user = await client.users.fetch(reminder.userId);
    if (user) {
      await user.send(`🔔 **Reminder**: ${reminder.title}`);
      await reminder.destroy();
    }
  }
}, 1000);

client.on('messageCreate', async message => {
  if (message.channel.type == ChannelType.DM && message.author.id != CLIENT_ID && ['szabodanika', 'simohosio', 'aq4065', 'jhlxy', 'mahmoud.ali', 'saba1227', 'bishwaswagle_73999', 'mail2shanaka_40323', 'mrsadeghi'].includes(message.author.username) ) {
    try {
      const initialReply = await message.author.send('...');
      const chatHistoryLimit = 10;
      const messages = await message.channel.messages.fetch({ limit: chatHistoryLimit });

      const pastMessages = messages.map(msg => ({
        name: msg.author.username,
        message: msg.cleanContent
      })).reverse();

      if (pastMessages.length > 0) {
        pastMessages.pop(); 
      }

      const response = await chatgpt.privateRespondTo(pastMessages, message.cleanContent);
      await initialReply.edit(response);
    } catch (error) {
      console.error('Error processing request:', error);
      await message.reply('Sorry, there was an error processing your request.');
    }
  }
  

  if (message.cleanContent.includes("@Sissy")) {
    try {
      const initialReply = await message.reply('...');
      const chatHistoryLimit = 5;
      const messages = await message.channel.messages.fetch({ limit: chatHistoryLimit });

      const pastMessages = messages.map(msg => ({
        name: msg.author.username,
        message: msg.cleanContent
      })).reverse();

      if (pastMessages.length > 0) {
        pastMessages.pop(); 
      }

      const response = await chatgpt.respondTo(pastMessages, message.cleanContent);
      await initialReply.edit(response);
    } catch (error) {
      console.error('Error processing request:', error);
      await message.reply('Sorry, there was an error processing your request.');
    }
  }
});

client.on('message', async message => {
  console.log(message);
  if (message.channel.type == "dm") {
      try {
        const initialReply = await message.reply('...');
        const chatHistoryLimit = 5;
        const messages = await message.channel.messages.fetch({ limit: chatHistoryLimit });
  
        const pastMessages = messages.map(msg => ({
          name: msg.author.username,
          message: msg.cleanContent
        })).reverse();
  
        if (pastMessages.length > 0) {
          pastMessages.pop(); 
        }
  
        const response = await chatgpt.respondTo(pastMessages, message.cleanContent);
        await initialReply.edit(response);
      } catch (error) {
        console.error('Error processing request:', error);
        await message.reply('Sorry, there was an error processing your request.');
      }
  }
});  

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply('Pong!');
  }

  if (interaction.commandName === 'say') {
    const input = interaction.options.getString('message');
    const chatHistoryLimit = interaction.options.getInteger('chathistlimit');
    
    var pastMessages = await interaction.channel.messages.fetch({ limit: chatHistoryLimit });
    var pastMessages = pastMessages.map(msg => ({
      name: msg.author.username,
      message: msg.cleanContent
    }));


    try {
      await interaction.deferReply({ ephemeral: false })
      const response = await chatgpt.respondTo(pastMessages, input);
      await interaction.editReply({ content: response })
    } catch (error) {
      console.error('Error fetching response from OpenAI:', error);
      await interaction.reply('Sorry, there was an error processing your request.');
    }
  }

  if (interaction.commandName === 'remind') {
    const user = interaction.options.getUser('user') ?? interaction.user;
    const name = interaction.options.getString('name');
    const month = interaction.options.getInteger('month');
    const day = interaction.options.getInteger('day');
    const hour = interaction.options.getInteger('hour') ?? 8; // Default to 8 EET
    const minute = interaction.options.getInteger('minute') ?? 0; // Default to 0

    var remindAt = moment.tz({ month: month - 1, day, hour, minute }, 'Europe/Helsinki').toDate();

    if (remindAt <= new Date()) {
      remindAt = moment.tz({month: month - 1, day, hour, minute }, 'Europe/Helsinki').add(1, 'years').toDate();
    }

    await Reminder.create({ userId: user.id, title: name, remindAt });

    await interaction.reply(`🔔 Reminder set for **@${user.displayName}**: **"${name}"** at **${remindAt}**`);
  }

  if (interaction.commandName === 'timer') {
    const user = interaction.options.getUser('user') ?? interaction.user;
    const name = interaction.options.getString('name') ?? "timer";
    const days = interaction.options.getInteger('days') ?? 0;
    const hours = interaction.options.getInteger('hours') ?? 0;
    const minutes = interaction.options.getInteger('minutes') ?? 0;
    const seconds = interaction.options.getInteger('seconds') ?? 0;

    const remindAt = moment().add(days, 'days').add(hours, 'hours').add(minutes, 'minutes').add(seconds, 'seconds').toDate();

    await Reminder.create({ userId: user.id, title: name, remindAt });

    await interaction.reply(`⏰ Timer set for **@${user.displayName}**: **"${name}"** at **${remindAt}**`);
  }
});

client.once(Events.ClientReady, readyClient => {
	console.log(`Ready! Logged in as ${readyClient.user.tag}`);
});

client.login(TOKEN);
  