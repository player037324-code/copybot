// Listens to pump.fun's CORE realtime cluster: counts followingFeed event types, prints samples, flags anything from a target user.
import WebSocket from 'ws';
const SECS = Number(process.argv[2] || 90);
const TARGET_ID = process.argv[3] || 'ea1951bf-9885-4dca-9f28-82830824ce3c';
const TARGET_W = process.argv[4] || 'Gs5FHwYLrDBmCmiv5VhBLCvyiBmBYfcPedZDqR88GYeX';
const C = { url: 'wss://prod-v2.nats.realtime.pump.fun', user: 'subscriber', pass: 'lW5a9y20NceF6AE9' };
const ws = new WebSocket(C.url, { headers: { origin: 'https://pump.fun', 'user-agent': 'Mozilla/5.0' } });
let buf = '', subbed = false; const types = {}, samples = {}, subj = {}; let hits = 0, n = 0;
ws.on('message', (d) => {
  buf += d.toString(); let i;
  while ((i = buf.indexOf('\r\n')) >= 0) {
    const line = buf.slice(0, i);
    if (line.startsWith('MSG ') || line.startsWith('HMSG ')) {
      const p = line.split(' '); const len = Number(p[p.length - 1]);
      if (buf.length < i + 2 + len + 2) break;
      const pl = buf.slice(i + 2, i + 2 + len); buf = buf.slice(i + 4 + len); n++;
      const s = p[1].split('.')[0]; subj[s] = (subj[s] || 0) + 1;
      let j; try { j = JSON.parse(pl); if (typeof j === 'string') j = JSON.parse(j); } catch { continue; }
      const t = (j.type || j.eventType || j.kind || '?') + ''; types[t] = (types[t] || 0) + 1;
      const key = p[1].split('.')[0] + ':' + t; if (!samples[key]) samples[key] = `${p[1]} => ${pl.slice(0, 700)}`;
      if (pl.includes(TARGET_ID) || pl.includes(TARGET_W)) { hits++; if (hits <= 5) console.log(`TARGET HIT ${p[1]} => ${pl.slice(0, 1200)}`); }
    } else {
      buf = buf.slice(i + 2);
      if (line.startsWith('INFO ') && !subbed) { subbed = true; ws.send(`CONNECT ${JSON.stringify({ verbose: false, pedantic: false, lang: 'js', version: '2.0', protocol: 1, headers: true, user: C.user, pass: C.pass })}\r\nSUB > 1\r\nPING\r\n`); }
      else if (line.startsWith('PING')) ws.send('PONG\r\n');
      else if (line.startsWith('-ERR')) console.log(line);
    }
  }
});
ws.on('error', (e) => console.log('ws', e.message));
setTimeout(() => {
  console.log(`\n${n} msgs in ${SECS}s; target hits ${hits}\nsubjects: ${JSON.stringify(subj)}\ntypes: ${JSON.stringify(types)}`);
  for (const [t, s] of Object.entries(samples)) console.log(`\n[${t}] ${s}`);
  process.exit(0);
}, SECS * 1000);
