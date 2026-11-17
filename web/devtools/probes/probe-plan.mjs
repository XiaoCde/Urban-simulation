import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html?ped=1');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });
const out = await p.evaluate(async () => {
  const C = window.__clock, F = window.__flood;
  C.setPlaying(false); C.seek(1080);
  let t0 = performance.now();
  while (performance.now() - t0 < 20000 && F.frameIndex !== 4) await new Promise(r => setTimeout(r, 200));
  const man = F.manifest, g = F.depthGrid;
  let mx = 0, ami = 0;
  for (let i = 0; i < g.data.length; i++) if (g.data[i] > mx) { mx = g.data[i]; ami = i; }
  const c = ami % man.cols, r = (ami / man.cols) | 0;
  const x = man.x0 + (c + 0.5) * man.step_m, z = man.z0 + (r + 0.5) * man.step_m;
  const first = +F.depthAt(x, z, 1140).toFixed(3);      // f007 未下载
  await new Promise(r => setTimeout(r, 2500));          // 等后台补帧
  const second = +F.depthAt(x, z, 1140).toFixed(3);
  const third = +F.depthAt(x, z, 1100).toFixed(3);
  return { idx: F.frameIndex, at: [+x.toFixed(0), +z.toFixed(0)], first, second, third };
});
console.log(JSON.stringify(out));
await b.close();
