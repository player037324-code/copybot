// Dry run: rebuild a past Lunar buy with our wallet and SIMULATE it. Never sends.
// usage: node scripts/clonetest.js <lunarBuySig> [sol]
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { cfg } from '../src/config.js';
import { conn } from '../src/trader.js';
import { parseTrades } from '../src/detect.js';
import { cloneBuy, findBuyIx } from '../src/clone.js';
import { buildFromIxs } from '../src/fast.js';
const sig = process.argv[2]; const sol = Number(process.argv[3] || 0.01);
const wallet = Keypair.fromSecretKey(bs58.decode(cfg.privateKey));
const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1 });
const ev = parseTrades(tx, cfg.target).find((e) => e.type === 'BUY');
console.log(`Lunar buy: ${ev?.mint} ${ev?.solSpent?.toFixed(3)} SOL tokens ${ev?.tokensRaw}`);
const f = findBuyIx(tx);
console.log(`AMM ix: ${f ? `${f.amm.name} disc ${Buffer.from(f.data.subarray(0, 8)).toString('hex')} accts ${f.accounts.length} datalen ${f.data.length}` : 'none found'}`);
const tops = tx.transaction.message.instructions.map((i) => (i.programId.toString()).slice(0, 6)).join(',');
console.log(`Lunar top-level programs: ${tops}`);
if (!f) { for (const inner of tx.meta.innerInstructions || []) console.log('  inner:', inner.instructions.map((i) => i.programId.toString().slice(0, 6)).join(',')); process.exit(0); }
const t0 = Date.now();
const { ixs, info } = cloneBuy(tx, cfg.target, wallet, ev, Math.floor(sol * 1e9), 9900);
const alts = (tx.transaction.message.addressTableLookups || []).map((l) => l.accountKey.toString());
const { tx: ours } = await buildFromIxs(conn, wallet, ixs, alts, 300000);
console.log(`built in ${Date.now() - t0}ms: ${JSON.stringify(info)} size ${ours.serialize().length}B`);
const sim = await conn.simulateTransaction(ours, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' });
console.log(`SIM: ${sim.value.err ? 'ERR ' + JSON.stringify(sim.value.err) : 'OK'}  CU ${sim.value.unitsConsumed}`);
console.log((sim.value.logs || []).filter((l) => /invoke \[1\]|failed|Error|error|success/.test(l)).slice(-12).join('\n'));
process.exit(0);
