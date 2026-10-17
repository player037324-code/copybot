// Listen to the target for ~150s and print every tx it signs. Never trades.
import WebSocket from 'ws';
import { PublicKey } from '@solana/web3.js';
import { cfg } from '../src/config.js';
import { conn } from '../src/trader.js';
import { parseTrades } from '../src/detect.js';
const key = new PublicKey(cfg.target);
const seen = new Set();
let changes = 0, signed = 0;
const ws = new WebSocket(cfg.wsUrl);
ws.on('open', () => { console.log('watching balance (150s)...'); ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'accountSubscribe', params: [cfg.target, { commitment: 'confirmed', encoding: 'base64' }] })); });
ws.on('message', async (d) => {
  const m = JSON.parse(d); const slot = m?.params?.result?.context?.slot; if (!slot) return;
  changes++;
  for (let a = 0; a < 10; a++) {
    const sigs = (await conn.getSignaturesForAddress(key, { limit: 1000 }, 'confirmed')).filter((s) => !s.err && Math.abs(s.slot - slot) <= 1 && !seen.has(s.signature));
    let got = false;
    for (const s of sigs) {
      seen.add(s.signature);
      const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1 });
      const k = tx.transaction.message.accountKeys.find((x) => x.pubkey.toString() === cfg.target);
      if (!k?.signer) continue;
      got = true; signed++;
      const evs = parseTrades(tx, cfg.target);
      const t = new Date().toISOString().slice(11, 19);
      console.log(evs.length ? evs.map((e) => `${t} ${e.type} ${e.mint} ${e.type === 'BUY' ? e.solSpent.toFixed(3) + ' SOL' : Math.round(e.fraction * 100) + '%'}`).join('\n') : `${t} signed non-swap tx ${s.signature.slice(0, 12)}`);
    }
    if (got) break;
    await new Promise((r) => setTimeout(r, 300));
  }
});
setTimeout(() => { console.log(`done: ${changes} balance changes, ${signed} signed txs`); process.exit(0); }, 150000);
