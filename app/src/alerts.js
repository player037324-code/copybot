// New-pool alerts for StonkFun sniping. Never trades.
//  1) NEW INDEX TOKEN: a watched creator wallet (e.g. H1TRD2, who made SAMA4 + TRUMP3) creates a new token
//  2) PAIRING LIVE:    the first StonkFun launch ever paired to a pool token (the moment to snipe)
// Alerts go to the log/status, and to Telegram if TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set on the server.
import 'dotenv/config';
import fs from 'fs';
import WebSocket from 'ws';
import { parseLaunch, LL, buildBuyIxs, buildTx } from './sniper.js';
import bs58 from 'bs58';
import { Keypair, Connection } from '@solana/web3.js';

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k].trim());
const KEY = env('HELIUS_API_KEY', '');
const RPC = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const WSS = `wss://mainnet.helius-rpc.com/?api-key=${KEY}`;
const PLATFORM = env('SNIPE_PLATFORM', '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt');
const CREATORS = env('ALERT_CREATORS', 'H1TRD2XtpMy5RJurDNtboDAUuvfzUCUZn8d82oBW3FZd').split(',').map((s) => s.trim()).filter(Boolean);
const NEW_DAYS = Number(env('ALERT_NEW_POOL_DAYS', '7')); // pool tokens younger than this count as "new pools"
const TG_TOKEN = env('TELEGRAM_BOT_TOKEN', ''); const TG_CHAT = env('TELEGRAM_CHAT_ID', '');
const STATE = 'logs/alerts-state.json';
const FEED = 'logs/alerts.jsonl';
fs.mkdirSync('logs', { recursive: true });

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const warn = (...a) => console.warn(`[${ts()}] WARN`, ...a);

let state = { quotes: {}, created: {} };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; } catch {}
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));

const rpc = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
const meta = async (id) => (await rpc('getAsset', { id }).catch(() => ({}))).result?.content?.metadata || {};
const bornAt = async (id) => (await rpc('getTransactionsForAddress', [id, { transactionDetails: 'signatures', sortOrder: 'asc', limit: 1 }]).catch(() => ({}))).result?.data?.[0]?.blockTime;

async function alert(kind, text, extra = {}) {
  const line = `🚨 ${kind}: ${text}`;
  log(line);
  fs.appendFileSync(FEED, JSON.stringify({ time: new Date().toISOString(), kind, text, ...extra }) + '\n');
  if (TG_TOKEN && TG_CHAT) {
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text: line, disable_web_page_preview: true }) })
      .then((r) => r.json()).then((j) => { if (!j.ok) warn(`telegram: ${JSON.stringify(j).slice(0, 120)}`); }).catch((e) => warn(`telegram: ${e.message}`));
  }
}

// seed: every pool token that already had StonkFun launches counts as known, so only truly new pairings alert
async function seed() {
  if (Object.keys(state.quotes).length) return log(`known pools: ${Object.keys(state.quotes).length}`);
  log('seeding known pools from the last 48h of StonkFun launches...');
  let token; const since = Math.floor(Date.now() / 1000) - 48 * 3600; const end = Date.now() + 120000;
  while (Date.now() < end) {
    const r = await rpc('getTransactionsForAddress', [PLATFORM, { transactionDetails: 'full', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, sortOrder: 'desc', limit: 100, filters: { status: 'succeeded', blockTime: { gte: since } }, ...(token ? { paginationToken: token } : {}) }]);
    for (const t of r.result?.data || []) { const L = parseLaunch(t); if (L) state.quotes[L.quote] ||= { firstSeen: t.blockTime, seeded: true }; }
    token = r.result?.paginationToken; if (!token) break;
  }
  save();
  log(`known pools: ${Object.keys(state.quotes).length}`);
}

