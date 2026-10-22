// Finds pump.fun's callout API + any realtime subject for callouts by scanning site code, then tries endpoints for a wallet.
const W = process.argv[2] || 'Gs5FHwYLrDBmCmiv5VhBLCvyiBmBYfcPedZDqR88GYeX';
const H = { origin: 'https://pump.fun', referer: 'https://pump.fun/', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36', accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scripts = new Set(); const bodies = [];
for (const p of ['https://pump.fun/', `https://pump.fun/profile/${W}`]) {
  const t = await (await fetch(p, { headers: H })).text(); bodies.push(t);
  for (const m of t.matchAll(/"(\/_next\/static\/chunks\/[^"]+\.js)"/g)) scripts.add('https://pump.fun' + m[1]);
  for (const m of t.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)) scripts.add(new URL(m[1], 'https://pump.fun').href);
}
bodies.push(...(await Promise.all([...scripts].map((s) => fetch(s, { headers: H }).then((r) => r.text()).catch(() => '')))));
const all = bodies.join('\n');
const seen = new Set(); let n = 0;
for (const m of all.matchAll(/callout/gi)) {
  const ctx = all.slice(Math.max(0, m.index - 140), m.index + 160).replace(/\s+/g, ' ');
  const k = ctx.slice(120, 200); if (seen.has(k)) continue; seen.add(k);
  if (/["'`][^"'`]*callout[^"'`]*["'`]/i.test(ctx) && (/\/|subject|Subject|api|fetch|get\(|post\(|nats|feed/i.test(ctx))) { console.log('* ' + ctx); if (++n > 45) break; }
}
const paths = [...new Set([...all.matchAll(/["'`]([A-Za-z0-9\/_${}.-]*callout[A-Za-z0-9\/_${}?=&.-]*)["'`]/gi)].map((m) => m[1]))];
console.log('\ncallout strings:', paths.slice(0, 60).join('  '));
const cands = [`callouts/user/${W}`, `callouts/${W}`, `users/${W}/callouts`, `callouts?address=${W}`, `callouts?user=${W}`, `v1/callouts/user/${W}`];
for (const c of cands) for (const host of ['https://frontend-api-v3.pump.fun/', 'https://profile-api.pump.fun/']) {
  await sleep(2000);
  const r = await fetch(host + c, { headers: H }).catch((e) => ({ status: e.message, text: async () => '' }));
  console.log(`${host}${c} -> ${r.status} ${(await r.text()).slice(0, 300)}`);
}
