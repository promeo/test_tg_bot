import TelegramBot from 'node-telegram-bot-api';
import { config, validateConfig } from './config';
import { generateWallet, encryptPrivateKey } from './services/wallet';
import { getUser, saveUser, userExists } from './services/database';
import { getBalance, getPositions, placeMarketOrder, getAvailableCoins } from './services/hyperliquid';
import {
  getTrendingMarkets,
  getMarket,
  searchMarkets,
  getPolygonBalances,
  getPolymarketPositions,
  placePolymarketOrder,
  swapUsdcToUsdce,
} from './services/polymarket';

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

// ==================== POLYMARKET COMMANDS ====================

// /pm_markets command - List trending prediction markets
bot.onText(/\/pm_markets(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match?.[1]?.trim();

  try {
    bot.sendMessage(chatId, query ? `Searching for "${query}"...` : 'Fetching trending markets...');

    const markets = query ? await searchMarkets(query, 5) : await getTrendingMarkets(5);

    if (markets.length === 0) {
      bot.sendMessage(chatId, 'No markets found.');
      return;
    }

    const marketText = markets.map((m, i) => {
      const yesPrice = parseFloat(m.outcomePrices[0] || '0') * 100;
      const noPrice = parseFloat(m.outcomePrices[1] || '0') * 100;
      const volume = parseFloat(m.volume) / 1000000;
      return `${i + 1}. ${m.question}\n` +
        `   YES: ${yesPrice.toFixed(0)}% | NO: ${noPrice.toFixed(0)}%\n` +
        `   Vol: $${volume.toFixed(1)}M\n` +
        `   ID: ${m.conditionId}`;
    }).join('\n\n');

    bot.sendMessage(
      chatId,
      `Polymarket ${query ? 'Search Results' : 'Trending'}\n\n${marketText}\n\n` +
      `Use /pm_buy <id> YES|NO <amount> to trade`
    );
  } catch (error) {
    bot.sendMessage(chatId, `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// /pm_balance command - Show Polymarket (Polygon) USDC balance
bot.onText(/\/pm_balance/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from?.id;

  if (!telegramId) return;

  const user = getUser(telegramId);
  if (!user) {
    bot.sendMessage(chatId, 'No wallet found. Use /start to create one.');
    return;
  }

  try {
    bot.sendMessage(chatId, 'Fetching Polygon balances...');
    const balances = await getPolygonBalances(user.encryptedPrivateKey);

    const pol = parseFloat(balances.pol) || 0;
    const usdcNative = parseFloat(balances.usdcNative) || 0;
    const usdcBridged = parseFloat(balances.usdcBridged) || 0;

    let message = `Polygon Wallet Balances\n\n` +
      `POL (gas): ${pol.toFixed(4)}\n` +
      `USDC.e: $${usdcBridged.toFixed(2)} (Polymarket)\n` +
      `USDC (native): $${usdcNative.toFixed(2)}\n\n`;

    // Show warning if they have native USDC but no USDC.e
    if (usdcNative > 0 && usdcBridged === 0) {
      message += `Note: Polymarket uses USDC.e (bridged), not native USDC.\n` +
        `Use /pm_swap <amount> to swap your USDC to USDC.e\n\n`;
    }

    message += `Your address:\n${balances.address}`;

    bot.sendMessage(chatId, message);
  } catch (error) {
    bot.sendMessage(chatId, `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// /pm_swap command - Swap native USDC to USDC.e for Polymarket
bot.onText(/\/pm_swap(?:\s+([\d.]+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from?.id;

  if (!telegramId) return;

  const user = getUser(telegramId);
  if (!user) {
    bot.sendMessage(chatId, 'No wallet found. Use /start to create one.');
    return;
  }

  const amountStr = match?.[1];
  if (!amountStr) {
    // No amount provided - show balance and usage
    try {
      const balances = await getPolygonBalances(user.encryptedPrivateKey);
      const usdcNative = parseFloat(balances.usdcNative) || 0;
      bot.sendMessage(
        chatId,
        `Usage: /pm_swap <amount>\n\n` +
        `Example: /pm_swap 10 (swaps 10 USDC to USDC.e)\n\n` +
        `Your native USDC balance: $${usdcNative.toFixed(2)}`
      );
    } catch {
      bot.sendMessage(chatId, `Usage: /pm_swap <amount>\n\nExample: /pm_swap 10`);
    }
    return;
  }

  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    bot.sendMessage(chatId, 'Invalid amount. Usage: /pm_swap 10');
    return;
  }

  try {
    // Check balance
    const balances = await getPolygonBalances(user.encryptedPrivateKey);
    const usdcNative = parseFloat(balances.usdcNative) || 0;

    if (usdcNative === 0) {
      bot.sendMessage(chatId, 'No native USDC to swap. Send USDC to your wallet first.');
      return;
    }

    if (amount > usdcNative) {
      bot.sendMessage(chatId, `Insufficient balance. You have $${usdcNative.toFixed(2)} native USDC.`);
      return;
    }

    bot.sendMessage(chatId, `Swapping $${amount.toFixed(2)} USDC to USDC.e...`);

    // Progress callback to update user
    const onProgress = (message: string) => {
      bot.sendMessage(chatId, message);
    };

    const result = await swapUsdcToUsdce(user.encryptedPrivateKey, amount, onProgress);

    if (result.success) {
      bot.sendMessage(
        chatId,
        `Swap Complete!\n\n` +
        `Swapped: $${result.amountIn} USDC\n` +
        `Received: $${result.amountOut} USDC.e\n\n` +
        `Tx: https://polygonscan.com/tx/${result.txHash}\n\n` +
        `Use /pm_balance to check your new balance.`
      );
    } else {
      bot.sendMessage(chatId, `Swap failed: ${result.error}`);
    }
  } catch (error) {
    bot.sendMessage(chatId, `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// /pm_positions command - Show Polymarket positions/orders
bot.onText(/\/pm_positions/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from?.id;

  if (!telegramId) return;

  const user = getUser(telegramId);
  if (!user) {
    bot.sendMessage(chatId, 'No wallet found. Use /start to create one.');
    return;
  }

  try {
    const positions = await getPolymarketPositions(user.encryptedPrivateKey);

    if (positions.openOrders.length === 0) {
      bot.sendMessage(chatId, 'No open orders on Polymarket.');
      return;
    }

    const ordersText = positions.openOrders.map((o) => {
      return `${o.side} ${o.outcome}\n` +
        `  Price: ${parseFloat(o.price).toFixed(2)}\n` +
        `  Size: ${o.size}\n` +
        `  Market: ${o.market.slice(0, 16)}...`;
    }).join('\n\n');

    bot.sendMessage(chatId, `Open Polymarket Orders:\n\n${ordersText}`);
  } catch (error) {
    bot.sendMessage(chatId, `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// /pm_buy fallback - show usage when format is wrong
bot.onText(/\/pm_buy(?!\s+\S+\s+(YES|NO|yes|no)\s+[\d.]+)/, async (msg) => {
  const chatId = msg.chat.id;
  console.log('pm_buy fallback triggered, message:', msg.text);
  bot.sendMessage(
    chatId,
    `Usage: /pm_buy <market_id> YES|NO <amount>\n\n` +
    `Example: /pm_buy 0x1234567890abcdef YES 5\n\n` +
    `Get market IDs from /pm_markets`
  );
});

// /pm_buy command - Buy YES/NO shares on Polymarket
bot.onText(/\/pm_buy\s+(\S+)\s+(YES|NO|yes|no)\s+([\d.]+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from?.id;

  console.log('pm_buy command received:', msg.text, match);

  if (!telegramId || !match) return;

  const user = getUser(telegramId);
  if (!user) {
    bot.sendMessage(chatId, 'No wallet found. Use /start to create one.');
    return;
  }

  const conditionId = match[1];
  const outcome = match[2].toUpperCase();
  const amount = parseFloat(match[3]);

  console.log(`pm_buy: conditionId=${conditionId}, outcome=${outcome}, amount=${amount}`);

  if (isNaN(amount) || amount <= 0) {
    bot.sendMessage(chatId, 'Invalid amount. Usage: /pm_buy <market_id> YES 10');
    return;
  }

  try {
    bot.sendMessage(chatId, `Looking up market...`);

    // Get market to find token ID
    console.log(`Looking up market with conditionId: ${conditionId}`);
    const market = await getMarket(conditionId);
    console.log(`Market result:`, market ? `found: ${market.question}` : 'not found');

    if (!market) {
      bot.sendMessage(chatId, 'Market not found. Use /pm_markets to find valid market IDs.');
      return;
    }

    const tokenIndex = outcome === 'YES' ? 0 : 1;
    const tokenId = market.clobTokenIds[tokenIndex];
    console.log(`Token ID for ${outcome}: ${tokenId}`);

    if (!tokenId) {
      bot.sendMessage(chatId, 'Token ID not found for this market.');
      return;
    }

    bot.sendMessage(chatId, `Placing BUY order for $${amount} ${outcome} on:\n"${market.question}"...`);

    const result = await placePolymarketOrder(user.encryptedPrivateKey, tokenId, 'BUY', amount);

    if (result.success) {
      bot.sendMessage(chatId, `Order placed!\nOrder ID: ${result.orderId}`);
    } else {
      bot.sendMessage(chatId, `Order failed: ${result.error}`);
    }
  } catch (error) {
    console.error('pm_buy error:', error);
    bot.sendMessage(chatId, `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// /pm_sell command - Sell YES/NO shares on Polymarket
bot.onText(/\/pm_sell\s+(\S+)\s+(YES|NO|yes|no)\s+([\d.]+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from?.id;

  if (!telegramId || !match) return;

  const user = getUser(telegramId);
  if (!user) {
    bot.sendMessage(chatId, 'No wallet found. Use /start to create one.');
    return;
  }

  const conditionId = match[1];
  const outcome = match[2].toUpperCase();
  const shares = parseFloat(match[3]);

  if (isNaN(shares) || shares <= 0) {
    bot.sendMessage(chatId, 'Invalid shares. Usage: /pm_sell <market_id> YES 10');
    return;
  }

  try {
    bot.sendMessage(chatId, `Looking up market...`);

    const market = await getMarket(conditionId);
    if (!market) {
      bot.sendMessage(chatId, 'Market not found. Use /pm_markets to find valid market IDs.');
      return;
    }

    const tokenIndex = outcome === 'YES' ? 0 : 1;
    const tokenId = market.clobTokenIds[tokenIndex];

    if (!tokenId) {
      bot.sendMessage(chatId, 'Token ID not found for this market.');
      return;
    }

    bot.sendMessage(chatId, `Placing SELL order for ${shares} ${outcome} shares on:\n"${market.question}"...`);

    const result = await placePolymarketOrder(user.encryptedPrivateKey, tokenId, 'SELL', shares);

    if (result.success) {
      bot.sendMessage(chatId, `Order placed!\nOrder ID: ${result.orderId}`);
    } else {
      bot.sendMessage(chatId, `Order failed: ${result.error}`);
    }
  } catch (error) {
    bot.sendMessage(chatId, `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
});

// /help command - Show available commands
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;

  bot.sendMessage(
    chatId,
    `*Trading Bot*\n\n` +
    `*HyperLiquid ${config.isTestnet ? '(TESTNET)' : ''}:*\n` +
    `/start - Create or show wallet\n` +
    `/wallet - Show your wallet address\n` +
    `/deposit - Funding instructions\n` +
    `/balance - Check HL account balance\n` +
    `/positions - View HL open positions\n` +
    `/buy <coin> <size> - Market buy (e.g., /buy ETH 0.01)\n` +
    `/sell <coin> <size> - Market sell (e.g., /sell ETH 0.01)\n` +
    `/coins - List available pairs\n\n` +
    `*Polymarket (Polygon Mainnet):*\n` +
    `/pm_markets [query] - List/search markets\n` +
    `/pm_balance - Check Polygon USDC balance\n` +
    `/pm_swap <amt> - Swap USDC to USDC.e\n` +
    `/pm_positions - View open orders\n` +
    `/pm_buy <id> YES|NO <$> - Buy shares\n` +
    `/pm_sell <id> YES|NO <qty> - Sell shares\n\n` +
    `/help - Show this help message`,
    { parse_mode: 'Markdown' }
  );
});

// Handle polling errors
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.message);
});

console.log('Bot initialized. Waiting for messages...');
