// Take-profit ladder for every position the sniper bought.
// Each time a position reaches another +100% from entry (2x, 3x, 4x ...), sell 10% of the ORIGINAL size to SOL.
// If the price jumps several levels at once, it sells all the missed steps together.
import 'dotenv/config';
import fs from 'fs';
import bs58 from 'bs58';
import { Keypair, PublicKey } from '@solana/web3.js';
import { conn } from './trader.js';
import { quote, swapInstructions, SOL_MINT } from './jupiter.js';
import { buildFromIxs, sendAndLand, startWarmers } from './fast.js';

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k].trim());
const STATE = 'logs/snipe-state.json';
const STEP_GAIN = Number(env('LADDER_STEP_GAIN_PCT', '100')) / 100; // +100% per step
const STEP_SELL = Number(env('LADDER_SELL_PCT', '10')) / 100;      // sell 10% of original per step
const POLL_MS = Number(env('LADDER_POLL_MS', '3000'));
const SLIP = Number(env('LADDER_SLIPPAGE_BPS', '2500'));
const QUOTE_MINT = env('SNIPE_QUOTE_MINT', '');
const wallet = Keypair.fromSecretKey(bs58.decode(env('SNIPE_PRIVATE_KEY', env('PRIVATE_KEY', ''))));
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const warn = (...a) => console.warn(`[${ts()}] WARN`, ...a);
const toIx = (ix) => ({ programId: new PublicKey(ix.programId), keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })), data: Buffer.from(ix.data, 'base64') });

startWarmers(conn);
const read = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const write = (st) => fs.writeFileSync(STATE, JSON.stringify(st, null, 2));

async function balanceRaw(mint) {
  const r = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) }, 'confirmed');
  return r.value.reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);
}

const lastLog = {};
async function tick() {
  const st = read();
  // one position per mint (a single buy can cover two targets)
  const byMint = {};
  for (const [k, p] of Object.entries(st)) if (p.ourSig && !p.err && p.tokensRaw && p.costRaw) byMint[p.mint] ||= { keys: [], p };
  for (const k of Object.keys(st)) { const p = st[k]; if (byMint[p.mint]) byMint[p.mint].keys.push(k); }
  for (const [mint, { keys, p }] of Object.entries(byMint)) {
    const steps = p.ladderSteps || 0;
    const origTokens = BigInt(p.tokensRaw);
    const chunk = (origTokens * BigInt(Math.round(STEP_SELL * 10000))) / 10000n;
    if (chunk <= 0n) continue;
    const held = await balanceRaw(mint).catch(() => null);
    if (held === null) continue;
    if (held === 0n) { if (!p.ladderDone) { for (const k of keys) st[k].ladderDone = true; write(st); log(`${p.symbol}: position is empty, ladder done`); } continue; }
    // price: value of one 10% chunk in the pool token we paid with, vs its share of our cost
    let q;
    try { q = await quote(mint, QUOTE_MINT || p.quoteMint || QUOTE_MINT, chunk.toString(), SLIP, false); } catch (e) {
      if (!lastLog[mint] || Date.now() - lastLog[mint] > 60000) { warn(`${p.symbol}: no price route yet (${e.message.slice(0, 80)})`); lastLog[mint] = Date.now(); }
      continue;
    }
    const chunkCost = (Number(p.costRaw) * STEP_SELL);
    const mult = Number(q.outAmount) / chunkCost; // 1.0 = break even, 2.0 = +100%
    const due = Math.max(0, Math.floor((mult - 1) / STEP_GAIN + 1e-9)); // steps earned so far
    if (!lastLog[`m${mint}`] || Date.now() - lastLog[`m${mint}`] > 60000) { log(`${p.symbol}: ${mult.toFixed(2)}x from entry | steps sold ${steps} | holding ${(Number(held) / 10 ** p.decimals).toFixed(0)}`); lastLog[`m${mint}`] = Date.now(); }
    if (due <= steps) continue;
    let n = due - steps;
    let amount = chunk * BigInt(n);
    if (amount > held) amount = held;
    try {
      const sq = await quote(mint, SOL_MINT, amount.toString(), SLIP, false);
      const ixs = await swapInstructions(sq, wallet.publicKey.toBase58());
      const { tx } = await buildFromIxs(conn, wallet, [...(ixs.setupInstructions || []), ixs.swapInstruction, ...(ixs.cleanupInstruction ? [ixs.cleanupInstruction] : [])].map(toIx), ixs.addressLookupTableAddresses || [], 400000);
      const r = await sendAndLand(conn, tx);
      for (const k of keys) { st[k].ladderSteps = due; (st[k].ladderSells ||= []).push({ at: new Date().toISOString(), mult: +mult.toFixed(2), steps: n, tokensRaw: amount.toString(), solOut: Number(sq.outAmount) / 1e9, sig: r.sig }); }
      write(st);
      log(`${p.symbol}: TAKE PROFIT at ${mult.toFixed(2)}x -> sold ${n * STEP_SELL * 100}% of original for ~${(Number(sq.outAmount) / 1e9).toFixed(4)} SOL | ${r.sig}`);
    } catch (e) { warn(`${p.symbol}: ladder sell failed at ${mult.toFixed(2)}x: ${e.message.slice(0, 160)}`); }
  }
}

log(`ladder running: every +${STEP_GAIN * 100}% from entry -> sell ${STEP_SELL * 100}% of original to SOL | wallet ${wallet.publicKey.toBase58()}`);
(async function loop() { for (;;) { try { await tick(); } catch (e) { warn(e.message); } await new Promise((r) => setTimeout(r, POLL_MS)); } })();
