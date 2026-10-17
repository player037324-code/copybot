import WebSocket from 'ws';
import { PublicKey } from '@solana/web3.js';
import { cfg, validate } from './config.js';
import { parseTrades } from './detect.js';
import { conn, buy, sell, monitorLoop, walletAddress, getPositions } from './trader.js';
import { log, warn } from './log.js';

validate();

log('=== copybot starting ===');
log(`mode: ${cfg.paper ? 'PAPER (no real trades)' : 'LIVE'}`);
log(`copying: ${cfg.target}`);
log(`our wallet: ${walletAddress}`);
log(`buy ${cfg.buySol} SOL | max ${cfg.maxPositions} positions | TP ${cfg.takeProfitPct || 'off'}% SL ${cfg.stopLossPct || 'off'}% | mirror sells ${cfg.mirrorSells}`);
log(`open positions: ${Object.keys(getPositions()).length}`);

const seen = new Set();

async function fetchTx(sig) {
  // logs come in at "processed"; the full tx is fetchable a moment later
  for (let i = 0; i < 20; i++) {
    const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }).catch(() => null);
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function handleSig(sig) {
  if (seen.has(sig)) return;
  seen.add(sig);
  if (seen.size > 5000) seen.delete(seen.values().next().value);

  const tx = await fetchTx(sig);
  if (!tx) return warn(`could not fetch ${sig}`);
  for (const ev of parseTrades(tx, cfg.target)) {
    if (ev.type === 'BUY') {
      log(`target BUY ${ev.mint} for ${ev.solSpent.toFixed(3)} SOL`);
      buy(ev, sig);
    } else if (ev.type === 'SELL') {
      log(`target SELL ${Math.round(ev.fraction * 100)}% of ${ev.mint}`);
      if (cfg.mirrorSells && getPositions()[ev.mint]) sell(ev.mint, ev.fraction, 'mirror', sig);
    }
  }
}

// The target address gets spammed by other bots (~100+ tx/sec that just mention it).
// So instead of reacting to every mention, we watch the wallet's SOL balance. It only
// changes when the wallet itself does something (every tx it signs pays a fee).
// On a change we look up that slot's transactions and keep the ones it signed.
const targetKey = new PublicKey(cfg.target);
let scanning = Promise.resolve();
async function onBalanceChange(slot) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const sigs = await conn.getSignaturesForAddress(targetKey, { limit: 1000 }, 'confirmed').catch(() => []);
    const hits = sigs.filter((s) => !s.err && s.slot >= slot - 1 && s.slot <= slot + 1);
    let found = false;
    for (const s of hits) {
      if (seen.has(s.signature)) { found = true; continue; }
      const before = seen.size;
      await handleSig(s.signature);
      if (seen.size > before) found = true;
    }
    if (found) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

function connect() {
  const ws = new WebSocket(cfg.wsUrl);
  let ping;
  ws.on('open', () => {
    log('websocket connected, watching target wallet balance...');
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'accountSubscribe',
      params: [cfg.target, { commitment: 'confirmed', encoding: 'base64' }],
    }));
    ping = setInterval(() => ws.readyState === 1 && ws.ping(), 30000);
  });
  ws.on('message', (data) => {
    try {
      const m = JSON.parse(data);
      const slot = m?.params?.result?.context?.slot;
      if (m.method === 'accountNotification' && slot) {
        scanning = scanning.then(() => onBalanceChange(slot)).catch((e) => warn(e.message));
      }
    } catch {}
  });
  ws.on('close', () => { clearInterval(ping); warn('websocket closed, reconnecting in 2s'); setTimeout(connect, 2000); });
  ws.on('error', (e) => warn(`websocket error: ${e.message}`));
}

connect();
monitorLoop();

process.on('unhandledRejection', (e) => warn(`unhandled: ${e?.message || e}`));
