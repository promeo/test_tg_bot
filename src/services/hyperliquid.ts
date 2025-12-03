import * as hl from '@nktkas/hyperliquid';
import { config } from '../config';
import { getAccountFromEncryptedKey } from './wallet';
import type { TradeResult } from '../types';

// Create transport based on environment
const transport = new hl.HttpTransport({ isTestnet: config.isTestnet });

// Info client (public data, no auth needed)
export const infoClient = new hl.InfoClient({ transport });

// Get exchange client for a specific user
export function getExchangeClient(encryptedPrivateKey: string): hl.ExchangeClient {
  const account = getAccountFromEncryptedKey(encryptedPrivateKey);
  return new hl.ExchangeClient({ wallet: account, transport });
}

// Fetch user's account balance
export async function getBalance(userAddress: string): Promise<{
  accountValue: string;
  withdrawable: string;
}> {
  const state = await infoClient.clearinghouseState({ user: userAddress as `0x${string}` });
  return {
    accountValue: state.marginSummary.accountValue,
    withdrawable: state.withdrawable,
  };
}

// Fetch user's open positions
export async function getPositions(userAddress: string): Promise<Array<{
  coin: string;
  size: string;
  entryPrice: string;
  unrealizedPnl: string;
  leverage: string;
}>> {
  const state = await infoClient.clearinghouseState({ user: userAddress as `0x${string}` });
  return state.assetPositions
    .filter((p) => parseFloat(p.position.szi) !== 0)
    .map((p) => ({
      coin: p.position.coin,
      size: p.position.szi,
      entryPrice: p.position.entryPx || '0',
      unrealizedPnl: p.position.unrealizedPnl,
      leverage: p.position.leverage.value.toString(),
    }));
}

// Place a market order
export async function placeMarketOrder(
  encryptedPrivateKey: string,
  coin: string,
  isBuy: boolean,
  size: number
): Promise<TradeResult> {
  try {
    const exchangeClient = getExchangeClient(encryptedPrivateKey);

    // Get current price for market order (use mid price + slippage)
    const l2Book = await infoClient.l2Book({ coin });
    if (!l2Book || !l2Book.levels[0]?.[0] || !l2Book.levels[1]?.[0]) {
      return { success: false, error: 'Could not fetch order book' };
    }
    const midPrice = (parseFloat(l2Book.levels[0][0].px) + parseFloat(l2Book.levels[1][0].px)) / 2;

    // Add 1% slippage for market orders
    const slippageMultiplier = isBuy ? 1.01 : 0.99;
    const limitPrice = midPrice * slippageMultiplier;

    // Get asset metadata for proper rounding
    const meta = await infoClient.meta();
    const assetInfo = meta.universe.find((a) => a.name === coin);
    if (!assetInfo) {
      return { success: false, error: `Unknown asset: ${coin}` };
    }

    // Round size to proper decimals
    const szDecimals = assetInfo.szDecimals;
    const roundedSize = Math.floor(size * Math.pow(10, szDecimals)) / Math.pow(10, szDecimals);

    const result = await exchangeClient.order({
      orders: [{
        a: meta.universe.findIndex((a) => a.name === coin), // asset index
        b: isBuy,
        p: limitPrice.toFixed(6),
        s: roundedSize.toFixed(szDecimals),
        r: false, // reduce only
        t: { limit: { tif: 'Ioc' } }, // Immediate or Cancel for market-like behavior
      }],
      grouping: 'na',
    });

    // The SDK always returns success, check the response data for status
    const response = result.response;
    if (response.type === 'order') {
      const status = response.data.statuses[0];
      if ('filled' in status) {
        return {
          success: true,
          filledSize: status.filled.totalSz,
          avgPrice: status.filled.avgPx,
        };
      } else if ('resting' in status) {
        return { success: false, error: 'Order resting (not filled immediately)' };
      }
    }

    return { success: false, error: 'Order not filled' };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// Get available coins
export async function getAvailableCoins(): Promise<string[]> {
  const meta = await infoClient.meta();
  return meta.universe.map((a) => a.name);
}
