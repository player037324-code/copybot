// Replay: feed a real past launch tx through the sniper's parser + builder, compare to a real
// sniper's buy accounts, and simulate. Never sends. usage: node scripts/snipetest.js <createSig> [refBuySig] [amount]
import 'dotenv/config';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { parseLaunch, buildBuyIxs, buildTx, LL } from '../src/sniper.js';
const [createSig, refSig, amt] = process.argv.slice(2);
const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.SNIPE_PRIVATE_KEY || process.env.PRIVATE_KEY));
const tx = await conn.getParsedTransaction(createSig, { maxSupportedTransactionVersion: 1 });
const t0 = performance.now();
const L = parseLaunch(tx);
const t1 = performance.now();
if (!L) { console.log('parseLaunch: NOT a launch'); process.exit(0); }
console.log(`parsed in ${(t1 - t0).toFixed(2)}ms: $${L.symbol} "${L.name}" base ${L.base} quote ${L.quote} creator ${L.creator.slice(0, 6)} platform ${L.platform.slice(0, 6)}`);
const q = await conn.getParsedAccountInfo(new PublicKey(L.quote));
const dec = q.value.data.parsed.info.decimals;
const amountRaw = BigInt(Math.floor(Number(amt || 1) * 10 ** dec));
const bh = await conn.getLatestBlockhash();
const t2 = performance.now();
const ixs = buildBuyIxs(L, wallet, amountRaw, 0n);
const ours = buildTx(wallet, ixs, bh.blockhash);
const t3 = performance.now();
console.log(`built + signed in ${(t3 - t2).toFixed(2)}ms, ${ours.serialize().length} bytes`);
if (refSig) {
  const ref = await conn.getParsedTransaction(refSig, { maxSupportedTransactionVersion: 1 });
  const refIx = ref.transaction.message.instructions.find((i) => i.programId.toString() === LL.toBase58() && i.accounts?.length === 18);
  const user = ref.transaction.message.accountKeys[0].pubkey.toString();
  const mine = ixs[1].keys.map((k) => k.pubkey.toBase58());
  let ok = 0, bad = 0;
  refIx.accounts.forEach((a, i) => {
    const r = a.toString();
    const userSpecific = [0, 5, 6].includes(i);
    const match = userSpecific ? mine[i] !== r : mine[i] === r;
    if (match) ok++; else { bad++; console.log(`  MISMATCH acct ${i}: ours ${mine[i]} vs ref ${r}`); }
  });
  console.log(`accounts vs real sniper (${user.slice(0, 6)}): ${ok}/18 match${bad ? `, ${bad} MISMATCH` : ' (user accounts correctly swapped to ours)'}`);
}
const sim = await conn.simulateTransaction(ours, { sigVerify: false, replaceRecentBlockhash: true });
console.log(`simulate now: ${sim.value.err ? 'ERR ' + JSON.stringify(sim.value.err) : 'OK'} CU ${sim.value.unitsConsumed}`);
(sim.value.logs || []).filter((l) => /Instruction: Buy|Error|failed|AnchorError/.test(l)).slice(-5).forEach((l) => console.log('  ' + l));
process.exit(0);
