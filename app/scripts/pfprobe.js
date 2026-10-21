// Measures (1) how much data the pump.fun trade stream costs on Helius and how many unique traders it has,
// (2) how pump.fun's profile API behaves (fields, rate limits) from this server. Read-only, never trades.
import 'dotenv/config';
import WebSocket from 'ws';

const KEY = process.env.HELIUS_API_KEY;
const WSS = `wss://mainnet.helius-rpc.com/?api-key=${KEY}`;
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const SECS = Number(process.argv[2] || 45);

function stream(name, sub, onMsg) {
  return new Promise((res) => {
    const st = { bytes: 0, msgs: 0, users: new Set(), err: null };
    const ws = new WebSocket(WSS);
    ws.on('open', () => ws.send(JSON.stringify(sub)));
    ws.on('message', (b) => { st.bytes += b.length; const m = JSON.parse(b); if (m.error) st.err = JSON.stringify(m.error).slice(0, 150); if (m.method) { st.msgs++; onMsg(m, st); } });
    ws.on('error', (e) => (st.err = e.message));
    setTimeout(() => { ws.close(); res({ name, ...st, users: st.users.size, sample: [...st.users].slice(0, 30) }); }, SECS * 1000);
  });
}

// pump TradeEvent: disc(8) mint(32) sol(8) tokens(8) is_buy(1) user(32). pumpswap Buy/SellEvent: user at 8+8*? -> just take signer via tx stream
import bs58 from 'bs58';
const TRADE_DISC = Buffer.from('bddb7fd34ee661ee', 'hex');
const logsSub = (id, prog) => ({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [prog] }, { commitment: 'confirmed' }] });
const onLogs = (m, st) => {
  for (const l of m.params.result.value.logs || []) {
    if (!l.startsWith('Program data: ')) continue;
    const b = Buffer.from(l.slice(14), 'base64');
    if (b.length >= 89 && b.subarray(0, 8).equals(TRADE_DISC)) st.users.add(bs58.encode(b.subarray(57, 89)));
  }
};
const txSub = { jsonrpc: '2.0', id: 3, method: 'transactionSubscribe', params: [{ accountInclude: [PUMP, AMM], failed: false, vote: false }, { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'accounts', showRewards: false, maxSupportedTransactionVersion: 1 }] };
const onTx = (m, st) => { const k = m.params.result.transaction?.transaction?.accountKeys?.find((a) => a.signer); if (k) st.users.add(k.pubkey); };

console.log(`measuring ${SECS}s of each stream in parallel...`);
const [a, b, c] = await Promise.all([stream('logs pump.fun', logsSub(1, PUMP), onLogs), stream('logs pumpswap', logsSub(2, AMM), () => {}), stream('tx accounts both', txSub, onTx)]);
for (const s of [a, b, c]) {
  const mbDay = (s.bytes / 1e6) * (86400 / SECS);
  console.log(`${s.name}: ${s.msgs} msgs, ${(s.bytes / 1e6).toFixed(2)} MB, unique traders ${s.users}, ~${mbDay.toFixed(0)} MB/day = ~${Math.round(mbDay * 20 / 1000)}k credits/day ${s.err ? 'ERR ' + s.err : ''}`);
}

// ---- profile API ----
const hosts = ['https://frontend-api-v3.pump.fun/users/'];
const H = { origin: 'https://pump.fun', referer: 'https://pump.fun/', 'user-agent': 'Mozilla/5.0', accept: 'application/json' };
const kim = await fetch(hosts[0] + 'Gs5FHwYLrDBmCmiv5VhBLCvyiBmBYfcPedZDqR88GYeX', { headers: H });
console.log(`\nprofile kimchi: HTTP ${kim.status} ${(await kim.text()).slice(0, 400)}`);
const wallets = [...new Set([...c.sample, ...a.sample])].slice(0, 60);
const t0 = Date.now(); const codes = {}; let named = 0, withX = 0; const ex = [];
let i = 0;
await Promise.all(Array.from({ length: 10 }, async () => {
  while (i < wallets.length) {
    const w = wallets[i++];
    try {
      const r = await fetch(hosts[0] + w, { headers: H }); codes[r.status] = (codes[r.status] || 0) + 1;
      const t = await r.text();
      if (r.status === 200) { const j = JSON.parse(t); if (j.username) named++; if (j.x_username) withX++; if (ex.length < 3) ex.push(t.slice(0, 250)); }
      else if (ex.length < 6) ex.push(`${r.status}: ${t.slice(0, 150)} ratelimit=${r.headers.get('x-ratelimit-remaining') || ''} retry=${r.headers.get('retry-after') || ''}`);
    } catch (e) { codes.err = (codes.err || 0) + 1; }
  }
}));
console.log(`profile lookups: ${wallets.length} in ${Date.now() - t0}ms, codes ${JSON.stringify(codes)}, with username ${named}, with X ${withX}`);
ex.forEach((e) => console.log('  ' + e));
process.exit(0);
