// Buy the quote token (e.g. SAMA4) with SOL ahead of a snipe. usage: node scripts/snipefund.js <SOL> [quoteMint] [--go]
// Without --go it only quotes. Refuses routes with >5% price impact (junk-pool protection).
import 'dotenv/config';
import bs58 from 'bs58';
import { Keypair, PublicKey } from '@solana/web3.js';
import { conn } from '../src/trader.js';
import { quote, swapInstructions, SOL_MINT, getSolUsd } from '../src/jupiter.js';
import { buildFromIxs, sendAndLand, startWarmers } from '../src/fast.js';
const sol = Number(process.argv[2]); const mint = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : process.env.SNIPE_QUOTE_MINT;
const go = process.argv.includes('--go');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.SNIPE_PRIVATE_KEY || process.env.PRIVATE_KEY));
if (!(sol > 0) || !mint) { console.log('usage: snipefund <SOL> [quoteMint] [--go]'); process.exit(0); }
const info = await conn.getParsedAccountInfo(new PublicKey(mint)); const dec = info.value.data.parsed.info.decimals;
const q = await quote(SOL_MINT, mint, Math.floor(sol * 1e9), 300, false);
const out = Number(q.outAmount) / 10 ** dec; const impact = Number(q.priceImpactPct) * 100;
const usd = await getSolUsd();
console.log(`${sol} SOL -> ${out.toFixed(4)} of ${mint.slice(0, 6)} | ${(sol * usd / out).toFixed(4)} USD each | price impact ${impact.toFixed(2)}% | route ${(q.routePlan || []).map((p) => `${p.swapInfo.label}(${p.percent}%)`).join(' > ')}`);
if (!(impact < 5)) { console.log('REFUSED: price impact over 5%, route is too thin (possible junk pool). Not buying.'); process.exit(0); }
if (!go) { console.log('quote only. Run snipe-fund with --go to buy.'); process.exit(0); }
startWarmers(conn);
const ixs = await swapInstructions(q, wallet.publicKey.toBase58());
const { tx } = await buildFromIxs(conn, wallet, [...(ixs.setupInstructions || []), ixs.swapInstruction, ...(ixs.cleanupInstruction ? [ixs.cleanupInstruction] : [])].map((ix) => ({ programId: new PublicKey(ix.programId), keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })), data: Buffer.from(ix.data, 'base64') })), ixs.addressLookupTableAddresses || [], 400000);
const r = await sendAndLand(conn, tx);
const bal = await conn.getTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
console.log(`BOUGHT. sig ${r.sig}`);
const p = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
console.log(`wallet now holds ${p.value.reduce((a, x) => a + Number(x.account.data.parsed.info.tokenAmount.uiAmount), 0)} of ${mint.slice(0, 6)}`);
process.exit(0);
