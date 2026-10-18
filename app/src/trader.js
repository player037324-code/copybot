import fs from 'fs';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { cfg } from './config.js';
import { quote, swapInstructions, getSolUsd, SOL_MINT } from './jupiter.js';
import { buildTx, buildFromIxs, sendAndLand, startWarmers } from './fast.js';
import { cloneBuy } from './clone.js';
import { log, warn, recordTrade, LOG_DIR } from './log.js';

const STATE_FILE = `${LOG_DIR}/positions.json`;

export const conn = new Connection(cfg.rpcUrl, { commitment: 'confirmed' });
const wallet = cfg.privateKey ? Keypair.fromSecretKey(bs58.decode(cfg.privateKey)) : null;
export const walletAddress = wallet?.publicKey.toBase58() || '(paper, no wallet)';

// positions: { [mint]: { amountRaw, decimals, costSol, openedAt, entryMcapUsd, targetSlot } }
let positions = {};
try { positions = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
const save = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(positions, null, 2)); } catch {} };
export const getPositions = () => positions;

// SOL balance kept in memory so buys never wait on an RPC call
let balanceSol = 0;
async function refreshBalance() {
  if (!wallet) return;
  try { balanceSol = (await conn.getBalance(wallet.publicKey, 'processed')) / 1e9; } catch {}
}

export function startTrader() {
  startWarmers(conn);
  refreshBalance();
  setInterval(refreshBalance, 5000).unref();
}

// one action at a time per coin, so a sell always waits for our buy to land
const locks = new Map();
function withLock(mint, fn) {
  const prev = locks.get(mint) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => { if (locks.get(mint) === next) locks.delete(mint); });
  locks.set(mint, next);
  return next;
}
const pending = new Set(); // coins we're mid-buy on

async function tokenBalanceRaw(mint) {
  const r = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(mint) }, 'processed');
  let total = 0n;
  for (const a of r.value) total += BigInt(a.account.data.parsed.info.tokenAmount.amount);
  return total;
}

