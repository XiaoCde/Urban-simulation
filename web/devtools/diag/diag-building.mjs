import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
mkdirSync('../out/motion', { recursive: true });
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 760 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html?ped=1');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });

for (const o of [
  { m: 600, name: 'diag_office_day', x: 2501.37, z: 354.69, d: 150, h: 95 },
  { m: 600, name: 'diag_office_day_near', x: 2501.37, z: 354.69, d: 80, h: 55 },
  { m: 20, name: 'diag_home_day', x: 2642.79, z: -331.65, d: 130, h: 85 },
]) {
  const info = await p.evaluate((a) => {
    const C = window.__clock;
    C.setPlaying(false); C.seek(a.m); window.__frame(0, 3);
    const cam = window.__camera, ctl = window.__controls;
    cam.position.set(a.x + a.d * 0.7, a.h, a.z + a.d * 0.9);
    if (ctl) { ctl.target.set(a.x, 12, a.z); ctl.update(); }
    window.__frame(0, 2);
    const P = window.__people;
    const groups = { office: window.__mark && window.__mark.story ? null : null };
    // office / home 没直接挂 window，用 people.buildings + 从 world 里按名字找
    const stat = {};
    const scan = (label, g) => {
      if (!g) return;
      let n = 0, tr = 0, order3 = 0, ghost = 0;
      const ops = {};
      g.traverse((o2) => {
        if (!o2.isMesh || !o2.material) return;
        n++;
        if (o2.material.transparent) tr++;
        if (o2.renderOrder === 3) order3++;
        const op = Math.round((o2.material.opacity ?? 1) * 100) / 100;
        ops[op] = (ops[op] || 0) + 1;
        if (op < 0.5) ghost++;
      });
      stat[label] = { n, transparent: tr, renderOrder3: order3, ghost, opacity: ops };
    };
    const world = window.__world || null;
    if (world) {
      for (const c of world.children) {
        if (c.userData && c.userData.officeId) scan('office', c);
        else if (c.userData && c.userData.homeId) scan('home', c);
      }
    }
    if (P) for (const [k, v] of Object.entries(P.buildings)) if (v && v.group) scan(k, v.group);
    return { stat, lights: (window.__scene ? 0 : 0) };
  }, o);
  console.log(o.name, JSON.stringify(info.stat));
  const data = await p.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
  writeFileSync(`../out/motion/${o.name}.png`, Buffer.from(data.split(',')[1], 'base64'));
}
await b.close();
