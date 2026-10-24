#!/usr/bin/env node
/**
 * 用**真实 GPU** 测帧率并截图（对比 shot.js 的 SwiftShader 软件渲染）。
 *
 * 区别：
 *   shot.js  → --use-angle=swiftshader  软件光栅化，慢但完全可复现，
 *              适合在无显卡的 CI 上出图；
 *   bench.js → 默认 backends           用本机真实 GPU，
 *              反映用户打开 Chrome 时看到的实际帧率。
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) { console.error('找不到 Chrome'); process.exit(1); }

const out = process.argv[2] || 'bench.png';
const W = Number(process.argv[3] || 1600);
const H = Number(process.argv[4] || 900);
const VIEW = process.argv[5] || 'south';

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: [
    '--no-sandbox',
    // 不指定 --use-angle，让 Chrome 自己挑硬件后端
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--hide-scrollbars',
    `--window-size=${W},${H}`,
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

const glInfo = [];
page.on('console', (m) => glInfo.push(m.text()));

await page.goto('http://127.0.0.1:8123/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(
  () => document.getElementById('loading')?.classList.contains('done'),
  { timeout: 120000, polling: 300 }
);

await page.evaluate((v) => { if (window.__setView) window.__setView(v); }, VIEW);

// 采样 3 秒的真实帧率
const fps = await page.evaluate(() => new Promise((resolve) => {
  let n = 0;
  const t0 = performance.now();
  function tick() {
    n++;
    if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
    else resolve(n / ((performance.now() - t0) / 1000));
  }
  requestAnimationFrame(tick);
}));

// 读取 GPU 信息
const gpu = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
});

const hud = await page.evaluate(() => document.getElementById('stat')?.textContent || '');
await page.screenshot({ path: out, type: 'png' });

console.log(`[bench] GPU: ${gpu}`);
console.log(`[bench] 实测帧率: ${fps.toFixed(1)} fps  (${W}x${H})`);
console.log(`[bench] HUD: ${hud}`);
console.log(`[bench] 截图: ${out}`);

await browser.close();
