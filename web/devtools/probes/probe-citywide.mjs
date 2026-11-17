/**
 * _probe_citywide.mjs — 全城覆盖实测探针（只读，不改产品代码）
 *
 * 目的：回答「人和车到底铺满 6×5.2 km 全城，还是只挤在白宫附近一小片」。
 * 量：城市/建筑/路网 AABB、住宅门牌/岗位/实时位置/车辆坐标的范围、
 *     500m 网格覆盖数、以白宫为心的分环占比、相机可见人数。
 *
 * 用法：node _probe_citywide.mjs [people=3000] [minute=480]
 */
import puppeteer from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';

const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
if (!CHROME) throw new Error('找不到 Chrome / Edge');
const N = Number(process.argv[2] || 3000);
const MIN = Number(process.argv[3] || 480);

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  protocolTimeout: 900000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 1200, height: 760 });
const errs = [];
const logs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => {
  if (m.type() === 'error') errs.push('console: ' + m.text());
  if (/city-drive|全城车行|接入失败|404|Failed to fetch/i.test(m.text())) logs.push(m.type() + ': ' + m.text().slice(0, 260));
});

const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1');
u.searchParams.set('ped', String(N));
u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
await p.evaluate(() => { window.__manualDrive = true; });

const R = await p.evaluate((minute) => {
  const PED = window.__ped, C = window.__clock, S = window.__solids;
  const RN = window.__roadnet ? window.__roadnet() : null;
  const T = window.__traffic ? window.__traffic() : null;
  const CL = PED.crowdLife || window.__crowdLife;
  const WH = { x: 1144, z: -815 };

  const bbox = () => ({ minx: Infinity, maxx: -Infinity, minz: Infinity, maxz: -Infinity, n: 0 });
  const add = (a, x, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    a.n++; if (x < a.minx) a.minx = x; if (x > a.maxx) a.maxx = x;
    if (z < a.minz) a.minz = z; if (z > a.maxz) a.maxz = z;
  };
  const fin = (a) => a.n ? {
    n: a.n, minx: +a.minx.toFixed(0), maxx: +a.maxx.toFixed(0),
    minz: +a.minz.toFixed(0), maxz: +a.maxz.toFixed(0),
    spanX: +(a.maxx - a.minx).toFixed(0), spanZ: +(a.maxz - a.minz).toFixed(0),
  } : { n: 0 };
  const rings = () => [0, 0, 0, 0, 0, 0];
  const ringOf = (x, z) => {
    const d = Math.hypot(x - WH.x, z - WH.z);
    return d < 500 ? 0 : d < 1000 ? 1 : d < 2000 ? 2 : d < 3000 ? 3 : d < 4500 ? 4 : 5;
  };
  const grid = () => new Map();
  const gadd = (g, x, z, cell) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const k = Math.floor(x / cell) + '_' + Math.floor(z / cell);
    g.set(k, (g.get(k) || 0) + 1);
  };

  const build = bbox(), buildG = grid(), buildR = rings();
  const rects = S && S.rects ? S.rects : [];
  for (const r of rects) {
    const x = (r.minx + r.maxx) / 2, z = (r.minz + r.maxz) / 2;
    add(build, x, z); gadd(buildG, x, z, 500); buildR[ringOf(x, z)]++;
  }

  const nodes = bbox(), edges = bbox(), nodeG = grid();
  const ns = RN && RN.nodes ? RN.nodes : (RN && RN.graph && RN.graph.nodes) || [];
  const es = RN && RN.edges ? RN.edges : (RN && RN.graph && RN.graph.edges) || [];
  for (const n of ns) { add(nodes, n.x, n.z); gadd(nodeG, n.x, n.z, 500); }
  for (const e of es) { add(edges, e.a.x, e.a.z); add(edges, e.b.x, e.b.z); }

  const cars = T && T.cars ? T.cars : [];
  const carB = bbox(), carG = grid(), carR = rings();
  for (const c of cars) {
    let x = NaN, z = NaN;
    if (c.e && c.e.a && c.e.b) {
      const t = Math.min(1, Math.max(0, c.t));
      x = c.e.a.x + (c.e.b.x - c.e.a.x) * t;
      z = c.e.a.z + (c.e.b.z - c.e.a.z) * t;
    }
    add(carB, x, z); gadd(carG, x, z, 500);
    if (Number.isFinite(x)) carR[ringOf(x, z)]++;
  }

  const homeB = bbox(), workB = bbox(), posB = bbox();
  const homeG = grid(), workG = grid(), posG = grid();
  const homeR = rings(), workR = rings(), posR = rings();
  let visible = 0, indoor = 0, outdoor = 0;
  for (const q of PED.peds) {
    const s = CL && CL.at ? CL.at(q.i, C.minute) : null;
    if (s && s.indoor) indoor++; else outdoor++;
    if (q.obj.visible) visible++;
    const x = q.obj.position.x, z = q.obj.position.z;
    add(posB, x, z); gadd(posG, x, z, 500); posR[ringOf(x, z)]++;
    const h = s && s.doors ? s.doors.home : null;
    const w = s && s.doors ? s.doors.work : null;
    if (h && Number.isFinite(h.x)) {
      add(homeB, h.x, h.z); gadd(homeG, h.x, h.z, 500); homeR[ringOf(h.x, h.z)]++;
    }
    if (w && Number.isFinite(w.x)) {
      add(workB, w.x, w.z); gadd(workG, w.x, w.z, 500); workR[ringOf(w.x, w.z)]++;
    }
  }

  C.seek(minute);
  window.__frame(0.05, 240, true);
  const pos2B = bbox(), pos2G = grid(), pos2R = rings();
  let visible2 = 0;
  for (const q of PED.peds) {
    const x = q.obj.position.x, z = q.obj.position.z;
    add(pos2B, x, z); gadd(pos2G, x, z, 500); pos2R[ringOf(x, z)]++;
    if (q.obj.visible) visible2++;
  }

  const cam = window.__camera ? window.__camera.position : null;
  const objGrid = (g) => Object.fromEntries([...g.entries()].map(([k, v]) => [k, v]));
  return {
    city: { x0: -1277, x1: 4701, z0: -4189, z1: 931, w: 5978, h: 5120 },
    whiteHouse: WH,
    camera: cam ? { x: +cam.x.toFixed(0), y: +cam.y.toFixed(0), z: +cam.z.toFixed(0) } : null,
    minute: +C.minute.toFixed(1),
    buildings: fin(build), buildingsGrid500: buildG.size, buildingsRings: buildR,
    roadNodes: fin(nodes), roadNodesGrid500: nodeG.size, roadEdges: fin(edges),
    cars: fin(carB), carsGrid500: carG.size, carsRings: carR, carCount: cars.length,
    homeDoors: fin(homeB), homeGrid500: homeG.size, homeRings: homeR,
    workDoors: fin(workB), workGrid500: workG.size, workRings: workR,
    pedPos0: fin(posB), pedGrid500: posG.size, pedRings0: posR, visible0: visible,
    indoor0: indoor, outdoor0: outdoor,
    pedPosAtMinute: fin(pos2B), pedGridAtMinute: pos2G.size,
    pedRingsAtMinute: pos2R, visibleAtMinute: visible2,
    densestCell0: Math.max(0, ...posG.values()),
    densestCellAtMinute: Math.max(0, ...pos2G.values()),
    grids: {
      buildings: objGrid(buildG), homes: objGrid(homeG),
      cars: objGrid(carG), pedsAtMinute: objGrid(pos2G),
      oldRoad: objGrid(nodeG),
    },
    crew: T && T.crewStats ? T.crewStats() : null,
    cityNet: window.__cityNet || null,
  };
}, MIN);

console.log('\n===== 全城覆盖实测 =====');
console.log('页面错误', errs.length, errs.slice(0, 6));
console.log('相关日志', logs.slice(0, 12));
console.log('cityNet', JSON.stringify(await p.evaluate(() => window.__cityNet || null)));
console.log(JSON.stringify(R, null, 2));
writeFileSync('out/_probe_citywide.json', JSON.stringify(R, null, 2));
await b.close();
