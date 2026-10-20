// Race OrbitFlare gRPC (Yellowstone) vs Helius websocket on live launches for a pool. Never trades.
// usage: node scripts/feedrace.js <poolMint> [seconds] [grpcUrl]
import 'dotenv/config';
import WebSocket from 'ws';
import bs58 from 'bs58';
import YS from '@triton-one/yellowstone-grpc';
const Client = YS.default || YS.Client || YS;
const PROCESSED = 0; // yellowstone CommitmentLevel.PROCESSED
const pool = process.argv[2]; const secs = Number(process.argv[3] || 120); const grpcUrl = process.argv[4] || process.env.ORBIT_GRPC || 'http://ny.rpc.orbitflare.com:10000';
const LL = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
const seen = {}; const mark = (sig, src) => { (seen[sig] ||= {})[src] ||= performance.now(); };
// Helius beta (our current fastest)
const ws = new WebSocket(`wss://beta.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, { perMessageDeflate: false });
ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'transactionSubscribe', params: [{ accountRequired: [LL, pool], failed: false, vote: false }, { commitment: 'processed', encoding: 'base64', transactionDetails: 'signatures', maxSupportedTransactionVersion: 1 }] })));
ws.on('message', (d) => { try { const m = JSON.parse(d); const s = m.params?.result?.signature; if (s) mark(s, 'helius'); } catch {} });
// OrbitFlare gRPC
let grpcOk = false;
try {
  const client = new Client(grpcUrl, undefined, { 'grpc.max_receive_message_length': 64 * 1024 * 1024 });
  await client.connect?.();
  const stream = await client.subscribe();
  stream.on('data', (u) => { if (u.transaction?.transaction?.signature) { grpcOk = true; mark(bs58.encode(u.transaction.transaction.signature), 'orbit'); } });
  stream.on('error', (e) => console.log('grpc error:', (e.details || e.message || '').slice(0, 200), 'code', e.code));
  stream.write({ accounts: {}, slots: {}, transactions: { t: { vote: false, failed: false, accountInclude: [], accountExclude: [], accountRequired: [LL, pool] } }, transactionsStatus: {}, entry: {}, blocks: {}, blocksMeta: {}, accountsDataSlice: [], commitment: PROCESSED });
  console.log(`grpc subscribed to ${grpcUrl}`);
} catch (e) { console.log('grpc connect failed:', e.message?.slice(0, 200)); }
setTimeout(() => {
  const both = Object.values(seen).filter((x) => x.helius && x.orbit);
  const lead = both.map((x) => x.helius - x.orbit).sort((a, b) => a - b); // + means orbit earlier
  const only = (k) => Object.values(seen).filter((x) => x[k] && Object.keys(x).length === 1).length;
  console.log(`txs seen: helius ${Object.values(seen).filter((x) => x.helius).length}, orbit ${Object.values(seen).filter((x) => x.orbit).length}, both ${both.length}, only-helius ${only('helius')}, only-orbit ${only('orbit')}`);
  if (lead.length) console.log(`orbit lead over helius (ms, + = orbit faster): median ${lead[Math.floor(lead.length / 2)].toFixed(1)} | p10 ${lead[Math.floor(lead.length * 0.1)].toFixed(1)} | p90 ${lead[Math.floor(lead.length * 0.9)].toFixed(1)} | orbit first in ${lead.filter((x) => x > 0).length}/${lead.length}`);
  else console.log(grpcOk ? 'no overlapping txs' : 'orbit sent nothing (IP not whitelisted? wrong endpoint?)');
  process.exit(0);
}, secs * 1000);
