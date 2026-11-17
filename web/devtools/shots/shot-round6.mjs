import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
mkdirSync('../out/motion', { recursive: true });
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  protocolTimeout: 300000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 1200, height: 720 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });
await p.evaluate(() => { window.__ready = false; });   // 停自动帧，全部手动推

async function canvasShot(name, m, x, z, dist, h) {
  await p.evaluate((a) => {
    const C = window.__clock, cam = window.__camera, ctl = window.__controls;
    C.setPlaying(false); C.seek(a.m); window.__frame(0, 2);
    cam.position.set(a.x + a.dist * 0.62, a.h, a.z + a.dist * 0.82);
    if (ctl) { ctl.target.set(a.x, 3, a.z); ctl.update(); }
    window.__frame(0, 2);
  }, { m, x, z, dist, h });
  const data = await p.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
  writeFileSync(`../out/motion/${name}.png`, Buffer.from(data.split(',')[1], 'base64'));
  console.log('[shot]', name);
}

// 0 点街景：整体提亮 + 路灯自发光灯头 + 相机附近真实点光源
await canvasShot('round6_night', 20, 2470, -200, 150, 60);
// 白天路口：三种车型的车头都应顺着车道
await canvasShot('round6_cars', 600, 2470, -200, 120, 78);
// DOM 面板（jpeg 更轻，失败也不影响前两张）
try {
  await p.screenshot({ path: '../out/motion/round6_panel.jpg', type: 'jpeg',
    quality: 68, timeout: 150000, captureBeyondViewport: false });
  console.log('[shot] round6_panel.jpg');
} catch (e) { console.log('[shot] panel skipped:', String(e.message).slice(0, 80)); }
await b.close();
