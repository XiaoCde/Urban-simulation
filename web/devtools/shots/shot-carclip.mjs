/** 交付图：早高峰跟拍马克的车（07:35 / 07:45 / 07:55）+ 俯视车与楼的位置关系。 */
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
mkdirSync('../out/ui', { recursive: true });
const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--window-size=1440,880'],
});
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 880 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
await p.evaluate(() => { window.__ready = false; });

const shot = async (name) => {
  try {
    await p.screenshot({ path: `../out/ui/${name}.jpg`, type: 'jpeg', quality: 82,
      captureBeyondViewport: false, timeout: 200000 });
    console.log('[shot]', name);
  } catch (e) { console.log('[shot] fail', name, String(e.message).slice(0, 80)); }
};

// 打开跟拍马克，并停在 07:35
await p.evaluate(() => {
  window.__clock.setPlaying(false);
  window.__clock.seek(455);
  window.__frame(0, 3);
  const row = document.querySelector('#mkOthers .prow[data-k="mark"]');
  if (row) row.click();
  window.__frame(0, 6);
});
await shot('10_car_0735');

for (const [m, name] of [[465, '11_car_0745'], [475, '12_car_0755'], [479, '13_car_0759']]) {
  await p.evaluate((mm) => {
    window.__clock.seek(mm);
    window.__frame(0, 8);
  }, m);
  await shot(name);
}

// 俯视：车与 FAA 办公楼 / 路面的位置关系（自由视角，强行摆机位）
await p.evaluate(() => {
  window.__clock.seek(475);
  window.__frame(0, 4);
  const c = window.__mark.car, cam = window.__camera, ctl = window.__controls;
  cam.position.set(c.position.x - 34, c.position.y + 62, c.position.z - 46);
  if (ctl) { ctl.target.set(c.position.x, c.position.y + 1, c.position.z); ctl.update(); }
  window.__frame(0, 3);
});
await shot('14_car_overhead');

// 车与公寓（出发楼）的关系
await p.evaluate(() => {
  window.__clock.seek(452);
  window.__frame(0, 4);
  const c = window.__mark.car, cam = window.__camera, ctl = window.__controls;
  cam.position.set(c.position.x - 30, c.position.y + 48, c.position.z - 40);
  if (ctl) { ctl.target.set(c.position.x, c.position.y, c.position.z); ctl.update(); }
  window.__frame(0, 3);
});
await shot('15_car_home');

const stat = await p.evaluate(() => ({
  solid: window.__solids.stats(),
  road: window.__solids.roadBlocking,
  car: window.__dayMotion.carAt(475),
}));
console.log('统计:', JSON.stringify(stat));
console.log('页面错误:', errs.length, errs.slice(0, 3).join(' | '));
await b.close();
