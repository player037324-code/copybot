// Timeline of an index token: created -> first pool/swap (tradeable) -> first StonkFun launch.
import 'dotenv/config';
import { parseLaunch } from '../src/sniper.js';
const RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const a = process.argv[2];
const rpc = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
const AMMS = { CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM', CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'Raydium CPMM', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM', LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM', cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: 'Meteora DAMM2', whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca', JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter' };
let token, t0, firstPool, firstLaunch, n = 0; const end = Date.now() + 80000; const events = [];
while (Date.now() < end && !firstLaunch) {
  const r = await rpc('getTransactionsForAddress', [a, { transactionDetails: 'full', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, sortOrder: 'asc', limit: 100, filters: { status: 'succeeded' }, ...(token ? { paginationToken: token } : {}) }]);
  for (const t of r.result?.data || []) {
    n++; t0 ||= t.blockTime;
    const progs = new Set([...t.transaction.message.instructions.map((i) => i.programId.toString()), ...(t.meta.innerInstructions || []).flatMap((g) => g.instructions.map((i) => i.programId.toString()))]);
    const amm = [...progs].map((p) => AMMS[p]).filter(Boolean);
    const logs = (t.meta.logMessages || []).filter((l) => /Instruction: /.test(l)).map((l) => l.replace(/.*Instruction: /, ''));
    if (!firstPool && amm.length) { firstPool = t; events.push(`+${((t.blockTime - t0) / 60).toFixed(1)}m  FIRST POOL/SWAP activity: ${[...new Set(amm)].join(',')} [${[...new Set(logs)].slice(0, 5).join(',')}] by ${t.transaction.message.accountKeys[0].pubkey.toString().slice(0, 6)}`); }
    if (events.length < 6 && !amm.length && n > 1) events.push(`+${((t.blockTime - t0) / 60).toFixed(1)}m  ${t.transaction.message.accountKeys[0].pubkey.toString().slice(0, 6)} [${[...new Set(logs)].slice(0, 5).join(',')}]`);
    const L = parseLaunch(t);
    if (L && L.quote === a) { firstLaunch = t; events.push(`+${((t.blockTime - t0) / 60).toFixed(1)}m  FIRST STONKFUN LAUNCH: $${L.symbol}`); break; }
  }
  token = r.result?.paginationToken; if (!token) break;
}
console.log(`created ${new Date(t0 * 1000).toISOString()} | scanned ${n} txs`);
events.forEach((e) => console.log(e));
if (firstPool && firstLaunch) console.log(`=> tradeable -> pairing live: ${((firstLaunch.blockTime - firstPool.blockTime) / 60).toFixed(1)} min`);
process.exit(0);
