// Direct swap: rebuild Lunar's own AMM instruction with OUR wallet + accounts.
// No Jupiter, no HTTP. Everything comes from Lunar's transaction.
import crypto from 'crypto';
import {
  PublicKey, TransactionInstruction, SystemProgram,
} from '@solana/web3.js';

const disc = (name) => crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const hex = (b) => Buffer.from(b).toString('hex');

export const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// program -> { buy instruction names Lunar might use, the exact-in name we send, user-seeded PDAs }
export const AMMS = {
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': { name: 'pump.fun', buys: ['buy', 'buy_exact_sol_in', 'buy_exact_quote_in'], exactIn: ['buy_exact_sol_in', 'buy_exact_quote_in'], rawExactIn: ['e1f7501ed5b38488'], use: 'buy_exact_sol_in', nativeSol: true, userPdas: ['user_volume_accumulator'] },
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': { name: 'pumpswap', buys: ['buy', 'buy_exact_quote_in'], exactIn: ['buy_exact_quote_in'], use: 'buy_exact_quote_in', userPdas: ['user_volume_accumulator'] },
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG': { name: 'meteora-damm2', buys: ['swap', 'swap2'], exactIn: ['swap'], use: 'swap', userPdas: [] },
  'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN': { name: 'meteora-dbc', buys: ['swap', 'swap2'], exactIn: ['swap'], use: 'swap', userPdas: [] },
};
for (const a of Object.values(AMMS)) {
  a.buyDiscs = new Set(a.buys.map((n) => hex(disc(n))));
  a.useDisc = disc(a.use);
  a.exactInDiscs = new Set([...a.exactIn.map((n) => hex(disc(n))), ...(a.rawExactIn || [])]);
  for (const r of a.rawExactIn || []) a.buyDiscs.add(r);
}

const b58 = (() => {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  return (s) => {
    let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
    let h = n.toString(16); if (h.length % 2) h = '0' + h;
    let z = 0; for (const c of s) { if (c === '1') z++; else break; }
    return Buffer.concat([Buffer.alloc(z), n === 0n ? Buffer.alloc(0) : Buffer.from(h, 'hex')]);
  };
})();

export function ata(owner, mint, tokenProgram) {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()], ATA_PROGRAM)[0];
}
function createAtaIdempotent(payer, owner, mint, tokenProgram) {
  const a = ata(owner, mint, tokenProgram);
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: a, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(tokenProgram), isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}
const syncNative = (acc) => new TransactionInstruction({ programId: new PublicKey(TOKEN), keys: [{ pubkey: acc, isSigner: false, isWritable: true }], data: Buffer.from([17]) });
const closeAccount = (acc, dest, owner) => new TransactionInstruction({
  programId: new PublicKey(TOKEN),
  keys: [{ pubkey: acc, isSigner: false, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }],
  data: Buffer.from([9]),
});

const keyStr = (k) => (typeof k === 'string' ? k : k.pubkey ? k.pubkey.toString() : k.toString());

// Find Lunar's AMM buy instruction (top level or inner CPI) in a jsonParsed tx.
export function findBuyIx(tx) {
  const msg = tx.transaction.message;
  const cands = [...msg.instructions];
  for (const inner of tx.meta?.innerInstructions || []) cands.push(...inner.instructions);
  for (const ix of cands) {
    const pid = keyStr(ix.programId);
    const amm = AMMS[pid];
    if (!amm || !ix.data || !ix.accounts) continue;
    const data = b58(ix.data);
    if (data.length < 24 || !amm.buyDiscs.has(hex(data.subarray(0, 8)))) continue;
    return { pid, amm, accounts: ix.accounts.map(keyStr), data };
  }
  return null;
}

