import { Wallet } from '@ethersproject/wallet';
import { ethers } from 'ethers';
import { ClobClient, Chain, Side, OrderType, AssetType } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { config } from '../config';
import { decryptPrivateKey } from './wallet';

// Token addresses on Polygon
const USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // Native USDC (Circle)
const USDC_BRIDGED = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e (bridged from Ethereum) - Polymarket uses this

// Polymarket contract addresses on Polygon
const POLYMARKET_CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'; // CLOB Exchange
const POLYMARKET_NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a'; // Neg Risk Exchange
const POLYMARKET_CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'; // Conditional Token Framework

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

// Get current gas prices for Polygon (with minimum 30 gwei tip)
async function getPolygonGasSettings(provider: ethers.providers.Provider): Promise<{
  maxFeePerGas: ethers.BigNumber;
  maxPriorityFeePerGas: ethers.BigNumber;
}> {
  const feeData = await provider.getFeeData();
  // Polygon requires minimum 25 gwei tip, use 35 gwei to be safe
  const minTip = ethers.utils.parseUnits('35', 'gwei');
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas?.gt(minTip)
    ? feeData.maxPriorityFeePerGas
    : minTip;
  // Max fee = base fee * 2 + priority fee (to handle base fee spikes)
  const baseFee = feeData.lastBaseFeePerGas || ethers.utils.parseUnits('30', 'gwei');
  const maxFeePerGas = baseFee.mul(2).add(maxPriorityFeePerGas);
  return { maxFeePerGas, maxPriorityFeePerGas };
}


// Store API credentials per user (in-memory cache)
const apiCredsCache: Map<string, { key: string; secret: string; passphrase: string }> = new Map();

// Create a wallet from encrypted private key
function getWallet(encryptedPrivateKey: string): Wallet {
  const privateKey = decryptPrivateKey(encryptedPrivateKey);
  return new Wallet(privateKey);
}

// Get or create CLOB client with API credentials for a user
export async function getClobClient(encryptedPrivateKey: string): Promise<ClobClient> {
  const wallet = getWallet(encryptedPrivateKey);
  const address = wallet.address.toLowerCase();

  // Check if we have cached API credentials
  let creds = apiCredsCache.get(address);

  if (!creds) {
    // First, create a client without credentials to derive API key
    const tempClient = new ClobClient(
      config.pmClobUrl,
      Chain.POLYGON,
      wallet,
      undefined,
      SignatureType.EOA
    );

    // Create or derive API keys using L1 authentication
    // createOrDeriveApiKey handles both new and existing wallets
    creds = await tempClient.createOrDeriveApiKey();
    apiCredsCache.set(address, creds);
  }

  // Create client with credentials
  return new ClobClient(
    config.pmClobUrl,
    Chain.POLYGON,
    wallet,
    creds,
    SignatureType.EOA
  );
}

// Market data types from Gamma API
export interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string[];
  outcomePrices: string[];
  volume: string;
  liquidity: string;
  clobTokenIds: string[];
  active: boolean;
  closed: boolean;
}

// CLOB Market type
interface ClobMarket {
  condition_id: string;
  question_id: string;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: string;
  }>;
  minimum_order_size: string;
  minimum_tick_size: string;
  description: string;
  category: string;
  end_date_iso: string;
  game_start_time: string;
  question: string;
  market_slug: string;
  active: boolean;
  closed: boolean;
  accepting_orders: boolean;
}

