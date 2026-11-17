/** 定位「人在空中 / 屋顶」：逐时段统计可见人的脚底高程 vs 地面高程。 */
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

const out = await p.evaluate(() => {
  const C = window.__clock, PED = window.__ped, CROWD = window.__crowdLife;
  const G = PED.graph;
  const groundAt = G.groundAt;
  const cam = window.__camera || window.__camNow();
  const flood = window.__flood;
  const peds = PED.peds;
  C.setPlaying(false);
  // 相机放高俯瞰，保证大多数人在可见范围内（否则被距离裁剪掉看不到）
  cam.position.set(2500, 400, 400);
  if (window.__controls) { window.__controls.target.set(2500, 0, 400); window.__controls.update(); }
  const rows = [];
  for (const m of [200, 600, 900, 1000, 1025, 1050, 1080, 1120, 1200, 1400]) {
    C.seek(m); window.__frame(0, 2);
    // 快进若干帧让人系统进入该时段状态
    for (let f = 0; f < 30; f++) PED.update(1 / 30, cam, flood);
    let vis = 0, air = 0, roof = 0, hi = 0;
    const samples = [];
    for (let i = 1; i < peds.length; i++) {
      const q = peds[i];
      if (!q.obj.visible) continue;
      vis++;
      const x = q.obj.position.x, z = q.obj.position.z, y = q.obj.position.y;
      const g = groundAt(x, z);
      const dy = y - g;
      if (dy > 0.4) {
        air++;
        if (q.refuge && q.refuge.kind === 1) roof++;
        else hi++;
        if (samples.length < 12) samples.push({
          i, dy: +dy.toFixed(2), g: +g.toFixed(2), y: +y.toFixed(2),
          mode: q.mode, why: q.why || null, state: q.state,
          rk: q.refuge ? q.refuge.kind : null, ry: q.refuge ? +q.refuge.y.toFixed(1) : null,
          climb: q.climb, pos: [+x.toFixed(0), +z.toFixed(0)],
        });
      }
    }
    const fs = PED.fleeStats();
    rows.push({ m, vis, air, roofKind: roof, hiKind: hi,
      flee: fs.flee, shelter: fs.shelter, roof: fs.roof, rainSh: fs.rainShelter, floodSh: fs.floodShelter,
      samples });
  }
  return { rows };
});
console.log(JSON.stringify({ ...out, errs }, null, 1));
await b.close();
