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
  const C = window.__clock, PED = window.__ped;
  C.setPlaying(false); C.seek(600);
  let minD = 1e9, overlap = 0, frames = 0, moved = 0;
  const start = PED.peds.map((q) => [q.obj.position.x, q.obj.position.z]);
  for (let f = 0; f < 40; f++) {
    window.__frame(1 / 30, 1);
    if (f % 4) continue;
    frames++;
    const ps = PED.peds.filter((q) => q.obj.visible).map((q) => [q.obj.position.x, q.obj.position.z]);
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const d = Math.hypot(ps[i][0] - ps[j][0], ps[i][1] - ps[j][1]);
      if (d < minD) minD = d;
      if (d < 0.45) overlap++;
    }
  }
  PED.peds.forEach((q, i) => { if (Math.hypot(q.obj.position.x - start[i][0], q.obj.position.z - start[i][1]) > 0.5) moved++; });
  return { frames, minDist: +minD.toFixed(2), overlapPairs: overlap, moved, total: PED.peds.length };
});
console.log(JSON.stringify(r));
await b.close();