// Fetch markets from Gamma API with pagination until we get enough tradeable ones
export async function getTrendingMarkets(limit: number = 10): Promise<GammaMarket[]> {
  const tradeableMarkets: GammaMarket[] = [];
  let offset = 0;
  const batchSize = 50; // Fetch in batches
  const maxIterations = 10; // Prevent infinite loops

  for (let i = 0; i < maxIterations && tradeableMarkets.length < limit; i++) {
    const response = await fetch(
      `${config.pmGammaUrl}/markets?closed=false&active=true&order=volume&ascending=false&limit=${batchSize}&offset=${offset}`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch markets: ${response.statusText}`);
    }

    const markets = (await response.json()) as any[];

    if (markets.length === 0) {
      break; // No more markets
    }

    // Filter for markets with order book enabled
    for (const m of markets) {
      if (!m.enableOrderBook) continue;
      if (m.closed) continue;

      const market: GammaMarket = {
        id: m.id,
        question: m.question,
        conditionId: m.conditionId,
        slug: m.slug,
        outcomes: m.outcomes ? JSON.parse(m.outcomes) : ['Yes', 'No'],
        outcomePrices: m.outcomePrices ? JSON.parse(m.outcomePrices) : ['0.5', '0.5'],
        volume: m.volume || '0',
        liquidity: m.liquidity || '0',
        clobTokenIds: m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [],
        active: m.active,
        closed: m.closed,
      };

      if (market.clobTokenIds.length >= 2) {
        tradeableMarkets.push(market);
        if (tradeableMarkets.length >= limit) break;
      }
    }

    offset += batchSize;
  }

  console.log(`Found ${tradeableMarkets.length} tradeable markets with order books`);
  return tradeableMarkets;
}

// Get specific market by condition ID from Gamma API
export async function getMarket(conditionId: string): Promise<GammaMarket | null> {
  // Gamma API's conditionId filter is broken (returns partial matches)
  // Search with same params as getTrendingMarkets and find exact match
  const response = await fetch(`${config.pmGammaUrl}/markets?closed=false&active=true&order=volume&ascending=false&limit=200`);

  if (!response.ok) {
    console.log(`Failed to fetch markets from Gamma`);
    return null;
  }

  const markets = (await response.json()) as any[];

  // Find exact conditionId match
  const m = markets.find((market: any) => market.conditionId === conditionId);

  if (!m) {
    console.log(`Market ${conditionId} not found in active markets`);
    return null;
  }

  if (!m.enableOrderBook) {
    console.log(`Market ${conditionId} does not have order book enabled`);
    return null;
  }

  const clobTokenIds = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [];
  if (clobTokenIds.length < 2) {
    console.log(`Market ${conditionId} has no valid tokens`);
    return null;
  }

  return {
    id: m.id,
    question: m.question,
    conditionId: m.conditionId,
    slug: m.slug,
    outcomes: m.outcomes ? JSON.parse(m.outcomes) : ['Yes', 'No'],
    outcomePrices: m.outcomePrices ? JSON.parse(m.outcomePrices) : ['0.5', '0.5'],
    volume: m.volume || '0',
    liquidity: m.liquidity || '0',
    clobTokenIds: clobTokenIds,
    active: m.active,
    closed: m.closed,
  };
}

// Search markets by query
export async function searchMarkets(query: string, limit: number = 5): Promise<GammaMarket[]> {
  const response = await fetch(
    `${config.pmGammaUrl}/markets?closed=false&active=true&limit=${limit}&_q=${encodeURIComponent(query)}`
  );

  if (!response.ok) {
    throw new Error(`Failed to search markets: ${response.statusText}`);
  }

  const markets = (await response.json()) as any[];
  return markets.map((m: any) => ({
    id: m.id,
    question: m.question,
    conditionId: m.conditionId,
    slug: m.slug,
    outcomes: m.outcomes ? JSON.parse(m.outcomes) : ['Yes', 'No'],
    outcomePrices: m.outcomePrices ? JSON.parse(m.outcomePrices) : ['0.5', '0.5'],
    volume: m.volume || '0',
    liquidity: m.liquidity || '0',
    clobTokenIds: m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [],
    active: m.active,
    closed: m.closed,
  }));
}

// Get on-chain balances directly from Polygon (POL, USDC, USDC.e)
export async function getPolygonBalances(encryptedPrivateKey: string): Promise<{
  pol: string;
  usdcNative: string;
  usdcBridged: string; // USDC.e - Polymarket uses this
  address: string;
}> {
  const wallet = getWallet(encryptedPrivateKey);
  const provider = new ethers.providers.JsonRpcProvider(config.polygonRpcUrl);

  // POL/MATIC balance
  const polBalance = await provider.getBalance(wallet.address);

  // Native USDC
  const usdcNative = new ethers.Contract(USDC_NATIVE, ERC20_ABI, provider);
  const usdcNativeBalance = await usdcNative.balanceOf(wallet.address);
  const usdcNativeDecimals = await usdcNative.decimals();

  // Bridged USDC.e
  const usdcBridged = new ethers.Contract(USDC_BRIDGED, ERC20_ABI, provider);
  const usdcBridgedBalance = await usdcBridged.balanceOf(wallet.address);
  const usdcBridgedDecimals = await usdcBridged.decimals();

  return {
    pol: ethers.utils.formatEther(polBalance),
    usdcNative: ethers.utils.formatUnits(usdcNativeBalance, usdcNativeDecimals),
    usdcBridged: ethers.utils.formatUnits(usdcBridgedBalance, usdcBridgedDecimals),
    address: wallet.address,
  };
}

// Get USDC balance from Polymarket CLOB API
export async function getPolymarketBalance(encryptedPrivateKey: string): Promise<{
  balance: string;
  allowance: string;
}> {
  const client = await getClobClient(encryptedPrivateKey);
  const result = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  return {
    balance: result.balance,
    allowance: result.allowance,
  };
}

// Ensure USDC.e is approved for Polymarket exchange contracts
export async function ensurePolymarketApprovals(encryptedPrivateKey: string): Promise<{
  success: boolean;
  txHash?: string;
  error?: string;
}> {
  try {
    const privateKey = decryptPrivateKey(encryptedPrivateKey);
    const provider = new ethers.providers.JsonRpcProvider(config.polygonRpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);

    // USDC.e contract
    const usdcBridged = new ethers.Contract(USDC_BRIDGED, ERC20_ABI, wallet);

    // Check current allowance for CTF Exchange
    const currentAllowance = await usdcBridged.allowance(wallet.address, POLYMARKET_CTF_EXCHANGE);
    const maxUint256 = ethers.constants.MaxUint256;

    // If allowance is already max, we're good
    if (currentAllowance.eq(maxUint256)) {
      console.log('USDC.e already approved for Polymarket exchange');
      return { success: true };
    }

    console.log('Approving USDC.e for Polymarket CTF Exchange...');

    // Get proper gas settings for Polygon
    const gasSettings = await getPolygonGasSettings(provider);

    // Approve max amount for CTF Exchange
    const approveTx = await usdcBridged.approve(
      POLYMARKET_CTF_EXCHANGE,
      maxUint256,
      { ...gasSettings }
    );

    console.log(`Approval tx submitted: ${approveTx.hash}`);
    const receipt = await approveTx.wait();
    console.log('Approval confirmed');

    return {
      success: true,
      txHash: receipt.transactionHash,
    };
  } catch (error) {
    console.error('Approval error:', error);
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    if (errorMsg.includes('insufficient funds')) {
      return { success: false, error: 'Insufficient POL for gas fees' };
    }
    return { success: false, error: errorMsg };
  }
}

// Get user's positions (open orders and trades)
export async function getPolymarketPositions(encryptedPrivateKey: string): Promise<{
  openOrders: Array<{
    id: string;
    market: string;
    side: string;
    price: string;
    size: string;
    outcome: string;
  }>;
}> {
  const client = await getClobClient(encryptedPrivateKey);
  const orders = await client.getOpenOrders();

  return {
    openOrders: orders.map((o) => ({
      id: o.id,
      market: o.market,
      side: o.side,
      price: o.price,
      size: o.original_size,
      outcome: o.outcome,
    })),
  };
}

// Place a market order on Polymarket
export async function placePolymarketOrder(
  encryptedPrivateKey: string,
  tokenId: string,
  side: 'BUY' | 'SELL',
  amount: number // USDC for BUY, shares for SELL
): Promise<{
  success: boolean;
  orderId?: string;
  approvalTxHash?: string;
  error?: string;
}> {
  try {
    console.log(`Placing Polymarket order: ${side} ${amount} for token ${tokenId}`);

    // Ensure USDC.e is approved for Polymarket before buying
    if (side === 'BUY') {
      console.log('Checking USDC.e approval for Polymarket...');
      const approvalResult = await ensurePolymarketApprovals(encryptedPrivateKey);
      if (!approvalResult.success) {
        return {
          success: false,
          error: `Approval failed: ${approvalResult.error}`,
        };
      }
      if (approvalResult.txHash) {
        console.log(`USDC.e approved in tx: ${approvalResult.txHash}`);
      }
    }

    const client = await getClobClient(encryptedPrivateKey);
    console.log('Got CLOB client, creating market order...');

    const result = await client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        amount: amount,
        side: side === 'BUY' ? Side.BUY : Side.SELL,
      },
      undefined,
      OrderType.FOK // Fill or Kill for market-like behavior
    );

    console.log('Order result:', JSON.stringify(result, null, 2));

    if (result.success) {
      return {
        success: true,
        orderId: result.orderID,
      };
    } else {
      return {
        success: false,
        error: result.errorMsg || 'Order not filled',
      };
    }
  } catch (error: any) {
    console.error('Polymarket order error:', error);

    // Check for specific error types
    const errorMsg = error?.message || 'Unknown error';
    if (errorMsg.includes('market not found') || errorMsg.includes('toString')) {
      return {
        success: false,
        error: 'Market not tradeable on CLOB. It may be closed or not active. Try a different market.',
      };
    }

    return {
      success: false,
      error: errorMsg,
    };
  }
}

// Cancel an order
export async function cancelPolymarketOrder(
  encryptedPrivateKey: string,
  orderId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const client = await getClobClient(encryptedPrivateKey);
    await client.cancelOrder({ orderID: orderId });
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// 1inch Router on Polygon
const ONEINCH_ROUTER = '0x1111111254EEB25477B68fb85Ed929f73A960582';

// Progress callback type for swap updates
export type SwapProgressCallback = (message: string) => void;

// Swap native USDC to USDC.e via 1inch API aggregator
export async function swapUsdcToUsdce(
  encryptedPrivateKey: string,
  amount: number, // Required amount in USDC
  onProgress?: SwapProgressCallback
): Promise<{
  success: boolean;
  amountIn?: string;
  amountOut?: string;
  txHash?: string;
  error?: string;
}> {
  try {
    const privateKey = decryptPrivateKey(encryptedPrivateKey);
    const provider = new ethers.providers.JsonRpcProvider(config.polygonRpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);

    // Get native USDC contract
    const usdcNative = new ethers.Contract(USDC_NATIVE, ERC20_ABI, wallet);
    const decimals = await usdcNative.decimals();

    // Get balance
    const balance = await usdcNative.balanceOf(wallet.address);
    if (balance.isZero()) {
      return { success: false, error: 'No native USDC balance to swap' };
    }

    const amountToSwap = ethers.utils.parseUnits(amount.toString(), decimals);

    if (amountToSwap.gt(balance)) {
      return { success: false, error: `Insufficient balance. Have ${ethers.utils.formatUnits(balance, decimals)} USDC` };
    }

    onProgress?.('Finding best swap route...');
    console.log(`Getting 1inch quote for ${amount} USDC to USDC.e...`);

    // Get quote from 1inch API (Polygon chainId = 137)
    const quoteUrl = `https://api.1inch.dev/swap/v6.0/137/swap?` +
      `src=${USDC_NATIVE}&` +
      `dst=${USDC_BRIDGED}&` +
      `amount=${amountToSwap.toString()}&` +
      `from=${wallet.address}&` +
      `slippage=1&` +
      `disableEstimate=true`;

    const quoteResponse = await fetch(quoteUrl, {
      headers: {
        'Authorization': `Bearer ${config.oneInchApiKey || ''}`,
        'Accept': 'application/json',
      },
    });

    if (!quoteResponse.ok) {
      const errorText = await quoteResponse.text();
      console.error('1inch API error:', errorText);

      // Fallback: try Kyberswap
      console.log('Falling back to Kyberswap...');
      onProgress?.('Using Kyberswap aggregator...');
      return await swapViaKyberswap(wallet, usdcNative, amountToSwap, decimals, amount, onProgress);
    }

    const quote = await quoteResponse.json() as {
      dstAmount: string;
      tx: {
        to: string;
        data: string;
        value: string;
        gas: number;
        gasPrice: string;
      };
    };
    console.log('1inch quote received:', {
      dstAmount: quote.dstAmount,
      gas: quote.tx.gas,
    });

    // Get proper gas settings for Polygon
    const gasSettings = await getPolygonGasSettings(provider);

    // Check/set allowance for 1inch router
    const currentAllowance = await usdcNative.allowance(wallet.address, ONEINCH_ROUTER);
    if (currentAllowance.lt(amountToSwap)) {
      onProgress?.('Approving USDC spend (1/2)...');
      console.log('Approving USDC for 1inch router...');
      const approveTx = await usdcNative.approve(
        ONEINCH_ROUTER,
        ethers.constants.MaxUint256,
        { ...gasSettings }
      );
      await approveTx.wait();
      console.log('Approval confirmed');
    }

    onProgress?.('Executing swap (2/2)...');
    console.log(`Executing swap of ${amount} USDC to USDC.e...`);

    // Execute the swap
    const tx = await wallet.sendTransaction({
      to: quote.tx.to,
      data: quote.tx.data,
      value: quote.tx.value || '0',
      gasLimit: Math.ceil(quote.tx.gas * 1.3),
      ...gasSettings,
    });

    onProgress?.(`Swap submitted, waiting for confirmation...`);
    console.log(`Swap tx submitted: ${tx.hash}`);
    const receipt = await tx.wait();

    const amountOutFormatted = ethers.utils.formatUnits(quote.dstAmount, decimals);

    return {
      success: true,
      amountIn: amount.toString(),
      amountOut: amountOutFormatted,
      txHash: receipt.transactionHash,
    };
  } catch (error) {
    console.error('Swap error:', error);
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';

    if (errorMsg.includes('insufficient funds')) {
      return { success: false, error: 'Insufficient POL for gas fees' };
    }

    return { success: false, error: errorMsg };
  }
}

// Fallback swap via Kyberswap aggregator
async function swapViaKyberswap(
  wallet: ethers.Wallet,
  usdcNative: ethers.Contract,
  amountToSwap: ethers.BigNumber,
  decimals: number,
  amount: number,
  onProgress?: SwapProgressCallback
): Promise<{
  success: boolean;
  amountIn?: string;
  amountOut?: string;
  txHash?: string;
  error?: string;
}> {
  try {
    console.log(`Getting Kyberswap quote for ${amount} USDC to USDC.e...`);

    // Kyberswap API
    const routeUrl = `https://aggregator-api.kyberswap.com/polygon/api/v1/routes?` +
      `tokenIn=${USDC_NATIVE}&` +
      `tokenOut=${USDC_BRIDGED}&` +
      `amountIn=${amountToSwap.toString()}&` +
      `saveGas=false&` +
      `gasInclude=true`;

    const routeResponse = await fetch(routeUrl);
    if (!routeResponse.ok) {
      const errorText = await routeResponse.text();
      console.error('Kyberswap route error:', errorText);
      return { success: false, error: 'No swap route found on any aggregator' };
    }

    const routeData = await routeResponse.json() as {
      data: {
        routeSummary: {
          amountOut: string;
          gas: string;
        };
      };
    };

    if (!routeData.data?.routeSummary) {
      return { success: false, error: 'No swap route found' };
    }

    // Build swap transaction
    const buildUrl = `https://aggregator-api.kyberswap.com/polygon/api/v1/route/build`;
    const buildResponse = await fetch(buildUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routeSummary: routeData.data.routeSummary,
        sender: wallet.address,
        recipient: wallet.address,
        slippageTolerance: 100, // 1% in bps
      }),
    });

    if (!buildResponse.ok) {
      const errorText = await buildResponse.text();
      console.error('Kyberswap build error:', errorText);
      return { success: false, error: 'Failed to build swap transaction' };
    }

    const buildData = await buildResponse.json() as {
      data: {
        data: string;
        routerAddress: string;
        gas: string;
      };
    };

    console.log('Kyberswap quote received:', {
      amountOut: routeData.data.routeSummary.amountOut,
      router: buildData.data.routerAddress,
    });

    // Get proper gas settings for Polygon
    const gasSettings = await getPolygonGasSettings(wallet.provider!);

    // Check/set allowance
    const currentAllowance = await usdcNative.allowance(wallet.address, buildData.data.routerAddress);
    if (currentAllowance.lt(amountToSwap)) {
      onProgress?.('Approving USDC spend (1/2)...');
      console.log('Approving USDC for Kyberswap router...');
      const approveTx = await usdcNative.approve(
        buildData.data.routerAddress,
        ethers.constants.MaxUint256,
        { ...gasSettings }
      );
      console.log(`Approval tx submitted: ${approveTx.hash}`);
      onProgress?.(`Approval tx: ${approveTx.hash.slice(0, 10)}... waiting for confirmation`);
      await approveTx.wait();
      console.log('Approval confirmed');
      onProgress?.('Approval confirmed ✓');
    }

    onProgress?.('Executing swap (2/2)...');
    console.log(`Executing Kyberswap swap of ${amount} USDC to USDC.e...`);

    // Execute swap
    const tx = await wallet.sendTransaction({
      to: buildData.data.routerAddress,
      data: buildData.data.data,
      value: '0',
      gasLimit: Math.ceil(Number(buildData.data.gas || routeData.data.routeSummary.gas) * 1.3),
      ...gasSettings,
    });

    console.log(`Swap tx submitted: ${tx.hash}`);
    onProgress?.(`Swap tx: ${tx.hash.slice(0, 10)}... waiting for confirmation`);
    const receipt = await tx.wait();

    const amountOutFormatted = ethers.utils.formatUnits(routeData.data.routeSummary.amountOut, decimals);

    return {
      success: true,
      amountIn: amount.toString(),
      amountOut: amountOutFormatted,
      txHash: receipt.transactionHash,
    };
  } catch (error) {
    console.error('Kyberswap error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
