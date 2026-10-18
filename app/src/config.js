import 'dotenv/config';

const num = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : Number(process.env[k]));
const bool = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k].toLowerCase() === 'true');
const str = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k].trim());

export const cfg = {
  heliusKey: process.env.HELIUS_API_KEY || '',
  jupKey: process.env.JUP_API_KEY || '',
  privateKey: process.env.PRIVATE_KEY || '',
  target: str('TARGET_WALLET', ''),

  paper: bool('PAPER', true),

  // ---- buying ----
  buyPct: num('BUY_PCT', 40),                    // % of target's SOL to spend
  minTargetBuySol: num('MIN_TARGET_BUY_SOL', 4), // target must spend MORE than this
  maxBuySol: num('MAX_BUY_SOL', 0),              // cap per buy (0 = no cap)
  reserveSol: num('RESERVE_SOL', 0.05),          // always keep this much SOL for fees
  maxPositions: num('MAX_POSITIONS', 0),         // 0 = unlimited
  copyRebuys: bool('COPY_REBUYS', false),        // only copy the initial buy
  newPositionsOnly: bool('NEW_POSITIONS_ONLY', true),
  // never pay more than this multiple of Lunar's own fill price (stops junk-pool / bad-route fills)
  maxPriceVsLunar: num('MAX_PRICE_VS_LUNAR', 2), // only copy when Lunar held 0 of the coin before

  // ---- selling ----
  mirrorSells: bool('MIRROR_SELLS', true),
  sellAllOnAnySell: bool('SELL_ALL_ON_ANY_SELL', true), // any sell/transfer out by target = we dump 100%
  takeProfitPct: num('TAKE_PROFIT_PCT', 0),
  stopLossPct: num('STOP_LOSS_PCT', 0),
  maxHoldMin: num('MAX_HOLD_MIN', 0),
  priceCheckMs: num('PRICE_CHECK_MS', 8000),

  // ---- execution / speed ----
  slippageBps: num('SLIPPAGE_BPS', 2500),
  // if a buy fails on slippage, retry right away at these levels (bps)
  buyRetrySlippages: str('BUY_RETRY_SLIPPAGES', '4000,5500').split(',').map(Number).filter(Boolean),
  sellSlippageBps: num('SELL_SLIPPAGE_BPS', 3000),
  onlyDirectRoutes: bool('ONLY_DIRECT_ROUTES', true),
  cuLimit: num('CU_LIMIT', 400000),
  directSwap: bool('DIRECT_SWAP', true),        // clone Lunar's own AMM ix (no Jupiter) when possible
  directCuLimit: num('DIRECT_CU_LIMIT', 150000),
  cuPriceMicroLamports: num('CU_PRICE_MICROLAMPORTS', 1000000),
  tipSol: num('TIP_SOL', 0.001),
  senderUrl: str('SENDER_URL', 'http://ewr-sender.helius-rpc.com'),
};

cfg.rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${cfg.heliusKey}`;
cfg.wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${cfg.heliusKey}`;

export function validate() {
  const missing = [];
  if (!cfg.heliusKey) missing.push('HELIUS_API_KEY');
  if (!cfg.jupKey) missing.push('JUP_API_KEY');
  if (!cfg.target) missing.push('TARGET_WALLET');
  if (!cfg.paper && !cfg.privateKey) missing.push('PRIVATE_KEY');
  if (missing.length) {
    console.error(`Missing in .env: ${missing.join(', ')}`);
    process.exit(1);
  }
}
