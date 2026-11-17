/** 密集采样小女孩 15:00–15:20 的轨迹，判断折返是路径锯齿还是碰撞推出。 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await b.newPage();
await p.setViewport({ width: 900, height: 560 });
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
const R = await p.evaluate(() => {
  const D = window.__dayMotion;
  const out = [];
  for (let m = 900; m <= 922; m += 0.25) {
    const q = D.at('girl', m);
    if (!q || q.crisis) continue;
    out.push({ m: +m.toFixed(2), x: +q.x.toFixed(2), z: +q.z.toFixed(2),
      y: +q.y.toFixed(1), clip: q.clip, moving: q.moving, floor: q.floor,
      indoor: q.indoor, seg: `${q.a}-${q.b}`, place: q.place });
  }
  return out;
});
console.log('分钟      x        z      y   clip   moving floor indoor place');
for (const q of R) console.log(
  `${String(q.m).padStart(7)} ${String(q.x).padStart(9)} ${String(q.z).padStart(9)} ${String(q.y).padStart(5)}`,
  `${String(q.clip).padEnd(6)} ${String(q.moving).padEnd(6)} ${String(q.floor).padEnd(5)}`,
  `${String(q.indoor).padEnd(6)} ${q.place}`);
await b.close();
