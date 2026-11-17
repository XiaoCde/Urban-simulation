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
  C.setPlaying(false); C.seek(1100);
  let t0 = performance.now();
  while (performance.now() - t0 < 20000 && F.frameIndex !== 5) await new Promise(r => setTimeout(r, 200));
  const man = F.manifest;
  // 在一条湿带上撒 600 个格的人流负载
  for (let k = 0; k < 2000; k++) {
    for (let i = 0; i < 30; i++) {
      const x = 2200 + (k % 40) * 8 + (i % 6), z = -400 + ((k / 40) | 0) % 40 * 8 + ((i / 6) | 0);
      fb.wade(x, z, 0.3, 0.2);
    }
    fb.step(0.2);
  }
  const st = fb.stats();
  let painted = 0;
  const t1 = performance.now();
  for (let k = 0; k < 20; k++) painted = F.repaint(true);
  const ms = +((performance.now() - t1) / 20).toFixed(3);
  return { cells: st.cells, maxDelay: +st.maxDelay.toFixed(2), painted, repaint_ms: ms };
}), null, 1));
await b.close();
