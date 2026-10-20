// StonkFun / Raydium LaunchLab sniper.
// Watches for the FIRST launch paired to SNIPE_QUOTE_MINT with ticker SNIPE_TICKER and buys it
// in the next block, paying with the quote token the wallet already holds. Zero network calls
// between seeing the launch and sending the buy.
import 'dotenv/config';
import fs from 'fs';
import crypto from 'crypto';
import WebSocket from 'ws';
import bs58 from 'bs58';
import {
  Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction,
  ComputeBudgetProgram, SystemProgram,
} from '@solana/web3.js';

// ---------- config ----------
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k].trim());
const S = {
  heliusKey: env('HELIUS_API_KEY', ''),
  privateKey: env('SNIPE_PRIVATE_KEY', env('PRIVATE_KEY', '')),
  quoteMint: env('SNIPE_QUOTE_MINT', ''),
  ticker: env('SNIPE_TICKER', '').replace(/^\$/, '').toUpperCase(),
  amount: Number(env('SNIPE_AMOUNT', '0')), // in quote-token units (e.g. 1400 SAMA4)
  // SNIPE_TARGETS="*:1000,TRUMP:1000" -> snipe the first launch (any ticker) AND the first $TRUMP.
  // If one launch matches several targets it is bought once (amount of the first listed target).
  targetsRaw: env('SNIPE_TARGETS', ''),
  platform: env('SNIPE_PLATFORM', '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt'), // StonkFun's LaunchLab platform
  minOutRaw: BigInt(env('SNIPE_MIN_OUT_RAW', '0')),
  cuLimit: Number(env('SNIPE_CU_LIMIT', '150000')),
  cuPrice: Number(env('SNIPE_CU_PRICE', '33000000')), // microLamports/CU. 150k x 33M = 0.005 SOL (matches the #1 buy on $ALTCOIN)
  jitoTipSol: Number(env('SNIPE_JITO_TIP_SOL', '0.45')),  // the #1 buy on $ALTCOIN tipped Jito 0.4 SOL
  tipSol: Number(env('SNIPE_TIP_SOL', '0.001')),         // Helius Sender tip
  jitoUrls: env('SNIPE_JITO_URLS', 'https://ny.mainnet.block-engine.jito.wtf,https://mainnet.block-engine.jito.wtf,https://slc.mainnet.block-engine.jito.wtf,https://frankfurt.mainnet.block-engine.jito.wtf').split(',').map((x) => x.trim()).filter(Boolean),
  maxLateSlots: Number(env('SNIPE_MAX_LATE_SLOTS', '3')),
  preprocessed: env('SNIPE_PREPROCESSED', 'true').toLowerCase() === 'true', // early shred-decoded feed
  dryRun: env('SNIPE_DRY_RUN', 'true').toLowerCase() === 'true',
  senderUrl: env('SENDER_URL', 'http://ewr-sender.helius-rpc.com'),
  nozomiKey: env('NOZOMI_KEY', ''), nozomiUrl: env('NOZOMI_URL', 'http://ewr1.nozomi.temporal.xyz'), nozomiTipSol: Number(env('SNIPE_NOZOMI_TIP_SOL', '0.001')),
  astraKey: env('ASTRALANE_KEY', ''), astraUrl: env('ASTRALANE_URL', 'http://ny.gateway.astralane.io'), astraTipSol: Number(env('SNIPE_ASTRALANE_TIP_SOL', '0.001')),
};
const RPC = `https://mainnet.helius-rpc.com/?api-key=${S.heliusKey}`;
const WSS = [`wss://mainnet.helius-rpc.com/?api-key=${S.heliusKey}`, `wss://beta.helius-rpc.com/?api-key=${S.heliusKey}`];
const STATE = 'logs/snipe-state.json';
fs.mkdirSync('logs', { recursive: true });

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 23);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const warn = (...a) => console.warn(`[${ts()}] WARN`, ...a);

