import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const DIR = '../out/motion';
mkdirSync(DIR, { recursive: true });
const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 760 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html?ped=1');
u.searchParams.set('capture', '1');
u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });

const shots = [
  { name: '0000_home', m: 20, dist: 78, high: 52 },
  { name: '0000_home_close', m: 20, dist: 38, high: 26 },
  { name: '0740_commute', m: 462, dist: 110, high: 70 },
  { name: '1240_cafe', m: 755, dist: 70, high: 46 },
  { name: '2200_living', m: 1320, dist: 70, high: 48 },
];
for (const s of shots) {
  const info = await p.evaluate((o) => {
    const C = window.__clock, D = window.__dayMotion;
    C.setPlaying(false); C.seek(o.m);
    window.__frame(0, 3);
    const q = D.at('mark', o.m);
    const cam = window.__camera, ctl = window.__controls;
    cam.position.set(q.x + o.dist * 0.72, q.y + o.high, q.z + o.dist * 0.82);
    if (ctl) { ctl.target.set(q.x, q.y, q.z); ctl.update(); }
    window.__frame(0, 2);
    return { place: q.place, floor: q.floor, clip: q.clip,
      x: Math.round(q.x), y: Math.round(q.y), z: Math.round(q.z) };
  }, s);
  const data = await p.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
  const f = `${DIR}/${s.name}.png`;
  writeFileSync(f, Buffer.from(data.split(',')[1], 'base64'));
  console.log('[shot]', f, JSON.stringify(info));
}
await b.close();
