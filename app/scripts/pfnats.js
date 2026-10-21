// 1) pulls pump.fun's realtime (NATS) connection config out of its site bundles
// 2) connects to the Unified instance and listens to unifiedTradeEvent.processed for 30s: rate, bytes, sample
import WebSocket from 'ws';
const H = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36', accept: '*/*' };
const html = await (await fetch('https://pump.fun/', { headers: H })).text();
const scripts = new Set();
for (const m of html.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)) scripts.add(new URL(m[1], 'https://pump.fun').href);
for (const m of html.matchAll(/"(\/_next\/static\/chunks\/[^"]+\.js)"/g)) scripts.add('https://pump.fun' + m[1]);
const bodies = [html, ...(await Promise.all([...scripts].map((s) => fetch(s, { headers: H }).then((r) => r.text()).catch(() => ''))))];
const seen = new Set();
const show = (label, re, w = 260) => {
  for (const t of bodies) for (const m of t.matchAll(re)) {
    const ctx = t.slice(Math.max(0, m.index - w), m.index + w).replace(/\s+/g, ' ');
    const k = ctx.slice(w - 40, w + 60); if (seen.has(k)) continue; seen.add(k);
    console.log(`--- ${label}: ${ctx}`);
  }
};
show('realtime host', /[a-z0-9-]+\.nats\.realtime\.pump\.fun|realtime\.pump\.fun/g, 200);
show('nats config', /setNatsConfigs|NatsInstance\.Unified\]\s*:\s*\{|servers\s*:/g, 300);
show('creds', /\b(?:user|username)\s*:\s*["'`][A-Za-z0-9_-]{3,40}["'`]\s*,\s*(?:pass|password)\s*:/g, 200);

// collect candidates (config is embedded as escaped JSON in the page)
const all = bodies.join('\n').replace(/\\"/g, '"');
const cfg = {};
for (const m of all.matchAll(/"(ADVANCED|CORE|UNIFIED|MULTICHAIN)":\{[^}]*?"servers":"([^"]+)","user":"([^"]+)","pass":"([^"]+)"/g)) cfg[m[1]] = { url: m[2], user: m[3], pass: m[4] };
console.log('\nconfigs: ' + JSON.stringify(Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, v.url]))));
const tries = [];
if (cfg.UNIFIED) tries.push([cfg.UNIFIED.url, cfg.UNIFIED.user, cfg.UNIFIED.pass]);
function tryNats(url, user, pass, subject, secs = 30) {
  return new Promise((res) => {
    const st = { url, user, subject, bytes: 0, msgs: 0, err: null, info: null, samples: [] };
    const ws = new WebSocket(url, { headers: { origin: 'https://pump.fun', 'user-agent': H['user-agent'] } });
    let buf = '';
    ws.on('message', (d) => {
      st.bytes += d.length; buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        if (line.startsWith('INFO ')) {
          st.info = line.slice(5, 300); buf = buf.slice(i + 2);
          const c = { verbose: false, pedantic: false, lang: 'js', version: '2.0', protocol: 1, headers: true, no_responders: true };
          if (user) { c.user = user; c.pass = pass; }
          ws.send(`CONNECT ${JSON.stringify(c)}\r\nSUB ${subject} 1\r\nPING\r\n`);
        } else if (line.startsWith('MSG ') || line.startsWith('HMSG ')) {
          const p = line.split(' '); const n = Number(p[p.length - 1]);
          if (buf.length < i + 2 + n + 2) break;
          const payload = buf.slice(i + 2, i + 2 + n); buf = buf.slice(i + 2 + n + 2);
          st.msgs++; st.subj = st.subj || {}; const sj = p[1].split('.').slice(0, 2).join('.'); st.subj[sj] = (st.subj[sj] || 0) + 1; if (st.samples.length < 1) st.samples.push(payload.slice(0, 300));
        } else { if (line.startsWith('PING')) ws.send('PONG\r\n'); if (line.startsWith('-ERR')) st.err = line; buf = buf.slice(i + 2); }
      }
    });
    ws.on('error', (e) => (st.err = e.message));
    ws.on('unexpected-response', (q, r) => (st.err = `HTTP ${r.statusCode}`));
    setTimeout(() => { try { ws.close(); } catch {} res(st); }, secs * 1000);
  });
}
const SUBS = [['UNIFIED', '>'], ['UNIFIED', 'unifiedTradeEvent.>'], ['CORE', '>'], ['ADVANCED', '>']];
await Promise.all(SUBS.map(async ([inst, subj]) => {
  const c = cfg[inst]; if (!c) return;
  const s = await tryNats(c.url, c.user, c.pass, subj, 25);
  const top = Object.entries(s.subj || {}).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`\n== ${inst} "${subj}": ${s.msgs} msgs ${(s.bytes / 1e6).toFixed(2)} MB/25s ${s.err || ''}\n   subjects: ${top}\n   sample: ${s.samples[0] || ''}`);
}));
process.exit(0);
