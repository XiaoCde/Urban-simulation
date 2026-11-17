/** 通用截图：node _shot_wide.mjs <out.png> <minute> [x z h dist] [query] */
import puppeteer from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const [,, out='out/w.png', minute='0', cx='', cz='', hh='', dd='', qs=''] = process.argv;
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 1200, height: 720 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
p.on('console', (m) => { if (m.type()==='error') console.log('ERR', m.text()); });
const u = new URL('http://127.0.0.1:8140/index.html' + (qs ? (qs.startsWith('?')?qs:'?'+qs) : ''));
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });
await p.evaluate((m, x, z, h, d) => {
  const C = window.__clock; C.setPlaying(false); C.seek(m);
  if (x !== '') {
    const cam = window.__camera, ctl = window.__controls;
    cam.position.set(Number(x) + Number(d) * 0.6, Number(h), Number(z) + Number(d) * 0.8);
    if (ctl) { ctl.target.set(Number(x), 0, Number(z)); ctl.update(); }
  }
}, minute, cx, cz, hh, dd);
await new Promise((r) => setTimeout(r, 1200));
await p.evaluate(() => window.__frame(1/30, 6));
const data = await p.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'));
console.log('[shot]', out);
await b.close();
