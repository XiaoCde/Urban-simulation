/** 实测：马克 / 罗伯特的车在全天轨迹里是否穿过建筑实体、是否开上半空楼层。 */
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
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });

const R = await p.evaluate(() => {
  const D = window.__dayMotion, BI = window.__bIdx, C = window.__clock;
  const gy = window.__terrY;
  const inRect = (r, x, z, pad = 0) => x > r.minx + pad && x < r.maxx - pad
    && z > r.minz + pad && z < r.maxz - pad;
  const hitAt = (x, z) => BI.rects.filter((r) => inRect(r, x, z, 0.5)).map((r) => r.id);
  const out = { samples: [], hits: [], high: [], segments: [], roadKill: window.__roadKill || null };
  if (!D || !BI) return { error: 'no dayMotion / bIdx' };

  // 逐分钟扫全部 inVehicle 位置
  let prevSeg = null;
  for (let m = 0; m < 1440; m++) {
    for (const key of ['mark', 'boss']) {
      const q = D.at(key, m);
      if (!q || !q.inVehicle) { if (key === 'mark') prevSeg = null; continue; }
      const g = gy ? gy(q.x, q.z) : 0;
      const h = hitAt(q.x, q.z);
      const tag = `${key}|${q.a}-${q.b}|${q.place}`;
      if (tag !== prevSeg && key === 'mark') {
        out.segments.push({ tag, from: q.a, to: q.b, clip: q.clip, spot: q.spot,
          start: [+q.x.toFixed(1), +q.y.toFixed(1), +q.z.toFixed(1)] });
        prevSeg = tag;
      }
      const rec = { m, key, x: +q.x.toFixed(1), y: +q.y.toFixed(1), z: +q.z.toFixed(1),
        gy: +(g || 0).toFixed(1), above: +(q.y - (g || 0)).toFixed(1), hit: h.length,
        ids: h.slice(0, 4), seg: tag, clip: q.clip, indoor: q.indoor, floor: q.floor };
      if (h.length) out.hits.push(rec);
      if (q.y - (g || 0) > 3) out.high.push(rec);
      out.samples.push(rec);
    }
  }

  // 路网边采样：多少路中心点落在建筑内（含精细楼）
  let roadPts = 0, roadInB = 0;
  const roadIds = {};
  const E = window.__roadnet ? window.__roadnet().edges : [];
  for (const e of E) {
    const n = Math.max(2, Math.ceil(Math.hypot(e.b.x - e.a.x, e.b.z - e.a.z) / 5));
    for (let i = 0; i <= n; i++) {
      const x = e.a.x + (e.b.x - e.a.x) * i / n, z = e.a.z + (e.b.z - e.a.z) * i / n;
      roadPts++;
      const h = hitAt(x, z);
      if (h.length) { roadInB++; for (const id of h) roadIds[id] = (roadIds[id] || 0) + 1; }
    }
  }
  out.road = { pts: roadPts, inBuilding: roadInB,
    top: Object.entries(roadIds).sort((a, b) => b[1] - a[1]).slice(0, 16) };

  // 实际渲染的车模型位置（跟拍/自由视角下的 car obj）
  const MK = window.__mark;
  C.setPlaying(false);
  out.carSnaps = [];
  for (const m of [455, 462, 470, 478, 485]) {
    C.seek(m); window.__frame(0, 2);
    const c = MK && MK.car;
    out.carSnaps.push({ m, pos: c ? [+c.position.x.toFixed(1), +c.position.y.toFixed(1), +c.position.z.toFixed(1)] : null,
      hit: c ? hitAt(c.position.x, c.position.z).length : -1 });
  }
  return out;
});

console.log('roadKill:', JSON.stringify(R.roadKill));
console.log('路网采样点落在楼体内:', R.road && R.road.inBuilding, '/', R.road && R.road.pts,
  ' 涉及楼:', JSON.stringify(R.road && R.road.top));
console.log('\n驾车段:', JSON.stringify(R.segments, null, 1));
console.log('\ninVehicle 采样总数:', R.samples.length,
  ' 落在楼内:', R.hits.length, ' 离地>3m:', R.high.length);
console.log('\n=== 穿楼时刻（按分钟聚合） ===');
const bySeg = {};
for (const h of R.hits) {
  const k = `${h.seg}|${h.ids.join(',')}`;
  (bySeg[k] ||= { n: 0, first: h.m, last: h.m, maxAbove: 0, sample: h }) .n++;
  bySeg[k].last = h.m; bySeg[k].maxAbove = Math.max(bySeg[k].maxAbove, h.above);
}
for (const [k, v] of Object.entries(bySeg)) {
  const hh = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  console.log(`${k}  ${v.n} 分钟 ${hh(v.first)}–${hh(v.last)}  最高离地 ${v.maxAbove}m  例:`,
    JSON.stringify(v.sample));
}
console.log('\n=== 半空行驶（离地 >3m） ===');
const byHi = {};
for (const h of R.high) (byHi[h.seg] ||= []).push(h);
for (const [k, v] of Object.entries(byHi)) {
  console.log(k, v.length, '分钟', '最高', Math.max(...v.map((x) => x.above)), 'm',
    '例', JSON.stringify(v[0]));
}
console.log('\n=== 实际车模型 ===');
console.log(JSON.stringify(R.carSnaps));
console.log('\n页面错误:', errs.length, errs.slice(0, 3).join(' | '));
await b.close();
