/**
 * 诊断：马克 4 条路线 + 全部车辆，逐段检测穿楼 / 离开路面。
 * node _probe_route2.mjs
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await b.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html?ped=1');
u.searchParams.set('capture', '1');
u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });

const out = await p.evaluate(() => {
  const M = window.__mark;
  const RN = window.__roadnet();
  const BX = window.__bIdx;
  const EX = window.__exclude || new Set();
  const T = window.__terrain();

  // 只保留「实际渲染出来」的楼（EXCLUDE 里的已经从管线剔除）
  const rects = BX.rects.filter((r) => !EX.has(r.id) && r.h > 3);
  const CELL = 64;
  const hashAt = BX.hashAt;
  const inBuilding = (x, z) => {
    const arr = BX.buckets.get(hashAt(x, z));
    if (!arr) return null;
    for (const r of arr) {
      if (EX.has(r.id) || r.h <= 3) continue;
      if (x > r.minx + 0.6 && x < r.maxx - 0.6 && z > r.minz + 0.6 && z < r.maxz - 0.6) return r.id;
    }
    return null;
  };
  // 到最近路段中线的距离
  const roadDist = (x, z) => {
    let bd = Infinity;
    for (const e of RN.edges) {
      const dx = e.b.x - e.a.x, dz = e.b.z - e.a.z;
      const L2 = dx * dx + dz * dz;
      let t = L2 > 1e-9 ? ((x - e.a.x) * dx + (z - e.a.z) * dz) / L2 : 0;
      if (t < -0.03 || t > 1.03) continue;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - (e.a.x + dx * t), z - (e.a.z + dz * t));
      if (d < bd) bd = d;
    }
    return bd;
  };
  // 地类（0 水 / 1 楼 / 3 草地 / 4 林地 …）
  const landcover = (x, z) => { try { return T.classify(x, z); } catch { return -1; } };

  const samplePolyline = (pts, step = 2) => {
    let total = 0, inB = 0, offRoad = 0, grass = 0;
    const bad = [];
    for (let i = 1; i < pts.length; i++) {
      const [ax, , az] = pts[i - 1];
      const [bx, , bz] = pts[i];
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(L / step));
      for (let k = 0; k <= n; k++) {
        const x = ax + (bx - ax) * k / n;
        const z = az + (bz - az) * k / n;
        total++;
        const hit = inBuilding(x, z);
        const rd = roadDist(x, z);
        const lc = landcover(x, z);
        if (hit) inB++;
        if (rd > 8) offRoad++;
        if (lc === 3 || lc === 4) grass++;
        if ((hit || rd > 8) && bad.length < 10) {
          bad.push({ seg: i, x: Math.round(x), z: Math.round(z),
            bld: hit, road: +rd.toFixed(1), lc });
        }
      }
    }
    return { pts: pts.length, samples: total, inBuilding: inB,
      offRoad8m: offRoad, grass, pctInB: +(100 * inB / total).toFixed(1),
      pctOff: +(100 * offRoad / total).toFixed(1), bad };
  };

  const routes = {};
  for (const k of ['route_home', 'route_detour', 'route_drive', 'route_drive_detour']) {
    const pts = M.story.routes[k];
    if (Array.isArray(pts)) routes[k] = samplePolyline(pts);
  }

  // 车：按 lanePoint 取实际渲染位置
  const TR = window.__traffic();
  const cars = [];
  let carInB = 0, carOff = 0;
  for (const c of TR.cars) {
    const e = c.e;
    const uu = Math.min(1, Math.max(0, c.t));
    const t = c.dir > 0 ? uu : 1 - uu;
    const dx = e.b.x - e.a.x, dz = e.b.z - e.a.z;
    const L = Math.hypot(dx, dz) || 1;
    const nx = -dz / L, nz = dx / L;
    const s = c.dir > 0 ? 1 : -1;
    const w = Math.min(1, Math.min(t, 1 - t) / 0.15);
    const off = 2.1 * w * s;
    const x = e.a.x + dx * t + nx * off;
    const z = e.a.z + dz * t + nz * off;
    const hit = inBuilding(x, z);
    const rd = roadDist(x, z);
    if (hit) carInB++;
    if (rd > 8) carOff++;
    if ((hit || rd > 8) && cars.length < 8) cars.push({ x: Math.round(x), z: Math.round(z), bld: hit, road: +rd.toFixed(1) });
  }
  return {
    rects: rects.length, edges: RN.edges.length,
    routes, cars: { total: TR.cars.length, inBuilding: carInB, offRoad8m: carOff, sample: cars },
  };
});
console.log(JSON.stringify(out, null, 1));
await b.close();
