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
import { PublicKey } from '@solana/web3.js';

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k].trim());
const NEW_HOURS = Number(env('PF_NEW_HOURS', '24'));
const QPS = Number(env('PF_QPS', '1')); // pump.fun's Cloudflare limits bursts hard; stay slow
const APP_ONLY = env('PF_APP_ONLY', 'true') === 'true'; // only wallets trading inside pump.fun's own app (real pump users, not bots/terminals)
const TOP = Number(env('PF_TOP', '2000')); // also scan the top N profiles by followers for new entries
const TOP_MIN = Number(env('PF_TOP_MIN', '3'));
const RECHECK_MIN = Number(env('PF_RECHECK_MIN', '30'));
const SUBJECT = env('PF_SUBJECT', 'unifiedTradeEvent.processed.>');
const DRY = env('PF_DRY', 'false') === 'true'; // true = log alerts but don't send Telegram
const MIN_X = Number(env('PF_MIN_X_FOLLOWERS', '2000')); // X followers (not pump.fun followers)
// X follower count via free public mirrors; cached so each handle is fetched once per few hours
const xCache = new Map();
async function xInfo(handle) {
  const k = handle.toLowerCase(); const c = xCache.get(k);
  if (c && Date.now() - c.at < 6 * 3600e3) return c;
  for (const u of [`https://api.vxtwitter.com/${handle}`, `https://api.fxtwitter.com/${handle}`]) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': 'pfwatch/1.0' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = await r.json(); const user = j.user || j;
      const followers = Number(user.followers ?? user.followers_count);
      if (!isFinite(followers)) continue;
      const v = { followers, verified: !!(user.verification?.verified ?? user.verified ?? user.is_blue_verified), name: user.name, at: Date.now() };
      xCache.set(k, v); return v;
    } catch {}
  }
  return null;
}
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
let state = { alerted: {}, watch: {}, top: {} };
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
const prio = []; // gift recipients: looked up before anything else, even if seen before
function enqueue(w, trade) {
  if (isSeen(w) || queued.has(w) || state.alerted[w]) return;
  queued.set(w, trade); queue.push(w);
  if (queue.length > QMAX) { const d = queue.splice(0, queue.length - QMAX); d.forEach((x) => queued.delete(x)); stats.dropped += d.length; }
}

const stats = { apps: {}, topScans: 0, trades: 0, lookups: 0, users: 0, withX: 0, recentX: 0, alerts: 0, r429: 0, err: 0, dropped: 0, since: Date.now() };
let pauseUntil = 0;
async function profile(w) {
  const r = await fetch(API + w, { headers: H, signal: AbortSignal.timeout(8000) });
  stats.lookups++;
  if (r.status === 404) return null;
  if (r.status === 429) { stats.r429++; const ra = Number(r.headers.get('retry-after')) || 5; pauseUntil = Date.now() + ra * 1000; throw Object.assign(new Error('429'), { retry: true }); }
  if (!r.ok) { stats.err++; throw Object.assign(new Error(`HTTP ${r.status}`), { retry: r.status >= 500 }); }
  return r.json();
}

