import puppeteer from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const [,, out='out/at.png', minute='1100', cx='1143', cz='-2057', h='260', dist='420'] = process.argv;
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 1200, height: 720 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html?ped=1');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });
await p.evaluate((m, x, z, hh, dd) => {
  const C = window.__clock, F = window.__flood, cam = window.__camera, ctl = window.__controls;
  C.setPlaying(false); C.seek(m);
  cam.position.set(x + dd * 0.6, hh, z + dd * 0.8);
  if (ctl) { ctl.target.set(x, 0, z); ctl.update(); }
}, Number(minute), Number(cx), Number(cz), Number(h), Number(dist));
const t0 = Date.now();
while (Date.now() - t0 < 20000) {
  const ok = await p.evaluate((m) => window.__flood.frameIndex === 5, Number(minute));
  if (ok) break;
  await new Promise((r) => setTimeout(r, 300));
}
await p.evaluate(() => window.__frame(1 / 30, 6));
const data = await p.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'));
console.log('[shot]', out, await p.evaluate(() => JSON.stringify(window.__flood.__dbg())));
await b.close();
