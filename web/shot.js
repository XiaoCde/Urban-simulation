#!/usr/bin/env node
/**
 * 无头截图 + 控制台错误捕获。
 *
 * 用途有两个：
 *   1. 验收（看画面对不对）
 *   2. 出片（离屏渲染，不依赖显卡实时）
 *
 * 用法:
 *   node shot.js <输出png> [宽度] [高度] [等待秒数] [相机预设]
 * 相机预设: south(默认) | north | aerial | closeup
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) { console.error('找不到 Chrome/Edge'); process.exit(1); }

const out = process.argv[2] || 'shot.png';
const W = Number(process.argv[3] || 1600);
const H = Number(process.argv[4] || 900);
const WAIT = Number(process.argv[5] || 6);
const VIEW = process.argv[6] || 'south';

// 相机预设的**唯一真源**是 src/main.js 里的 window.__setView()。
// 这里的表只作速查/文档，实际截图走 __setView(name)，改机位请改 main.js。
const PRESETS = {
  // 城市总览（默认，东南上空看整块 6×5.2 km）
  city:       { pos: [4312, 1900, 1371], target: [1712, 0, -1629] },
  mall:       { pos: [1258, 190, 1150],  target: [2600, 20, -300] },
  river:      { pos: [-560, 120, 620],   target: [900, 0, -600] },
  // 白宫近景一律从**西侧**看：东侧有 OSM 的 State Ballroom 在建工地大盒子
  whitehouse: { pos: [1036, 44, -693],   target: [1144, 20, -815] },
  south:      { pos: [1100, 26, -719],   target: [1144, 22, -815] },
  north:      { pos: [1128, 25, -901],   target: [1144, 23, -815] },
  aerial:     { pos: [1068, 82, -683],   target: [1144, 20, -809] },
  closeup:    { pos: [1160, 21, -775],   target: [1144, 22, -795] },
  portico:    { pos: [1144, 20, -769],   target: [1144, 21, -802] },
};

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',   // 无头环境用软件 GL，保证渲染一致
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    `--window-size=${W},${H}`,
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));

await page.goto('http://127.0.0.1:8123/', { waitUntil: 'domcontentloaded', timeout: 60000 });

// 等场景建好：main.js 在地形 + 建筑全部就位后才置 window.__ready = true
await page.waitForFunction(
  () => window.__ready === true,
  { timeout: 180000, polling: 300 }
);

// 切相机预设
await page.evaluate((v) => {
  if (window.__setView) window.__setView(v);
}, VIEW);

await new Promise((r) => setTimeout(r, WAIT * 1000));

const stat = await page.evaluate(() => document.getElementById('stat')?.textContent || '');
await page.screenshot({ path: out, type: 'png' });

console.log(`[shot] ${out}  ${W}x${H}  view=${VIEW}`);
console.log(`[shot] HUD: ${stat}`);
if (logs.length) {
  console.log(`[shot] 控制台 ${logs.length} 条:`);
  for (const l of logs.slice(0, 40)) console.log('  ' + l);
} else {
  console.log('[shot] 控制台干净，无报错');
}

await browser.close();