const fresh_ = (p) => p.last_username_update_timestamp && Date.now() - Number(p.last_username_update_timestamp) < NEW_HOURS * 3600e3;
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
const usd = (x) => { const n = Number(x); if (!isFinite(n) || !n) return '?'; return n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`; };
const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function handle(w, trade, isRecheck = false) {
  let p;
  try { p = await profile(w); }
  catch (e) { if (e.retry) { if (trade?.gift) prio.unshift({ w, t: trade }); else if (!isRecheck) { queued.set(w, trade); queue.push(w); } } return; }
  markSeen(w);
  if (!p || !p.username) { delete state.watch[w]; return; }
  stats.users++;
  if (p.is_banned) return;
  const recent = fresh_(p);
  if (p.x_username) {
    stats.withX++;
    if (recent && !(state.alerted[w] > 0) && !(state.alerted[w] < 0 && !trade?.gift)) { stats.recentX++; delete state.watch[w]; if (await bigX(w, p)) await alert(w, p, trade, isRecheck); }
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

// gate: linked X must have > MIN_X followers. Small accounts are logged and never rechecked.
async function bigX(w, p) {
  const x = await xInfo(p.x_username);
  if (!x) { warn(`couldn't read X followers for @${p.x_username}, skipping`); return false; }
  p._x = x;
  if (x.followers < MIN_X) { state.alerted[w] = -x.followers; log(`skip ${p.username} @${p.x_username}: ${x.followers} X followers`); return false; }
  return true;
}
async function alert(w, p, trade, viaRecheck, source = 'trade') {
  state.alerted[w] = Date.now(); stats.alerts++; save();
  const rec = { time: new Date().toISOString(), wallet: w, username: p.username, x: p.x_username, followers: p.followers, xFollowers: p._x?.followers, xVerified: p._x?.verified, following: p.following, setAt: p.last_username_update_timestamp, evm: p.canonical_evm_wallet, bio: p.bio, trade, viaRecheck, source };
  fs.appendFileSync(FEED, JSON.stringify(rec) + '\n');
  log(`🆕 ${p.username} @${p.x_username} X followers=${p._x?.followers} wallet=${w}${viaRecheck ? ' (linked X after first trade)' : ''}`);
  const t = trade || {};
  if (t.mint && !t.symbol && HELIUS) {
    try { const j = await (await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: t.mint } }), signal: AbortSignal.timeout(5000) })).json(); t.symbol = j.result?.content?.metadata?.symbol; } catch {}
  }
  const g = t.gift;
  const giftLine = g ? `🎁 Just got sent <b>${g.pct.toFixed(1)}%</b> of ${g.symbol ? '$' + esc(g.symbol) : 'a coin'}${g.name ? ' (' + esc(g.name) + ')' : ''}${g.byDev ? ' by its dev' : ''}${nameMatch(g, p) ? '\n🎯 Coin name matches them' : ''}\nCA: <code>${g.mint}</code>` : '';
  const tradeLine = g ? giftLine : t.mint ? `First seen: ${t.type === 'sell' ? 'sold' : 'bought'} ${t.symbol ? '$' + esc(t.symbol) : t.mint.slice(0, 6) + '…'} @ ${usd(t.mcap)} mcap${t.usd ? ` (${usd(t.usd)})` : ''}\nCA: <code>${t.mint}</code>` : '';
  const head = [
    `${g ? '🎁' : '🆕'} <b>NEW PUMP PROFILE</b>${g ? ' (sent supply)' : viaRecheck ? ' (just linked X)' : source === 'top' ? ' (new on top followers list)' : ''}`,
    `<b>${esc(p.username)}</b> · <a href="https://x.com/${esc(p.x_username)}">@${esc(p.x_username)}</a>`,
    `X followers: ${p._x ? p._x.followers.toLocaleString('en-US') : '?'}${p._x?.verified ? ' ✅ verified' : ''} · pump.fun followers: ${(p.followers || 0).toLocaleString('en-US')}`,
    `Profile set: ${p.last_username_update_timestamp ? ago(Number(p.last_username_update_timestamp)) : '?'}`,
    tradeLine,
    p.bio ? `Bio: ${esc(String(p.bio).slice(0, 160))}` : '',
  ].filter(Boolean).join('\n');
  const wallets = [`SOL wallet:\n<code>${w}</code>`, p.canonical_evm_wallet ? `EVM wallet:\n<code>${esc(p.canonical_evm_wallet)}</code>` : ''].filter(Boolean).join('\n');
  const links = `<a href="https://pump.fun/profile/${w}">pump.fun</a> · <a href="https://x.com/${esc(p.x_username)}">X</a> · <a href="https://solscan.io/account/${w}">Solscan</a> · <a href="https://gmgn.ai/sol/address/${w}">GMGN</a>`;
  const text = [head, wallets, links].join('\n\n');
  await send(text.length > 1000 ? text.slice(0, 1000) : text, p.profile_image || null);
}

// ---- one shared request budget for profile lookups + top-list pages ----
let tokens = 1; const BURST = Math.max(1, QPS * 3);
setInterval(() => { tokens = Math.min(BURST, tokens + QPS / 10); }, 100);
const take = () => { if (Date.now() < pauseUntil || tokens < 1) return false; tokens -= 1; return true; };
const waitToken = async () => { while (!take()) await new Promise((r) => setTimeout(r, 200)); };

