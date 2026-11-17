#!/usr/bin/env node
/**
 * shot_page.mjs — 通用页面截图（等 window.__ready，再把 __stats 打出来）
 * 用法: node shot_page.mjs <url> <out.png> [w] [h] [waitSec] [zoomOut]
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
  .find((p) => existsSync(p));
const URL = process.argv[2] || 'http://127.0.0.1:8123/megakit.html';
const OUT = process.argv[3] || 'out/megakit.png';
const W = Number(process.argv[4] || 1600);
const H = Number(process.argv[5] || 900);
const WAIT = Number(process.argv[6] || 2.5);
const VIEW = process.argv[7] || '';   // 'at:x,z,h' 把镜头摆到某点上空

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-gl=angle',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars',
    `--window-size=${W},${H}`],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400) logs.push(`[http${r.status()}] ${r.url()}`); });

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
try {
  await page.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 300 });
} catch (e) {
  console.log('[shot] __ready 未置位，仍然截图');
}
if (VIEW.startsWith('at:')) {
  const q = VIEW.slice(3).split(',').map(Number);
  const [x, z, hh] = [q[0], q[1], q[2] || 120];
  await page.evaluate(([x, z, hh]) => {
    const c = window.__camera, t = window.__controls;
    if (!c || !t) return;
    const y = window.__terrain ? window.__terrain().sampleHeight(x, z) : 10;
    c.position.set(x - hh * 0.62, y + hh * 0.72, z + hh * 0.78);
    t.target.set(x, y + 8, z);
    t.update();
  }, [x, z, hh]);
}
await new Promise((r) => setTimeout(r, WAIT * 1000));
const st = await page.evaluate(() => ({ stats: window.__stats || null, mk: window.__megakit || null, search: location.search, ready: window.__ready === true }));
await page.screenshot({ path: OUT, type: 'png' });
console.log(`[shot] ${OUT} ${W}x${H}`);
if (st) console.log('[stats] ' + JSON.stringify(st));
for (const l of logs) if (/megakit|street|landmark|ped|ldt|error|Error|warn/i.test(l)) console.log('  ' + l);
await browser.close();
