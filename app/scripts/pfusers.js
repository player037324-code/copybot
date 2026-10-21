// Probes pump.fun's /users list endpoint gently (few requests, spaced) to see if it's a usable new-signups feed.
const H = { origin: 'https://pump.fun', referer: 'https://pump.fun/', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36', accept: 'application/json' };
const B = 'https://frontend-api-v3.pump.fun/users';
const urls = (process.argv[2] ? [process.argv[2]] : [
  B,
  `${B}?limit=50&offset=0`,
  `${B}?sortBy=created_timestamp&sortOrder=DESC&limit=50`,
  `${B}?offset=50&limit=50`,
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const u of urls) {
  const r = await fetch(u, { headers: H });
  const t = await r.text();
  console.log(`\n== ${u} -> HTTP ${r.status} ${r.headers.get('retry-after') ? 'retry-after=' + r.headers.get('retry-after') : ''} ${t.length}b`);
  try {
    const j = JSON.parse(t); const arr = Array.isArray(j) ? j : j.users || j.data || [];
    console.log(`items: ${arr.length}; keys: ${Object.keys(arr[0] || j).join(',')}`);
    for (const x of arr.slice(0, 12)) console.log(`  ${x.username} x=${x.x_username || '-'} f=${x.followers} setAt=${x.last_username_update_timestamp ? new Date(Number(x.last_username_update_timestamp)).toISOString() : '-'} ${x.address}`);
    const withX = arr.filter((x) => x.x_username).length;
    const ts = arr.map((x) => Number(x.last_username_update_timestamp)).filter(Boolean).sort();
    console.log(`with X: ${withX}; setAt range: ${ts.length ? new Date(ts[0]).toISOString() + ' .. ' + new Date(ts[ts.length - 1]).toISOString() : '-'}`);
  } catch { console.log(t.slice(0, 300)); }
  await sleep(4000);
}