// ---------- LaunchLab constants (verified against the real $ALTCOIN launch) ----------
export const LL = new PublicKey('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj');
const GLOBAL_CONFIG = new PublicKey('31WUZ2UsqHCxDaZTZEX1z9noY5rxGmw6ZyAqmG53rirH');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, LL)[0];
const AUTHORITY = pda([Buffer.from('vault_auth_seed')]);
const EVENT_AUTH = pda([Buffer.from('__event_authority')]);
const disc = (n) => crypto.createHash('sha256').update(`global:${n}`).digest().subarray(0, 8);
const BUY_EXACT_IN = disc('buy_exact_in'); // faea0d7bd59c13ec
const CREATE_DISCS = new Set(['25be7ede2c9aab11', ...['initialize', 'initialize_v2', 'initialize_with_token_2022'].map((n) => disc(n).toString('hex'))]);
const TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE', 'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta', '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD', '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF', '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey', '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
].map((a) => new PublicKey(a));
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY', 'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL', '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
].map((a) => new PublicKey(a));

export const NOZOMI_TIP_ACCOUNTS = ['TEMPaMeCRFAS9EKF53Jd6KpHxgL47uWLcpFArU1Fanq', 'noz3jAjPiHuBPqiSPkkugaJDkJscPuRhYnSpbi8UvC4', 'noz3str9KXfpKknefHji8L1mPgimezaiUyCHYMDv1GE', 'noz6uoYCDijhu1V7cutCpwxNiSovEwLdRHPwmgCGDNo', 'noz9EPNcT7WH6Sou3sr3GGjHQYVkN3DNirpbvDkv9YJ', 'nozc5yT15LazbLTFVZzoNZCwjh3yUtW86LoUyqsBu4L', 'nozFrhfnNGoyqwVuwPAW4aaGqempx4PU6g6D9CJMv7Z', 'nozievPk7HyK1Rqy1MPJwVQ7qQg2QoJGyP71oeDwbsu', 'noznbgwYnBLDHu8wcQVCEw6kDrXkPdKkydGJGNXGvL7', 'nozNVWs5N8mgzuD3qigrCG2UoKxZttxzZ85pvAQVrbP', 'nozpEGbwx4BcGp6pvEdAh1JoC2CQGZdU6HbNP1v2p6P', 'nozrhjhkCr3zXT3BiT4WCodYCUFeQvcdUkM7MqhKqge', 'nozrwQtWhEdrA6W8dkbt9gnUaMs52PdAv5byipnadq3', 'nozUacTVWub3cL4mJmGCYjKZTnE9RbdY5AP46iQgbPJ', 'nozWCyTPppJjRuw2fpzDhhWbW355fzosWSzrrMYB1Qk', 'nozWNju6dY353eMkMqURqwQEoM3SFgEKC6psLCSfUne', 'nozxNBgWohjR75vdspfxR5H9ceC7XXH99xpxhVGt3Bb'].map((a) => new PublicKey(a));
export const ASTRA_TIP_ACCOUNTS = ['astrazznxsGUhWShqgNtAdfrzP2G83DzcWVJDxwV9bF', 'astra4uejePWneqNaJKuFFA8oonqCE1sqF6b45kDMZm', 'astra9xWY93QyfG6yM8zwsKsRodscjQ2uU2HKNL5prk', 'astraRVUuTHjpwEVvNBeQEgwYx9w9CFyfxjYoobCZhL', 'astraEJ2fEj8Xmy6KLG7B3VfbKfsHXhHrNdCQx7iGJK', 'astraubkDw81n4LuutzSQ8uzHCv4BhPVhfvTcYv8SKC', 'astraZW5GLFefxNPAatceHhYjfA1ciq9gvfEg2S47xk', 'astrawVNP4xDBKT7rAdxrLYiTSTdqtUr63fSMduivXK'].map((a) => new PublicKey(a));
export const nozomiSend = (b64) => fetch(`${S.nozomiUrl}/api/sendTransaction2?c=${S.nozomiKey}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: b64 }).then(async (r) => (r.ok ? { result: 'ok' } : { error: `nozomi ${r.status} ${(await r.text()).slice(0, 100)}` }));
export const astraSend = (b64) => fetch(`${S.astraUrl}/iris2?api-key=${S.astraKey}&method=sendTransaction`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: b64 }).then(async (r) => { const t = await r.text(); try { const j = JSON.parse(t); return j; } catch { return r.ok ? { result: t } : { error: `astralane ${r.status} ${t.slice(0, 100)}` }; } });
export const SENDERS = S;

const ata = (owner, mint, prog) => PublicKey.findProgramAddressSync([owner.toBuffer(), prog.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

// ---------- parse a launch from a LaunchLab create instruction ----------
function readStr(buf, o) { const n = buf.readUInt32LE(o); return [buf.subarray(o + 4, o + 4 + n).toString('utf8'), o + 4 + n]; }
export function parseLaunch(tx) {
  const msg = tx.transaction.message;
  // launches can be direct LaunchLab calls OR wrapped by another program (StonkFun's J7pour router) as an inner CPI
  const all = [...msg.instructions];
  for (const g of tx.meta?.innerInstructions || []) all.push(...g.instructions);
  for (const ix of all) {
    if ((ix.programId?.toString?.() ?? ix.programId) !== LL.toBase58() || !ix.data) continue;
    const d = Buffer.from(bs58.decode(ix.data));
    if (!CREATE_DISCS.has(d.subarray(0, 8).toString('hex'))) continue;
    try {
      let o = 8; const decimals = d[o]; o += 1;
      const [name, o2] = readStr(d, o); const [symbol] = readStr(d, o2);
      const a = ix.accounts.map((k) => k.toString());
      // create accounts (both variants): 0 payer,1 creator,2 global,3 platform,4 authority,5 pool,6 base,7 quote,8 baseVault,9 quoteVault
      // token programs sit at different slots per variant (Token-2022 launch vs classic SPL launch), so read them
      // from the token balances in this same tx (each balance carries its programId), with a safe fallback.
      const bals = [...(tx.meta?.postTokenBalances || []), ...(tx.meta?.preTokenBalances || [])];
      const progOf = (mint) => bals.find((b) => b.mint === mint && b.programId)?.programId;
      const isT22 = d.subarray(0, 8).toString('hex') === '25be7ede2c9aab11';
      const tokenProgs = a.filter((k) => k === TOKEN.toBase58() || k === TOKEN22.toBase58());
      const baseProg = progOf(a[6]) || (isT22 ? TOKEN22.toBase58() : TOKEN.toBase58());
      const quoteProg = progOf(a[7]) || (isT22 ? a[11] : tokenProgs[tokenProgs.length - 1]) || TOKEN.toBase58();
      return { name, symbol, decimals, globalConfig: a[2], authority: a[4], creator: a[1], platform: a[3], pool: a[5], base: a[6], quote: a[7], baseVault: a[8], quoteVault: a[9], baseProg, quoteProg, variant: isT22 ? 'token2022' : 'spl' };
    } catch { return null; }
  }
  return null;
}

// ---------- build our buy (pure local, no RPC) ----------
// per-pool things that never change between launches are cached (my quote ATA, platform fee vault)
const cache = new Map();
const cached = (k, f) => { if (!cache.has(k)) cache.set(k, f()); return cache.get(k); };
export function buildBuyIxs(L, wallet, amountRaw, minOutRaw) {
  const me = wallet.publicKey;
  const base = new PublicKey(L.base); const quote = cached(`q${L.quote}`, () => new PublicKey(L.quote));
  const baseProg = L.baseProg === TOKEN22.toBase58() ? TOKEN22 : new PublicKey(L.baseProg);
  const quoteProg = cached(`qp${L.quoteProg}`, () => new PublicKey(L.quoteProg));
  const platform = cached(`p${L.platform}`, () => new PublicKey(L.platform));
  // pool + vaults come straight from the launch tx (verified identical to the derived PDAs); derive only if missing
  const pool = L.pool ? new PublicKey(L.pool) : pda([Buffer.from('pool'), base.toBuffer(), quote.toBuffer()]);
  const baseVault = L.baseVault ? new PublicKey(L.baseVault) : pda([Buffer.from('pool_vault'), pool.toBuffer(), base.toBuffer()]);
  const quoteVault = L.quoteVault ? new PublicKey(L.quoteVault) : pda([Buffer.from('pool_vault'), pool.toBuffer(), quote.toBuffer()]);
  const myBase = ata(me, base, baseProg);
  const myQuote = cached(`mq${me.toBase58()}${L.quote}`, () => ata(me, quote, quoteProg));
  const platformFee = cached(`pf${L.platform}${L.quote}`, () => pda([platform.toBuffer(), quote.toBuffer()]));
  const creatorFee = pda([new PublicKey(L.creator).toBuffer(), quote.toBuffer()]);
  const keys = [
    [me, true, true], [L.authority ? cached(`a${L.authority}`, () => new PublicKey(L.authority)) : AUTHORITY, false, false], [L.globalConfig ? cached(`g${L.globalConfig}`, () => new PublicKey(L.globalConfig)) : GLOBAL_CONFIG, false, false], [platform, false, false],
    [pool, false, true], [myBase, false, true], [myQuote, false, true],
    [baseVault, false, true], [quoteVault, false, true],
    [base, false, false], [quote, false, false], [baseProg, false, false], [quoteProg, false, false],
    [EVENT_AUTH, false, false], [LL, false, false], [SystemProgram.programId, false, false],
    [platformFee, false, true], [creatorFee, false, true],
  ].map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable }));
  const data = Buffer.alloc(32);
  BUY_EXACT_IN.copy(data, 0);
  data.writeBigUInt64LE(BigInt(amountRaw), 8);
  data.writeBigUInt64LE(BigInt(minOutRaw), 16);
  data.writeBigUInt64LE(0n, 24); // share_fee_rate
  const createBaseAta = new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: me, isSigner: true, isWritable: true }, { pubkey: myBase, isSigner: false, isWritable: true },
      { pubkey: me, isSigner: false, isWritable: false }, { pubkey: base, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: baseProg, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
  return [createBaseAta, new TransactionInstruction({ programId: LL, keys, data })];
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];
export function buildTx(wallet, ixs, blockhash, cuLimit = S.cuLimit, cuPrice = S.cuPrice, tipSol = S.tipSol, jitoTipSol = S.jitoTipSol) {
  const all = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
    ...ixs,
    ...(jitoTipSol > 0 ? [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: pick(JITO_TIP_ACCOUNTS), lamports: Math.round(jitoTipSol * 1e9) })] : []),
    ...(tipSol > 0 ? [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: pick(TIP_ACCOUNTS), lamports: Math.round(tipSol * 1e9) })] : []),
    ...(S.nozomiKey && S.nozomiTipSol > 0 ? [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: pick(NOZOMI_TIP_ACCOUNTS), lamports: Math.round(S.nozomiTipSol * 1e9) })] : []),
    ...(S.astraKey && S.astraTipSol > 0 ? [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: pick(ASTRA_TIP_ACCOUNTS), lamports: Math.round(S.astraTipSol * 1e9) })] : []),
  ];
  const msg = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash, instructions: all }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([wallet]);
  return tx;
}

// ---------- runtime ----------
async function main() {
  const targets = (S.targetsRaw ? S.targetsRaw.split(',') : [`${S.ticker}:${S.amount}`]).map((x) => x.trim()).filter(Boolean).map((x) => {
    const [t, a] = x.split(':'); return { ticker: (t || '').replace(/^\$/, '').toUpperCase(), amount: Number(a) };
  });
  const missing = ['heliusKey', 'privateKey', 'quoteMint'].filter((k) => !S[k]);
  if (missing.length || !targets.length || targets.some((t) => !t.ticker || !(t.amount > 0))) { console.error(`sniper not configured: ${missing.join(', ')} targets=${JSON.stringify(targets)}`); process.exit(1); }
  const conn = new Connection(RPC, { commitment: 'confirmed' });
  const wallet = Keypair.fromSecretKey(bs58.decode(S.privateKey));
  const quotePk = new PublicKey(S.quoteMint);
  const quoteInfo = await conn.getParsedAccountInfo(quotePk);
  const quoteProg = new PublicKey(quoteInfo.value.owner);
  const decimals = quoteInfo.value.data.parsed.info.decimals;
  for (const t of targets) t.amountRaw = BigInt(Math.floor(t.amount * 10 ** decimals));
  const amountRaw = targets[0].amountRaw;
  const totalAmount = targets.reduce((a, t) => a + t.amount, 0);
  const myQuote = ata(wallet.publicKey, quotePk, quoteProg);
  const bal = await conn.getTokenAccountBalance(myQuote).catch(() => null);
  const have = bal ? Number(bal.value.uiAmount) : 0;

  let state = {}; try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
  for (const t of targets) t.key = `${S.quoteMint}:${t.ticker}`;
  log('=== sniper starting ===');
  log(`mode: ${S.dryRun ? 'DRY RUN (builds + simulates, never sends)' : 'LIVE'}`);
  log(`pool ${S.quoteMint} on platform ${S.platform.slice(0, 6)}`);
  for (const t of targets) log(`target: first ${t.ticker === '*' ? 'launch (ANY ticker)' : '$' + t.ticker} -> buy ${t.amount}${state[t.key] ? ' [ALREADY DONE]' : ''}`);
  log(`wallet ${wallet.publicKey.toBase58()} | holds ${have} of pool token, targets need up to ${totalAmount}`);
  const solBal = (await conn.getBalance(wallet.publicKey)) / 1e9;
  if (solBal < targets.length * (S.jitoTipSol + 0.01) + 0.02) warn(`wallet has ${solBal.toFixed(3)} SOL, needs ~${(targets.length * (S.jitoTipSol + 0.01) + 0.02).toFixed(3)} for ${targets.length} snipes' tips/fees/rent`);
  if (have < totalAmount) warn(`wallet holds ${have} of the pool token, needs ${totalAmount} for all targets. Buys will fail until funded.`);
  if (targets.every((t) => state[t.key])) log('all targets already done for this pool. Clear with snipe-reset.');

  // keep a fresh blockhash + warm connections so the hot path never waits
  let bh = await conn.getLatestBlockhash('confirmed');
  setInterval(async () => { try { bh = await conn.getLatestBlockhash('confirmed'); } catch {} }, 1000);
  setInterval(() => fetch(`${S.senderUrl}/ping`).catch(() => {}), 4000);
  if (S.nozomiKey) setInterval(() => fetch(`${S.nozomiUrl}/ping`).catch(() => {}), 30000);
  if (S.astraKey) setInterval(() => fetch(`${S.astraUrl}/gethealth`).catch(() => {}), 30000);
  // precompute everything that doesn't depend on the new coin
  const senderSend = `${S.senderUrl}/fast?api-key=${S.heliusKey}`;
  const post = (b64) => fetch(senderSend, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] }) }).then((r) => r.json());
  const jitoOne = (url, b64) => fetch(`${url}/api/v1/transactions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [b64, { encoding: 'base64' }] }) }).then((r) => r.json());
  const jitoSend = (b64) => Promise.allSettled(S.jitoUrls.map((u) => jitoOne(u, b64)));
  setInterval(() => S.jitoUrls.forEach((u) => fetch(`${u}/api/v1/getTipAccounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"getTipAccounts","params":[]}' }).catch(() => {})), 20000);
  // warm up: build + sign a throwaway tx so the first real build isn't cold (JIT, PDA math, signing)
  for (let i = 0; i < 25; i++) {
    const fake = { base: Keypair.generate().publicKey.toBase58(), quote: S.quoteMint, creator: Keypair.generate().publicKey.toBase58(), platform: S.platform, baseProg: TOKEN22.toBase58(), quoteProg: quoteProg.toBase58() };
    Buffer.from(buildTx(wallet, buildBuyIxs(fake, wallet, amountRaw, S.minOutRaw), bh.blockhash).serialize()).toString('base64');
  }
  { const times = [];
    for (let i = 0; i < 10; i++) {
      const fake = { base: Keypair.generate().publicKey.toBase58(), quote: S.quoteMint, creator: Keypair.generate().publicKey.toBase58(), platform: S.platform, baseProg: TOKEN22.toBase58(), quoteProg: quoteProg.toBase58(), pool: Keypair.generate().publicKey.toBase58(), baseVault: Keypair.generate().publicKey.toBase58(), quoteVault: Keypair.generate().publicKey.toBase58() };
      const a = performance.now(); const ixs = buildBuyIxs(fake, wallet, amountRaw, S.minOutRaw); const b = performance.now(); const tx = buildTx(wallet, ixs, bh.blockhash); const c = performance.now(); Buffer.from(tx.serialize()).toString('base64'); const d = performance.now();
      times.push([b - a, c - b, d - c, d - a]);
    }
    const med = (k) => times.map((x) => x[k]).sort((x, y) => x - y)[5].toFixed(2);
    log(`warm build time (median of 10): total ${med(3)}ms = accounts ${med(0)} + compile/sign ${med(1)} + serialize ${med(2)}`); }
  log(`send paths: Helius Sender x2 + Helius RPC${S.nozomiKey ? ' + Nozomi' : ''}${S.astraKey ? ' + Astralane' : ''} + Jito ${S.jitoUrls.map((u) => u.split('//')[1].split('.')[0]).join(',')}`);
  const extra = (S.nozomiKey ? S.nozomiTipSol : 0) + (S.astraKey ? S.astraTipSol : 0);
  log(`fees: priority ${(S.cuLimit * S.cuPrice / 1e15).toFixed(4)} SOL + Jito tip ${S.jitoTipSol} + Sender ${S.tipSol} + Nozomi/Astralane ${extra} = ${(S.cuLimit * S.cuPrice / 1e15 + S.jitoTipSol + S.tipSol + extra).toFixed(4)} SOL per snipe (tips only paid if it lands)`);
  const seenMints = new Set();

  // ---------------- launch handling ----------------
  // Two feeds:
  //  'pre'  = Helius preprocessedSubscribe: txs decoded from shreds BEFORE execution (fastest; may later fail)
  //  'conf' = transactionSubscribe at processed: only txs that actually executed successfully (the truth)
  // We fire on the first matching launch from 'pre'. When 'conf' shows the first launch that really
  // succeeded, we check it is the coin we fired on; if the early one failed, we fire on the real one.
  for (const t of targets) { const st = state[t.key]; if (st) { t.firedMint = st.mint; t.confirmedMint = st.mint; t.buyState = st.err ? 'failed' : 'done'; } }
  const isDone = (t) => !!t.confirmedMint;
  const seen = new Set();

  async function fire(L, hits, createSig, slot, src, seenAt, why) {
    for (const t of hits) { t.firedMint = L.base; t.buyState = 'pending'; }
    const buyRaw = hits[0].amountRaw;
    const label = hits.map((t) => (t.ticker === '*' ? 'FIRST LAUNCH' : '$' + t.ticker)).join(' + ');
    const t0 = performance.now();
    const ours = buildTx(wallet, buildBuyIxs(L, wallet, buyRaw, S.minOutRaw), bh.blockhash);
    const raw = Buffer.from(ours.serialize());
    const b64 = raw.toString('base64');
    const buildMs = (performance.now() - t0).toFixed(2);
    const ourSig = bs58.encode(ours.signatures[0]);
    if (!S.dryRun) {
      // send first, log after: every ms counts
      const sendT = Date.now();
      const sends = Promise.allSettled([post(b64), jitoSend(b64), ...(S.nozomiKey ? [nozomiSend(b64)] : []), ...(S.astraKey ? [astraSend(b64)] : []), post(b64), conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })]);
      log(`  >>> FIRE ${label} on $${L.symbol} ${L.base} [${src}${why ? ', ' + why : ''}] | build ${buildMs}ms | ${sendT - seenAt}ms after seeing launch | ${ourSig}`);
      sends.then((r) => r.filter((x) => x.status === 'rejected' || x.value?.error).forEach((x) => warn(`  send path error: ${JSON.stringify(x.reason?.message || x.value?.error).slice(0, 150)}`)));
    } else {
      log(`  >>> DRY RUN would fire ${label} on $${L.symbol} ${L.base} [${src}${why ? ', ' + why : ''}] | build ${buildMs}ms | ${Date.now() - seenAt}ms after seeing launch`);
    }
    for (const t of hits) state[t.key] = { mint: L.base, symbol: L.symbol, createSig, slot, src, at: new Date().toISOString(), coveredBy: label, ourSig: S.dryRun ? null : ourSig };
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
    if (S.dryRun) {
      const sim = await conn.simulateTransaction(ours, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }).catch((e) => ({ value: { err: e.message, logs: [] } }));
      log(`  DRY RUN sim: ${sim.value.err ? 'ERR ' + JSON.stringify(sim.value.err) : 'OK'} ${(sim.value.logs || []).find((l) => /AnchorError/.test(l))?.slice(0, 150) || ''}`);
      for (const t of hits) t.buyState = 'done';
      return;
    }
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 250));
      const st = (await conn.getSignatureStatuses([ourSig]).catch(() => ({ value: [null] }))).value[0];
      if (st) {
        const behind = st.slot - slot;
        if (st.err) { warn(`  BUY FAILED on $${L.symbol} (landed +${behind} slots): ${JSON.stringify(st.err)}`); for (const t of hits) if (t.firedMint === L.base) t.buyState = 'failed'; }
        else {
          log(`  BUY LANDED on $${L.symbol} +${behind} slots after launch (slot ${st.slot})`);
          for (const t of hits) if (t.firedMint === L.base) t.buyState = 'done';
          setTimeout(async () => {
            try {
              const bal = await conn.getTokenAccountBalance(ata(wallet.publicKey, new PublicKey(L.base), new PublicKey(L.baseProg)), 'confirmed');
              for (const t of hits) if (state[t.key]?.mint === L.base) { Object.assign(state[t.key], { tokensRaw: bal.value.amount, decimals: bal.value.decimals, costRaw: buyRaw.toString(), costDecimals: decimals, baseProg: L.baseProg }); }
              fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
              log(`  position recorded: ${bal.value.uiAmountString} $${L.symbol} for ${Number(buyRaw) / 10 ** decimals} pool tokens`);
            } catch (e) { warn(`  could not record position: ${e.message}`); }
          }, 1500);
        }
        for (const t of hits) if (state[t.key]?.mint === L.base) { state[t.key].landedSlot = st.slot; state[t.key].err = st.err || null; }
        fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
        return;
      }
      if (i % 2 === 1 && i < 12) { post(b64).catch(() => {}); jitoSend(b64).catch(() => {}); if (S.nozomiKey) nozomiSend(b64).catch(() => {}); if (S.astraKey) astraSend(b64).catch(() => {}); }
    }
    warn(`  buy on $${L.symbol} never landed`);
    for (const t of hits) if (t.firedMint === L.base) t.buyState = 'failed';
  }

  async function onLaunch(L, createSig, slot, src, seenAt, confirmed) {
    const k = `${confirmed ? 'c' : 'p'}${L.base}`;
    if (seen.has(k)) return; seen.add(k);
    log(`launch [${src}] $${L.symbol} (${L.name}) ${L.base} quote ${L.quote.slice(0, 6)} platform ${L.platform.slice(0, 6)} ${L.variant} slot ${slot}`);
    if (L.quote !== S.quoteMint) return;
    if (L.platform !== S.platform) return log(`  our pool but other platform (${L.platform.slice(0, 6)}), ignoring`);
    const sym = L.symbol.replace(/^\$/, '').toUpperCase();
    const matching = targets.filter((t) => t.ticker === '*' || t.ticker === sym);
    if (!confirmed) {
      // early signal: fire on the first match we see, unless the target is already settled
      const hits = matching.filter((t) => !t.firedMint && !isDone(t));
      if (!hits.length) return log(matching.length ? '  already fired/settled for this target, ignoring' : '  not a target, ignoring');
      return fire(L, hits, createSig, slot, src, seenAt, 'early');
    }
    // confirmed: the first SUCCESSFUL match is the real "first" for each target
    const toFire = [];
    for (const t of matching) {
      if (isDone(t)) continue;                       // a later copy
      t.confirmedMint = L.base;
      if (t.firedMint === L.base) { log(`  confirmed: $${L.symbol} is the real first for ${t.ticker === '*' ? 'FIRST LAUNCH' : '$' + t.ticker}, we already fired on it`); continue; }
      if (t.firedMint && t.buyState !== 'failed') {
        // we fired early on a different coin; only re-fire if that early launch did not actually succeed
        const createSt = (await conn.getSignatureStatuses([state[t.key]?.createSig].filter(Boolean)).catch(() => ({ value: [null] }))).value[0];
        if (createSt && !createSt.err) { warn(`  early-fired coin ${t.firedMint} also launched OK; not double-buying. Real first was $${L.symbol} ${L.base}`); continue; }
        log(`  early-fired launch ${t.firedMint.slice(0, 6)} did not succeed -> firing on the real first $${L.symbol}`);
      }
      toFire.push(t);
    }
    if (toFire.length) await fire(L, toFire, createSig, slot, src, seenAt, toFire.some((t) => t.firedMint) ? 'correction' : 'confirmed feed');
    else if (!matching.length) log('  not a target, ignoring');
  }

  // confirmed feeds (two endpoints, whichever is first)
  for (const [i, url] of WSS.entries()) {
    const src = i === 0 ? 'mainnet' : 'beta';
    const connect = () => {
      const ws = new WebSocket(url, { perMessageDeflate: false });
      let ping;
      ws.on('open', () => {
        log(`feed ${src} connected`);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'transactionSubscribe', params: [
          { accountRequired: [LL.toBase58(), S.quoteMint], failed: false, vote: false },
          { commitment: 'processed', encoding: 'jsonParsed', transactionDetails: 'full', showRewards: false, maxSupportedTransactionVersion: 1 },
        ] }));
        ping = setInterval(() => ws.readyState === 1 && ws.ping(), 15000);
      });
      ws.on('message', (data) => {
        const seenAt = Date.now();
        let m; try { m = JSON.parse(data); } catch { return; }
        if (m.error) return warn(`feed ${src}: ${JSON.stringify(m.error).slice(0, 150)}`);
        const r = m.params?.result;
        if (!r?.transaction) return;
        const L = parseLaunch(r.transaction);
        if (L) onLaunch(L, r.signature, r.slot, src, seenAt, true).catch((e) => warn(`onLaunch: ${e.message}`));
      });
      ws.on('close', () => { clearInterval(ping); warn(`feed ${src} closed, reconnecting`); setTimeout(connect, 300); });
      ws.on('error', (e) => warn(`feed ${src} error: ${e.message}`));
    };
    connect();
  }

  // early feed: Helius preprocessed transactions (decoded from shreds, before execution). Binary frames:
  // [0] version u8 | [1..9) slot u64 LE | [9..73) signature | [73..] transaction wire bytes
  if (S.preprocessed) {
    const altCache = new Map();
    const connectPre = () => {
      const ws = new WebSocket(`wss://beta.helius-rpc.com/?api-key=${S.heliusKey}`, { perMessageDeflate: false });
      let ping;
      ws.on('open', () => {
        log('feed pre (preprocessed/shreds) connected');
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'preprocessedSubscribe', params: { accountInclude: [], accountExclude: [], accountRequired: [LL.toBase58(), S.quoteMint] } }));
        ping = setInterval(() => ws.readyState === 1 && ws.ping(), 15000);
      });
      ws.on('message', (data, isBinary) => {
        const seenAt = Date.now();
        if (!isBinary) { try { const m = JSON.parse(data); if (m.error) warn(`feed pre: ${JSON.stringify(m.error).slice(0, 200)}`); else if (m.id === 7) log(`feed pre subscribed (${m.result})`); } catch {} return; }
        try {
          const buf = Buffer.from(data);
          if (buf[0] !== 1) return;
          const slot = Number(buf.readBigUInt64LE(1));
          const sig = bs58.encode(buf.subarray(9, 73));
          const vtx = VersionedTransaction.deserialize(buf.subarray(73));
          const msg = vtx.message;
          let keys = msg.staticAccountKeys.map((k) => k.toBase58());
          for (const l of msg.addressTableLookups || []) {
            const alt = altCache.get(l.accountKey.toBase58());
            if (!alt) { conn.getAddressLookupTable(l.accountKey).then((r) => r.value && altCache.set(l.accountKey.toBase58(), r.value.state.addresses.map((a) => a.toBase58()))).catch(() => {}); keys = null; break; }
            keys.push(...l.writableIndexes.map((i) => alt[i]));
          }
          if (keys) for (const l of msg.addressTableLookups || []) { const alt = altCache.get(l.accountKey.toBase58()); keys.push(...l.readonlyIndexes.map((i) => alt[i])); }
          if (!keys) return; // needs a lookup table we haven't cached yet; confirmed feed will catch it
          const tx = { transaction: { message: { instructions: msg.compiledInstructions.map((ix) => ({ programId: keys[ix.programIdIndex], accounts: ix.accountKeyIndexes.map((i) => keys[i]), data: bs58.encode(ix.data) })) } }, meta: null };
          const L = parseLaunch(tx);
          if (L) onLaunch(L, sig, slot, 'pre', seenAt, false).catch((e) => warn(`onLaunch(pre): ${e.message}`));
        } catch { /* v1 or unparseable tx: confirmed feed covers it */ }
      });
      ws.on('close', () => { clearInterval(ping); warn('feed pre closed, reconnecting'); setTimeout(connectPre, 300); });
      ws.on('error', (e) => warn(`feed pre error: ${e.message}`));
    };
    connectPre();
  }
  setInterval(() => log(`alive | pool ${S.quoteMint.slice(0, 6)} | ${targets.map((t) => (t.ticker === '*' ? 'FIRST' : '$' + t.ticker) + (t.confirmedMint ? ' done' : t.firedMint ? ' fired' : ' armed')).join(', ')}`), 300000).unref();
}

// run when launched directly or by pm2 (pm2 puts the real script path in pm_exec_path), not when imported
const entry = process.env.pm_exec_path || process.argv[1] || '';
if (entry.endsWith('sniper.js')) main().catch((e) => { console.error(e); process.exit(1); });
