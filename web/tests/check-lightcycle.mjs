/** 灯网 24h 时刻表验收：逐小时拖时间轴，看开关曲线、亮窗率、光池数量。 */
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
p.on('pageerror', (e) => errs.push(e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
u.searchParams.set('seed', '20261117');
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
const R = await p.evaluate(() => {
  const G = window.__lightGrid, C = window.__clock;
  const rows = [];
  C.setPlaying(false);
  for (let h = 0; h < 24; h++) {
    const m = h * 60;
    C.seek(m);
    window.__frame(0, 1);
    const s = G.stats();
    rows.push({
      h: `${String(h).padStart(2, '0')}:00`,
      night: s.night, ratio: s.ratio,
      street: s.streetLights, indoor: s.indoorLights,
      quads: s.glowQuads, bulbs: s.emissiveMats,
    });
  }
  return { rows, errs: [] };
});
console.log('时刻   夜系数  亮窗率  路灯光池  室内灯池  光斑数');
for (const r of R.rows) {
  console.log(`${r.h}   ${r.night.toFixed(2)}    ${r.ratio.toFixed(2)}     ${r.street}        ${r.indoor}       ${r.quads}`);
}
const on = R.rows.filter((r) => r.night > 0.5).map((r) => r.h);
const off = R.rows.filter((r) => r.night < 0.05).map((r) => r.h);
console.log('\n全亮时段:', on.join(' '));
console.log('全灭时段:', off.join(' '));
console.log('页面错误:', errs.length, errs.slice(0, 2).join('|'));
await b.close();
