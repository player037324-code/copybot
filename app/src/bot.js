import WebSocket from 'ws';
import { PublicKey } from '@solana/web3.js';
import { cfg, validate } from './config.js';
import { parseTrades } from './detect.js';
import { conn, buy, sell, monitorLoop, startTrader, walletAddress, getPositions } from './trader.js';
import { log, warn } from './log.js';

validate();

log('=== copybot starting ===');
log(`mode: ${cfg.paper ? 'PAPER (no real trades)' : 'LIVE'}`);
log(`copying: ${cfg.target}`);
log(`our wallet: ${walletAddress}`);
log(`buy ${cfg.buyPct}% of Lunar's SOL when he spends > ${cfg.minTargetBuySol} SOL | new positions only: ${cfg.newPositionsOnly} | max per buy: ${cfg.maxBuySol || 'none'}`);
log(`sell: ${cfg.sellAllOnAnySell ? 'SELL ALL on any Lunar sell or transfer out' : 'mirror proportionally'} | TP ${cfg.takeProfitPct || 'off'} SL ${cfg.stopLossPct || 'off'}`);
log(`exec: slippage ${cfg.slippageBps / 100}% buy / ${cfg.sellSlippageBps / 100}% sell | tip ${cfg.tipSol} SOL | sender ${cfg.senderUrl}`);
log(`open positions: ${Object.keys(getPositions()).length}`);

startTrader();

const seen = new Set();
const feed = { txs: 0, signed: 0, lagMs: [] };
setInterval(() => {
  const lag = feed.lagMs.length ? Math.round(feed.lagMs.reduce((a, b) => a + b, 0) / feed.lagMs.length) : null;
  log(`feed: ${feed.txs} txs mentioning Lunar, ${feed.signed} signed by him (last 60s)${lag !== null ? `, avg ${lag}ms after block time` : ''}`);
  feed.txs = 0; feed.signed = 0; feed.lagMs = [];
}, 60000).unref();
function remember(sig) {
  if (seen.has(sig)) return false;
  seen.add(sig);
  if (seen.size > 20000) seen.delete(seen.values().next().value);
  return true;
}

function handleTx(tx, sig, slot, seenAt) {
  feed.txs++;
  const k = tx?.transaction?.message?.accountKeys?.find((x) => (x.pubkey?.toString?.() ?? x) === cfg.target);
  if (k?.signer) feed.signed++;
  if (tx?.blockTime) feed.lagMs.push(seenAt - tx.blockTime * 1000);
  for (const ev of parseTrades(tx, cfg.target)) {
    if (ev.type === 'BUY') {
      log(`Lunar BUY ${ev.mint} ${ev.solSpent.toFixed(3)} SOL ${ev.isNew ? 'NEW POSITION' : '(adding)'} (slot ${slot})`);
      buy(ev, sig, slot, seenAt);
    } else {
      const held = !!getPositions()[ev.mint];
      log(`Lunar ${ev.solGot > 0 ? 'SELL' : 'TRANSFER OUT'} ${Math.round(ev.fraction * 100)}% of ${ev.mint}${held ? ' -> dumping ours' : ''}`);
      if (cfg.mirrorSells && held) sell(ev.mint, ev.fraction, ev.solGot > 0 ? 'Lunar sold' : 'Lunar moved tokens out', sig);
    }
  }
}

// ---- fast path: Helius transactionSubscribe at processed, full tx included ----
// ---- fallback: watch SOL balance + look up signed txs (works on any plan) ----
let mode = 'fast';
const targetKey = new PublicKey(cfg.target);

async function onBalanceChange(slot) {
  const seenAt = Date.now();
  for (let attempt = 0; attempt < 12; attempt++) {
    const sigs = await conn.getSignaturesForAddress(targetKey, { limit: 1000 }, 'confirmed').catch(() => []);
    const hits = sigs.filter((s) => !s.err && Math.abs(s.slot - slot) <= 1 && !seen.has(s.signature));
    let found = false;
    for (const s of hits) {
      const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).catch(() => null);
      if (!tx) continue;
      remember(s.signature);
      handleTx(tx, s.signature, s.slot, seenAt);
      found = true;
    }
    if (found) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

function connect() {
  const ws = new WebSocket(cfg.wsUrl, { perMessageDeflate: false });
  let ping;
  let chain = Promise.resolve();
  ws.on('open', () => {
    if (mode === 'fast') {
      log('websocket connected: transactionSubscribe (processed)');
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'transactionSubscribe',
        params: [
          { accountRequired: [cfg.target], failed: false, vote: false },
          { commitment: 'processed', encoding: 'jsonParsed', transactionDetails: 'full', showRewards: false, maxSupportedTransactionVersion: 1 },
        ],
      }));
    } else {
      log('websocket connected: balance watch (fallback mode)');
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'accountSubscribe', params: [cfg.target, { commitment: 'confirmed', encoding: 'base64' }] }));
    }
    ping = setInterval(() => ws.readyState === 1 && ws.ping(), 20000);
  });
  ws.on('message', (data) => {
    const seenAt = Date.now();
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.id === 1 && m.error) {
      warn(`transactionSubscribe not available (${JSON.stringify(m.error).slice(0, 120)}), switching to fallback`);
      mode = 'fallback';
      ws.close();
      return;
    }
    if (m.method === 'transactionNotification') {
      const r = m.params?.result;
      const sig = r?.signature;
      if (!sig || !remember(sig)) return;
      try { handleTx(r.transaction, sig, r.slot, seenAt); } catch (e) { warn(`parse ${sig}: ${e.message}`); }
    } else if (m.method === 'accountNotification') {
      const slot = m.params?.result?.context?.slot;
      if (slot) chain = chain.then(() => onBalanceChange(slot)).catch((e) => warn(e.message));
    }
  });
  ws.on('close', () => { clearInterval(ping); warn('websocket closed, reconnecting'); setTimeout(connect, 500); });
  ws.on('error', (e) => warn(`websocket error: ${e.message}`));
}

connect();
monitorLoop();

process.on('unhandledRejection', (e) => warn(`unhandled: ${e?.message || e}`));
