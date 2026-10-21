// pfwatch: alerts when a pump.fun trader has a freshly set up profile with a linked X account.
//  feed:    pump.fun's own public realtime trade feed (NATS, same one pump.fun's website uses). Costs 0 Helius credits.
//  lookup:  each new wallet's profile once via frontend-api-v3.pump.fun/users/<wallet>
//  alert:   x_username linked AND username set within PF_NEW_HOURS -> Telegram (photo + wallet + links)
//  recheck: recent profiles without X yet are rechecked every PF_RECHECK_MIN until PF_NEW_HOURS passes,
//           so someone who links X after their first trade still gets caught.
// Never trades.
import 'dotenv/config';
import fs from 'fs';
import WebSocket from 'ws';

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k].trim());
const NEW_HOURS = Number(env('PF_NEW_HOURS', '48'));
const QPS = Number(env('PF_QPS', '20'));
const RECHECK_MIN = Number(env('PF_RECHECK_MIN', '30'));
const SUBJECT = env('PF_SUBJECT', 'unifiedTradeEvent.processed');
const DRY = env('PF_DRY', 'false') === 'true'; // true = log alerts but don't send Telegram
const MIN_FOLLOWERS = Number(env('PF_MIN_FOLLOWERS', '0'));
const TG_TOKEN = env('TELEGRAM_BOT_TOKEN', ''); const TG_CHAT = env('PF_TELEGRAM_CHAT_ID', env('TELEGRAM_CHAT_ID', ''));
const HELIUS = env('HELIUS_API_KEY', '');
const API = 'https://frontend-api-v3.pump.fun/users/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
const H = { origin: 'https://pump.fun', referer: 'https://pump.fun/', 'user-agent': UA, accept: 'application/json' };
const STATE = 'logs/pfwatch-state.json';
const FEED = 'logs/pfwatch.jsonl';
fs.mkdirSync('logs', { recursive: true });

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const warn = (...a) => console.warn(`[${ts()}] WARN`, ...a);

// alerted: wallet -> time (never alert twice). watch: wallet -> {until, next} for recheck.
let state = { alerted: {}, watch: {} };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; } catch {}
const save = () => { try { fs.writeFileSync(STATE + '.tmp', JSON.stringify(state)); fs.renameSync(STATE + '.tmp', STATE); } catch (e) { warn('save', e.message); } };
setInterval(save, 60000);

// ---- seen set: two generations so memory stays bounded ----
const GEN_MAX = 1_500_000;
let seenA = new Set(), seenB = new Set();
const isSeen = (w) => seenA.has(w) || seenB.has(w);
const markSeen = (w) => { seenA.add(w); if (seenA.size > GEN_MAX) { seenB = seenA; seenA = new Set(); log('seen set rotated'); } };

// ---- lookup queue (newest first; old backlog is dropped, wallet gets re-queued next time it trades) ----
const queue = []; const queued = new Map(); // wallet -> first trade info
const QMAX = 30000;
function enqueue(w, trade) {
  if (isSeen(w) || queued.has(w) || state.alerted[w]) return;
  queued.set(w, trade); queue.push(w);
  if (queue.length > QMAX) { const d = queue.splice(0, queue.length - QMAX); d.forEach((x) => queued.delete(x)); stats.dropped += d.length; }
}

const stats = { trades: 0, lookups: 0, users: 0, withX: 0, recentX: 0, alerts: 0, r429: 0, err: 0, dropped: 0, since: Date.now() };
let pauseUntil = 0;
async function profile(w) {
  const r = await fetch(API + w, { headers: H, signal: AbortSignal.timeout(8000) });
  stats.lookups++;
  if (r.status === 404) return null;
  if (r.status === 429) { stats.r429++; const ra = Number(r.headers.get('retry-after')) || 5; pauseUntil = Date.now() + ra * 1000; throw Object.assign(new Error('429'), { retry: true }); }
  if (!r.ok) { stats.err++; throw Object.assign(new Error(`HTTP ${r.status}`), { retry: r.status >= 500 }); }
  return r.json();
}

