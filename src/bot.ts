import TelegramBot from 'node-telegram-bot-api';
import { config, validateConfig } from './config';
import { generateWallet, encryptPrivateKey } from './services/wallet';
import { getUser, saveUser, userExists } from './services/database';
import { getBalance, getPositions, placeMarketOrder, getAvailableCoins } from './services/hyperliquid';

// Validate configuration
validateConfig();

const bot = new TelegramBot(config.telegramToken, { polling: true });

console.log(`Bot is running on ${config.isTestnet ? 'TESTNET' : 'MAINNET'}...`);

// /start command - Create wallet if new user
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from?.id;

  if (!telegramId) {
    bot.sendMessage(chatId, 'Error: Could not identify user.');
    return;
  }

  if (userExists(telegramId)) {
    const user = getUser(telegramId)!;
    bot.sendMessage(
      chatId,
      `Welcome back! Your HyperLiquid wallet is ready.\n\n` +
      `Address: \`${user.address}\`\n\n` +
      `Use /help to see available commands.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Generate new wallet
  const { address, privateKey } = generateWallet();
  const encryptedKey = encryptPrivateKey(privateKey);

  // Save user
  saveUser({
    telegramId,
    address,
    encryptedPrivateKey: encryptedKey,
    createdAt: new Date().toISOString(),
  });

  bot.sendMessage(
    chatId,
    `Wallet created!\n\n` +
    `Your HyperLiquid ${config.isTestnet ? 'TESTNET' : ''} address:\n` +
    `\`${address}\`\n\n` +
    `To start trading:\n` +
    `1. Fund your wallet with USDC on ${config.isTestnet ? 'HyperLiquid Testnet' : 'Arbitrum'}\n` +
    `2. Use /balance to check your funds\n` +
    `3. Use /buy or /sell to trade\n\n` +
    `Use /help for all commands.`,
    { parse_mode: 'Markdown' }
  );
});

// /wallet command - Show wallet address
bot.onText(/\/wallet/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from?.id;

  if (!telegramId) return;

  const user = getUser(telegramId);
  if (!user) {
    bot.sendMessage(chatId, 'No wallet found. Use /start to create one.');
    return;
  }

  bot.sendMessage(
    chatId,
    `Your HyperLiquid wallet:\n\n` +
    `\`${user.address}\``,
    { parse_mode: 'Markdown' }
  );
});

// /deposit command - Show deposit instructions
bot.onText(/\/deposit/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from?.id;

  if (!telegramId) return;

  const user = getUser(telegramId);
  if (!user) {
    bot.sendMessage(chatId, 'No wallet found. Use /start to create one.');
    return;
  }

  const instructions = config.isTestnet
    ? `To fund your testnet wallet:\n\n` +
      `1. Go to https://app.hyperliquid-testnet.xyz\n` +
      `2. Use the testnet faucet to get test USDC\n` +
      `3. Send to your address:\n\`${user.address}\``
    : `To fund your wallet:\n\n` +
      `1. Bridge USDC from Arbitrum to HyperLiquid\n` +
      `2. Send to your address:\n\`${user.address}\`\n\n` +
      `Bridge: https://app.hyperliquid.xyz/bridge`;

  bot.sendMessage(chatId, instructions, { parse_mode: 'Markdown' });
});