let inflight = 0; let topBusy = false;
setInterval(() => {
  if (topBusy) return; // top-list scan gets the budget while it runs
  const now = Date.now();
  for (const [w, v] of Object.entries(state.watch)) {
    if (now > v.until) { delete state.watch[w]; continue; }
    if (now < v.next) continue;
    if (!take()) return;
    v.next = now + RECHECK_MIN * 60e3; inflight++;
    handle(w, v.trade, true).finally(() => inflight--);
  }
  while (prio.length && inflight < 6 && take()) { const { w, t } = prio.shift(); inflight++; handle(w, t).finally(() => inflight--); }
  while (queue.length && inflight < 4 && take()) {
    const w = queue.pop(); const t = queued.get(w); queued.delete(w);
    if (isSeen(w) || state.alerted[w]) { tokens += 1; continue; }
    inflight++;
    handle(w, t).finally(() => inflight--);
  }
}, 100);

// ---- top profiles scan: catches big accounts that just joined/linked X and are gaining followers fast ----
async function topScan() {
  if (!TOP) return;
  topBusy = true;
  const first = !Object.keys(state.top).length; const seenNow = {}; let fresh = 0; let minF = Infinity; const t0 = Date.now();
  try {
    for (let off = 0; off < TOP; off += 50) {
      await waitToken();
      const r = await fetch(`https://frontend-api-v3.pump.fun/users?offset=${off}&limit=50`, { headers: H, signal: AbortSignal.timeout(10000) });
      if (r.status === 429) { stats.r429++; pauseUntil = Date.now() + (Number(r.headers.get('retry-after')) || 30) * 1000; off -= 50; continue; }
      if (!r.ok) break;
      const arr = await r.json(); if (!Array.isArray(arr) || !arr.length) break;
      for (const p of arr) {
        const w = p.address; if (!w) continue; seenNow[w] = 1; minF = Math.min(minF, p.followers || 0);
        if (first || state.top[w]) continue;
        fresh++;
        if (p.x_username && fresh_(p) && !state.alerted[w] && !p.is_banned && (await bigX(w, p))) await alert(w, p, null, false, 'top');
      }
    }
    state.top = { ...state.top, ...seenNow }; stats.topScans++; save();
    log(`top scan: ${Object.keys(seenNow).length} profiles (cutoff ${minF} pump followers) in ${Math.round((Date.now() - t0) / 1000)}s${first ? ' (first scan, seeding)' : `, ${fresh} new to the list`}`);
  } catch (e) { warn('top scan', e.message); }
  topBusy = false;
}
setTimeout(topScan, 30000); setInterval(topScan, TOP_MIN * 60e3);

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
  const app = e.app || 'none'; stats.apps[app] = (stats.apps[app] || 0) + 1;
  if (APP_ONLY && !String(e.app || '').startsWith('pump')) return;
  if (isSeen(w) || queued.has(w) || state.alerted[w]) return;
  enqueue(w, { mint: e.mintAddress || e.mint, symbol: e.coinMeta?.symbol, name: e.coinMeta?.name, type: e.type, mcap: num(e.marketCapUsd), sol: num(e.amountSol), usd: num(e.amountUsd), tx: e.tx, at: e.timestamp, app: e.app });
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
        if (p[1].startsWith('unifiedCoinCreationEvent')) onCoin(payload); else onTrade(payload);
      } else {
        buf = buf.slice(i + 2);
        if (line.startsWith('INFO ') && !subscribed) {
          subscribed = true;
          ws.send(`CONNECT ${JSON.stringify({ verbose: false, pedantic: false, lang: 'js', version: '2.0', protocol: 1, headers: true, no_responders: true, user: c.user, pass: c.pass })}\r\nSUB ${SUBJECT} 1\r\nSUB unifiedCoinCreationEvent.processed 2\r\nPING\r\n`);
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
  log(`stats ${mins.toFixed(0)}m: trades ${stats.trades} (${Math.round(stats.trades / mins / 60)}/s) | lookups ${stats.lookups} | profiles ${stats.users} | with X ${stats.withX} | ALERTS ${stats.alerts} | queue ${queue.length} | rechecking ${Object.keys(state.watch).length} | 429s ${stats.r429} | dropped ${stats.dropped} | top scans ${stats.topScans} | apps ${Object.entries(stats.apps).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => k + '=' + v).join(',')}${DRY ? ' | DRY (no telegram)' : ''}`);
  fs.writeFileSync('logs/pfwatch-stats.json', JSON.stringify({ ...stats, queue: queue.length, watch: Object.keys(state.watch).length, dry: DRY, updated: new Date().toISOString() }));
}, 60000);

