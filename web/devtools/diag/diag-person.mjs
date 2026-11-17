import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
mkdirSync('../out/motion', { recursive: true });
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 1000, height: 640 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html?ped=1');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });

for (const o of [{ m: 755, name: 'diag_cafe_near', d: 13, h: 4 },
  { m: 20, name: 'diag_home_near', d: 13, h: 4 }]) {
  const diag = await p.evaluate((a) => {
    const C = window.__clock, D = window.__dayMotion;
    C.setPlaying(false); C.seek(a.m); window.__frame(0, 3);
    const q = D.at('mark', a.m);
    const cam = window.__camera, ctl = window.__controls;
    cam.position.set(q.x + a.d, q.y + a.h, q.z + a.d);
    if (ctl) { ctl.target.set(q.x, q.y + 1, q.z); ctl.update(); }
    window.__frame(0, 2);
    const mk = window.__ped && window.__ped.peds[0];
    const P = window.__people;
    const cast = P ? P.actors.map((x) => ({
      k: x.def.key, vis: x.model.visible,
      x: Math.round(x.root.position.x), y: Math.round(x.root.position.y), z: Math.round(x.root.position.z),
      dist: Math.round(Math.hypot(x.root.position.x - q.x, x.root.position.z - q.z)),
      clip: x.cur ? String(x.cur.getClip().name) : null,
    })) : [];
    const bd = P ? P.buildings : {};
    const mat = {};
    for (const [k, v] of Object.entries(bd)) {
      let n = 0, tr = 0, op = null;
      if (v && v.group) v.group.traverse((o2) => {
        if (!o2.isMesh || !o2.material) return;
        n++;
        if (o2.material.transparent) tr++;
        if (op === null) op = o2.material.opacity;
      });
      mat[k] = { n, transparent: tr, opacity: op };
    }
    return {
      q: { x: Math.round(q.x), y: Math.round(q.y), z: Math.round(q.z), place: q.place },
      cam: { x: Math.round(cam.position.x), y: Math.round(cam.position.y), z: Math.round(cam.position.z) },
      mark: mk ? { vis: mk.obj.visible, x: Math.round(mk.obj.position.x),
        y: Math.round(mk.obj.position.y), z: Math.round(mk.obj.position.z) } : null,
      cast: cast.slice(0, 3), mat,
    };
  }, o);
  console.log(o.name, JSON.stringify(diag));
  const data = await p.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
  writeFileSync(`../out/motion/${o.name}.png`, Buffer.from(data.split(',')[1], 'base64'));
}
await b.close();
