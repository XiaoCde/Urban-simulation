#!/usr/bin/env node
/**
 * 积水叠层截图：开 F → 指定帧 → 出图。验收用。
 * 用法: node _fshot.mjs <输出png> <帧号> [宽度] [高度] [机位] [等待秒]
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
  .find((p) => existsSync(p));
const out = process.argv[2] || '_flood.png';
const FRAME = Number(process.argv[3] || 0);
const W = Number(process.argv[4] || 1600);
const H = Number(process.argv[5] || 900);
const VIEW = process.argv[6] || 'city';
const WAIT = Number(process.argv[7] || 2);

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

await page.goto('http://127.0.0.1:8123/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 180000, polling: 300 });
await page.waitForFunction(() => !!window.__flood, { timeout: 60000, polling: 300 });

// 机位：普通预设名，或 at:x,z（把镜头摆到某个坐标上空 110 m，俯 35°）
await page.evaluate((v) => {
  if (v.startsWith('at:')) {
    const parts = v.slice(3).split(',').map(Number);
    const [x, z, hh] = [parts[0], parts[1], parts[2] || 110];
    const c = window.__camera, t = window.__controls;
    const y = window.__terrain().sampleHeight(x, z);
    c.position.set(x - hh * 0.8, y + hh, z + hh * 1.1);
    t.target.set(x, y + 6, z);
    t.update();
  } else if (window.__setView) window.__setView(v);
}, VIEW);
await page.evaluate(() => { window.__flood.setVisible(true); });
await page.evaluate((i) => window.__flood.showFrame(i), FRAME);
await new Promise((r) => setTimeout(r, WAIT * 1000));
const info = await page.evaluate(() => ({
  frames: window.__flood.frames, idx: window.__flood.index,
  stat: document.getElementById('stat')?.textContent || '',
  label: document.getElementById('flTime')?.textContent || '',
}));
await page.screenshot({ path: out, type: 'png' });
console.log(`[fshot] ${out} ${W}x${H} frame=${info.idx}/${info.frames} ${info.label}`);
console.log(`[fshot] HUD: ${info.stat}`);
for (const l of logs.slice(0, 25)) console.log('  ' + l);
await browser.close();