// ---- sniper self-test: simulate our buy against a real recent StonkFun launch every few minutes ----
// "not enough pool token" style errors are expected (wallet doesn't hold every pool token); anything else
// (wrong account, new layout, new program) means the sniper's buy is broken -> alert.
const SELFTEST_MIN = Number(env('SELFTEST_EVERY_MIN', '10'));
const selfConn = new Connection(RPC, 'confirmed');
let selfWallet = null; try { selfWallet = Keypair.fromSecretKey(bs58.decode(env('SNIPE_PRIVATE_KEY', env('PRIVATE_KEY', '')))); } catch {}
let latestLaunch = null, lastSelftest = 0, lastSelftestOk = null;
const OK_ERRORS = new Set([2506, 3012, 1]); // require_gte (balance), account not initialized (no quote ATA), insufficient funds
async function selftest() {
  if (!selfWallet || !latestLaunch) return;
  const L = latestLaunch; latestLaunch = null; lastSelftest = Date.now();
  try {
    const bh = await selfConn.getLatestBlockhash();
    const tx = buildTx(selfWallet, buildBuyIxs(L, selfWallet, 1000n, 0n), bh.blockhash, 150000, 1000, 0, 0);
    const sim = await selfConn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    const err = sim.value.err; const code = err?.InstructionError?.[1]?.Custom;
    const reachedBuy = (sim.value.logs || []).some((l) => /Instruction: BuyExactIn/.test(l));
    const anchor = (sim.value.logs || []).find((l) => /AnchorError/.test(l)) || '';
    // OK = our buy got into LaunchLab's BuyExactIn and only failed on our wallet's balance/quote account (or succeeded)
    const ok = !err || (reachedBuy && (code === 2506 || /user_quote_token/.test(anchor)));
    log(`selftest on $${L.symbol} (${L.variant}, config ${L.globalConfig?.slice(0, 6)}): ${ok ? 'OK' : 'BROKEN'} ${err ? JSON.stringify(err) : 'sim ok'} ${anchor.slice(0, 140)}`);
    if (!ok && lastSelftestOk !== false) await alert('SNIPER BUY BROKEN', `Self-test failed on a real launch ($${L.symbol} ${L.base}): ${JSON.stringify(err)} ${anchor.slice(0, 160)}. Tell Claude before the next pairing.`, { mint: L.base });
    if (ok && lastSelftestOk === false) await alert('SNIPER BUY OK AGAIN', `Self-test passing again on $${L.symbol}.`);
    lastSelftestOk = ok;
  } catch (e) { warn(`selftest: ${e.message}`); }
}
setInterval(() => { if (Date.now() - lastSelftest > SELFTEST_MIN * 60000) selftest(); }, 30000);

async function onLaunch(tx, slot) {
  const L = parseLaunch(tx);
  if (!L || L.platform !== PLATFORM) return;
  latestLaunch = L;
  if (state.quotes[L.quote]) return;
  state.quotes[L.quote] = { firstSeen: Math.floor(Date.now() / 1000), firstTicker: L.symbol, firstMint: L.base, slot };
  save();
  const [m, born] = await Promise.all([meta(L.quote), bornAt(L.quote)]);
  const ageDays = born ? (Date.now() / 1000 - born) / 86400 : null;
  const isNew = ageDays !== null && ageDays < NEW_DAYS;
  await alert(isNew ? 'NEW PAIRING LIVE' : 'first StonkFun launch on older pool',
    `$${m.symbol || '?'} (${m.name || ''}) ${L.quote} is now live on StonkFun. First launch: $${L.symbol} ${L.base}. Pool token is ${ageDays === null ? '?' : ageDays < 1 ? `${(ageDays * 24).toFixed(1)}h` : `${ageDays.toFixed(1)}d`} old.`,
    { quote: L.quote, firstMint: L.base, firstTicker: L.symbol, isNew });
}

