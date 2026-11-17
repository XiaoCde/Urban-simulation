import puppeteer from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', protocolTimeout: 300000,
  args: ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 1100, height: 700 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture','1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });
await p.evaluate(() => { window.__ready = false; });
for (const [name, key, minute] of [['05_mark_office','mark',600], ['06_woman_cafe','woman',760]]) {
  const info = await p.evaluate((k, m) => {
    window.__clock.setPlaying(false); window.__clock.seek(m); window.__frame(0, 2);
    document.querySelector(`#mkOthers .prow[data-k="${k}"]`).click();
    window.__frame(0, 4);
    const h = window.__mark.hud();
    return { cam: window.__camera.position.toArray().map((v)=>+v.toFixed(1)),
      camPlace: window.__camPlace, cutN: window.__cutN, hud: h.placeName };
  }, key, minute);
  console.log(name, JSON.stringify(info));
  const data = await p.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
  writeFileSync(`../out/ui/${name}.png`, Buffer.from(data.split(',')[1], 'base64'));
}
await b.close();