// /balance command - Show account balance
bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from?.id;

  if (!telegramId) return;

  const user = getUser(telegramId);
  if (!user) {
    bot.sendMessage(chatId, 'No wallet found. Use /start to create one.');
    return;
  }

  try {
    const balance = await getBalance(user.address);

    // Format spot balances
    const spotText = balance.spotBalances.length > 0
      ? balance.spotBalances.map(b => `  ${b.coin}: ${parseFloat(b.total).toFixed(2)}`).join('\n')
      : '  (empty)';

    bot.sendMessage(
      chatId,
      `Account Balance:\n\n` +
      `*Perps Account:*\n` +
      `  Value: $${parseFloat(balance.perpsValue).toFixed(2)}\n` +
      `  Withdrawable: $${parseFloat(balance.perpsWithdrawable).toFixed(2)}\n\n` +
      `*Spot Account:*\n${spotText}\n\n` +
      `_To trade perps, transfer USDC from Spot to Perps on HL web app._`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    bot.sendMessage(chatId, `Error fetching balance: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// /positions command - Show open positions
bot.onText(/\/positions/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from?.id;

  if (!telegramId) return;

  const user = getUser(telegramId);
  if (!user) {
    bot.sendMessage(chatId, 'No wallet found. Use /start to create one.');
    return;
  }

  try {
    const positions = await getPositions(user.address);

    if (positions.length === 0) {
      bot.sendMessage(chatId, 'No open positions.');
      return;
    }

    const positionText = positions.map((p) => {
      const side = parseFloat(p.size) > 0 ? 'LONG' : 'SHORT';
      const pnlSign = parseFloat(p.unrealizedPnl) >= 0 ? '+' : '';
      return `${p.coin} ${side}\n` +
        `  Size: ${p.size}\n` +
        `  Entry: $${parseFloat(p.entryPrice).toFixed(2)}\n` +
        `  PnL: ${pnlSign}$${parseFloat(p.unrealizedPnl).toFixed(2)}\n` +
        `  Leverage: ${p.leverage}x`;
    }).join('\n\n');

    bot.sendMessage(chatId, `Open Positions:\n\n${positionText}`);
  } catch (error) {
    bot.sendMessage(chatId, `Error fetching positions: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// /buy command - Place market buy order
bot.onText(/\/buy\s+(\w+)\s+([\d.]+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from?.id;

  if (!telegramId || !match) return;

  const user = getUser(telegramId);
  if (!user) {
    bot.sendMessage(chatId, 'No wallet found. Use /start to create one.');
    return;
  }

  const coin = match[1].toUpperCase();
  const size = parseFloat(match[2]);

  if (isNaN(size) || size <= 0) {
    bot.sendMessage(chatId, 'Invalid size. Usage: /buy ETH 0.01');
    return;
  }

  bot.sendMessage(chatId, `Placing market BUY order for ${size} ${coin}...`);

  try {
    const result = await placeMarketOrder(user.encryptedPrivateKey, coin, true, size);

    if (result.success) {
      bot.sendMessage(
        chatId,
        `Order Filled!\n\n` +
        `Bought ${result.filledSize} ${coin}\n` +
        `Avg Price: $${parseFloat(result.avgPrice!).toFixed(2)}`
      );
    } else {
      bot.sendMessage(chatId, `Order failed: ${result.error}`);
    }
  } catch (error) {
    bot.sendMessage(chatId, `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// /sell command - Place market sell order
bot.onText(/\/sell\s+(\w+)\s+([\d.]+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from?.id;

  if (!telegramId || !match) return;

  const user = getUser(telegramId);
  if (!user) {
    bot.sendMessage(chatId, 'No wallet found. Use /start to create one.');
    return;
  }

  const coin = match[1].toUpperCase();
  const size = parseFloat(match[2]);

  if (isNaN(size) || size <= 0) {
    bot.sendMessage(chatId, 'Invalid size. Usage: /sell ETH 0.01');
    return;
  }

  bot.sendMessage(chatId, `Placing market SELL order for ${size} ${coin}...`);

  try {
    const result = await placeMarketOrder(user.encryptedPrivateKey, coin, false, size);

    if (result.success) {
      bot.sendMessage(
        chatId,
        `Order Filled!\n\n` +
        `Sold ${result.filledSize} ${coin}\n` +
        `Avg Price: $${parseFloat(result.avgPrice!).toFixed(2)}`
      );
    } else {
      bot.sendMessage(chatId, `Order failed: ${result.error}`);
    }
  } catch (error) {
    bot.sendMessage(chatId, `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// /coins command - List available trading pairs
bot.onText(/\/coins/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const coins = await getAvailableCoins();
    bot.sendMessage(
      chatId,
      `Available trading pairs:\n\n${coins.slice(0, 30).join(', ')}${coins.length > 30 ? '...' : ''}`
    );
  } catch (error) {
    bot.sendMessage(chatId, `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// /help command - Show available commands
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;

  bot.sendMessage(
    chatId,
    `HyperLiquid Trading Bot ${config.isTestnet ? '(TESTNET)' : ''}\n\n` +
    `Commands:\n` +
    `/start - Create or show wallet\n` +
    `/wallet - Show your wallet address\n` +
    `/deposit - Funding instructions\n` +
    `/balance - Check account balance\n` +
    `/positions - View open positions\n` +
    `/buy <coin> <size> - Market buy (e.g., /buy ETH 0.01)\n` +
    `/sell <coin> <size> - Market sell (e.g., /sell ETH 0.01)\n` +
    `/coins - List available pairs\n` +
    `/help - Show this help message`
  );
});

// Handle polling errors
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});

console.log('Bot initialized. Waiting for messages...');
