// Dumps full coin-creation events from pump.fun's realtime feed to see what's in them (fee recipients, socials, X handles).
import WebSocket from 'ws';
const SECS = Number(process.argv[2] || 40);
const H = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36' };
const html = (await (await fetch('https://pump.fun/', { headers: H })).text()).replace(/\\"/g, '"');
const m = html.match(/"UNIFIED":\{[^}]*?"servers":"([^"]+)","user":"([^"]+)","pass":"([^"]+)"/);
const ws = new WebSocket(m[1], { headers: { origin: 'https://pump.fun', 'user-agent': H['user-agent'] } });
let buf = '', n = 0, subbed = false; const keys = {};
ws.on('message', (d) => {
  buf += d.toString(); let i;
  while ((i = buf.indexOf('\r\n')) >= 0) {
    const line = buf.slice(0, i);
    if (line.startsWith('MSG ') || line.startsWith('HMSG ')) {
      const p = line.split(' '); const len = Number(p[p.length - 1]);
      if (buf.length < i + 2 + len + 2) break;
      let pl = buf.slice(i + 2, i + 2 + len); buf = buf.slice(i + 4 + len);
      try { let j = JSON.parse(pl); if (typeof j === 'string') j = JSON.parse(j); for (const k of Object.keys(j)) keys[k] = (keys[k] || 0) + 1; if (n++ < 3) console.log(`\n${p[1]}:\n${JSON.stringify(j).slice(0, 2500)}`); } catch {}
    } else {
      buf = buf.slice(i + 2);
      if (line.startsWith('INFO ') && !subbed) { subbed = true; ws.send(`CONNECT ${JSON.stringify({ verbose: false, pedantic: false, lang: 'js', version: '2.0', protocol: 1, headers: true, user: m[2], pass: m[3] })}\r\nSUB unifiedCoinCreationEvent.processed 1\r\nPING\r\n`); }
      else if (line.startsWith('PING')) ws.send('PONG\r\n');
    }
  }
});
setTimeout(() => { console.log(`\n${n} coins in ${SECS}s; fields: ${JSON.stringify(keys)}`); process.exit(0); }, SECS * 1000);
