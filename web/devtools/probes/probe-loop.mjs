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
console.log(JSON.stringify(await p.evaluate(async () => {
  const C = window.__clock, F = window.__flood, fb = window.__fb;
  C.setPlaying(false);
  const out = {};
  // 退水段：延滞应该让这一格「水退得更慢」= 更深
  C.seek(1160);
  let t0 = performance.now();
  while (performance.now() - t0 < 20000 && F.frameIndex !== 7) await new Promise(r => setTimeout(r, 200));
  await new Promise(r => setTimeout(r, 300));
  const man = F.manifest, g = F.depthGrid;
  // 找一个 0.2~0.6 m 的中等积水格
  let pick = null, bestGrad = 0;
  for (let i = 0; i < g.data.length; i += 3) {
    const xx = man.x0 + (i % man.cols + 0.5) * 8, zz = man.z0 + (((i / man.cols) | 0) + 0.5) * 8;
    const a = F.depthAt(xx, zz, 1140), bb = F.depthAt(xx, zz, 1160);
    if (a > 0.3 && a < 1.6) {
      const gr = a - bb;              // 20 分钟退了多少
      if (gr > bestGrad) { bestGrad = gr; pick = i; }
    }
  }
  if (pick === null) return { err: 'no mid-depth cell' };
  const c = pick % man.cols, r = (pick / man.cols) | 0;
  const x = man.x0 + (c + 0.5) * 8, z = man.z0 + (r + 0.5) * 8;
  out.before = +F.depthAt(x, z, 1160).toFixed(3);
  out.grad20min = +bestGrad.toFixed(3);
  out.paintedBefore = F.repaint(true);
  // 40 人在这格里踩 10 分钟
  for (let k = 0; k < 3000; k++) {
    for (let i = 0; i < 40; i++) fb.wade(x + (i % 8) * 1.2, z + ((i / 8) | 0) * 1.2, 0.3, 0.2);
    fb.step(0.2);
  }
  out.stats = fb.stats();
  out.after = +F.depthAt(x, z, 1160).toFixed(3);
  out.paintedAfter = F.repaint(true);
  out.delta = +(out.after - out.before).toFixed(3);
  return out;
}), null, 1));
await b.close();
