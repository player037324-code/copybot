// Who bought a coin first, in what slot, and what fees they paid.  usage: node scripts/race.js <mint> [n]
import { conn } from '../src/trader.js';
import { cfg } from '../src/config.js';
import { PublicKey } from '@solana/web3.js';
const mint = process.argv[2]; const N = Number(process.argv[3] || 14);
const JITO = new Set(['96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5','HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe','Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY','ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49','DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh','ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt','DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL','3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT']);
const SENDER = new Set(['4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE','D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ','9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta','5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn','2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD','2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ','wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF','3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT','4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey','4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or']);
let all = [], before;
for (let p = 0; p < 6; p++) { const b = await conn.getSignaturesForAddress(new PublicKey(mint), { limit: 1000, before }); if (!b.length) break; all = all.concat(b); before = b[b.length - 1].signature; }
const ok = all.filter((s) => !s.err).reverse();
const lunarIdx = await (async () => { for (let i = 0; i < ok.length; i++) { const t = await conn.getParsedTransaction(ok[i].signature, { maxSupportedTransactionVersion: 1 }); if (t.transaction.message.accountKeys[0].pubkey.toString() === cfg.target) return i; } return 0; })();
const start = Math.max(0, lunarIdx - 3);
console.log(`${ok.length} successful txs on this coin. Lunar's buy is #${lunarIdx}. Showing from #${start}:`);
let lunarSlot = null;
for (const s of ok.slice(start, start + N)) {
  const t = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1 });
  const keys = t.transaction.message.accountKeys; const signer = keys[0].pubkey.toString();
  let cuPrice = 0, cuLimit = 0, tip = 0, tipTo = '';
  for (const ix of t.transaction.message.instructions) {
    const pid = ix.programId.toString();
    if (pid === 'ComputeBudget111111111111111111111111111111' && ix.data) {
      const d = Buffer.from(require_bs58(ix.data));
      if (d[0] === 3) cuPrice = Number(d.readBigUInt64LE(1)); if (d[0] === 2) cuLimit = d.readUInt32LE(1);
    }
    if (ix.parsed?.type === 'transfer' && ix.program === 'system') { const to = ix.parsed.info.destination; if (JITO.has(to)) { tip += ix.parsed.info.lamports; tipTo = 'jito'; } else if (SENDER.has(to)) { tip += ix.parsed.info.lamports; tipTo = 'helius'; } else if (ix.parsed.info.lamports < 1e8 && signer === ix.parsed.info.source && to !== mint) { tip += ix.parsed.info.lamports; tipTo = tipTo || `other:${to.slice(0, 6)}`; } }
  }
  const i = keys.findIndex((k) => k.pubkey.toString() === signer);
  const sol = (t.meta.postBalances[i] - t.meta.preBalances[i]) / 1e9;
  if (signer === cfg.target) lunarSlot = s.slot;
  const who = signer === cfg.target ? 'LUNAR' : signer === process.env.OUR ? 'US   ' : signer.slice(0, 5) + '';
  const progs = [...new Set(t.transaction.message.instructions.map((x) => x.programId.toString().slice(0, 4)))].join(',');
  console.log(`slot ${s.slot}${lunarSlot ? ` (+${s.slot - lunarSlot})` : ''}  ${who.padEnd(6)} sol ${sol.toFixed(3).padStart(8)}  prio ${((cuPrice * (cuLimit || 200000)) / 1e15).toFixed(5)} SOL (${cuPrice}uL x ${cuLimit})  tip ${(tip / 1e9).toFixed(4)} ${tipTo}  fee ${(t.meta.fee / 1e9).toFixed(5)}  progs ${progs}`);
}
function require_bs58(s) { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c)); let h = n.toString(16); if (h.length % 2) h = '0' + h; const out = Buffer.from(h === '00' ? '' : h, 'hex'); let z = 0; for (const c of s) { if (c === '1') z++; else break; } return Buffer.concat([Buffer.alloc(z), out]); }
