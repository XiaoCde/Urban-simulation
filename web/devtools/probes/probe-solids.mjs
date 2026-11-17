/** 分清哪些命中楼是「真实可见实体」，哪些是被删掉的幽灵。 */
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
  const B = window.__buildings, BI = window.__bIdx;
  const EX = [...(window.__exclude || [])];
  const exSet = new Set(EX);
  const E = window.__roadnet().edges;
  // 重算「压路被删」的 id 集合（与主模块同一套判定）
  const killed = new Set();
  const KEEP = new Set(['66418809', '48037641', '1207911106', '574897355', '48041424',
    '48041308', '48041293']);
  const hit = (x, z) => {
    const arr = BI.buckets.get(BI.hashAt(x, z)); if (!arr) return;
    for (const r of arr) {
      if (r.h > 250 || KEEP.has(r.id)) continue;
      if (x > r.minx && x < r.maxx && z > r.minz && z < r.maxz) killed.add(r.id);
    }
  };
  for (const e of E) {
    const n = Math.max(2, Math.ceil(Math.hypot(e.b.x - e.a.x, e.b.z - e.a.z) / 6));
    for (let i = 0; i <= n; i++) hit(e.a.x + (e.b.x - e.a.x) * i / n, e.a.z + (e.b.z - e.a.z) * i / n);
  }
  const ids = ['1207911106', '48037641', '1029354', '907961605', '66418944',
    '16159112', '1029353', '380771', '48040421'];
  const detail = ids.map((id) => {
    const r = BI.rects.find((q) => q.id === id);
    return { id, rect: r ? [r.minx, r.maxx, r.minz, r.maxz, r.h].map((v) => +v.toFixed(1)) : null,
      ex: exSet.has(id), killed: killed.has(id), keep: KEEP.has(id) };
  });
  // 路网点落在「可见实体」里的数量（排除 killed 幽灵）
  let visPts = 0, tot = 0;
  const visIds = {};
  for (const e of E) {
    const n = Math.max(2, Math.ceil(Math.hypot(e.b.x - e.a.x, e.b.z - e.a.z) / 5));
    for (let i = 0; i <= n; i++) {
      const x = e.a.x + (e.b.x - e.a.x) * i / n, z = e.a.z + (e.b.z - e.a.z) * i / n;
      tot++;
      const arr = BI.buckets.get(BI.hashAt(x, z)) || [];
      for (const r of arr) {
        if (killed.has(r.id)) continue;
        if (x > r.minx + 0.8 && x < r.maxx - 0.8 && z > r.minz + 0.8 && z < r.maxz - 0.8) {
          visPts++; visIds[r.id] = (visIds[r.id] || 0) + 1; break;
        }
      }
    }
  }
  // office / home 精细楼实际包围盒
  const box = (o) => {
    if (!o) return null;
    const T = window.__THREE;
    const bb = new T.Box3().setFromObject(o.group || o);
    return [bb.min.x, bb.max.x, bb.min.z, bb.max.z].map((v) => +v.toFixed(1));
  };
  return { excludeN: EX.length, killedN: killed.size, detail,
    visRoad: { pts: visPts, total: tot, top: Object.entries(visIds).sort((a, b) => b[1] - a[1]).slice(0, 20) },
    officeBox: box(window.__officeBuilding), homeBox: box(window.__homeBuilding),
    roadKill: window.__roadKill };
});
console.log(JSON.stringify(R, null, 1));
await b.close();
