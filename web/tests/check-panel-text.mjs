import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  protocolTimeout: 180000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 1200, height: 720 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });
await p.evaluate(() => { window.__ready = false; });
const out = await p.evaluate(() => ({
  rows: [...document.querySelectorAll('#mkOthers .prow')].map((r) => ({
    name: r.querySelector('.nm').textContent,
    state: r.querySelector('.st').textContent,
    go: r.querySelector('.go').textContent,
  })),
}));
console.log(JSON.stringify(out, null, 1));
const bad = out.rows.filter((r) => /\b(idle|walk|run|sit|look)\b/.test(r.state));
console.log(bad.length === 0 ? 'PASS 全列表中文动作' : 'FAIL 仍有技术名 ' + JSON.stringify(bad));
console.log('页面错误:', errs.length ? errs.join(' | ') : 'none');
try {
  await p.screenshot({ path: '../out/motion/round6_panel.jpg', type: 'jpeg',
    quality: 70, timeout: 90000, captureBeyondViewport: false });
  console.log('[shot] ../out/motion/round6_panel.jpg');
} catch (e) { console.log('[shot] skipped:', String(e.message).slice(0, 70)); }
await b.close();
