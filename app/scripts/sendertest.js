// Send one tiny real tx through each landing service (self-transfer + that service's min tip) and time it.
import 'dotenv/config';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { NOZOMI_TIP_ACCOUNTS, ASTRA_TIP_ACCOUNTS, nozomiSend, astraSend, SENDERS as S } from '../src/sniper.js';
const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, 'confirmed');
const w = Keypair.fromSecretKey(bs58.decode(process.env.SNIPE_PRIVATE_KEY || process.env.PRIVATE_KEY));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const JITO = ['96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe', 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY', 'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49'].map((a) => new PublicKey(a));
const SENDER_TIP = ['4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE', 'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ'].map((a) => new PublicKey(a));
const post = (url, body, ct = 'application/json') => fetch(url, { method: 'POST', headers: { 'content-type': ct }, body }).then(async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return r.ok ? { result: t || 'ok' } : { error: `${r.status} ${t.slice(0, 120)}` }; } });
const tests = [
  ['Nozomi', S.nozomiKey, pick(NOZOMI_TIP_ACCOUNTS), 0.001, (b64) => nozomiSend(b64)],
  ['Astralane', S.astraKey, pick(ASTRA_TIP_ACCOUNTS), 0.001, (b64) => astraSend(b64)],
  ['Helius Sender', true, pick(SENDER_TIP), 0.001, (b64) => post(`${S.senderUrl}/fast?api-key=${process.env.HELIUS_API_KEY}`, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] }))],
  ['Jito NY', true, pick(JITO), 0.0001, (b64) => post('https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [b64, { encoding: 'base64' }] }))],
];
for (const [name, enabled, tipTo, tip, send] of tests) {
  if (!enabled) { console.log(`${name}: no key, skipped`); continue; }
  const bh = await conn.getLatestBlockhash('confirmed');
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 2000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000000 }), SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: w.publicKey, lamports: 1 }), SystemProgram.transfer({ fromPubkey: w.publicKey, toPubkey: tipTo, lamports: Math.round(tip * 1e9) })];
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: w.publicKey, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message()); tx.sign([w]);
  const sig = bs58.encode(tx.signatures[0]); const b64 = Buffer.from(tx.serialize()).toString('base64');
  const t0 = Date.now(); const slot0 = await conn.getSlot('processed');
  const r = await send(b64).catch((e) => ({ error: e.message }));
  const acceptMs = Date.now() - t0;
  if (r?.error) { console.log(`${name}: REJECTED in ${acceptMs}ms: ${JSON.stringify(r.error).slice(0, 160)}`); continue; }
  let landed = null;
  for (let i = 0; i < 40 && !landed; i++) { await new Promise((x) => setTimeout(x, 250)); const st = (await conn.getSignatureStatuses([sig])).value[0]; if (st) landed = st; }
  console.log(landed ? `${name}: accepted in ${acceptMs}ms, LANDED ${landed.err ? 'with error ' + JSON.stringify(landed.err) : 'OK'} in slot +${landed.slot - slot0} (~${Date.now() - t0}ms) tip ${tip} SOL` : `${name}: accepted in ${acceptMs}ms but did NOT land within 10s`);
}
process.exit(0);
