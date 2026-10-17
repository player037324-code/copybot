import { cfg } from './config.js';

const BASE = 'https://api.jup.ag/swap/v1';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const headers = () => ({ 'x-api-key': cfg.jupKey, 'content-type': 'application/json' });

async function req(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: headers() });
      if (r.status === 429) { await sleep(600 * (i + 1)); continue; }
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Jupiter ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
      return body;
    } catch (e) {
      lastErr = e;
      await sleep(300 * (i + 1));
    }
  }
  throw lastErr || new Error('Jupiter rate limited');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function quote(inputMint, outputMint, amountRaw) {
  const q = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amountRaw),
    slippageBps: String(cfg.slippageBps),
    restrictIntermediateTokens: 'true',
  });
  return req(`${BASE}/quote?${q}`);
}

export async function buildSwap(quoteResponse, userPublicKey) {
  return req(`${BASE}/swap`, {
    method: 'POST',
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: false,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: cfg.priorityFeeLamports,
          priorityLevel: 'veryHigh',
        },
      },
    }),
  });
}

// SOL price in USD, cached 60s
let solUsd = { v: 0, at: 0 };
export async function getSolUsd() {
  if (Date.now() - solUsd.at < 60000 && solUsd.v) return solUsd.v;
  try {
    const q = await quote(SOL_MINT, USDC_MINT, 1e9);
    solUsd = { v: Number(q.outAmount) / 1e6, at: Date.now() };
  } catch {}
  return solUsd.v;
}
