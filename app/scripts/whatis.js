// What is this address? token info, who created it and when, liquidity, and any StonkFun launches paired to it.
import 'dotenv/config';
import { PublicKey, Connection } from '@solana/web3.js';
import { parseLaunch } from '../src/sniper.js';
import { quote, SOL_MINT } from '../src/jupiter.js';
const KEY = process.env.HELIUS_API_KEY; const RPC = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const conn = new Connection(RPC, 'confirmed');
const a = process.argv[2];
const rpc = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
const acc = await conn.getParsedAccountInfo(new PublicKey(a));
const v = acc.value;
console.log(`owner program: ${v?.owner?.toString() || 'ACCOUNT DOES NOT EXIST'}  type: ${v?.data?.parsed?.type || (v ? 'raw ' + v.data.length + 'B' : '-')}`);
if (v?.data?.parsed?.type === 'mint') {
  const i = v.data.parsed.info;
  console.log(`decimals ${i.decimals} supply ${Number(i.supply) / 10 ** i.decimals} mintAuthority ${i.mintAuthority} freezeAuthority ${i.freezeAuthority}`);
}
const asset = (await rpc('getAsset', { id: a })).result;
if (asset) console.log(`name: ${asset.content?.metadata?.name}  symbol: $${asset.content?.metadata?.symbol}  uri: ${asset.content?.json_uri}  desc: ${(asset.content?.metadata?.description || '').slice(0, 160)}`);
const first = (await rpc('getTransactionsForAddress', [a, { transactionDetails: 'full', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, sortOrder: 'asc', limit: 5 }])).result?.data || [];
const last = (await rpc('getTransactionsForAddress', [a, { transactionDetails: 'signatures', sortOrder: 'desc', limit: 1000 }])).result?.data || [];
if (first[0]) {
  const t = first[0]; const signer = t.transaction.message.accountKeys[0].pubkey.toString();
  const logs = [...new Set((t.meta.logMessages || []).filter((l) => /Instruction: /.test(l)).map((l) => l.replace(/.*Instruction: /, '')))];
  console.log(`created ${new Date(t.blockTime * 1000).toISOString()} (${((Date.now() / 1000 - t.blockTime) / 3600).toFixed(1)}h ago) by ${signer}  ix: ${logs.slice(0, 10).join(',')}`);
  const mints = [...new Set((t.meta.postTokenBalances || []).map((b) => b.mint))];
  if (mints.length > 1) console.log(`  same tx also touched mints: ${mints.filter((m) => m !== a).map((m) => m.slice(0, 8)).join(' ')}`);
}
console.log(`activity: ${last.length >= 1000 ? '1000+' : last.length} txs total, latest ${last[0] ? new Date(last[0].blockTime * 1000).toISOString() : '-'}`);
const largest = await conn.getTokenLargestAccounts(new PublicKey(a)).catch(() => null);
if (largest) {
  for (const x of largest.value.slice(0, 5)) { const o = await conn.getParsedAccountInfo(x.address); console.log(`  holder ${o.value?.data?.parsed?.info?.owner?.slice(0, 8)} ${x.uiAmount}`); }
}
try { const q = await quote(SOL_MINT, a, 1e8, 300, false); console.log(`tradeable: 0.1 SOL -> ${Number(q.outAmount) / 10 ** (v?.data?.parsed?.info?.decimals || 6)} | impact ${(Number(q.priceImpactPct) * 100).toFixed(2)}% | ${(q.routePlan || []).map((p) => p.swapInfo.label).join(' > ')}`); } catch (e) { console.log(`not tradeable on Jupiter yet (${e.message.slice(0, 80)})`); }
let launches = 0; const tick = {};
for (const s of last.slice(0, 300)) {
  const t = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1 }).catch(() => null);
  const L = t && parseLaunch(t);
  if (L && L.quote === a) { launches++; tick[L.symbol] = (tick[L.symbol] || 0) + 1; }
}
console.log(`StonkFun/LaunchLab launches paired to it (in latest ${Math.min(300, last.length)} txs): ${launches}${launches ? ' ' + JSON.stringify(tick) : ''}`);
process.exit(0);
