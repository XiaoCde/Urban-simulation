/** 全城市民冒烟探针：加载页面 → 看装配统计 / 页面错误 / 几帧真实位移。 */
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
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 180)); });
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
const R = await p.evaluate(() => {
  const C = window.__crowdLife, P = window.__ped;
  const d = C ? C.debug(720) : [];
  const xs = P ? P.peds ? P.peds.map((q) => q.obj.position.x) : [] : [];
  const zs = P ? P.peds ? P.peds.map((q) => q.obj.position.z) : [] : [];
  return {
    stats: C ? C.stats() : null,
    debugN: d.length,
    sample: d.slice(0, 6),
    pedCount: P && P.peds ? P.peds.length : (P && P.stats ? P.stats.count : null),
    xRange: xs.length ? [Math.min(...xs), Math.max(...xs)] : null,
    zRange: zs.length ? [Math.min(...zs), Math.max(...zs)] : null,
  };
});
console.log(JSON.stringify(R, null, 1));
console.log('页面错误', errs.length, errs.slice(0, 6));
await b.close();
