// Detail on the target's recent successful txs: programs used, SOL change, token changes
import { cfg } from '../src/config.js';
import { conn } from '../src/trader.js';
import { PublicKey } from '@solana/web3.js';
const NAMES = { '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pumpfun', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'pumpswap', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'jupiter', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'raydium', 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'raydium-cpmm', 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'meteora-dlmm', 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG': 'meteora-damm2', 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB': 'meteora-damm', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'orca', 'ComputeBudget111111111111111111111111111111': 'cb', '11111111111111111111111111111111': 'system', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'token', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': 'ata', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb': 'token22' };
let all = [], before;
for (let p = 0; p < 15; p++) { const b = await conn.getSignaturesForAddress(new PublicKey(cfg.target), { limit: 1000, before }); if (!b.length) break; all = all.concat(b); before = b[b.length - 1].signature; }
const span = ((all[0].blockTime - all[all.length - 1].blockTime) / 3600).toFixed(2);
const okAll = all.filter((s) => !s.err);
console.log(`${all.length} txs over ${span}h, ${okAll.length} succeeded`);
const sigs = okAll.slice(0, 25);
for (const s of sigs) {
  const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1 });
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toString());
  const i = keys.indexOf(cfg.target);
  const progs = [...new Set(tx.transaction.message.instructions.map((x) => NAMES[x.programId.toString()] || x.programId.toString().slice(0, 8)))];
  const tok = {};
  for (const b of tx.meta.preTokenBalances || []) if (b.owner === cfg.target) tok[b.mint] = -Number(b.uiTokenAmount.uiAmount || 0);
  for (const b of tx.meta.postTokenBalances || []) if (b.owner === cfg.target) tok[b.mint] = (tok[b.mint] || 0) + Number(b.uiTokenAmount.uiAmount || 0);
  console.log(`${s.signature.slice(0, 12)} signer=${keys[0] === cfg.target} sol=${i >= 0 ? ((tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9).toFixed(5) : 'n/a'} progs=${progs.join(',')}`);
  for (const [m, d] of Object.entries(tok)) if (Math.abs(d) > 0) console.log(`    ${m.slice(0, 8)} ${d > 0 ? '+' : ''}${d}`);
}
const f = (await conn.getSignaturesForAddress(new PublicKey(cfg.target), { limit: 1000 })).find((s) => s.err);
if (f) {
  const tx = await conn.getParsedTransaction(f.signature, { maxSupportedTransactionVersion: 1 });
  const progs = [...new Set(tx.transaction.message.instructions.map((x) => NAMES[x.programId.toString()] || x.programId.toString().slice(0, 8)))];
  console.log(`\nsample failed: progs=${progs.join(',')} err=${JSON.stringify(f.err).slice(0, 100)}`);
  console.log((tx.meta.logMessages || []).slice(-4).join('\n').slice(0, 600));
}
