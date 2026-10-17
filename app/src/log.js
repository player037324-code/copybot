import fs from 'fs';
import path from 'path';

const dir = path.resolve(process.env.LOG_DIR || 'logs');
fs.mkdirSync(dir, { recursive: true });
const tradesFile = path.join(dir, 'trades.jsonl');

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export const log = (...a) => console.log(`[${ts()}]`, ...a);
export const warn = (...a) => console.warn(`[${ts()}] WARN`, ...a);

export function recordTrade(t) {
  fs.appendFileSync(tradesFile, JSON.stringify({ time: new Date().toISOString(), ...t }) + '\n');
}

export const TRADES_FILE = tradesFile;
export const LOG_DIR = dir;