log(`pfwatch: alert when a new pump.fun profile (set up within ${NEW_HOURS}h) links an X with ${MIN_X}+ followers | lookups ${QPS}/s | ${APP_ONLY ? 'pump app traders only' : 'all traders'} | top ${TOP} scan every ${TOP_MIN}m | recheck every ${RECHECK_MIN}m${DRY ? ' | DRY RUN' : ''}`);
// ---- gift watcher: devs of fresh coins sending a big chunk of supply to someone (usually the person the coin is named after) ----
const GIFT_ON = env('PF_GIFT', 'true') === 'true';
const GIFT_HOURS = Number(env('PF_GIFT_HOURS', '2'));
const GIFT_MIN_PCT = Number(env('PF_GIFT_MIN_PCT', '1'));
const GIFT_MB_DAY = Number(env('PF_GIFT_MB_DAY', '2000')); // Helius bills 20 credits/MB -> 2000 MB = 40k credits/day max
const creators = new Map(); // creator wallet -> { at, coins: Map(mint -> {name, symbol, curve}) }
const coinInfo = new Map(); // mint -> {name, symbol, creator, curve}
function onCoin(raw) {
  let e; try { e = JSON.parse(raw); if (typeof e === 'string') e = JSON.parse(e); } catch { return; }
  if (!e.mint || !e.creator) return;
  stats.coins = (stats.coins || 0) + 1;
  const c = creators.get(e.creator) || { at: 0, coins: new Map() };
  c.at = Date.now(); c.coins.set(e.mint, true); creators.set(e.creator, c);
  coinInfo.set(e.mint, { name: e.name, symbol: e.symbol, creator: e.creator, curve: e.bonding_curve });
  giftDirty = true;
}
const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function nameMatch(g, p) {
  const coin = [norm(g.name), norm(g.symbol)].filter((x) => x.length >= 3);
  const who = [norm(p.username), norm(p.x_username), norm(p._x?.name)].filter((x) => x.length >= 3);
  return coin.some((c) => who.some((w) => c.includes(w) || w.includes(c)));
}
const onCurve = (a) => { try { return PublicKey.isOnCurve(new PublicKey(a).toBytes()); } catch { return false; } };
const gift = { ws: null, subId: null, bytes: 0, day: new Date().toISOString().slice(0, 10), txs: 0, found: 0, paused: false, err: null };
let giftDirty = false;
function onGiftTx(res) {
  gift.txs++;
  const tx = res.transaction?.transaction; const meta = res.transaction?.meta; if (!tx || !meta) return;
  const keys = tx.message.accountKeys.map((k) => k.pubkey || k);
  const signer = keys[0];
  const ownerOf = {}; // token account -> owner
  for (const b of [...(meta.preTokenBalances || []), ...(meta.postTokenBalances || [])]) if (b.owner) ownerOf[keys[b.accountIndex]] = b.owner;
  const ixs = [...tx.message.instructions, ...(meta.innerInstructions || []).flatMap((x) => x.instructions)];
  for (const ix of ixs) {
    if (!String(ix.program || '').startsWith('spl-token') || !ix.parsed || !/^transfer/.test(ix.parsed.type)) continue;
    const info = ix.parsed.info; const auth = info.authority || info.multisigAuthority;
    if (!auth || !creators.has(auth)) continue; // only the dev sending
    const mint = info.mint || (meta.postTokenBalances || []).find((b) => keys[b.accountIndex] === info.source)?.mint;
    if (!mint || !/pump$/.test(mint)) continue;
    const amt = Number(info.tokenAmount?.uiAmount ?? (Number(info.amount) / 1e6));
    const pct = (amt / 1e9) * 100;
    if (!(pct >= GIFT_MIN_PCT)) continue;
    const to = ownerOf[info.destination];
    const ci = coinInfo.get(mint) || {};
    if (!to || to === auth || to === ci.curve || !onCurve(to)) continue; // must be a real wallet, not the curve/pool
    gift.found++;
    log(`🎁 dev ${auth.slice(0, 6)} sent ${pct.toFixed(1)}% of ${ci.symbol || mint.slice(0, 6)} to ${to}`);
    fs.appendFileSync('logs/pfwatch-gifts.jsonl', JSON.stringify({ time: new Date().toISOString(), from: auth, to, mint, pct, name: ci.name, symbol: ci.symbol, sig: res.signature }) + '\n');
    if (state.alerted[to] > 0 || prio.length > 300 || prio.some((x) => x.w === to)) continue;
    prio.push({ w: to, t: { gift: { mint, pct, name: ci.name, symbol: ci.symbol, byDev: ci.creator === auth, from: auth, sig: res.signature } } });
  }
}
function giftSubscribe() {
  if (!GIFT_ON || !HELIUS) return;
  const today = new Date().toISOString().slice(0, 10);
  if (today !== gift.day) { gift.day = today; gift.bytes = 0; if (gift.paused) log('gift watcher: new day, resuming'); gift.paused = false; }
  if (gift.paused) return;
  const cutoff = Date.now() - GIFT_HOURS * 3600e3;
  for (const [w, c] of creators) if (c.at < cutoff) { for (const m of c.coins.keys()) coinInfo.delete(m); creators.delete(w); }
  const list = [...creators.keys()].slice(-40000);
  if (!list.length) return;
  if (!gift.ws || gift.ws.readyState !== 1) {
    gift.ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${HELIUS}`);
    gift.ws.on('open', () => { gift.subId = null; giftDirty = true; giftSubscribe(); });
    gift.ws.on('message', (d) => {
      gift.bytes += d.length;
      if (gift.bytes > GIFT_MB_DAY * 1e6 && !gift.paused) { gift.paused = true; warn(`gift watcher hit ${GIFT_MB_DAY} MB today (Helius credit cap), pausing until UTC midnight`); try { gift.ws.close(); } catch {} return; }
      let m; try { m = JSON.parse(d); } catch { return; }
      if (m.error) { gift.err = JSON.stringify(m.error).slice(0, 160); warn('gift sub error', gift.err); return; }
      if (m.id === 'sub' && typeof m.result === 'number') { const old = gift.subId; gift.subId = m.result; if (old !== null) gift.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'unsub', method: 'transactionUnsubscribe', params: [old] })); return; }
      if (m.method === 'transactionNotification') onGiftTx(m.params.result);
    });
    gift.ws.on('close', () => { gift.ws = null; if (!gift.paused) setTimeout(giftSubscribe, 3000); });
    gift.ws.on('error', (e) => warn('gift ws', e.message));
    setInterval(() => { try { gift.ws?.readyState === 1 && gift.ws.ping(); } catch {} }, 30000).unref();
    return;
  }
  if (!giftDirty) return;
  giftDirty = false;
  gift.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'sub', method: 'transactionSubscribe', params: [{ accountInclude: list, failed: false, vote: false }, { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', showRewards: false, maxSupportedTransactionVersion: 0 }] }));
}
if (GIFT_ON) { setTimeout(giftSubscribe, 20000); setInterval(giftSubscribe, 90000); }
setInterval(() => { if (GIFT_ON) log(`gift watcher: ${creators.size} dev wallets watched | ${gift.txs} txs | ${gift.found} gifts | ${(gift.bytes / 1e6).toFixed(0)} MB today (~${Math.round(gift.bytes / 1e6 * 20 / 1000)}k credits)${gift.paused ? ' | PAUSED (cap)' : ''}${gift.err ? ' | err ' + gift.err : ''}`); }, 5 * 60e3);

connect();
