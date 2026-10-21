// Finds the realtime feed pump.fun's own website uses (wss URLs, NATS creds, subjects) by scanning its JS bundles.
const H = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36', accept: '*/*' };
const pages = ['https://pump.fun/', 'https://pump.fun/board', 'https://pump.fun/profile/Gs5FHwYLrDBmCmiv5VhBLCvyiBmBYfcPedZDqR88GYeX'];
const scripts = new Set();
for (const p of pages) {
  try {
    const r = await fetch(p, { headers: H }); const t = await r.text();
    console.log(`${p} HTTP ${r.status} ${t.length}b`);
    for (const m of t.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)) scripts.add(new URL(m[1], 'https://pump.fun').href);
    for (const m of t.matchAll(/"(\/_next\/static\/chunks\/[^"]+\.js)"/g)) scripts.add('https://pump.fun' + m[1]);
  } catch (e) { console.log(p, e.message); }
}
console.log(`scripts: ${scripts.size}`);
const hits = new Map();
const pats = [/wss:\/\/[A-Za-z0-9.\-\/_:]+/g, /nats[A-Za-z0-9.\-_:\/]*/gi, /["'`]([A-Za-z]*(?:Trade|trade)[A-Za-z]*Event[A-Za-z.>*]*)["'`]/g, /user:\s*["'`][^"'`]{2,40}["'`]\s*,\s*pass(?:word)?:\s*["'`][^"'`]{2,60}["'`]/g, /["'`](?:unified|advanced)[A-Za-z.>*]{3,40}["'`]/g];
let n = 0;
await Promise.all([...scripts].map(async (s) => {
  try {
    const t = await (await fetch(s, { headers: H })).text(); n++;
    for (const re of pats) for (const m of t.matchAll(re)) {
      const k = m[0].slice(0, 140);
      if (!hits.has(k)) { const i = m.index; hits.set(k, t.slice(Math.max(0, i - 80), i + 160).replace(/\s+/g, ' ')); }
    }
  } catch {}
}));
console.log(`fetched ${n} scripts, ${hits.size} hits`);
for (const [k, ctx] of [...hits].slice(0, 60)) console.log(`* ${k}\n    ${ctx}`);
