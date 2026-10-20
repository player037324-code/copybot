// Show which programs/pools a tx touched and every token balance change. usage: node scripts/txinfo.js <sig>
import { conn } from '../src/trader.js';
const sig = process.argv[2];
const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1 });
if (!tx) { console.log('not found'); process.exit(0); }
const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toString());
console.log(`slot ${tx.slot} err ${JSON.stringify(tx.meta.err)} signer ${keys[0]}`);
const progs = new Set();
const walk = (ix, d) => { progs.add(ix.programId.toString()); };
tx.transaction.message.instructions.forEach((i) => walk(i));
(tx.meta.innerInstructions || []).forEach((g) => g.instructions.forEach((i) => walk(i)));
console.log('programs:', [...progs].join(' '));
const ch = {};
for (const b of tx.meta.preTokenBalances || []) ch[b.accountIndex] = { mint: b.mint, owner: b.owner, pre: Number(b.uiTokenAmount.uiAmount || 0), post: 0 };
for (const b of tx.meta.postTokenBalances || []) { ch[b.accountIndex] = ch[b.accountIndex] || { mint: b.mint, owner: b.owner, pre: 0 }; ch[b.accountIndex].post = Number(b.uiTokenAmount.uiAmount || 0); }
for (const [i, c] of Object.entries(ch)) if (c.pre !== c.post) console.log(`  ${keys[i].slice(0, 8)} owner ${String(c.owner).slice(0, 8)} mint ${c.mint.slice(0, 8)} ${c.pre} -> ${c.post} (${(c.post - c.pre).toFixed(4)})`);
console.log('tx fee (base+priority):', (tx.meta.fee / 1e9).toFixed(6), 'SOL  CU used', tx.meta.computeUnitsConsumed);
for (const ix of tx.transaction.message.instructions) {
  if (ix.parsed?.type === 'transfer' && ix.program === 'system') console.log(`  TRANSFER ${(ix.parsed.info.lamports / 1e9).toFixed(6)} SOL -> ${ix.parsed.info.destination}`);
  if (ix.programId.toString() === 'ComputeBudget111111111111111111111111111111') { const d = Buffer.from((await import('bs58')).default.decode(ix.data)); if (d[0] === 2) console.log('  CU limit', d.readUInt32LE(1)); if (d[0] === 3) console.log('  CU price', Number(d.readBigUInt64LE(1)), 'microLamports'); }
}
console.log('SOL change signer:', ((tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9).toFixed(4));
(tx.meta.logMessages || []).filter((l) => /Instruction: |invoke \[1\]|invoke \[2\]/.test(l)).slice(0, 25).forEach((l) => console.log('  ' + l));
process.exit(0);
