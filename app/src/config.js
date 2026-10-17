import 'dotenv/config';

const num = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : Number(process.env[k]));
const bool = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k].toLowerCase() === 'true');

export const cfg = {
  heliusKey: process.env.HELIUS_API_KEY || '',
  jupKey: process.env.JUP_API_KEY || '',
  privateKey: process.env.PRIVATE_KEY || '',
  target: (process.env.TARGET_WALLET || '').trim(),

  paper: bool('PAPER', true),

  buySol: num('BUY_SOL', 0.05),
  minTargetBuySol: num('MIN_TARGET_BUY_SOL', 0.1),
  maxPositions: num('MAX_POSITIONS', 5),
  copyRebuys: bool('COPY_REBUYS', false),
  minMcapUsd: num('MIN_MCAP_USD', 0),
  maxMcapUsd: num('MAX_MCAP_USD', 0),

  mirrorSells: bool('MIRROR_SELLS', true),
  takeProfitPct: num('TAKE_PROFIT_PCT', 100),
  stopLossPct: num('STOP_LOSS_PCT', 40),
  maxHoldMin: num('MAX_HOLD_MIN', 0),
  priceCheckMs: num('PRICE_CHECK_MS', 8000),

  slippageBps: num('SLIPPAGE_BPS', 1500),
  priorityFeeLamports: num('PRIORITY_FEE_LAMPORTS', 1000000),
};

cfg.rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${cfg.heliusKey}`;
cfg.wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${cfg.heliusKey}`;

export function validate() {
  const missing = [];
  if (!cfg.heliusKey) missing.push('HELIUS_API_KEY');
  if (!cfg.jupKey) missing.push('JUP_API_KEY');
  if (!cfg.target) missing.push('TARGET_WALLET');
  if (!cfg.paper && !cfg.privateKey) missing.push('PRIVATE_KEY (run: npm run wallet)');
  if (missing.length) {
    console.error(`Missing in .env: ${missing.join(', ')}`);
    process.exit(1);
  }
}
