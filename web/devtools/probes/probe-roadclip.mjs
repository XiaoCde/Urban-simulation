/** 核对：96 辆社会车辆是否穿楼；以及仍压在路面上的可见楼到底是哪几栋。 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await b.newPage();
await p.setViewport({ width: 900, height: 560 });
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
const R = await p.evaluate(() => {
  const S = window.__solids, net = window.__roadnet(), T = window.__traffic();
  const THREE = window.__THREE;
  const P = new THREE.Vector3();
  const hits = [];
  let n = 0;
  if (T && T.cars) {
    for (const c of T.cars) {
      const t = Math.min(1, Math.max(0, c.t));
      net.lanePoint(c.e, t, c.dir, 0, P);
      n++;
      const h = S.hit(P.x, P.z, 1.6);
      if (h) hits.push({ kind: c.kind, x: +P.x.toFixed(1), z: +P.z.toFixed(1), id: h.id,
        edge: [+c.e.a.x.toFixed(0), +c.e.a.z.toFixed(0), +c.e.b.x.toFixed(0), +c.e.b.z.toFixed(0)] });
    }
  }
  // 仍压在路中线上的可见实体，按 id 统计
  const ids = {};
  for (const e of net.edges) {
    const L = Math.hypot(e.b.x - e.a.x, e.b.z - e.a.z);
    const k = Math.max(2, Math.ceil(L / 5));
    for (let i = 0; i <= k; i++) {
      const x = e.a.x + (e.b.x - e.a.x) * i / k, z = e.a.z + (e.b.z - e.a.z) * i / k;
      const h = S.hit(x, z, 0.8);
      if (h) { (ids[h.id] ||= { n: 0, box: null }).n++;
        if (!ids[h.id].box) { const r = S.rects.find((q) => q.id === h.id);
          ids[h.id].box = r ? [r.minx, r.maxx, r.minz, r.maxz].map((v) => +v.toFixed(0)) : null; }
      }
    }
  }
  return { traffic: { n, hits: hits.slice(0, 20), total: hits.length },
    roadIds: Object.entries(ids).sort((a, b) => b[1].n - a[1].n).slice(0, 10),
    roadKill: window.__roadKill };
});
console.log('社会车辆:', R.traffic.n, ' 穿楼:', R.traffic.total);
console.log(JSON.stringify(R.traffic.hits.slice(0, 10), null, 1));
console.log('\n仍压路的可见楼:');
for (const [id, v] of R.roadIds) console.log(' ', id, v.n, '点', JSON.stringify(v.box));
console.log('\nroadKill:', JSON.stringify(R.roadKill));
await b.close();
