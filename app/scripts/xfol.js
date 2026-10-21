// Tests free X follower-count sources from this server.
const h = process.argv[2] || 'kimchi1x';
const src = [`https://api.fxtwitter.com/${h}`, `https://api.vxtwitter.com/${h}`];
for (const u of src) {
  try {
    const r = await fetch(u, { headers: { 'user-agent': 'pfwatch/1.0' }, signal: AbortSignal.timeout(10000) });
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch {}
    const f = j.user?.followers ?? j.followers_count ?? j.followers;
    console.log(`${u} -> HTTP ${r.status} followers=${f} ${f === undefined ? t.slice(0, 300) : ''}`);
  } catch (e) { console.log(`${u} -> ${e.message}`); }
}
