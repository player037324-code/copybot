// How a token was launched and who bought first. usage: node scripts/launchinfo.js <mint> [pairMint]
import { conn } from '../src/trader.js';
import { cfg } from '../src/config.js';
const mint = process.argv[2]; const pair = process.argv[3];
const rpc = async (method, params) => (await (await fetch(cfg.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
const md = (await rpc('getAsset', { id: mint })).result?.content?.metadata || {};
console.log(`token ${md.name} ($${md.symbol}) ${mint}`);
const sigs = (await rpc('getTransactionsForAddress', [mint, { transactionDetails: 'signatures', sortOrder: 'asc', limit: 25 }])).result?.data || [];
if (!sigs.length) { console.log('no txs'); process.exit(0); }
const t0 = sigs[0];
let pairCreated = null;
if (pair) { const p = (await rpc('getTransactionsForAddress', [pair, { transactionDetails: 'signatures', sortOrder: 'asc', limit: 1 }])).result?.data?.[0]; if (p) pairCreated = p; }
console.log(`created ${new Date(t0.blockTime * 1000).toISOString()} slot ${t0.slot}${pairCreated ? `  (${t0.slot - pairCreated.slot} slots / ${((t0.blockTime - pairCreated.blockTime) / 60).toFixed(1)} min after pair ${pair.slice(0, 6)} was created)` : ''}`);
for (let i = 0; i < sigs.length; i++) {
  const s = sigs[i];
  const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1 });
  if (!tx) continue;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toString());
  const signer = keys[0];
  const progs = [...new Set([...tx.transaction.message.instructions.map((x) => x.programId.toString()), ...(tx.meta.innerInstructions || []).flatMap((g) => g.instructions.map((x) => x.programId.toString()))])].filter((p) => !/^(Compute|Tokenkeg|Tokenz|ATok|1111|Sysvar|memo)/.test(p));
  const ixs = [...new Set((tx.meta.logMessages || []).filter((l) => /Instruction: /.test(l)).map((l) => l.replace(/.*Instruction: /, '')))].filter((x) => !/Transfer|GetAccountData|InitializeImmutable|InitializeAccount3|SyncNative|CloseAccount|Create$|CreateIdempotent/.test(x));
  const tok = (tx.meta.postTokenBalances || []).find((b) => b.mint === mint && b.owner === signer);
  const pre = (tx.meta.preTokenBalances || []).find((b) => b.mint === mint && b.owner === signer);
  const got = (Number(tok?.uiTokenAmount.uiAmount || 0) - Number(pre?.uiTokenAmount.uiAmount || 0));
  const pairCh = (() => { const a = (tx.meta.preTokenBalances || []).find((b) => b.mint === pair && b.owner === signer); const b = (tx.meta.postTokenBalances || []).find((b) => b.mint === pair && b.owner === signer); return pair ? Number(b?.uiTokenAmount.uiAmount || 0) - Number(a?.uiTokenAmount.uiAmount || 0) : 0; })();
  const sol = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
  console.log(`#${i} slot ${s.slot} (+${s.slot - t0.slot}) ${s.err ? 'FAIL ' : ''}${signer.slice(0, 6)} sol ${sol.toFixed(3)}${pair ? ` pair ${pairCh.toFixed(2)}` : ''} tokens ${got.toFixed(0)} | ${ixs.join(',').slice(0, 90)} | ${progs.map((p) => p.slice(0, 6)).join(',')}`);
  if (i === 0) {
    console.log(`   creation programs: ${progs.join(' ')}`);
    console.log(`   creation logs: ${(tx.meta.logMessages || []).filter((l) => /Program log|invoke \[1\]/.test(l)).slice(0, 14).map((l) => l.replace('Program log: ', '')).join(' | ').slice(0, 900)}`);
  }
}
process.exit(0);
