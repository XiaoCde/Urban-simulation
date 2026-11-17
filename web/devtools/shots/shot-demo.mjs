/** 导师演示用的一组关键时刻截图：全天 8 帧，统一命名 demo_NN_*.jpg。 */
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
mkdirSync('../out/ui', { recursive: true });
const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--window-size=1600,960'],
});
const p = await b.newPage();
await p.setViewport({ width: 1600, height: 960 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
await p.evaluate(() => { window.__ready = false; window.__clock.setPlaying(false); });

const shot = async (name) => {
  try {
    await p.screenshot({ path: `../out/ui/${name}.jpg`, type: 'jpeg', quality: 84,
      captureBeyondViewport: false, timeout: 200000 });
    console.log('[shot]', name);
  } catch (e) { console.log('[shot] fail', name, String(e.message).slice(0, 70)); }
};

/** 统一机位切换：follow=null 走官方全城视角，follow=key 点名跟拍。 */
const at = async (minute, follow = null, name = '') => {
  await p.evaluate(({ minute, follow }) => {
    const C = window.__clock;
    C.seek(minute);
    window.__frame(0, 3);
    if (window.__setFollow) window.__setFollow(false);
    if (follow && window.__setFollow) window.__setFollow(true, follow);
    else if (window.__mkview) window.__mkview();
    window.__frame(0, 8);
  }, { minute, follow });
  await shot(name);
};

await at(20, 'mark', 'demo_01_0000_bedroom');       // 00:20 分房后的卧室
await at(455, 'mark', 'demo_02_0735_commute');      // 07:35 通勤车（不穿楼）
await at(720, null, 'demo_03_1200_city');           // 12:00 白天全城
await at(760, 'woman', 'demo_04_1240_cafe');        // 12:40 咖啡馆室内
await at(1075, null, 'demo_05_1755_crisis');       // 17:55 暴雨实时决策
await at(1100, 'mark', 'demo_06_1820_shelter');     // 18:20 避险待命
await at(1170, null, 'demo_07_1930_return');       // 19:30 绕积水返家
await at(1320, null, 'demo_08_2200_night');         // 22:00 夜景灯网

const info = await p.evaluate(() => ({
  solids: window.__solids.stats(),
  car: window.__dayMotion.carDebug(1100),
  page: document.title,
}));
console.log('统计:', JSON.stringify(info));
console.log('页面错误:', errs.length, errs.slice(0, 3).join(' | '));
await b.close();
