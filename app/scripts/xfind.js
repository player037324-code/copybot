// Finds pump.fun profiles linked to an X handle (or with the name in their username).
// 1) looks for a user-search endpoint in pump.fun's site code and tries it  2) pages the top-followers list
const handle = (process.argv[2] || '').toLowerCase(); const pages = Number(process.argv[3] || 60);
const H = { origin: 'https://pump.fun', referer: 'https://pump.fun/', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36', accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const name = handle.replace(/^muststop/, ''); // e.g. murad
const hit = (u) => (u.x_username || '').toLowerCase() === handle || (u.username || '').toLowerCase().includes(name);
const show = (u) => `${u.username} x=@${u.x_username || '-'} pumpFollowers=${u.followers} setAt=${u.last_username_update_timestamp ? new Date(Number(u.last_username_update_timestamp)).toISOString() : '-'} wallet=${u.address}`;
// site code: search endpoints
const html = await (await fetch('https://pump.fun/', { headers: H })).text();
const js = [...html.matchAll(/"(\/_next\/static\/chunks\/[^"]+\.js)"/g)].map((m) => 'https://pump.fun' + m[1]);
const code = (await Promise.all(js.map((u) => fetch(u, { headers: H }).then((r) => r.text()).catch(() => '')))).join('\n');
const paths = new Set([...code.matchAll(/["'`](\/?(?:users?|search|profiles?)[A-Za-z0-9\/_-]*search[A-Za-z0-9\/_?=&-]*|\/?search\/[A-Za-z0-9\/_-]+|\/?(?:users?|profiles?)\/[A-Za-z0-9_-]*(?:x|twitter|social|by)[A-Za-z0-9\/_-]*)["'`]/gi)].map((m) => m[1]));
console.log('search-ish paths in site code:', [...paths].slice(0, 30).join('  '));
const tries = [...[...paths].slice(0, 6).map((p) => `https://frontend-api-v3.pump.fun/${p.replace(/^\//, '')}${p.includes('?') ? '&' : '?'}query=${name}&searchTerm=${name}&q=${name}`)];
for (const u of tries) {
  await sleep(2500);
  const r = await fetch(u, { headers: H }).catch(() => null); if (!r) continue;
  const t = await r.text(); let arr = []; try { const j = JSON.parse(t); arr = Array.isArray(j) ? j : j.users || j.data || j.results || []; } catch {}
  console.log(`${u} -> ${r.status} items=${arr.length} ${arr.filter((x) => x && x.username).filter(hit).map(show).join(' | ') || t.slice(0, 120)}`);
}
// top list
let found = 0;
for (let off = 0; off < pages * 50; off += 50) {
  await sleep(1500);
  const r = await fetch(`https://frontend-api-v3.pump.fun/users?offset=${off}&limit=50`, { headers: H });
  if (r.status === 429) { const ra = Number(r.headers.get('retry-after')) || 20; console.log(`429 at ${off}, waiting ${ra}s`); await sleep(ra * 1000); off -= 50; continue; }
  const arr = await r.json().catch(() => []); if (!Array.isArray(arr) || !arr.length) { console.log(`list ended at ${off}`); break; }
  for (const u of arr) if (hit(u)) { found++; console.log('FOUND ' + show(u)); }
  if (off % 1000 === 0) console.log(`scanned ${off + 50}, smallest so far ${arr[arr.length - 1].followers} pump followers`);
}
console.log(`done, ${found} match(es)`);