// Map every Lunar-owned account in his instruction to our equivalent.
function buildAccountMap(tx, target, our, ammPid, amm) {
  const keys = tx.transaction.message.accountKeys.map(keyStr);
  const map = new Map([[target, our.toBase58()]]);
  const tokenAccts = {}; // lunar token account -> {mint, program}
  for (const b of [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])]) {
    if (b.owner === target) tokenAccts[keys[b.accountIndex]] = { mint: b.mint, program: b.programId || TOKEN };
  }
  // token accounts Lunar created + closed inside the tx (temp WSOL) never show in balances
  const all = [...tx.transaction.message.instructions];
  for (const inner of tx.meta?.innerInstructions || []) all.push(...inner.instructions);
  for (const ix of all) {
    const p = ix.parsed; if (!p?.info) continue;
    if (/^initializeAccount/.test(p.type) && p.info.owner === target) tokenAccts[p.info.account] = { mint: p.info.mint, program: keyStr(ix.programId) };
    if (p.type === 'createIdempotent' || p.type === 'create') { if (p.info.wallet === target) tokenAccts[p.info.account] = { mint: p.info.mint, program: p.info.tokenProgram || TOKEN }; }
  }
  for (const [acc, { mint, program }] of Object.entries(tokenAccts)) map.set(acc, ata(our, mint, program).toBase58());
  for (const seed of amm.userPdas) {
    const pid = new PublicKey(ammPid);
    const theirs = PublicKey.findProgramAddressSync([Buffer.from(seed), new PublicKey(target).toBuffer()], pid)[0].toBase58();
    const ours = PublicKey.findProgramAddressSync([Buffer.from(seed), our.toBuffer()], pid)[0].toBase58();
    map.set(theirs, ours);
  }
  return { map, tokenAccts };
}

/**
 * Build our instructions copying Lunar's buy.
 * ev: { mint, solSpent, tokensRaw }  (tokensRaw = how many raw tokens Lunar received)
 * Returns { ixs, info } or throws if this trade can't be cloned (caller falls back to Jupiter).
 */
export function cloneBuy(tx, target, wallet, ev, lamports, slippageBps) {
  const found = findBuyIx(tx);
  if (!found) throw new Error('no supported AMM buy in Lunar tx');
  const { pid, amm, accounts, data } = found;
  const our = wallet.publicKey;
  const { map, tokenAccts } = buildAccountMap(tx, target, our, pid, amm);

  // Lunar's ix as signed by him: which accounts were signers/writable
  const keys = tx.transaction.message.accountKeys;
  const meta = (k) => keys.find((x) => keyStr(x) === k) || {};
  const outKeys = accounts.map((k) => {
    const mapped = map.get(k) || k;
    const m = meta(k);
    return { pubkey: new PublicKey(mapped), isSigner: mapped === our.toBase58(), isWritable: !!m.writable || mapped === our.toBase58() };
  });
  if (accounts.some((k) => k === target) === false) throw new Error('Lunar wallet not in AMM ix (unknown router layout)');

  // expected tokens for our size, from Lunar's own fill, then apply slippage
  const tokensPerLamport = Number(ev.tokensRaw) / (ev.solSpent * 1e9);
  const expected = lamports * tokensPerLamport * 0.85; // price is higher after his buy
  const minOut = BigInt(Math.max(1, Math.floor(expected * (1 - slippageBps / 10000))));
  const amt = Buffer.alloc(16);
  amt.writeBigUInt64LE(BigInt(lamports), 0);
  amt.writeBigUInt64LE(minOut, 8);
  const tail = data.length > 24 ? data.subarray(24) : Buffer.alloc(0); // e.g. pump track_volume flag
  // if Lunar already used an exact-SOL-in instruction, reuse exactly that one (same account layout)
  const hisDisc = data.subarray(0, 8);
  const useDisc = amm.exactInDiscs.has(hex(hisDisc)) ? hisDisc : amm.useDisc;
  const isSwap = hex(useDisc) === hex(disc('swap'));
  const ixData = Buffer.concat([useDisc, amt, isSwap ? Buffer.alloc(0) : tail]);
  const swapIx = new TransactionInstruction({ programId: new PublicKey(pid), keys: outKeys, data: ixData });

  // setup: our token ATA (+ funded WSOL if this AMM takes WSOL)
  const tokenProgram = Object.values(tokenAccts).find((t) => t.mint === ev.mint)?.program || TOKEN;
  const pre = [createAtaIdempotent(our, our, ev.mint, tokenProgram)];
  const post = [];
  const usesWsol = !amm.nativeSol && Object.values(tokenAccts).some((t) => t.mint === WSOL);
  if (usesWsol) {
    const w = ata(our, WSOL, TOKEN);
    pre.push(createAtaIdempotent(our, our, WSOL, TOKEN));
    pre.push(SystemProgram.transfer({ fromPubkey: our, toPubkey: w, lamports }));
    pre.push(syncNative(w));
    post.push(closeAccount(w, our, our));
  }
  return { ixs: [...pre, swapIx, ...post], info: { amm: amm.name, minOut: minOut.toString(), usesWsol } };
}
