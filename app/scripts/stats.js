import fs from 'fs';

const file = 'logs/trades.jsonl';
if (!fs.existsSync(file)) { console.log('No trades yet.'); process.exit(0); }

const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const buys = rows.filter((r) => r.side === 'BUY');
const sells = rows.filter((r) => r.side === 'SELL');
const pnlSol = sells.reduce((s, r) => s + r.pnlSol, 0);
const pnlUsd = sells.reduce((s, r) => s + (r.pnlUsd || 0), 0);
const wins = sells.filter((r) => r.pnlSol > 0).length;

let open = {};
try { open = JSON.parse(fs.readFileSync('logs/positions.json', 'utf8')); } catch {}

console.log(`Buys: ${buys.length}   Sells: ${sells.length}   Open: ${Object.keys(open).length}`);
console.log(`Realized PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL ($${pnlUsd.toFixed(2)})`);
if (sells.length) console.log(`Win rate: ${((wins / sells.length) * 100).toFixed(0)}% (${wins}/${sells.length})`);
console.log('\nLast 10 trades:');
for (const r of rows.slice(-10)) {
  const t = r.time.slice(5, 19).replace('T', ' ');
  if (r.side === 'BUY') console.log(`${t}  BUY  ${r.mint.slice(0, 8)}  ${Number(r.sol).toFixed(3)} SOL  @ $${((r.mcapUsd || 0) / 1000).toFixed(1)}K mcap  (+${r.slotsBehind ?? '?'} slots, ${r.reactMs ?? '?'}ms)`);
  else if (r.side === 'BUY_FAIL') console.log(`${t}  FAIL ${r.mint.slice(0, 8)}  ${r.error}`);
  else console.log(`${t}  SELL ${r.mint.slice(0, 8)}  ${r.pnlSol >= 0 ? '+' : ''}${r.pnlSol.toFixed(4)} SOL  [${r.reason}]`);
}
