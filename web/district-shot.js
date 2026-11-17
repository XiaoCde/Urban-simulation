#!/usr/bin/env node
/** 多人物场景截图与状态探针：node district-shot.js <png> [tMin] [view] [who] [W] [H] */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const candidates = [
  'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) throw new Error('找不到 Chrome/Edge');
const out = process.argv[2] || '_district.png';
const t = Number(process.argv[3] || 60);
const view = process.argv[4] || 'follow';
const who = process.argv[5] || 'mark';
const W = Number(process.argv[6] || 1400), H = Number(process.argv[7] || 900);

const browser = await puppeteer.launch({
  executablePath, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', `--window-size=${W},${H}`],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));
await page.goto(`http://127.0.0.1:8123/district.html?play=0&t=${t}&view=${view}&who=${who}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 400 });
await new Promise((r) => setTimeout(r, 2600));
const all = await page.evaluate(() => window.__districtAll());
await page.screenshot({ path: out, type: 'png' });
console.log(`[district-shot] ${out} ${W}x${H} t=${t} who=${who}`);
console.log(JSON.stringify(all, null, 1));
const bad = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]') || l.startsWith('[reqfail]'));
console.log(`[district-shot] console=${logs.length} errors=${bad.length}`);
for (const l of [...bad, ...logs].slice(0, 40)) console.log(l);
await browser.close();
