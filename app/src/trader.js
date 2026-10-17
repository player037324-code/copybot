import fs from 'fs';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { cfg } from './config.js';
import { quote, buildSwap, getSolUsd, SOL_MINT } from './jupiter.js';
import { log, warn, recordTrade } from './log.js';

const STATE_FILE = 'logs/positions.json';

export const conn = new Connection(cfg.rpcUrl, { commitment: 'confirmed' });
const wallet = cfg.privateKey ? Keypair.fromSecretKey(bs58.decode(cfg.privateKey)) : null;
export const walletAddress = wallet?.publicKey.toBase58() || '(paper, no wallet)';

// positions: { [mint]: { amountRaw: string, decimals, costSol, openedAt, symbolHint } }
let positions = {};
try { positions = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(positions, null, 2));
export const getPositions = () => positions;

// one action at a time per mint so a buy and sell can't race
const locks = new Map();
function withLock(mint, fn) {
  const prev = locks.get(mint) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => { if (locks.get(mint) === next) locks.delete(mint); });
  locks.set(mint, next);
  return next;
}

async function sendSwap(q) {
  const swap = await buildSwap(q, wallet.publicKey.toBase58());
  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
  tx.sign([wallet]);
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
  const res = await conn.confirmTransaction(
    { signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: swap.lastValidBlockHeight },
    'confirmed'
  );
  if (res.value.err) throw new Error(`tx failed ${sig}: ${JSON.stringify(res.value.err)}`);
  return sig;
}

async function tokenBalanceRaw(mint) {
  const r = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) });
  let total = 0n;
  for (const a of r.value) total += BigInt(a.account.data.parsed.info.tokenAmount.amount);
  return total;
}

async function mcapUsd(mint, decimals, tokensOutRaw, solIn) {
  try {
    const supply = await conn.getTokenSupply(new PublicKey(mint));
    const supplyUi = Number(supply.value.uiAmount);
    const tokensUi = Number(tokensOutRaw) / 10 ** decimals;
    const priceSol = solIn / tokensUi;
    const solUsd = await getSolUsd();
    return priceSol * supplyUi * solUsd;
  } catch { return 0; }
}

