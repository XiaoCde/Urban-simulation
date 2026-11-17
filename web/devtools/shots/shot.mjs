/**
 * 自动验收截图（能反映运行时改动）。
 *
 * 背景：无头 Chrome + SwiftShader 环境里 requestAnimationFrame 完全不触发，
 * 普通 page.screenshot() 永远拿到首帧。这里用 ?capture=1 让页面改用定时器推帧、
 * 并打开 preserveDrawingBuffer，然后直接从 canvas 取图。
 *
 * 用法：node _shot.mjs <url> <out.png> [minute] [followKey] [frames]
 */
import puppeteer from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);

const url = process.argv[2] || 'http://127.0.0.1:8140/index.html';
const out = process.argv[3] || 'out/shot.png';
const minute = Number(process.argv[4] ?? 1050);
const follow = process.argv[5] || '';
const frames = Number(process.argv[6] ?? 6);
const width = Number(process.argv[7] ?? 1400);
const height = Number(process.argv[8] ?? 800);

const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await b.newPage();
await p.setViewport({ width, height });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));

const u = new URL(url);
u.searchParams.set('capture', '1');
u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 180000, polling: 300 });

await p.evaluate((m, f) => {
  if (window.__clock) window.__clock.seek(m);
  if (f && window.__setFollow) window.__setFollow(true, f);
}, minute, follow);
await new Promise((r) => setTimeout(r, 900));
await p.evaluate((n) => window.__frame(1 / 30, n), frames);
await new Promise((r) => setTimeout(r, 250));

const data = await p.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'));
console.log('[shot]', out, `${width}x${height}`, 'min', minute, follow || '(自由)');

await b.close();
