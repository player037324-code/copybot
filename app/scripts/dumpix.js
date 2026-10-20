// Dump every LaunchLab instruction (accounts + data) in the first N txs of a mint.
import { conn } from '../src/trader.js';
import { cfg } from '../src/config.js';
import bs58 from 'bs58';
const mint = process.argv[2]; const N = Number(process.argv[3] || 2);
const LL = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
const rpc = async (method, params) => (await (await fetch(cfg.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
const sigs = ((await rpc('getTransactionsForAddress', [mint, { transactionDetails: 'signatures', sortOrder: 'asc', limit: 10, filters: { status: 'succeeded' } }])).result?.data || []).slice(0, N);
for (const s of sigs) {
  const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1 });
  const keys = tx.transaction.message.accountKeys;
  const meta = (a) => { const k = keys.find((x) => x.pubkey.toString() === a); return `${k?.signer ? 'S' : '-'}${k?.writable ? 'W' : '-'}`; };
  console.log(`\n=== ${s.signature} slot ${s.slot} signer ${keys[0].pubkey}`);
  const all = tx.transaction.message.instructions.map((i) => ['top', i]);
  for (const g of tx.meta.innerInstructions || []) for (const i of g.instructions) all.push([`in${g.index}`, i]);
  for (const [w, ix] of all) {
    const pid = ix.programId.toString();
    if (pid === LL && ix.data) {
      const d = Buffer.from(bs58.decode(ix.data));
      console.log(`[${w}] LaunchLab disc ${d.subarray(0, 8).toString('hex')} len ${d.length}`);
      console.log(`   data ${d.toString('hex').slice(0, 400)}`);
      ix.accounts.forEach((a, j) => console.log(`   ${String(j).padStart(2)} ${meta(a.toString())} ${a}`));
    } else if (ix.parsed && /Metadata|metadata/.test(ix.parsed.type || '')) {
      console.log(`[${w}] ${ix.program} ${ix.parsed.type} ${JSON.stringify(ix.parsed.info).slice(0, 200)}`);
    }
  }
}
process.exit(0);
