// callouts: instant Telegram alert when a watched pump.fun user posts a callout on any coin.
// Source: pump.fun's public realtime feed (NATS "calloutCreated" on the CORE cluster). No Helius credits, no pump.fun API calls.
// Watchlist: CALLOUT_WATCH = comma list of wallet addresses and/or pump.fun userIds (default: Kimchi).
import 'dotenv/config';
import fs from 'fs';
import WebSocket from 'ws';

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k].trim());
const WATCH = new Set(env('CALLOUT_WATCH', 'Gs5FHwYLrDBmCmiv5VhBLCvyiBmBYfcPedZDqR88GYeX,ea1951bf-9885-4dca-9f28-82830824ce3c').split(',').map((s) => s.trim()).filter(Boolean));
const TG_TOKEN = env('TELEGRAM_BOT_TOKEN', ''); const TG_CHAT = env('CALLOUT_TELEGRAM_CHAT_ID', env('TELEGRAM_CHAT_ID', ''));
const CORE = { url: env('CALLOUT_NATS_URL', 'wss://prod-v2.nats.realtime.pump.fun'), user: env('CALLOUT_NATS_USER', 'subscriber'), pass: env('CALLOUT_NATS_PASS', 'lW5a9y20NceF6AE9') };
const SUBJECT = 'calloutCreated';
const LIVE_TEST = process.argv[2] === '--live-test';
fs.mkdirSync('logs', { recursive: true });
const FEED = 'logs/callouts.jsonl';
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const warn = (...a) => console.warn(`[${ts()}] WARN`, ...a);
const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const usd = (x) => { const n = Number(x); if (!isFinite(n) || !n) return null; return n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`; };
const stats = { msgs: 0, callouts: 0, hits: 0, since: Date.now() };
const sent = new Set();

async function tg(text, photo) {
  if (!TG_TOKEN || !TG_CHAT) return warn('telegram not configured');
  const call = async (method, body) => {
    const j = await (await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, parse_mode: 'HTML', ...body }) })).json();
    if (!j.ok) throw new Error(JSON.stringify(j).slice(0, 160));
  };
  try {
    if (photo) { try { return await call('sendPhoto', { photo, caption: text.slice(0, 1020) }); } catch (e) { warn('photo failed:', e.message); } }
    await call('sendMessage', { text, disable_web_page_preview: true });
  } catch (e) { warn('telegram:', e.message); }
}

// market cap: DexScreener (free); short timeout so it never delays the alert much
async function mcap(mint) {
  try {
    const j = await (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(2500) })).json();
    const p = (j.pairs || []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return p ? (p.marketCap || p.fdv) : null;
  } catch { return null; }
}

const ipfs = (u) => (!u ? null : u.startsWith('http') ? u : `https://ipfs.io/ipfs/${u.replace(/^ipfs:\/\//, '')}`);
let onCallout = async function (raw) {
  let e; try { e = JSON.parse(raw); if (typeof e === 'string') e = JSON.parse(e); } catch { return; }
  stats.callouts++;
  const a = e.author || {};
  if (!LIVE_TEST && !(WATCH.has(a.walletAddress) || WATCH.has(a.userId))) return;
  if (sent.has(e.id)) return; sent.add(e.id);
  stats.hits++;
  const coin = e.coin || {}; const c = e.callout || {};
  const mint = coin.mint || c.coinMint;
  fs.appendFileSync(FEED, JSON.stringify({ seenAt: new Date().toISOString(), ...e }) + '\n');
  log(`📣 CALLOUT by ${a.userName}: $${coin.symbol} ${mint} (${c.type || e.kind})`);
  const co = c.callout || {};
  const mc = co.calloutMarketCap || (mint && !String(mint).startsWith('0x') ? await mcap(mint) : null);
  const text = co.thesis || c.text || c.message || c.content || c.body || c.comment || e.text || e.message || '';
  const lines = [
    LIVE_TEST ? `🧪 <b>LIVE TEST</b> (real callout by ${esc(a.userName)}, NOT Kimchi, don't ape)` : `📣 <b>CALLOUT: ${esc(a.userName || 'watched user')}</b>`,
    `<b>$${esc(coin.symbol || '?')}</b>${mc ? ` @ ${usd(mc)} mcap` : ''}`,
    text ? `"${esc(String(text).slice(0, 300))}"` : '',
    c.costBasisUsd ? `Their bag: ${usd(c.costBasisUsd)}${c.costBasisSol ? ` (${Number(c.costBasisSol).toFixed(2)} SOL)` : ''}${c.isExited ? ' (exited)' : ''}` : '',
    '',
    `CA:\n<code>${esc(mint)}</code>`,
    '',
    `<a href="https://pump.fun/coin/${mint}">pump.fun</a> · <a href="https://dexscreener.com/solana/${mint}">Dex</a> · <a href="https://axiom.trade/t/${mint}">Axiom</a> · <a href="https://gmgn.ai/sol/token/${mint}">GMGN</a> · <a href="https://pump.fun/profile/${a.walletAddress}">profile</a>`,
  ];
  await tg(lines.join('\n').replace(/\n{3,}/g, '\n\n'), ipfs(coin.imageUri));
  if (LIVE_TEST) { log('live test alert sent'); process.exit(0); }
};

let lastMsg = Date.now();
function connect() {
  log(`feed: ${CORE.url} subject ${SUBJECT} | watching ${[...WATCH].join(', ')}`);
  const ws = new WebSocket(CORE.url, { headers: { origin: 'https://pump.fun', 'user-agent': 'Mozilla/5.0' } });
  let buf = ''; let subscribed = false; let pinger;
  ws.on('message', (d) => {
    lastMsg = Date.now(); buf += d.toString(); let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      if (line.startsWith('MSG ') || line.startsWith('HMSG ')) {
        const p = line.split(' '); const total = Number(p[p.length - 1]); const hdr = line.startsWith('HMSG ') ? Number(p[p.length - 2]) : 0;
        if (buf.length < i + 2 + total + 2) break;
        const payload = buf.slice(i + 2 + hdr, i + 2 + total); buf = buf.slice(i + 2 + total + 2);
        stats.msgs++; onCallout(payload).catch((err) => warn('callout handler', err.message));
      } else {
        buf = buf.slice(i + 2);
        if (line.startsWith('INFO ') && !subscribed) {
          subscribed = true;
          ws.send(`CONNECT ${JSON.stringify({ verbose: false, pedantic: false, lang: 'js', version: '2.0', protocol: 1, headers: true, user: CORE.user, pass: CORE.pass })}\r\nSUB ${SUBJECT} 1\r\nPING\r\n`);
          log('feed connected');
          pinger = setInterval(() => { try { ws.send('PING\r\n'); } catch {} }, 20000);
        } else if (line.startsWith('PING')) ws.send('PONG\r\n');
        else if (line.startsWith('-ERR')) warn('feed', line);
      }
    }
    if (buf.length > 4e6) buf = '';
  });
  ws.on('error', (e) => warn('feed error', e.message));
  // callouts can be quiet for a while, but PONGs to our 20s PINGs keep lastMsg fresh
  const dog = setInterval(() => { if (Date.now() - lastMsg > 90000) { warn('feed silent 90s, reconnecting'); try { ws.terminate(); } catch {} } }, 15000);
  ws.on('close', () => { clearInterval(pinger); clearInterval(dog); warn('feed closed, reconnecting in 2s'); setTimeout(connect, 2000); });
}

