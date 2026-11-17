/** 交付用 UI 图：全城白天（含面板）、点人名跟拍（办公楼 6F）、夜里街景。 */
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
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
await p.evaluate(() => { window.__ready = false; });

const shot = async (name) => {
  try {
    await p.screenshot({ path: `../out/ui/${name}.jpg`, type: 'jpeg', quality: 80,
      captureBeyondViewport: false, timeout: 200000 });
    console.log('[shot]', name);
  } catch (e) { console.log('[shot] fail', name, String(e.message).slice(0, 60)); }
};

// 1) 白天全城 + 完整 UI
await p.evaluate(() => {
  const C = window.__clock; C.setPlaying(false); C.seek(600);
  window.__frame(0, 1);
  if (window.__mkview) window.__mkview();          // 官方街区视角：办公楼 + 公寓 + 咖啡馆都在画面里
  window.__frame(0, 3);
});
await shot('01_day_city');

// 2) 点“马克·陈”跟拍 → 办公楼 6F
await p.evaluate(() => {
  window.__clock.seek(600); window.__frame(0, 2);
  document.querySelector('#mkOthers .prow[data-k="mark"]').click();
  window.__frame(0, 4);
});
await shot('02_follow_mark');

// 3) 点“艾米·陈”跟拍 → 咖啡馆
await p.evaluate(() => {
  window.__clock.seek(760); window.__frame(0, 2);
  document.querySelector('#mkOthers .prow[data-k="woman"]').click();
  window.__frame(0, 4);
});
await shot('03_follow_cafe');

// 4) 夜里 22:00 全城（路灯 + 亮窗）
await p.evaluate(() => {
  document.querySelector('#mkOthers .prow[data-k="woman"]').click();   // 再点 = 自由视角
  const C = window.__clock; C.seek(1320);
  if (window.__mkview) window.__mkview();
  const cam = window.__camera, ctl = window.__controls;
  cam.position.multiplyScalar(1.28);
  if (ctl) ctl.update();
  window.__frame(0, 3);
});
await shot('04_night_city');

await b.close();
