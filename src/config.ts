import dotenv from 'dotenv';
dotenv.config();

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  encryptionKey: process.env.ENCRYPTION_KEY || '',
  isTestnet: process.env.HL_TESTNET === 'true',

  // HyperLiquid endpoints
  hlApiUrl: process.env.HL_TESTNET === 'true'
    ? 'https://api.hyperliquid-testnet.xyz'
    : 'https://api.hyperliquid.xyz',
  hlWsUrl: process.env.HL_TESTNET === 'true'
    ? 'wss://api.hyperliquid-testnet.xyz/ws'
    : 'wss://api.hyperliquid.xyz/ws',

  // Polymarket endpoints (mainnet only - no testnet available)
  pmClobUrl: 'https://clob.polymarket.com',
  pmGammaUrl: 'https://gamma-api.polymarket.com',
  polygonRpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
  polygonChainId: 137,

  // 1inch API key (optional, Kyberswap fallback works without key)
  oneInchApiKey: process.env.ONEINCH_API_KEY || '',
};

export function validateConfig(): void {
  if (!config.telegramToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required');
  }
  if (!config.encryptionKey || config.encryptionKey.length < 32) {
    throw new Error('ENCRYPTION_KEY must be at least 32 characters');
  }
}
