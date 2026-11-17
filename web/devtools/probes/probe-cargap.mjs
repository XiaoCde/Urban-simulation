import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', protocolTimeout: 300000,
  args: ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 900, height: 560 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture','1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
await p.evaluate(() => { window.__ready = false; });
const r = await p.evaluate(() => {
  const C = window.__clock, T = window.__traffic();
  C.setPlaying(false); C.seek(600);
  let worst = 1e9, bad = 0, frames = 0;
  for (let f = 0; f < 40; f++) {
    window.__frame(1 / 30, 1);
    if (f % 4) continue;
    frames++;
    const groups = new Map();
    for (const c of T.cars) {
      const k = c.e.__k || (c.e.__k = Math.random());
      const key = k + '|' + c.dir;
      let arr = groups.get(key); if (!arr) groups.set(key, arr = []);
      arr.push(c);
    }
    for (const arr of groups.values()) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => a.t - b.t);
      for (let i = 0; i + 1 < arr.length; i++) {
        const L = Math.hypot(arr[i].e.b.x - arr[i].e.a.x, arr[i].e.b.z - arr[i].e.a.z) || 1;
        const gap = (arr[i + 1].t - arr[i].t) * L;
        if (gap < worst) worst = gap;
        if (gap < 4.0) bad++;
      }
    }
  }
  return { cars: T.cars.length, frames, worstGap: +worst.toFixed(2), overlapPairs: bad };
});
console.log(JSON.stringify(r));
await b.close();
