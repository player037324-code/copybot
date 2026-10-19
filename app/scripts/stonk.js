// Investigate a StonkFun pairing address: what it is, first launches paired to it, tickers, first buyers.
// usage: node scripts/stonk.js <address> [ticker]
import { PublicKey } from '@solana/web3.js';
import { conn } from '../src/trader.js';
import { cfg } from '../src/config.js';
const addr = process.argv[2]; const want = (process.argv[3] || '').replace('$', '').toUpperCase();
const LAUNCHLAB = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
const info = await conn.getParsedAccountInfo(new PublicKey(addr));
const v = info.value;
console.log(`address ${addr}: owner ${v?.owner?.toString()} parsed=${v?.data?.parsed ? v.data.parsed.type : 'raw ' + (v?.data?.length ?? '?') + 'B'}`);
if (v?.data?.parsed?.info) console.log('  ', JSON.stringify(v.data.parsed.info).slice(0, 300));
const das = async (id) => { try { const r = await fetch(cfg.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id } }) }); const j = await r.json(); return j.result?.content?.metadata || {}; } catch { return {}; } };
const meta = await das(addr); if (meta.symbol) console.log(`  token: ${meta.name} ($${meta.symbol})`);
let all = [], before;
for (let p = 0; p < 10; p++) { const b = await conn.getSignaturesForAddress(new PublicKey(addr), { limit: 1000, before }); if (!b.length) break; all = all.concat(b); before = b[b.length - 1].signature; if (b.length < 1000) break; }
all.reverse();
console.log(`${all.length} txs. first: ${new Date(all[0].blockTime * 1000).toISOString()} slot ${all[0].slot}  last: ${new Date(all.at(-1).blockTime * 1000).toISOString()}`);
const seenMints = new Map(); let shown = 0;
for (const s of all.slice(0, 400)) {
  if (s.err) continue;
  const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1 });
  if (!tx) continue;
  const progs = new Set([...tx.transaction.message.instructions.map((i) => i.programId.toString()), ...(tx.meta.innerInstructions || []).flatMap((g) => g.instructions.map((i) => i.programId.toString()))]);
  const signer = tx.transaction.message.accountKeys[0].pubkey.toString();
  const logs = (tx.meta.logMessages || []).filter((l) => /Instruction: /.test(l)).map((l) => l.replace('Program log: Instruction: ', '')).join(',');
  const isLL = progs.has(LAUNCHLAB);
  const newMints = [...new Set((tx.meta.postTokenBalances || []).map((b) => b.mint))].filter((m) => m !== addr && !seenMints.has(m) && m !== 'So11111111111111111111111111111111111111112');
  if (shown < 12 && s === all[0]) { console.log(`#0 slot ${s.slot} signer ${signer.slice(0, 6)} ix: ${logs.slice(0, 160)}`); shown++; }
  if (isLL && /Initialize/i.test(logs)) {
    for (const m of newMints) {
      const md = await das(m); seenMints.set(m, { slot: s.slot, t: s.blockTime, sym: md.symbol, name: md.name, creator: signer, sig: s.signature });
      const hit = want && (md.symbol || '').replace('$', '').toUpperCase() === want;
      console.log(`LAUNCH slot ${s.slot} ${new Date(s.blockTime * 1000).toISOString().slice(11, 19)} ${hit ? '>>> ' : ''}$${md.symbol} (${md.name}) mint ${m} creator ${signer.slice(0, 6)}`);
    }
  }
}
if (want) {
  const first = [...seenMints.entries()].find(([, v]) => (v.sym || '').replace('$', '').toUpperCase() === want);
  if (!first) { console.log(`no $${want} launch found in first 400 txs`); process.exit(0); }
  const [mint, l] = first;
  console.log(`\nFIRST $${want}: ${mint} at slot ${l.slot}, ${l.slot - all[0].slot} slots (${l.t - all[0].blockTime}s) after this address's first tx. creator ${l.creator}`);
  const ms = (await conn.getSignaturesForAddress(new PublicKey(mint), { limit: 1000 })).reverse().filter((x) => !x.err).slice(0, 12);
  for (const x of ms) {
    const t = await conn.getParsedTransaction(x.signature, { maxSupportedTransactionVersion: 1 });
    const sg = t.transaction.message.accountKeys[0].pubkey.toString();
    const lg = (t.meta.logMessages || []).filter((q) => /Instruction: (Buy|Sell|Initialize)/.test(q)).map((q) => q.replace('Program log: Instruction: ', '')).join(',');
    const tk = (t.meta.postTokenBalances || []).find((b) => b.mint === mint && b.owner === sg);
    console.log(`  slot ${x.slot} (+${x.slot - l.slot})  ${sg.slice(0, 6)}  ${lg || 'other'}  holds ${tk ? Number(tk.uiTokenAmount.uiAmount).toFixed(0) : 0}`);
  }
}
process.exit(0);