setInterval(() => {
  const m = (Date.now() - stats.since) / 60000;
  log(`stats ${m.toFixed(0)}m: ${stats.callouts} callouts seen on pump.fun | ${stats.hits} from watchlist`);
  fs.writeFileSync('logs/callouts-stats.json', JSON.stringify({ ...stats, watch: [...WATCH], updated: new Date().toISOString() }));
}, 5 * 60000);

if (process.argv[2] === '--sample') {
  // print the first few raw callouts from anyone (no Telegram), to check the payload format
  let n = 0; const S = Number(process.argv[3] || 3);
  onCallout = async (raw) => { console.log('\n' + raw.slice(0, 3000)); if (++n >= S) process.exit(0); };
  connect(); setTimeout(() => { console.log(`only ${n} callouts in 100s`); process.exit(0); }, 100000);
} else if (process.argv[2] === '--test') {
  // fire a sample alert so you can see the format in Telegram
  tg(`📣 <b>CALLOUT: Kimchi</b> (TEST)\n<b>$TEST</b> @ $42.0K mcap\n\nCA:\n<code>Gs5FHwYLrDBmCmiv5VhBLCvyiBmBYfcPedZDqR88GYeX</code>\n\nThis is a test. Real callouts from Kimchi will look like this.`).then(() => process.exit(0));
} else connect();
