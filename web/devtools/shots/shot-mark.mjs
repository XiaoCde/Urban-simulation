import puppeteer from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const [, , out = 'out/mark.png', minute = '1095', dist = '18', up = '7'] = process.argv;
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 1000, height: 720 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html?ped=1');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });
const info = await p.evaluate(async (m, dd, uu) => {
  const C = window.__clock, M = window.__mark;
  C.setPlaying(false); C.seek(m);
  await new Promise((r) => setTimeout(r, 600));
  window.__frame(1 / 30, 5);
  const pos = M.story.position;
  const cam = window.__camera, ctl = window.__controls;
  cam.position.set(pos.x + Number(dd), pos.y + Number(uu), pos.z + Number(dd) * 0.75);
  if (ctl) { ctl.target.set(pos.x, pos.y + 0.9, pos.z); ctl.update(); }
  window.__frame(1 / 30, 3);
  return { st: M.story.state, pn: M.story.pathName,
    pos: [Math.round(pos.x), +pos.y.toFixed(1), Math.round(pos.z)] };
}, minute, dist, up);
await new Promise((r) => setTimeout(r, 300));
await p.evaluate(() => window.__frame(1 / 30, 3));
const data = await p.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'));
console.log(JSON.stringify(info), '->', out);
await b.close();