// TRADEABLE: first deposit/swap touching a token we saw get created (H1TRD2 did the first one for SAMA4 and MUSK4)
async function checkTradeable(tx) {
  const keys = new Set(tx.transaction.message.accountKeys.map((k) => k.pubkey?.toString?.() ?? k));
  for (const b of [...(tx.meta?.postTokenBalances || []), ...(tx.meta?.preTokenBalances || [])]) keys.add(b.mint);
  const logs = (tx.meta?.logMessages || []).join('\n');
  if (!/Instruction: (Deposit|Swap|SwapV2|SwapV3Dyn|Route)/.test(logs)) return;
  for (const [mint, c] of Object.entries(state.created)) {
    if (c.tradeableAt || !keys.has(mint)) continue;
    c.tradeableAt = Math.floor(Date.now() / 1000); save();
    const m = await meta(mint);
    const at = new Date(Date.now() + 79 * 60000).toISOString().slice(11, 16); const at2 = new Date(Date.now() + 86 * 60000).toISOString().slice(11, 16);
    await alert('NOW TRADEABLE', `$${m.symbol || '?'} (${m.name || ''}) ${mint} just got its first deposit/swap. Buy it now for the snipe. Last two pairings went live 79-86 min after this, so around ${at}-${at2} UTC.`, { mint });
  }
}
// backup: poll Jupiter for created tokens that aren't tradeable yet
setInterval(async () => {
  for (const [mint, c] of Object.entries(state.created)) {
    if (c.tradeableAt || Date.now() / 1000 - c.at > 12 * 3600) continue;
    const r = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${mint}&amount=10000000&slippageBps=300`, { headers: { 'x-api-key': process.env.JUP_API_KEY || '' } }).then((x) => x.json()).catch(() => ({}));
    if (r.outAmount && Number(r.outAmount) > 0) {
      c.tradeableAt = Math.floor(Date.now() / 1000); save();
      const m = await meta(mint);
      await alert('NOW TRADEABLE', `$${m.symbol || '?'} ${mint} is now buyable on Jupiter (${(r.routePlan || []).map((p) => p.swapInfo.label).join('>')}). Pairings went live 79-86 min after tradeable last two times.`, { mint });
    }
  }
}, 60000);

async function onCreatorTx(tx, sig) {
  await checkTradeable(tx);
  const pre = new Set((tx.meta?.preTokenBalances || []).map((b) => b.mint));
  const ixs = [...(tx.meta?.logMessages || [])].join('\n');
  if (!/Initialize/.test(ixs)) return;
  // new mints show up as accounts the creator just initialized; check each unknown account that is now a mint
  const cands = new Set();
  for (const g of tx.meta?.innerInstructions || []) for (const i of g.instructions) if (i.parsed?.type && /^initializeMint/.test(i.parsed.type)) cands.add(i.parsed.info.mint);
  for (const i of tx.transaction.message.instructions) if (i.parsed?.type && /^initializeMint/.test(i.parsed.type)) cands.add(i.parsed.info.mint);
  for (const b of tx.meta?.postTokenBalances || []) if (!pre.has(b.mint)) cands.add(b.mint);
  // also: first-time accounts written in this tx that are mints with 0 supply
  for (const k of tx.transaction.message.accountKeys) { const a = k.pubkey?.toString?.() ?? k; if (k.writable && !k.signer) cands.add(a); }
  for (const c of cands) {
    if (state.created[c]) continue;
    const r = await rpc('getAccountInfo', [c, { encoding: 'jsonParsed' }]).catch(() => ({}));
    const v = r.result?.value;
    if (v?.data?.parsed?.type !== 'mint') continue;
    const born = await bornAt(c);
    if (!born || Date.now() / 1000 - born > 3600) continue; // only brand-new mints
    state.created[c] = { at: born, sig }; save();
    const m = await meta(c);
    await alert('NEW INDEX TOKEN', `$${m.symbol || '?'} (${m.name || 'no metadata yet'}) ${c} just created by ${tx.transaction.message.accountKeys[0].pubkey?.toString?.() ?? ''}. Pairing on StonkFun may go live soon (SAMA4 went live ~91 min after creation).`, { mint: c });
  }
}

function subscribe(name, filter, handler) {
  const connect = () => {
    const ws = new WebSocket(WSS, { perMessageDeflate: false });
    let ping;
    ws.on('open', () => {
      log(`feed ${name} connected`);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'transactionSubscribe', params: [{ ...filter, failed: false, vote: false }, { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', showRewards: false, maxSupportedTransactionVersion: 1 }] }));
      ping = setInterval(() => ws.readyState === 1 && ws.ping(), 20000);
    });
    ws.on('message', (d) => {
      let m; try { m = JSON.parse(d); } catch { return; }
      if (m.error) return warn(`${name}: ${JSON.stringify(m.error).slice(0, 150)}`);
      const r = m.params?.result;
      if (r?.transaction) handler(r.transaction, r.signature, r.slot).catch((e) => warn(`${name}: ${e.message}`));
    });
    ws.on('close', () => { clearInterval(ping); warn(`feed ${name} closed, reconnecting`); setTimeout(connect, 1000); });
    ws.on('error', (e) => warn(`feed ${name}: ${e.message}`));
  };
  connect();
}

await seed();
for (const m of (process.env.ALERT_TRACK_MINTS || '6s2umN1sqM8mS8ERRmt9cqcFwAoWu5ofma7DN3KfFiue').split(',').map((x) => x.trim()).filter(Boolean)) {
  if (!state.created[m]) { state.created[m] = { at: Math.floor(Date.now() / 1000), manual: true }; save(); log(`tracking ${m} for NOW TRADEABLE`); }
}
log(`watching creators: ${CREATORS.join(', ')} | telegram: ${TG_TOKEN && TG_CHAT ? 'ON' : 'off (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID on the server)'}`);
subscribe('stonkfun-launches', { accountRequired: [LL.toBase58(), PLATFORM] }, (tx, sig, slot) => onLaunch(tx, slot));
subscribe('creators', { accountInclude: CREATORS }, onCreatorTx);
setInterval(() => log(`alive | ${Object.keys(state.quotes).length} known pools | ${Object.keys(state.created).length} new tokens seen`), 600000);
