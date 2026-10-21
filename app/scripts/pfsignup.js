// Looks for any pump.fun realtime event that fires when an account/profile is created or X is linked.
// 1) every *_SUBJECT constant in pump.fun's site code  2) every subject seen on all 4 NATS clusters for N seconds
import WebSocket from 'ws';
const SECS = Number(process.argv[2] || 60);
const H = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36', accept: '*/*' };
const pages = ['https://pump.fun/', 'https://pump.fun/profile/Gs5FHwYLrDBmCmiv5VhBLCvyiBmBYfcPedZDqR88GYeX'];
const scripts = new Set(); const bodies = [];
for (const p of pages) {
  const t = await (await fetch(p, { headers: H })).text(); bodies.push(t);
  for (const m of t.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)) scripts.add(new URL(m[1], 'https://pump.fun').href);
  for (const m of t.matchAll(/"(\/_next\/static\/chunks\/[^"]+\.js)"/g)) scripts.add('https://pump.fun' + m[1]);
}
bodies.push(...(await Promise.all([...scripts].map((s) => fetch(s, { headers: H }).then((r) => r.text()).catch(() => '')))));
const all = bodies.join('\n');
const subj = new Set();
for (const m of all.matchAll(/"([A-Z0-9_]*SUBJECT[A-Z0-9_]*)",0,"([^"]{2,80})"/g)) subj.add(`${m[1]} = ${m[2]}`);
console.log(`SUBJECT constants in site code (${subj.size}):`); [...subj].sort().forEach((x) => console.log('  ' + x));
const words = new Set();
for (const m of all.matchAll(/["'`]([a-zA-Z]*(?:[Uu]ser|[Pp]rofile|[Ss]ignup|[Ss]ignUp|[Rr]egister|[Oo]nboard|[Tt]witter|[Xx]Link|[Ll]inked)[a-zA-Z]*(?:Created|Registered|Linked|Event|Updated|Joined)[a-zA-Z.]*)["'`]/g)) words.add(m[1]);
console.log(`\nuser/profile event-ish names (${words.size}): ${[...words].slice(0, 80).join(', ')}`);

const cfg = {};
for (const m of all.replace(/\\"/g, '"').matchAll(/"(ADVANCED|CORE|UNIFIED|MULTICHAIN)":\{[^}]*?"servers":"([^"]+)","user":"([^"]+)","pass":"([^"]+)"/g)) cfg[m[1]] = { url: m[2], user: m[3], pass: m[4] };
const norm = (s) => s.split('.').map((p) => (/^[1-9A-HJ-NP-Za-km-z]{32,44}$|^0x[0-9a-fA-F]{40}$|^[0-9a-f-]{36}$|^\d+$/.test(p) ? '<id>' : p)).join('.');
function listen(name, c) {
  return new Promise((res) => {
    const seen = {}; const sample = {};
    const ws = new WebSocket(c.url, { headers: { origin: 'https://pump.fun', 'user-agent': H['user-agent'] } });
    let buf = ''; let subbed = false;
    ws.on('message', (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        if (line.startsWith('MSG ') || line.startsWith('HMSG ')) {
          const p = line.split(' '); const n = Number(p[p.length - 1]);
          if (buf.length < i + 2 + n + 2) break;
          const pl = buf.slice(i + 2, i + 2 + n); buf = buf.slice(i + 4 + n);
          const k = norm(p[1]); seen[k] = (seen[k] || 0) + 1; if (!sample[k]) sample[k] = pl.slice(0, 350);
        } else {
          buf = buf.slice(i + 2);
          if (line.startsWith('INFO ') && !subbed) { subbed = true; ws.send(`CONNECT ${JSON.stringify({ verbose: false, pedantic: false, lang: 'js', version: '2.0', protocol: 1, headers: true, user: c.user, pass: c.pass })}\r\nSUB > 1\r\nPING\r\n`); }
          else if (line.startsWith('PING')) ws.send('PONG\r\n');
          else if (line.startsWith('-ERR')) console.log(name, line);
        }
      }
    });
    ws.on('error', (e) => console.log(name, e.message));
    setTimeout(() => { try { ws.close(); } catch {} res({ name, seen, sample }); }, SECS * 1000);
  });
}
const res = await Promise.all(Object.entries(cfg).map(([k, c]) => listen(k, c)));
for (const r of res) {
  console.log(`\n== ${r.name}: ${Object.keys(r.seen).length} subject types in ${SECS}s`);
  for (const [k, v] of Object.entries(r.seen).sort((a, b) => b[1] - a[1])) {
    const hot = /user|profile|sign|regist|onboard|twitter|follow|social|account|wallet/i.test(k);
    console.log(`  ${hot ? '*' : ' '} ${k} = ${v}${hot ? '\n      ' + r.sample[k] : ''}`);
  }
}
process.exit(0);