const fresh = (p) => p.last_username_update_timestamp && Date.now() - Number(p.last_username_update_timestamp) < NEW_HOURS * 3600e3;
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const usd = (x) => { const n = Number(x); if (!isFinite(n) || !n) return '?'; return n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`; };
const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function handle(w, trade, isRecheck = false) {
  let p;
  try { p = await profile(w); }
  catch (e) { if (e.retry) { if (!isRecheck) { queued.set(w, trade); queue.push(w); } } return; }
  markSeen(w);
  if (!p || !p.username) { delete state.watch[w]; return; }
  stats.users++;
  if (p.is_banned) return;
  const recent = fresh(p);
  if (p.x_username) {
    stats.withX++;
    if (recent && (p.followers || 0) >= MIN_FOLLOWERS && !state.alerted[w]) { stats.recentX++; delete state.watch[w]; await alert(w, p, trade, isRecheck); }
    else delete state.watch[w];
    return;
  }
  // profile set up recently but no X yet: keep checking until the window passes
  if (recent && !state.watch[w]) {
    state.watch[w] = { until: Number(p.last_username_update_timestamp) + NEW_HOURS * 3600e3, next: Date.now() + RECHECK_MIN * 60e3, trade };
  } else if (!recent) delete state.watch[w];
}

async function tg(method, body) {
  const j = await (await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, parse_mode: 'HTML', ...body }) })).json();
  if (!j.ok) throw new Error(JSON.stringify(j).slice(0, 160));
}
async function send(text, photo) {
  if (DRY || !TG_TOKEN || !TG_CHAT) return;
  try {
    if (photo) { try { return await tg('sendPhoto', { photo, caption: text }); } catch (e) { warn('photo failed, sending text:', e.message); } }
    await tg('sendMessage', { text, disable_web_page_preview: true });
  } catch (e) { warn('telegram:', e.message); }
}

async function alert(w, p, trade, viaRecheck) {
  state.alerted[w] = Date.now(); stats.alerts++; save();
  const rec = { time: new Date().toISOString(), wallet: w, username: p.username, x: p.x_username, followers: p.followers, following: p.following, setAt: p.last_username_update_timestamp, evm: p.canonical_evm_wallet, bio: p.bio, trade, viaRecheck };
  fs.appendFileSync(FEED, JSON.stringify(rec) + '\n');
  log(`🆕 ${p.username} @${p.x_username} followers=${p.followers} wallet=${w}${viaRecheck ? ' (linked X after first trade)' : ''}`);
  const t = trade || {};
  if (t.mint && !t.symbol && HELIUS) {
    try { const j = await (await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: t.mint } }), signal: AbortSignal.timeout(5000) })).json(); t.symbol = j.result?.content?.metadata?.symbol; } catch {}
  }
  const tradeLine = t.mint ? `First seen: ${t.type === 'sell' ? 'sold' : 'bought'} ${t.symbol ? '$' + esc(t.symbol) : t.mint.slice(0, 6) + '…'} @ ${usd(t.mcap)} mcap${t.sol ? ` (${Number(t.sol).toFixed(2)} SOL)` : ''}` : '';
  const head = [
    `🆕 <b>NEW PUMP PROFILE</b>${viaRecheck ? ' (just linked X)' : ''}`,
    `<b>${esc(p.username)}</b> · <a href="https://x.com/${esc(p.x_username)}">@${esc(p.x_username)}</a>`,
    `Followers: ${(p.followers || 0).toLocaleString('en-US')} · Following: ${(p.following || 0).toLocaleString('en-US')}`,
    `Profile set: ${p.last_username_update_timestamp ? ago(Number(p.last_username_update_timestamp)) : '?'}`,
    tradeLine,
    p.bio ? `Bio: ${esc(String(p.bio).slice(0, 160))}` : '',
  ].filter(Boolean).join('\n');
  const wallets = [`SOL wallet:\n<code>${w}</code>`, p.canonical_evm_wallet ? `EVM wallet:\n<code>${esc(p.canonical_evm_wallet)}</code>` : ''].filter(Boolean).join('\n');
  const links = `<a href="https://pump.fun/profile/${w}">pump.fun</a> · <a href="https://x.com/${esc(p.x_username)}">X</a> · <a href="https://solscan.io/account/${w}">Solscan</a> · <a href="https://gmgn.ai/sol/address/${w}">GMGN</a>`;
  const text = [head, wallets, links].join('\n\n');
  await send(text.length > 1000 ? text.slice(0, 1000) : text, p.profile_image || null);
}

// ---- workers: QPS-limited ----
let inflight = 0;
setInterval(() => {
  if (Date.now() < pauseUntil) return;
  let budget = Math.max(1, Math.round(QPS / 10));
  // rechecks first (few), then new wallets newest-first
  const now = Date.now();
  for (const [w, v] of Object.entries(state.watch)) {
    if (budget <= 0) break;
    if (now > v.until) { delete state.watch[w]; continue; }
    if (now < v.next) continue;
    v.next = now + RECHECK_MIN * 60e3; budget--; inflight++;
    handle(w, v.trade, true).finally(() => inflight--);
  }
  while (budget > 0 && queue.length && inflight < QPS * 2) {
    const w = queue.pop(); const t = queued.get(w); queued.delete(w);
    if (isSeen(w) || state.alerted[w]) continue;
    budget--; inflight++;
    handle(w, t).finally(() => inflight--);
  }
}, 100);

// ---- feed: pump.fun realtime (NATS over websocket) ----
async function natsConfig() {
  const fallback = { url: 'wss://unified-prod.nats.realtime.pump.fun', user: 'subscriber', pass: 'OX745xvUbNQMuFqV' };
  try {
    const html = (await (await fetch('https://pump.fun/', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) })).text()).replace(/\\"/g, '"');
    const m = html.match(/"UNIFIED":\{[^}]*?"servers":"([^"]+)","user":"([^"]+)","pass":"([^"]+)"/);
    if (m) return { url: m[1], user: m[2], pass: m[3] };
    warn('feed config not found on pump.fun page, using saved one');
  } catch (e) { warn('feed config fetch failed, using saved one:', e.message); }
  return fallback;
}

const num = (x) => (x === undefined || x === null ? undefined : Number(x));
function onTrade(raw) {
  let e; try { e = JSON.parse(raw); if (typeof e === 'string') e = JSON.parse(e); } catch { return; }
  const w = e.userAddress || e.user || e.traderPublicKey; if (!w) return;
  stats.trades++;
  if (isSeen(w) || queued.has(w) || state.alerted[w]) return;
  enqueue(w, { mint: e.mintAddress || e.mint, symbol: e.symbol || e.tokenSymbol || e.coinSymbol, type: e.type, mcap: num(e.marketCapUsd ?? e.usdMarketCap), sol: e.quoteMintAddress === 'So11111111111111111111111111111111111111112' ? num(e.quoteAmount) : num(e.solAmount), tx: e.tx, at: e.timestamp });
}

let lastMsg = Date.now();
async function connect() {
  const c = await natsConfig();
  log(`feed: ${c.url} subject ${SUBJECT}`);
  const ws = new WebSocket(c.url, { headers: { origin: 'https://pump.fun', 'user-agent': UA } });
  let buf = ''; let pinger; let subscribed = false;
  ws.on('open', () => { lastMsg = Date.now(); });
  ws.on('message', (d) => {
    lastMsg = Date.now(); buf += d.toString();
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      if (line.startsWith('MSG ') || line.startsWith('HMSG ')) {
        const p = line.split(' '); const total = Number(p[p.length - 1]); const hdr = line.startsWith('HMSG ') ? Number(p[p.length - 2]) : 0;
        if (buf.length < i + 2 + total + 2) break;
        const payload = buf.slice(i + 2 + hdr, i + 2 + total); buf = buf.slice(i + 2 + total + 2);
        onTrade(payload);
      } else {
        buf = buf.slice(i + 2);
        if (line.startsWith('INFO ') && !subscribed) {
          subscribed = true;
          ws.send(`CONNECT ${JSON.stringify({ verbose: false, pedantic: false, lang: 'js', version: '2.0', protocol: 1, headers: true, no_responders: true, user: c.user, pass: c.pass })}\r\nSUB ${SUBJECT} 1\r\nPING\r\n`);
          log('feed connected');
          pinger = setInterval(() => { try { ws.send('PING\r\n'); } catch {} }, 20000);
        } else if (line.startsWith('PING')) ws.send('PONG\r\n');
        else if (line.startsWith('-ERR')) warn('feed', line);
      }
    }
    if (buf.length > 4e6) buf = ''; // never let a bad frame grow forever
  });
  ws.on('error', (e) => warn('feed error', e.message));
  ws.on('close', () => { clearInterval(pinger); warn('feed closed, reconnecting in 3s'); setTimeout(connect, 3000); });
  const dog = setInterval(() => { if (Date.now() - lastMsg > 60000) { warn('feed silent 60s, reconnecting'); clearInterval(dog); try { ws.terminate(); } catch {} } }, 15000);
  ws.on('close', () => clearInterval(dog));
}

setInterval(() => {
  const mins = (Date.now() - stats.since) / 60000;
  log(`stats ${mins.toFixed(0)}m: trades ${stats.trades} (${Math.round(stats.trades / mins / 60)}/s) | lookups ${stats.lookups} | profiles ${stats.users} | with X ${stats.withX} | ALERTS ${stats.alerts} | queue ${queue.length} | rechecking ${Object.keys(state.watch).length} | 429s ${stats.r429} | dropped ${stats.dropped}${DRY ? ' | DRY (no telegram)' : ''}`);
  fs.writeFileSync('logs/pfwatch-stats.json', JSON.stringify({ ...stats, queue: queue.length, watch: Object.keys(state.watch).length, dry: DRY, updated: new Date().toISOString() }));
}, 60000);

log(`pfwatch: alert when a trader has linked X and set their profile within ${NEW_HOURS}h | lookups ${QPS}/s | recheck every ${RECHECK_MIN}m${DRY ? ' | DRY RUN' : ''}`);
setTimeout(() => send(`🟢 <b>Pump profile watcher online</b>\nAlerting new pump.fun profiles with a linked X (set up in the last ${NEW_HOURS}h).`), 5000);
connect();
