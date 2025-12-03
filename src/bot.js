require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('Error: TELEGRAM_BOT_TOKEN is not set in .env file');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

console.log('Bot is running with long polling...');

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Hello! I am your test bot. Send me any message and I will echo it back.\n\nCommands:\n/start - Start the bot\n/help - Show help');
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Available commands:\n/start - Start the bot\n/help - Show this help message\n\nOr just send me any text and I will echo it back!');
});

bot.on('message', (msg) => {
  if (msg.text && !msg.text.startsWith('/')) {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, `You said: ${msg.text}`);
  }
});

bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});
