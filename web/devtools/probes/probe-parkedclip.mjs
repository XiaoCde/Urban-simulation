/** 探测：马克车轨迹是否穿过静态停放车 / 街具（非 traffic 动态车）。 */
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
  const C = window.__collide, D = window.__dayMotion;
  const byTag = C.stats().byTag;
  const cars = C.items.filter((it) => it.tag === 'car' && !it.dead);
  const out = { byTag, parked: cars.length, hits: [], sampleCars: cars.slice(0, 5)
    .map((c) => [(c.minx + c.maxx) / 2, (c.minz + c.maxz) / 2].map((v) => +v.toFixed(1))) };
  for (let m = 448; m <= 482; m++) {
    const q = D.carAt(m);
    if (!q) continue;
    let best = null;
    for (const c of cars) {
      const cx = Math.max(c.minx, Math.min(q.x, c.maxx));
      const cz = Math.max(c.minz, Math.min(q.z, c.maxz));
      const d = Math.hypot(q.x - cx, q.z - cz);
      if (!best || d < best.d) best = { d, x: +(c.minx + c.maxx) / 2, z: +(c.minz + c.maxz) / 2 };
    }
    if (best && best.d < 2.2) out.hits.push({ m, d: +best.d.toFixed(2), car: [best.x.toFixed(1), best.z.toFixed(1)] });
  }
  // 其它 tag 的近距命中（街具/树/家具）
  const near = [];
  for (let m = 448; m <= 482; m += 2) {
    const q = D.carAt(m);
    if (!q) continue;
    const h = C.blockedCircle(q.x, q.z, 1.3, q.y, q.y + 1.6,
      { ignoreTags: new Set(['building', 'tree']) });
    if (h) near.push({ m, tag: h.tag, box: [h.minx, h.maxx, h.minz, h.maxz].map((v) => +v.toFixed(1)) });
  }
  out.near = near.slice(0, 20);
  return out;
});
console.log('碰撞层分布:', JSON.stringify(R.byTag), ' 停放车:', R.parked,
  ' 样例:', JSON.stringify(R.sampleCars));
console.log('马克车贴到停放车(<2.2m):', R.hits.length, JSON.stringify(R.hits.slice(0, 12)));
console.log('其它实体近距命中:', R.near.length, JSON.stringify(R.near.slice(0, 10)));
await b.close();
