/** 全量车体检：行驶车 / 路边停放 / 马克的车 —— 离路距离 + 车头与路段夹角。 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html?ped=1');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });
const out = await p.evaluate(async () => {
  const THREE = await import('three');
  const RN = window.__roadnet();
  const TR = window.__traffic();
  const BX = window.__bIdx, EX = window.__exclude || new Set();
  const nearEdge = (x, z) => {
    let bd = Infinity, dir = null;
    for (const e of RN.edges) {
      const dx = e.b.x - e.a.x, dz = e.b.z - e.a.z, L2 = dx * dx + dz * dz;
      let t = L2 > 1e-9 ? ((x - e.a.x) * dx + (z - e.a.z) * dz) / L2 : 0;
      if (t < -0.03 || t > 1.03) continue;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - (e.a.x + dx * t), z - (e.a.z + dz * t));
      if (d < bd) { bd = d; const L = Math.sqrt(L2) || 1; dir = [dx / L, dz / L]; }
    }
    return { d: bd, dir };
  };
  const inB = (x, z) => {
    const arr = BX.buckets.get(BX.hashAt(x, z));
    if (!arr) return false;
    for (const r of arr) {
      if (EX.has(r.id) || r.h <= 3) continue;
      if (x > r.minx + 0.5 && x < r.maxx - 0.5 && z > r.minz + 0.5 && z < r.maxz - 0.5) return true;
    }
    return false;
  };
  const angleDeg = (fx, fz, dir) => {
    if (!dir) return null;
    const dot = Math.abs(fx * dir[0] + fz * dir[1]);
    return +(Math.acos(Math.min(1, dot)) * 180 / Math.PI).toFixed(1);
  };
  const buckets = { moving: [], parked: [], mark: [] };
  const add = (kind, x, z, fx, fz) => {
    const ne = nearEdge(x, z);
    const r = { x: Math.round(x), z: Math.round(z), road: +ne.d.toFixed(1),
      bld: inB(x, z), angle: angleDeg(fx, fz, ne.dir) };
    buckets[kind].push(r);
  };

  // 行驶车：用 traffic 的 car.yaw（同步到实例矩阵的就是它）
  for (const c of TR.cars) {
    const yaw = c.yaw ?? 0;
    const e = c.e;
    const t = c.dir > 0 ? c.t : 1 - c.t;
    const dx = e.b.x - e.a.x, dz = e.b.z - e.a.z, L = Math.hypot(dx, dz) || 1;
    const w = Math.min(1, Math.min(t, 1 - t) / 0.15);
    const off = 2.1 * w * (c.dir > 0 ? 1 : -1);
    const x = e.a.x + dx * t + (-dz / L) * off;
    const z = e.a.z + dz * t + (dx / L) * off;
    add('moving', x, z, Math.sin(yaw), Math.cos(yaw));
  }

  // 停放的 InstancedMesh：按名字分组取矩阵
  const sc = window.__scene;
  const M = new THREE.Matrix4(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), scl = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  sc.traverse((o) => {
    if (!o.isInstancedMesh) return;
    if (!/^park_/.test(o.name)) return;
    // 每种车的第 0 个 part 就够定位（同一车位的所有 part 共用变换）
    if (!/^park_(sedan|suv|compact)0$/.test(o.name)) return;
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, M);
      M.decompose(pos, q, scl);
      fwd.set(0, 0, 1).applyQuaternion(q);
      add('parked', pos.x, pos.z, fwd.x, fwd.z);
    }
  });
  // 马克与公寓门口的散车（普通 Object3D）
  const mc = window.__mark && window.__mark.car;
  if (mc) add('mark', mc.position.x, mc.position.z,
    Math.sin(mc.rotation.y), Math.cos(mc.rotation.y));

  const summary = {};
  for (const [k, rows] of Object.entries(buckets)) {
    const n = rows.length;
    summary[k] = {
      n,
      offRoad8: rows.filter((r) => r.road > 8).length,
      inBuilding: rows.filter((r) => r.bld).length,
      yawOff30: rows.filter((r) => r.angle !== null && r.angle > 30).length,
      yawOff60: rows.filter((r) => r.angle !== null && r.angle > 60).length,
      worst: rows.filter((r) => (r.angle || 0) > 30).slice(0, 8),
      offRoadWorst: rows.filter((r) => r.road > 8).slice(0, 3),
    };
  }
  return summary;
});
console.log(JSON.stringify(out, null, 1));
await b.close();
