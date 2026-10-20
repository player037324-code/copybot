// What just happened on a pool token: newest txs, programs, and any new mints created.
import 'dotenv/config';
const RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const a = process.argv[2];
const rpc = async (m, p) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) })).json());
let txs = [], tok; for (let i = 0; i < 6; i++) { const r = await rpc('getTransactionsForAddress', [a, { transactionDetails: 'full', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, sortOrder: 'desc', limit: 100, filters: { status: 'succeeded', blockTime: { gte: Math.floor(Date.now() / 1000) - 3600 } }, ...(tok ? { paginationToken: tok } : {}) }]); txs = txs.concat(r.result?.data || []); tok = r.result?.paginationToken; if (!tok) break; }
txs.reverse();
const { parseLaunch } = await import('../src/sniper.js');
for (const t of txs) { const L = parseLaunch(t); if (L && L.quote === a) console.log(`LAUNCH ${new Date(t.blockTime * 1000).toISOString().slice(11, 19)} slot ${t.slot} $${L.symbol} (${L.name}) ${L.base} platform ${L.platform.slice(0, 6)} top-level ${t.transaction.message.instructions.map((i) => i.programId.toString().slice(0, 6)).join(',')}`); }
console.log(`${txs.length} txs in last 60 min touching ${a.slice(0, 6)}`);
const seen = new Set();
for (const t of txs) {
  const progs = [...new Set([...t.transaction.message.instructions.map((i) => i.programId.toString()), ...(t.meta.innerInstructions || []).flatMap((g) => g.instructions.map((i) => i.programId.toString()))])].filter((p) => !/^(Compute|Tokenkeg|Tokenz|ATok|1111|Sysvar|memo|metaq)/.test(p));
  const logs = [...new Set((t.meta.logMessages || []).filter((l) => /Instruction: /.test(l)).map((l) => l.replace(/.*Instruction: /, '')))].filter((x) => !/Transfer|GetAccount|InitializeImm|InitializeAcc|SyncNative|CloseAccount|CreateIdem/.test(x));
  const pre = new Set((t.meta.preTokenBalances || []).map((b) => b.mint));
  const newM = [...new Set((t.meta.postTokenBalances || []).map((b) => b.mint))].filter((m) => !pre.has(m) && m !== a && !seen.has(m) && m !== 'So11111111111111111111111111111111111111112');
  const created = /InitializeMint|Initialize(WithToken2022)?$|InitializeV2|Create/.test(logs.join(','));
  if (created && newM.length) {
    for (const m of newM) { seen.add(m); const md = (await rpc('getAsset', { id: m })).result?.content?.metadata || {};
      console.log(`${new Date(t.blockTime * 1000).toISOString().slice(11, 19)} NEW TOKEN $${md.symbol} (${md.name}) ${m} | ${logs.slice(0, 6).join(',')} | programs ${progs.join(' ')} | signer ${t.transaction.message.accountKeys[0].pubkey.toString().slice(0, 6)}`); }
  }
}
const pc = {}; for (const t of txs) for (const i of t.transaction.message.instructions) { const p = i.programId.toString(); pc[p] = (pc[p] || 0) + 1; }
console.log('top-level programs:', Object.entries(pc).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => k.slice(0, 8) + ':' + v).join(' '));
process.exit(0);
