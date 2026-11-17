import puppeteer from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const [, , out = 'out/ped.png', minute = '600', qs = ''] = process.argv;
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 900, height: 700 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html?ped=6' + (qs ? '&' + qs : ''));
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });
const info = await p.evaluate(async (m) => {
  const C = window.__clock; C.setPlaying(false); C.seek(m);
  await new Promise((r) => setTimeout(r, 900));
  window.__frame(1 / 30, 6);
  const P = window.__ped;
  const q = P.peds.filter((x) => x.enabled)[0] || P.peds[0];
  const pos = q.obj.position.clone();
  const cam = window.__camera, ctl = window.__controls;
  cam.position.set(pos.x + 4.2, pos.y + 1.9, pos.z + 3.2);
  if (ctl) { ctl.target.set(pos.x, pos.y + 0.95, pos.z); ctl.update(); }
  window.__frame(1 / 30, 3);
  return { clip: q.cur ? String(q.cur.getClip ? q.cur.getClip().name : q.cur) : null,
    mode: q.mode, pos: [Math.round(pos.x), +pos.y.toFixed(1), Math.round(pos.z)],
    tracks: q.cur && q.cur.getClip ? q.cur.getClip().tracks.length : 0,
    dur: q.cur && q.cur.getClip ? +q.cur.getClip().duration.toFixed(2) : 0 };
}, minute);
await new Promise((r) => setTimeout(r, 300));
await p.evaluate(() => window.__frame(1 / 30, 3));
const data = await p.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'));
console.log(JSON.stringify(info), '->', out);
await b.close();
