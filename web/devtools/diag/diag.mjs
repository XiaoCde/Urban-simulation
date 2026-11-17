/**
 * 体检探针：人重叠 / 待机动作 / 车朝向 / 楼压路。
 * node _diag.mjs [minute] [query]
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const minute = Number(process.argv[2] ?? 0);
const qs = process.argv[3] || '';
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 900, height: 560 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html' + (qs ? '?' + qs : ''));
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });

const out = await p.evaluate(async (mm) => {
  const C = window.__clock; C.setPlaying(false); C.seek(mm);
  await new Promise((r) => setTimeout(r, 900));
  window.__frame(1 / 30, 4);
  const R = {};

  // ---- 1) 人物重叠 ----
  const PED = window.__ped;
  const pts = [];
  if (PED) for (const q of PED.peds) if (q.obj.visible) pts.push([q.obj.position.x, q.obj.position.z, q.obj.position.y]);
  let dup = 0; const dupPairs = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][2] - pts[j][2]);
      if (d < 0.8) { dup++; if (dupPairs.length < 6) dupPairs.push([i, j, +d.toFixed(2)]); }
    }
  }
  R.peds = { visible: pts.length, total: PED ? PED.peds.length : 0, dup, dupPairs };

  // ---- 2) 六个具名角色的位置与动作 ----
  const PE = window.__people;
  R.cast = [];
  if (PE && PE.actors) {
    for (const a of PE.actors) {
      const s = a.story || {};
      const clip = s.cur ? (s.cur.getClip ? s.cur.getClip().name : String(s.cur)) : null;
      R.cast.push({
        key: a.key, state: s.state, clip,
        pos: [Math.round(a.root.position.x), Math.round(a.root.position.z)],
        storyT: s.tMin != null ? +s.tMin.toFixed(1) : null,
      });
    }
  }
  if (R.cast.length > 1) {
    const seen = {};
    for (const c of R.cast) {
      const k = c.pos.join(',');
      seen[k] = (seen[k] || 0) + 1;
    }
    R.castDup = Object.entries(seen).filter(([, n]) => n > 1);
  }

  // ---- 3) 车的朝向 vs 位移 ----
  const TR = window.__traffic && window.__traffic();
  R.cars = null;
  if (TR && TR.cars) {
    const before = TR.cars.map((c) => ({ x: c.p ? c.p.x : 0, z: c.p ? c.p.z : 0 }));
    // 用 lanePoint 取世界坐标
    const getPos = (c) => {
      const e = c.e; const t = Math.min(1, Math.max(0, c.t));
      const uu = c.dir > 0 ? t : 1 - t;
      return { x: e.a.x + (e.b.x - e.a.x) * uu, z: e.a.z + (e.b.z - e.a.z) * uu };
    };
    const p0 = TR.cars.map(getPos);
    TR.advance(2.0);
    const p1 = TR.cars.map(getPos);
    let moved = 0, sideways = 0;
    const samples = [];
    for (let i = 0; i < TR.cars.length; i++) {
      const dx = p1[i].x - p0[i].x, dz = p1[i].z - p0[i].z;
      const dl = Math.hypot(dx, dz);
      if (dl < 0.05) continue;
      moved++;
      const e = TR.cars[i].e;
      const fx = (e.b.x - e.a.x) * (TR.cars[i].dir > 0 ? 1 : -1);
      const fz = (e.b.z - e.a.z) * (TR.cars[i].dir > 0 ? 1 : -1);
      const fl = Math.hypot(fx, fz) || 1;
      const dot = (dx / dl) * (fx / fl) + (dz / dl) * (fz / fl);
      if (dot < 0.9) sideways++;
      if (samples.length < 4) samples.push({ dot: +dot.toFixed(3), dl: +dl.toFixed(2) });
    }
    R.cars = { total: TR.cars.length, moved, sideways, samples };
  }

  // ---- 4) 楼压路 ----
  const B = window.__buildings;
  const rn = window.__roadnet && window.__roadnet();
  R.roadVsBuilding = null;
  if (B && rn && rn.edges) {
    const boxes = [];
    for (const bd of B.buildings) {
      let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
      for (let k = 0; k < bd.vc; k++) {
        const a = (bd.v0 + k) * 4;
        const x = B.verts[a], z = B.verts[a + 1];
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (z < minz) minz = z; if (z > maxz) maxz = z;
      }
      if (!(bd.height_m > 3)) continue;
      boxes.push({ id: bd.id, minx, maxx, minz, maxz, h: bd.height_m });
    }
    let hit = 0; const ex = [];
    for (const e of rn.edges) {
      const mx = (e.a.x + e.b.x) / 2, mz = (e.a.z + e.b.z) / 2;
      for (const bb of boxes) {
        if (mx > bb.minx && mx < bb.maxx && mz > bb.minz && mz < bb.maxz) {
          hit++;
          if (ex.length < 8) ex.push({ id: bb.id, h: +bb.h.toFixed(0), x: Math.round(mx), z: Math.round(mz) });
          break;
        }
      }
    }
    R.roadVsBuilding = { edges: rn.edges.length, hit, ex };
  }
  return R;
}, minute);

console.log(JSON.stringify(out, null, 1));
await b.close();
