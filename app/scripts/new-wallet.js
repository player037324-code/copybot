// Creates a fresh trading wallet and saves its private key straight into .env.
// The key never gets printed. Only the public address is shown.
import fs from 'fs';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

const envPath = '.env';
if (!fs.existsSync(envPath)) fs.copyFileSync('.env.example', envPath);
let env = fs.readFileSync(envPath, 'utf8');

const existing = env.match(/^PRIVATE_KEY=(.+)$/m);
if (existing && existing[1].trim() && !process.argv.includes('--force')) {
  const kp = Keypair.fromSecretKey(bs58.decode(existing[1].trim()));
  console.log(`A wallet already exists: ${kp.publicKey.toBase58()}`);
  console.log('Run with --force to replace it (move funds out first!)');
  process.exit(0);
}

if (existing && existing[1].trim()) {
  // never throw away a key that might hold funds
  const bak = `wallet-backup-${Date.now()}.txt`;
  fs.writeFileSync(bak, existing[0] + '\n', { mode: 0o600 });
  console.log(`Old key backed up to ${bak}`);
}

const kp = Keypair.generate();
const line = `PRIVATE_KEY=${bs58.encode(kp.secretKey)}`;
env = /^PRIVATE_KEY=.*$/m.test(env) ? env.replace(/^PRIVATE_KEY=.*$/m, line) : env + `\n${line}\n`;
fs.writeFileSync(envPath, env, { mode: 0o600 });
fs.chmodSync(envPath, 0o600);

console.log('New trading wallet created and saved to .env');
console.log(`Address (send SOL here): ${kp.publicKey.toBase58()}`);
console.log('To import into Phantom later: cat .env | grep PRIVATE_KEY  (only do this on the server)');