const fmtUsd = (v) => (!v ? '?' : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`);

async function mcapUsd(mint, decimals, tokensRaw, sol) {
  try {
    const supply = await conn.getTokenSupply(new PublicKey(mint));
    const priceSol = sol / (Number(tokensRaw) / 10 ** decimals);
    return priceSol * Number(supply.value.uiAmount) * (await getSolUsd());
  } catch { return 0; }
}

async function swap(inputMint, outputMint, amountRaw, slippageBps) {
  const t0 = Date.now();
  const q = await quote(inputMint, outputMint, amountRaw, slippageBps);
  const t1 = Date.now();
  if (cfg.paper) return { q, sig: 'paper', slot: null, ms: { quote: t1 - t0 } };
  const ixs = await swapInstructions(q, wallet.publicKey.toBase58());
  const t2 = Date.now();
  const { tx } = await buildTx(conn, wallet, ixs);
  const t3 = Date.now();
  const { sig, slot } = await sendAndLand(conn, tx);
  return { q, sig, slot, ms: { quote: t1 - t0, ixs: t2 - t1, build: t3 - t2, land: Date.now() - t3 } };
}

export function buy(ev, targetSig, targetSlot, seenAt, lunarTx) {
  const tag = ev.mint.slice(0, 6);
  // cheap checks first, before any network call
  if (cfg.newPositionsOnly && !ev.isNew) return log(`skip ${tag}: Lunar already holds it (adding, not a new position)`);
  if (!(ev.solSpent > cfg.minTargetBuySol)) return log(`skip ${tag}: Lunar spent ${ev.solSpent.toFixed(2)} SOL (need > ${cfg.minTargetBuySol})`);
  if ((positions[ev.mint] || pending.has(ev.mint)) && !cfg.copyRebuys) return log(`skip ${tag}: already in it (initial buy only)`);
  if (cfg.maxPositions && Object.keys(positions).length + pending.size >= cfg.maxPositions) return log(`skip ${tag}: max positions`);

  let size = ev.solSpent * (cfg.buyPct / 100);
  if (cfg.maxBuySol) size = Math.min(size, cfg.maxBuySol);
  if (!cfg.paper) {
    const avail = balanceSol - cfg.reserveSol - cfg.tipSol;
    if (avail < 0.01) return warn(`skip ${tag}: wallet too low (${balanceSol.toFixed(3)} SOL)`);
    if (size > avail) { log(`${tag}: sizing down ${size.toFixed(3)} -> ${avail.toFixed(3)} SOL (balance)`); size = avail; }
    balanceSol -= size; // reserve immediately so parallel buys don't overspend
  }
  size = Math.floor(size * 1e9) / 1e9;
  pending.add(ev.mint);

  return withLock(ev.mint, async () => {
    try {
      const steps = [cfg.slippageBps, ...cfg.buyRetrySlippages];
      let r;
      // 1) fastest: rebuild Lunar's own swap with our wallet, no API calls
      if (cfg.directSwap && !cfg.paper && lunarTx) {
        const t0 = Date.now();
        try {
          const { ixs, info } = cloneBuy(lunarTx, cfg.target, wallet, ev, Math.floor(size * 1e9), cfg.slippageBps);
          const alts = (lunarTx.transaction.message.addressTableLookups || []).map((l) => l.accountKey.toString());
          const { tx } = await buildFromIxs(conn, wallet, ixs, alts, cfg.directCuLimit);
          const t1 = Date.now();
          const landed = await sendAndLand(conn, tx);
          r = { q: { outAmount: info.minOut }, sig: landed.sig, slot: landed.slot, ms: { direct: info.amm, build: t1 - t0, land: Date.now() - t1 } };
        } catch (e) {
          const behind = e.slot && targetSlot ? ` (landed +${e.slot - targetSlot} slots after Lunar)` : '';
          warn(`  ${tag} direct swap failed${behind}: ${e.message.slice(0, 160)} -> falling back to Jupiter`);
          if (e.slot) recordTrade({ side: 'BUY_FAIL', mint: ev.mint, sol: size, direct: true, slotsBehind: e.slot && targetSlot ? e.slot - targetSlot : null, error: e.message.slice(0, 200), targetSig });
        }
      }
      // 2) Jupiter, with slippage retries
      for (let i = 0; !r && i < steps.length; i++) {
        try {
          r = await swap(SOL_MINT, ev.mint, Math.floor(size * 1e9), steps[i]);
          if (i > 0) log(`  ${tag} landed on retry ${i} at ${steps[i] / 100}% slippage`);
          break;
        } catch (e) {
          const behind = e.slot && targetSlot ? ` (landed +${e.slot - targetSlot} slots after Lunar)` : '';
          const slip = /"Custom":6001|SlippageToleranceExceeded|0x1771/.test(e.message);
          warn(`  ${tag} attempt ${i + 1} at ${steps[i] / 100}% failed${behind}: ${slip ? 'slippage exceeded' : e.message.slice(0, 160)}`);
          recordTrade({ side: 'BUY_FAIL', mint: ev.mint, sol: size, slippageBps: steps[i], slotsBehind: e.slot && targetSlot ? e.slot - targetSlot : null, error: e.message.slice(0, 200), targetSig });
          if (!slip || i === steps.length - 1) throw e;
          if (!pending.has(ev.mint)) throw new Error('cancelled');
        }
      }
      const reactMs = Date.now() - seenAt;
      let amountRaw = BigInt(r.q.outAmount);
      if (!cfg.paper) {
        const bal = await tokenBalanceRaw(ev.mint).catch(() => 0n);
        if (bal > 0n) amountRaw = bal;
      }
      const p = positions[ev.mint] || { amountRaw: '0', decimals: ev.decimals, costSol: 0, openedAt: Date.now() };
      p.amountRaw = (BigInt(p.amountRaw) + amountRaw).toString();
      p.costSol += size;
      p.targetSlot = targetSlot;
      positions[ev.mint] = p;
      save();
      const slotsBehind = r.slot && targetSlot ? r.slot - targetSlot : null;
      log(`${cfg.paper ? '[PAPER] ' : ''}BUY ${ev.mint} ${size.toFixed(3)} SOL (Lunar ${ev.solSpent.toFixed(2)}) | ${slotsBehind !== null ? `landed +${slotsBehind} slots after Lunar` : ''} | ${reactMs}ms from seeing Lunar | ${JSON.stringify(r.ms)} | ${r.sig}`);
      // mcap is just for the log, done after so it never slows the buy
      mcapUsd(ev.mint, ev.decimals, amountRaw, size).then((m) => {
        if (positions[ev.mint]) { positions[ev.mint].entryMcapUsd = m; save(); }
        log(`  ${tag} entry mcap ${fmtUsd(m)}`);
        recordTrade({ side: 'BUY', mint: ev.mint, sol: size, targetSol: ev.solSpent, mcapUsd: Math.round(m), slotsBehind, reactMs, paper: cfg.paper, sig: r.sig, targetSig });
      });
    } catch (e) {
      warn(`BUY ${tag} gave up: ${e.message.slice(0, 160)}`);
      balanceSol += size;
    } finally {
      pending.delete(ev.mint);
      refreshBalance();
    }
  });
}

export function sell(mint, fraction, reason, targetSig) {
  const tag = mint.slice(0, 6);
  return withLock(mint, async () => {
    const p = positions[mint];
    if (!p) return;
    const all = cfg.sellAllOnAnySell || fraction >= 0.95;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        let amount = all ? BigInt(p.amountRaw) : (BigInt(p.amountRaw) * BigInt(Math.round(fraction * 10000))) / 10000n;
        if (!cfg.paper && all) amount = await tokenBalanceRaw(mint);
        if (amount <= 0n) { delete positions[mint]; save(); return log(`${tag}: nothing left to sell`); }

        const r = await swap(mint, SOL_MINT, amount, cfg.sellSlippageBps);
        const solOut = Number(r.q.outAmount) / 1e9;
        const portion = all ? 1 : Number(amount) / Number(BigInt(p.amountRaw));
        const costPart = p.costSol * portion;
        const pnl = solOut - costPart;
        const solUsd = await getSolUsd();
        const exitMcap = p.entryMcapUsd && costPart ? p.entryMcapUsd * (solOut / costPart) : 0;
        if (portion >= 1) delete positions[mint];
        else { p.amountRaw = (BigInt(p.amountRaw) - amount).toString(); p.costSol -= costPart; }
        save();
        log(`${cfg.paper ? '[PAPER] ' : ''}SELL ${Math.round(portion * 100)}% ${mint} -> ${solOut.toFixed(4)} SOL | PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL ($${(pnl * solUsd).toFixed(2)}) | entry ${fmtUsd(p.entryMcapUsd)} exit ~${fmtUsd(exitMcap)} [${reason}] ${JSON.stringify(r.ms)} ${r.sig}`);
        recordTrade({ side: 'SELL', mint, portion, solOut, costSol: costPart, pnlSol: pnl, pnlUsd: pnl * solUsd, exitMcapUsd: Math.round(exitMcap), reason, paper: cfg.paper, sig: r.sig, targetSig });
        refreshBalance();
        return;
      } catch (e) {
        warn(`SELL ${tag} attempt ${attempt} failed: ${e.message}`);
        if (/COULD_NOT_FIND_ANY_ROUTE|No routes/i.test(e.message) && attempt >= 2) {
          warn(`${tag}: no route, coin may be rugged. Keeping in positions.`);
          return;
        }
      }
    }
  });
}

// optional TP / SL / max-hold (all off by default)
export async function monitorLoop() {
  if (!cfg.takeProfitPct && !cfg.stopLossPct && !cfg.maxHoldMin) return;
  for (;;) {
    for (const [mint, p] of Object.entries(positions)) {
      try {
        if (cfg.maxHoldMin && (Date.now() - p.openedAt) / 60000 > cfg.maxHoldMin) { await sell(mint, 1, 'max hold'); continue; }
        if (!cfg.takeProfitPct && !cfg.stopLossPct) continue;
        const q = await quote(mint, SOL_MINT, p.amountRaw, cfg.sellSlippageBps);
        const chg = ((Number(q.outAmount) / 1e9 - p.costSol) / p.costSol) * 100;
        if (cfg.takeProfitPct && chg >= cfg.takeProfitPct) await sell(mint, 1, `TP +${chg.toFixed(0)}%`);
        else if (cfg.stopLossPct && chg <= -cfg.stopLossPct) await sell(mint, 1, `SL ${chg.toFixed(0)}%`);
      } catch {}
      await new Promise((r) => setTimeout(r, 400));
    }
    await new Promise((r) => setTimeout(r, cfg.priceCheckMs));
  }
}
