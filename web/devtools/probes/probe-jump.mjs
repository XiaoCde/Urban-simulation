/** 定位「可见人瞬移」：逐帧记录 >2.2m 跳变的当事人完整状态。 */
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
  const C = window.__clock, PED = window.__ped, CROWD = window.__crowdLife;
  const cam = window.__camera, flood = window.__flood, ctl = window.__controls;
  const peds = PED.peds;
  C.setPlaying(false);
  let best = peds[1], bd = Infinity;
  for (let i = 1; i < peds.length; i++) {
    const h = peds[i].homeXZ;
    if (!h) continue;
    const d = Math.hypot(h.x - 2501, h.z - 355);
    if (d < bd) { bd = d; best = peds[i]; }
  }
  const anchor = best.homeXZ || best.obj.position;
  cam.position.set(anchor.x + 18, 12, anchor.z + 18);
  if (ctl) { ctl.target.set(anchor.x, 0, anchor.z); ctl.update(); }
  const jumps = [], summary = [];
  for (const m of [20, 500, 760, 1090, 1320]) {
    C.seek(m); window.__frame(0, 2);
    for (let f = 0; f < 36; f++) {
      C.minute += 0.42;
      const pre = peds.map((q) => ({ x: q.obj.position.x, z: q.obj.position.z,
        vis: !!q.obj.visible, mode: q.mode, seg: q.lastSeg, indoor: q.wasIndoor,
        enter: !!q.enterWalk, ci: q.ci, s: q.s }));
      PED.update(1 / 30, cam, flood);
      for (let i = 1; i < peds.length; i++) {
        const q = peds[i], a = pre[i];
        const d = Math.hypot(q.obj.position.x - a.x, q.obj.position.z - a.z);
        if (a.vis && q.obj.visible && d > 2.2) {
          const soc = CROWD.at(i, C.minute);
          jumps.push({ m, f, i, d: +d.toFixed(1),
            from: [+a.x.toFixed(1), +a.z.toFixed(1)],
            to: [+q.obj.position.x.toFixed(1), +q.obj.position.z.toFixed(1)],
            mode0: a.mode, mode1: q.mode, seg0: a.seg, seg1: q.lastSeg,
            indoor0: a.indoor, indoor1: q.wasIndoor, nowIndoor: !!soc.indoor,
            enter0: a.enter, enter1: !!q.enterWalk,
            ci0: a.ci, ci1: q.ci, s0: +a.s.toFixed(1), s1: +q.s.toFixed(1),
            home: q.homeXZ ? [+q.homeXZ.x.toFixed(0), +q.homeXZ.z.toFixed(0)] : null });
        }
      }
    }
    const visN = peds.filter((q) => q.obj.visible).length;
    const outN = peds.filter((q, i) => !CROWD.at(i, C.minute).indoor).length;
    const nearN = peds.filter((q) => q.obj.position.distanceTo(cam.position) < 360).length;
    summary.push({ m, visN, outN, nearN, cam: [+cam.position.x.toFixed(0), +cam.position.z.toFixed(0)],
      minute: +C.minute.toFixed(1) });
  }
  return { jumps: jumps.slice(0, 30), total: jumps.length, summary };
});
console.log(JSON.stringify(R, null, 1));
console.log('页面错误', errs.length, errs.slice(0, 3));
await b.close();
