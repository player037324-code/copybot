// Sanity check: are the keys working? Pulls the target's recent trades without trading.
import { cfg, validate } from '../src/config.js';
import { conn, walletAddress } from '../src/trader.js';
import { parseTrades } from '../src/detect.js';
import { getSolUsd } from '../src/jupiter.js';
import { PublicKey } from '@solana/web3.js';

validate();
console.log('Helius RPC...', (await conn.getSlot()) ? 'OK' : 'FAIL');
const sol = await getSolUsd();
console.log('Jupiter API...', sol ? `OK (SOL = $${sol.toFixed(2)})` : 'FAIL, check JUP_API_KEY');
if (!cfg.paper || cfg.privateKey) {
  if (cfg.privateKey) {
    const bal = await conn.getBalance(new PublicKey(walletAddress));
    console.log(`Our wallet ${walletAddress}: ${(bal / 1e9).toFixed(4)} SOL`);
  }
}
console.log(`\nScanning target's last 1000 txs (${cfg.target.slice(0, 6)}...)`);
let all = [], before;
for (let page = 0; page < 1; page++) {
  const batch = await conn.getSignaturesForAddress(new PublicKey(cfg.target), { limit: 1000, before });
  if (!batch.length) break;
  all = all.concat(batch); before = batch[batch.length - 1].signature;
}
const ok = all.filter((s) => !s.err);
const span = all.length ? ((all[0].blockTime - all[all.length - 1].blockTime) / 3600).toFixed(1) : 0;
console.log(`${all.length} txs over ${span}h: ${ok.length} succeeded, ${all.length - ok.length} failed`);
let buys = 0, sells = 0, other = 0;
const lines = [];
for (const s of ok.slice(0, 60)) {
  const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1 }).catch(() => null);
  const evs = parseTrades(tx, cfg.target);
  if (!evs.length) { other++; continue; }
  for (const ev of evs) {
    ev.type === 'BUY' ? buys++ : sells++;
    const when = s.blockTime ? new Date(s.blockTime * 1000).toISOString().slice(5, 16).replace('T', ' ') : '';
    lines.push(`${when}  ${ev.type.padEnd(4)} ${ev.mint}  ${ev.type === 'BUY' ? ev.solSpent.toFixed(3) + ' SOL' : Math.round(ev.fraction * 100) + '% (+' + ev.solGot.toFixed(3) + ' SOL)'}`);
  }
}
console.log(`Of the last ${Math.min(60, ok.length)} successful: ${buys} buys, ${sells} sells, ${other} non-trade`);
lines.slice(0, 30).forEach((l) => console.log(l));
