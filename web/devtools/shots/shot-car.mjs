import puppeteer from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const [, , out = 'out/car.png', idx = '3', minute = '1020'] = process.argv;
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 900, height: 620 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });
const info = await p.evaluate(async (i, m) => {
  const C = window.__clock; C.setPlaying(false); C.seek(m);
  await new Promise((r) => setTimeout(r, 800));
  window.__frame(1 / 30, 4);
  const TR = window.__traffic();
  const c = TR.cars[Number(i) % TR.cars.length];
  const uu = c.dir > 0 ? Math.min(1, c.t) : 1 - Math.min(1, c.t);
  const x = c.e.a.x + (c.e.b.x - c.e.a.x) * uu;
  const z = c.e.a.z + (c.e.b.z - c.e.a.z) * uu;
  const fx = (c.e.b.x - c.e.a.x) * (c.dir > 0 ? 1 : -1);
  const fz = (c.e.b.z - c.e.a.z) * (c.dir > 0 ? 1 : -1);
  const fl = Math.hypot(fx, fz) || 1;
  const cam = window.__camera, ctl = window.__controls;
  // 站在车「后面」看它：如果能看到车尾，说明朝向对；看到车侧 = 斜了 90°
  cam.position.set(x - fx / fl * 9, 2.6, z - fz / fl * 9);
  if (ctl) { ctl.target.set(x, 0.9, z); ctl.update(); }
  window.__frame(1 / 30, 3);
  return { pos: [Math.round(x), Math.round(z)], fwd: [+(fx / fl).toFixed(2), +(fz / fl).toFixed(2)] };
}, idx, minute);
await new Promise((r) => setTimeout(r, 300));
await p.evaluate(() => window.__frame(1 / 30, 3));
const data = await p.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'));
console.log(JSON.stringify(info), '->', out);
await b.close();
