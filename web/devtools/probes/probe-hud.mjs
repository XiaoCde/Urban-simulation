import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', protocolTimeout: 300000,
  args: ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 800, height: 500 });
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture','1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });
await p.evaluate(() => { window.__ready = false; });
for (const m of [20, 600, 760, 1260]) {
  const r = await p.evaluate((mm) => {
    window.__clock.setPlaying(false); window.__clock.seek(mm); window.__frame(0, 1);
    const D = window.__dayMotion;
    return D.keys.map((k) => { const q = D.at(k, mm); return [k, q.place, q.placeName, q.floor, q.spot]; });
  }, m);
  console.log('---', m, 'min');
  for (const x of r) console.log('  ', x.join(' | '));
}
await b.close();
