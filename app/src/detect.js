// Turns a target-wallet transaction into BUY / SELL events.
import { SOL_MINT } from './jupiter.js';

const IGNORE = new Set([
  SOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

function sumByMint(balances, owner) {
  const out = {};
  for (const b of balances || []) {
    if (b.owner !== owner) continue;
    const amt = BigInt(b.uiTokenAmount.amount);
    if (!out[b.mint]) out[b.mint] = { amt: 0n, decimals: b.uiTokenAmount.decimals };
    out[b.mint].amt += amt;
  }
  return out;
}

export function parseTrades(tx, target) {
  if (!tx || !tx.meta || tx.meta.err) return [];
  const raw = tx.transaction.message.accountKeys;
  const keys = raw.map((k) => (typeof k === 'string' ? k : k.pubkey.toString()));
  const idx = keys.indexOf(target);
  // only count transactions the target actually signed (ignores the spam that just mentions it)
  if (idx < 0 || (typeof raw[idx] === 'object' && raw[idx].signer === false)) return [];
  const solDelta = idx >= 0 ? (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9 : 0;

  // count wrapped SOL movement as SOL too
  const pre = sumByMint(tx.meta.preTokenBalances, target);
  const post = sumByMint(tx.meta.postTokenBalances, target);
  const wsolDelta = Number(((post[SOL_MINT]?.amt ?? 0n) - (pre[SOL_MINT]?.amt ?? 0n))) / 1e9;
  const totalSolDelta = solDelta + wsolDelta;

  const events = [];
  const mints = new Set([...Object.keys(pre), ...Object.keys(post)]);
  for (const mint of mints) {
    if (IGNORE.has(mint)) continue;
    const a = pre[mint]?.amt ?? 0n;
    const b = post[mint]?.amt ?? 0n;
    if (a === b) continue;
    const decimals = (post[mint] || pre[mint]).decimals;
    if (b > a) {
      // got tokens. Only count it as a buy if they spent SOL (not an airdrop/transfer in)
      if (totalSolDelta < 0) events.push({ type: 'BUY', mint, decimals, solSpent: -totalSolDelta, isNew: a === 0n });
    } else {
      const fraction = a === 0n ? 1 : Number(a - b) / Number(a);
      events.push({ type: 'SELL', mint, decimals, fraction: Math.min(1, fraction), solGot: Math.max(0, totalSolDelta) });
    }
  }
  return events;
}
