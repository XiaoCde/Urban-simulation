/** 对准某个具名角色截图：node _shot_person.mjs out.png key minute [dist] [up] */
import puppeteer from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const [, , out = 'out/p.png', key = 'boss', minute = '0', dist = '7', up = '2.2'] = process.argv;
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 900, height: 700 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });
const info = await p.evaluate(async (k, m, dd, uu) => {
  const C = window.__clock; C.setPlaying(false); C.seek(m);
  await new Promise((r) => setTimeout(r, 800));
  window.__frame(1 / 30, 4);
  const a = window.__people.actors.find((x) => x.key === k) || window.__people.actors[0];
  const pos = a.root.position.clone();
  const cam = window.__camera, ctl = window.__controls;
  cam.position.set(pos.x + Number(dd) * 0.8, pos.y + Number(uu), pos.z + Number(dd) * 0.6);
  if (ctl) { ctl.target.set(pos.x, pos.y + 1.0, pos.z); ctl.update(); }
  window.__frame(1 / 30, 3);
  return { key: a.key, pos: [Math.round(pos.x), +pos.y.toFixed(1), Math.round(pos.z)],
    clip: a.cur ? a.cur.getClip().name : null, seg: a.daySeg,
    tracks: a.cur ? a.cur.getClip().tracks.length : 0,
    dur: a.cur ? +a.cur.getClip().duration.toFixed(3) : 0 };
}, key, minute, dist, up);
await new Promise((r) => setTimeout(r, 400));
await p.evaluate(() => window.__frame(1 / 30, 3));
const data = await p.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'));
console.log(JSON.stringify(info), '->', out);
await b.close();
