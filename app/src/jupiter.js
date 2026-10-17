import { cfg } from './config.js';

const BASE = 'https://api.jup.ag/swap/v1';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const headers = { 'x-api-key': cfg.jupKey, 'content-type': 'application/json' };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(url, opts = {}, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...opts, headers });
      if (r.status === 429) { await sleep(150 * (i + 1)); continue; }
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Jupiter ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
      return body;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(100);
    }
  }
  throw lastErr || new Error('Jupiter rate limited');
}

export function quote(inputMint, outputMint, amountRaw, slippageBps = cfg.slippageBps, direct = cfg.onlyDirectRoutes) {
  const q = new URLSearchParams({
    inputMint, outputMint,
    amount: String(amountRaw),
    slippageBps: String(slippageBps),
    restrictIntermediateTokens: 'true',
    onlyDirectRoutes: String(direct),
  });
  return req(`${BASE}/quote?${q}`);
}

// raw instructions so we can add our own priority fee + Sender tip and skip simulation
export function swapInstructions(quoteResponse, userPublicKey) {
  return req(`${BASE}/swap-instructions`, {
    method: 'POST',
    body: JSON.stringify({ quoteResponse, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: false }),
  });
}

let solUsd = { v: 0, at: 0 };
export async function getSolUsd() {
  if (Date.now() - solUsd.at < 60000 && solUsd.v) return solUsd.v;
  try {
    const q = await quote(SOL_MINT, USDC_MINT, 1e9, 50, false);
    solUsd = { v: Number(q.outAmount) / 1e6, at: Date.now() };
  } catch {}
  return solUsd.v;
}

// keep the TLS connection to Jupiter hot
setInterval(() => { getSolUsd().catch(() => {}); }, 20000).unref();