const fmtUsd = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`);

export function buy(ev, targetSig) {
  return withLock(ev.mint, async () => {
    const have = !!positions[ev.mint];
    if (ev.solSpent < cfg.minTargetBuySol) return log(`skip buy ${ev.mint.slice(0, 6)}: target only spent ${ev.solSpent.toFixed(3)} SOL`);
    if (have && !cfg.copyRebuys) return log(`skip buy ${ev.mint.slice(0, 6)}: already holding`);
    if (!have && Object.keys(positions).length >= cfg.maxPositions) return log(`skip buy ${ev.mint.slice(0, 6)}: max positions (${cfg.maxPositions})`);

    const lamports = Math.floor(cfg.buySol * 1e9);
    const q = await quote(SOL_MINT, ev.mint, lamports);
    const mcap = await mcapUsd(ev.mint, ev.decimals, q.outAmount, cfg.buySol);
    if (cfg.minMcapUsd && mcap && mcap < cfg.minMcapUsd) return log(`skip buy ${ev.mint.slice(0, 6)}: mcap ${fmtUsd(mcap)} under min`);
    if (cfg.maxMcapUsd && mcap > cfg.maxMcapUsd) return log(`skip buy ${ev.mint.slice(0, 6)}: mcap ${fmtUsd(mcap)} over max`);

    let amountRaw = BigInt(q.outAmount);
    let sig = 'paper';
    if (!cfg.paper) {
      const before = have ? await tokenBalanceRaw(ev.mint) : 0n;
      sig = await sendSwap(q);
      const after = await tokenBalanceRaw(ev.mint);
      amountRaw = after - before > 0n ? after - before : amountRaw;
    }

    const p = positions[ev.mint] || { amountRaw: '0', decimals: ev.decimals, costSol: 0, openedAt: Date.now() };
    p.amountRaw = (BigInt(p.amountRaw) + amountRaw).toString();
    p.costSol += cfg.buySol;
    p.entryMcapUsd = p.entryMcapUsd || mcap;
    positions[ev.mint] = p;
    save();

    log(`${cfg.paper ? '[PAPER] ' : ''}BUY ${ev.mint} for ${cfg.buySol} SOL at ${fmtUsd(mcap)} mcap (target spent ${ev.solSpent.toFixed(3)}) ${sig}`);
    recordTrade({ side: 'BUY', mint: ev.mint, sol: cfg.buySol, mcapUsd: Math.round(mcap), paper: cfg.paper, sig, targetSig });
  }).catch((e) => warn(`buy ${ev.mint} failed: ${e.message}`));
}

export function sell(mint, fraction, reason, targetSig) {
  return withLock(mint, async () => {
    const p = positions[mint];
    if (!p) return;
    const full = fraction >= 0.95;
    let amount = full ? BigInt(p.amountRaw) : (BigInt(p.amountRaw) * BigInt(Math.round(fraction * 10000))) / 10000n;
    if (!cfg.paper && full) amount = await tokenBalanceRaw(mint); // sell everything actually in the wallet
    if (amount <= 0n) { delete positions[mint]; save(); return; }

    const q = await quote(mint, SOL_MINT, amount);
    const solOut = Number(q.outAmount) / 1e9;
    let sig = 'paper';
    if (!cfg.paper) sig = await sendSwap(q);

    const portion = full ? 1 : Number(amount) / Number(BigInt(p.amountRaw));
    const costPart = p.costSol * portion;
    const pnl = solOut - costPart;
    const solUsd = await getSolUsd();
    const exitMcap = p.entryMcapUsd && costPart ? p.entryMcapUsd * (solOut / costPart) : 0;

    if (full) delete positions[mint];
    else { p.amountRaw = (BigInt(p.amountRaw) - amount).toString(); p.costSol -= costPart; }
    save();

    log(`${cfg.paper ? '[PAPER] ' : ''}SELL ${Math.round(portion * 100)}% ${mint} for ${solOut.toFixed(4)} SOL, PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL ($${(pnl * solUsd).toFixed(2)}) exit ~${fmtUsd(exitMcap)} [${reason}] ${sig}`);
    recordTrade({ side: 'SELL', mint, portion, solOut, costSol: costPart, pnlSol: pnl, pnlUsd: pnl * solUsd, exitMcapUsd: Math.round(exitMcap), reason, paper: cfg.paper, sig, targetSig });
  }).catch((e) => warn(`sell ${mint} failed: ${e.message}`));
}

// TP / SL / max-hold loop
export async function monitorLoop() {
  for (;;) {
    for (const [mint, p] of Object.entries(positions)) {
      try {
        const ageMin = (Date.now() - p.openedAt) / 60000;
        if (cfg.maxHoldMin && ageMin > cfg.maxHoldMin) { await sell(mint, 1, 'max hold'); continue; }
        if (!cfg.takeProfitPct && !cfg.stopLossPct) continue;
        const q = await quote(mint, SOL_MINT, p.amountRaw);
        const value = Number(q.outAmount) / 1e9;
        const chg = ((value - p.costSol) / p.costSol) * 100;
        if (cfg.takeProfitPct && chg >= cfg.takeProfitPct) await sell(mint, 1, `TP +${chg.toFixed(0)}%`);
        else if (cfg.stopLossPct && chg <= -cfg.stopLossPct) await sell(mint, 1, `SL ${chg.toFixed(0)}%`);
      } catch (e) {
        // no route usually means the coin is dead / rugged
        if (/COULD_NOT_FIND_ANY_ROUTE|No routes/i.test(e.message)) warn(`no route for ${mint.slice(0, 6)}, may be rugged`);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    await new Promise((r) => setTimeout(r, cfg.priceCheckMs));
  }
}
