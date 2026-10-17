// Low-latency transaction building + landing via Helius Sender.
import {
  PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction,
  ComputeBudgetProgram, SystemProgram, AddressLookupTableAccount,
} from '@solana/web3.js';
import { cfg } from './config.js';
import { warn } from './log.js';

const TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE', 'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta', '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD', '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF', '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey', '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
].map((a) => new PublicKey(a));

const senderSend = `${cfg.senderUrl}/fast?api-key=${cfg.heliusKey}`;

export function startWarmers(conn) {
  // fresh blockhash always in memory, so we never fetch one in the hot path
  const refresh = async () => {
    try { blockhash = await conn.getLatestBlockhash('confirmed'); } catch (e) { warn(`blockhash: ${e.message}`); }
  };
  refresh();
  setInterval(refresh, 1500).unref();
  // keep Sender connection warm (docs: ping when idle > 5s)
  setInterval(() => fetch(`${cfg.senderUrl}/ping`).catch(() => {}), 4000).unref();
}
let blockhash = null;

const altCache = new Map();
async function getAlts(conn, addrs) {
  const missing = addrs.filter((a) => !altCache.has(a));
  if (missing.length) {
    const infos = await conn.getMultipleAccountsInfo(missing.map((a) => new PublicKey(a)), 'confirmed');
    infos.forEach((info, i) => {
      if (info) altCache.set(missing[i], new AddressLookupTableAccount({ key: new PublicKey(missing[i]), state: AddressLookupTableAccount.deserialize(info.data) }));
    });
  }
  return addrs.map((a) => altCache.get(a)).filter(Boolean);
}

const toIx = (ix) => new TransactionInstruction({
  programId: new PublicKey(ix.programId),
  keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
  data: Buffer.from(ix.data, 'base64'),
});

export async function buildTx(conn, wallet, jupIx) {
  if (!blockhash) blockhash = await conn.getLatestBlockhash('confirmed');
  const alts = await getAlts(conn, jupIx.addressLookupTableAddresses || []);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cfg.cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.cuPriceMicroLamports }),
    ...(jupIx.setupInstructions || []).map(toIx),
    toIx(jupIx.swapInstruction),
    ...(jupIx.cleanupInstruction ? [toIx(jupIx.cleanupInstruction)] : []),
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)],
      lamports: Math.round(cfg.tipSol * 1e9),
    }),
  ];
  const bh = blockhash;
  const msg = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message(alts);
  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);
  return { tx, lastValidBlockHeight: bh.lastValidBlockHeight };
}

async function postSender(b64) {
  const r = await fetch(senderSend, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error(`Sender: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}

// Send, keep rebroadcasting until it lands or fails. Returns { sig, slot }.
export async function sendAndLand(conn, tx) {
  const b64 = Buffer.from(tx.serialize()).toString('base64');
  const sig = await postSender(b64);
  conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 }).catch(() => {}); // second path
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const st = (await conn.getSignatureStatuses([sig]).catch(() => ({ value: [null] }))).value[0];
    if (st) {
      if (st.err) { const e = new Error(`tx failed ${sig}: ${JSON.stringify(st.err)}`); e.slot = st.slot; e.sig = sig; throw e; }
      return { sig, slot: st.slot };
    }
    if (i % 3 === 2) postSender(b64).catch(() => {});
  }
  throw new Error(`tx not landed ${sig}`);
}
