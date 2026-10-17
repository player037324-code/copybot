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
console.log(`\nTarget's last trades (${cfg.target.slice(0, 6)}...):`);
const sigs = await conn.getSignaturesForAddress(new PublicKey(cfg.target), { limit: 15 });
for (const s of sigs) {
  const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
  for (const ev of parseTrades(tx, cfg.target)) {
    const when = s.blockTime ? new Date(s.blockTime * 1000).toISOString().slice(5, 16).replace('T', ' ') : '';
    console.log(`${when}  ${ev.type.padEnd(4)} ${ev.mint}  ${ev.type === 'BUY' ? ev.solSpent.toFixed(3) + ' SOL' : Math.round(ev.fraction * 100) + '%'}`);
  }
}
