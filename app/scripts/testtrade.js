// Real round trip: buy <SOL> of <mint> then sell it all back. Impact-guarded. usage: node scripts/testtrade.js <mint> <SOL>
import 'dotenv/config';
import bs58 from 'bs58';
import { Keypair, PublicKey } from '@solana/web3.js';
import { conn } from '../src/trader.js';
import { quote, swapInstructions, SOL_MINT, getSolUsd } from '../src/jupiter.js';
import { buildFromIxs, sendAndLand, startWarmers } from '../src/fast.js';
const [mint, solStr] = process.argv.slice(2); const sol = Number(solStr);
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.SNIPE_PRIVATE_KEY || process.env.PRIVATE_KEY));
const me = wallet.publicKey;
const toIx = (ix) => ({ programId: new PublicKey(ix.programId), keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })), data: Buffer.from(ix.data, 'base64') });
const balSol = async () => (await conn.getBalance(me, 'confirmed')) / 1e9;
const balTok = async () => { const r = await conn.getParsedTokenAccountsByOwner(me, { mint: new PublicKey(mint) }, 'confirmed'); return r.value.reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n); };
const s0 = await balSol();
console.log(`wallet ${me.toBase58()} SOL ${s0.toFixed(4)}`);
if (s0 < sol + 0.02) { console.log(`NOT ENOUGH SOL: need ~${(sol + 0.02).toFixed(3)}, have ${s0.toFixed(4)}. Fund the wallet first.`); process.exit(0); }
startWarmers(conn); await new Promise((r) => setTimeout(r, 800));
async function swap(inM, outM, amt, label) {
  const q = await quote(inM, outM, amt, 1500, false);
  const impact = Number(q.priceImpactPct) * 100;
  console.log(`${label}: route ${(q.routePlan || []).map((p) => p.swapInfo.label).join('>')} impact ${impact.toFixed(2)}%`);
  if (!(impact < 5)) throw new Error(`REFUSED ${label}: price impact ${impact.toFixed(1)}% (thin/junk route)`);
  const ixs = await swapInstructions(q, me.toBase58());
  const { tx } = await buildFromIxs(conn, wallet, [...(ixs.setupInstructions || []), ixs.swapInstruction, ...(ixs.cleanupInstruction ? [ixs.cleanupInstruction] : [])].map(toIx), ixs.addressLookupTableAddresses || [], 400000);
  const t = Date.now(); const r = await sendAndLand(conn, tx);
  console.log(`  ${label} LANDED in ${Date.now() - t}ms slot ${r.slot} sig ${r.sig}`);
  return r;
}
const t0 = await balTok();
await swap(SOL_MINT, mint, Math.floor(sol * 1e9), 'BUY');
await new Promise((r) => setTimeout(r, 1500));
const got = (await balTok()) - t0;
const info = await conn.getParsedAccountInfo(new PublicKey(mint)); const dec = info.value.data.parsed.info.decimals; const supply = Number(info.value.data.parsed.info.supply) / 10 ** dec;
const usd = await getSolUsd();
console.log(`  got ${(Number(got) / 10 ** dec).toFixed(2)} tokens -> entry mcap ~$${((sol / (Number(got) / 10 ** dec)) * supply * usd / 1000).toFixed(1)}K`);
if (got <= 0n) { console.log('no tokens received, skipping sell'); process.exit(0); }
await swap(mint, SOL_MINT, got, 'SELL');
await new Promise((r) => setTimeout(r, 1500));
const s1 = await balSol();
console.log(`ROUND TRIP DONE: SOL ${s0.toFixed(4)} -> ${s1.toFixed(4)} (${(s1 - s0 >= 0 ? '+' : '')}${(s1 - s0).toFixed(4)} SOL incl. fees, tips, slippage)`);
process.exit(0);
