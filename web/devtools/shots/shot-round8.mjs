import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
mkdirSync('../out/ui', { recursive: true });
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--window-size=1280,780'] });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 780 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture','1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
await p.evaluate(() => { window.__ready = false; });

async function canvas(name, fn) {
  await p.evaluate(fn);
  const data = await p.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
  writeFileSync(`../out/ui/${name}.png`, Buffer.from(data.split(',')[1], 'base64'));
  console.log('[shot]', name);
}

// 1) 7:00 厨房：人和餐桌/冰箱的相对位置（不穿模）
await canvas('08_kitchen_collide', () => {
  const C = window.__clock; C.setPlaying(false); C.seek(420);
  const sc = window.__life.group.children.find((c) => c.name === 'sc_home_kitchen');
  const cam = window.__camera, ctl = window.__controls;
  // 镜头进到房间里看（楼会被隐藏，但门框/家具/人都实心）
  cam.position.set(sc.position.x + 3.4, sc.position.y + 2.1, sc.position.z + 3.6);
  if (ctl) { ctl.target.set(sc.position.x, sc.position.y + 0.8, sc.position.z); ctl.update(); }
  window.__frame(0, 2);
});

// 2) 10:00 路口：车辆排队，前车后车有明显车距
await canvas('09_traffic_gap', () => {
  const C = window.__clock; C.setPlaying(false); C.seek(600);
  const cam = window.__camera, ctl = window.__controls;
  cam.position.set(2470 + 120 * 0.62, 78, -200 + 120 * 0.82);
  if (ctl) { ctl.target.set(2470, 3, -200); ctl.update(); }
  window.__frame(0, 6);
});
await b.close();
