// Oldest-first scan via Helius getTransactionsForAddress; finds the first launch with a ticker paired to a quote mint.
import { PublicKey } from '@solana/web3.js';
import { conn } from '../src/trader.js';
import { cfg } from '../src/config.js';
const addr = process.argv[2]; const want = (process.argv[3] || '').replace('$', '').toUpperCase();
const LAUNCHLAB = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
const rpc = async (method, params) => { const r = await fetch(cfg.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); return r.json(); };
const das = async (id) => (await rpc('getAsset', { id })).result?.content?.metadata || {};
const r = await rpc('getTransactionsForAddress', [addr, { transactionDetails: 'signatures', sortOrder: 'asc', limit: 1000, filters: { status: 'succeeded' } }]);
if (r.error) { console.log('getTransactionsForAddress error:', JSON.stringify(r.error).slice(0, 300)); process.exit(0); }
const sigs = r.result?.data || [];
console.log(`oldest ${sigs.length} txs: first ${new Date(sigs[0].blockTime * 1000).toISOString()} slot ${sigs[0].slot}`);
const t0 = sigs[0];
let found = null, n = 0;
for (const s of sigs) {
  const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1 });
  if (!tx) continue;
  const progs = new Set([...tx.transaction.message.instructions.map((i) => i.programId.toString()), ...(tx.meta.innerInstructions || []).flatMap((g) => g.instructions.map((i) => i.programId.toString()))]);
  const logs = (tx.meta.logMessages || []).filter((l) => /Instruction: /.test(l)).map((l) => l.replace('Program log: Instruction: ', ''));
  const signer = tx.transaction.message.accountKeys[0].pubkey.toString();
  if (n < 3) { console.log(`tx#${n} slot ${s.slot} +${s.slot - t0.slot} signer ${signer.slice(0, 6)} ix ${[...new Set(logs)].slice(0, 8).join(',')}`); }
  n++;
  if (!progs.has(LAUNCHLAB) || !logs.some((l) => /^Initialize/.test(l))) continue;
  const mints = [...new Set((tx.meta.postTokenBalances || []).map((b) => b.mint))].filter((m) => m !== addr);
  for (const m of mints) {
    const md = await das(m);
    const hit = (md.symbol || '').replace('$', '').toUpperCase() === want;
    console.log(`LAUNCH slot ${s.slot} (+${s.slot - t0.slot} slots, +${s.blockTime - t0.blockTime}s) ${hit ? '>>> ' : ''}$${md.symbol} ${m} by ${signer.slice(0, 6)} [${logs.filter((l) => /Initialize|Buy/.test(l)).join(',')}]`);
    if (hit && !found) found = { m, s, signer };
  }
  if (found && n > 60) break;
}
if (!found) { console.log(`no $${want} in first ${n}`); process.exit(0); }
const ms = (await rpc('getTransactionsForAddress', [found.m, { transactionDetails: 'signatures', sortOrder: 'asc', limit: 15, filters: { status: 'succeeded' } }])).result?.data || [];
console.log(`\nfirst trades on $${want} (${found.m}):`);
for (const x of ms) {
  const t = await conn.getParsedTransaction(x.signature, { maxSupportedTransactionVersion: 1 });
  const sg = t.transaction.message.accountKeys[0].pubkey.toString();
  const lg = (t.meta.logMessages || []).filter((q) => /Instruction: (Buy|Sell|Initialize)/.test(q)).map((q) => q.replace('Program log: Instruction: ', '')).join(',');
  console.log(`  slot ${x.slot} (+${x.slot - found.s.slot}) idx ${x.transactionIndex ?? '?'} ${sg.slice(0, 6)} ${lg || 'other'}`);
}
process.exit(0);
