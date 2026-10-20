// Recent StonkFun launches grouped by pairing pool (quote mint). Flags pools whose token was created recently.
// usage: node scripts/stonkpools.js [hours]
import 'dotenv/config';
import { parseLaunch } from '../src/sniper.js';
const KEY = process.env.HELIUS_API_KEY; const RPC = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const PLATFORM = process.env.SNIPE_PLATFORM || '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt';
const hours = Number(process.argv[2] || 24);
const rpc = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
const since = Math.floor(Date.now() / 1000) - hours * 3600;
const deadline = Date.now() + 70000;
const pools = {}; let token, pages = 0, txs = 0, oldest = null;
while (Date.now() < deadline) {
  const r = await rpc('getTransactionsForAddress', [PLATFORM, { transactionDetails: 'full', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, sortOrder: 'desc', limit: 100, filters: { status: 'succeeded', blockTime: { gte: since } }, ...(token ? { paginationToken: token } : {}) }]);
  if (r.error) { console.log('error:', JSON.stringify(r.error).slice(0, 200)); break; }
  const data = r.result?.data || []; pages++;
  for (const t of data) {
    txs++; oldest = t.blockTime;
    const L = parseLaunch(t); if (!L || L.platform !== PLATFORM) continue;
    const p = pools[L.quote] ||= { n: 0, first: Infinity, last: 0, tickers: {} };
    p.n++; p.first = Math.min(p.first, t.blockTime); p.last = Math.max(p.last, t.blockTime);
    p.tickers[L.symbol] = (p.tickers[L.symbol] || 0) + 1;
  }
  token = r.result?.paginationToken; if (!token || !data.length) break;
}
console.log(`scanned ${txs} StonkFun txs in ${pages} pages, back to ${oldest ? new Date(oldest * 1000).toISOString() : '?'}${Date.now() >= deadline ? ' (time limit hit, older ones not scanned)' : ''}`);
const rows = [];
for (const [q, p] of Object.entries(pools)) {
  const md = (await rpc('getAsset', { id: q })).result?.content?.metadata || {};
  const born = (await rpc('getTransactionsForAddress', [q, { transactionDetails: 'signatures', sortOrder: 'asc', limit: 1 }])).result?.data?.[0]?.blockTime;
  rows.push({ q, sym: md.symbol || '?', name: md.name || '', born, ...p });
}
rows.sort((a, b) => (b.born || 0) - (a.born || 0));
const ago = (t) => { const m = Math.round((Date.now() / 1000 - t) / 60); return m < 120 ? `${m}m ago` : `${(m / 60).toFixed(1)}h ago`; };
for (const r of rows.slice(0, 25)) {
  const top = Object.entries(r.tickers).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `$${k}x${v}`).join(' ');
  const fresh = r.born && Date.now() / 1000 - r.born < 86400 ? 'NEW ' : '    ';
  console.log(`${fresh}$${r.sym.padEnd(8)} ${r.q}  pool token created ${r.born ? ago(r.born) : '?'} | ${r.n} launches, first ${ago(r.first)} | ${top}`);
}
process.exit(0);
