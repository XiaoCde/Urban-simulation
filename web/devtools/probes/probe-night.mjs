/** 查 22:00 镜头街区为什么没人可见：距离 / 室内 / 模式 / 可见性交叉统计。 */
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
  const C = window.__clock, PED = window.__ped, CROWD = window.__crowdLife;
  const cam = window.__camera, flood = window.__flood, ctl = window.__controls;
  const peds = PED.peds;
  C.setPlaying(false);
  let best = peds[1], bd = Infinity;
  for (let i = 1; i < peds.length; i++) {
    const h = peds[i].homeXZ; if (!h) continue;
    const d = Math.hypot(h.x - 2501, h.z - 355);
    if (d < bd) { bd = d; best = peds[i]; }
  }
  const a = best.homeXZ || best.obj.position;
  cam.position.set(a.x + 18, 12, a.z + 18);
  if (ctl) { ctl.target.set(a.x, 0, a.z); ctl.update(); }
  const out = [];
  for (const m of [20, 500, 760, 1320]) {
    C.seek(m); window.__frame(0, 2);
    for (let f = 0; f < 36; f++) { C.minute += 0.42; PED.update(1 / 30, cam, flood); }
    const rows = peds.slice(1).map((q, k) => {
      const i = k + 1, soc = CROWD.at(i, C.minute);
      return { i, dist: +q.obj.position.distanceTo(cam.position).toFixed(0),
        indoor: !!soc.indoor, vis: !!q.obj.visible, pvis: !!q.visible,
        mode: q.mode, seg: soc.segment };
    });
    const near = rows.filter((r) => r.dist < 360);
    out.push({ m, minute: +C.minute.toFixed(0),
      near: near.length,
      nearOutdoor: near.filter((r) => !r.indoor).length,
      nearOutdoorVisible: near.filter((r) => !r.indoor && r.vis).length,
      nearIndoorVisible: near.filter((r) => r.indoor && r.vis).length,
      modes: [...new Set(near.map((r) => r.mode))].join(','),
      segs: [...new Set(near.map((r) => r.seg))].join(','),
      sample: near.filter((r) => !r.indoor).slice(0, 8) });
  }
  return out;
});
console.log(JSON.stringify(R, null, 1));
await b.close();
