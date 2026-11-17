/** 灯网验收：shader 是否编译通过、全城灯网统计、白天/深夜/室内截图。 */
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
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
p.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || /Shader Error|THREE.WebGLProgram|GLSL/i.test(t)) errs.push(t.slice(0, 240));
});
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
await p.evaluate(() => { window.__ready = false; });

const shot = async (name) => {
  await p.screenshot({ path: `../out/ui/${name}.jpg`, type: 'jpeg', quality: 82,
    captureBeyondViewport: false, timeout: 200000 });
  console.log('[shot]', name);
};

const at = async (m, n = 3, setup = null) => {
  await p.evaluate(({ m, n, setupSrc }) => {
    const C = window.__clock;
    C.setPlaying(false); C.seek(m);
    window.__frame(0, n);
    if (setupSrc) (new Function(setupSrc))();
    window.__frame(0, 2);
  }, { m, n, setupSrc: setup });
  const s = await p.evaluate(() => ({
    grid: window.__lightGrid ? window.__lightGrid.stats() : null,
    points: (() => { let k = 0; window.__scene.traverse((o) => { if (o.isPointLight && o.visible) k++; }); return k; })(),
    night: window.__lightGrid ? window.__lightGrid.nightFactor(window.__clock.minute, 0) : null,
  }));
  console.log(`[${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}]`, JSON.stringify(s));
};

// 1) 正午全城
await at(720, 2, 'if (window.__mkview) window.__mkview();');
await shot('05_day_grid');

// 2) 傍晚 18:30 暴雨（提前开灯）
await at(1110, 2, 'if (window.__mkview) window.__mkview();');
await shot('06_dusk_grid');

// 3) 深夜 22:00 全城
await at(1320, 3, 'if (window.__mkview) window.__mkview();');
await shot('07_night_grid');

// 4) 深夜 00:30 跟拍马克（卧室室内灯）
await at(30, 3, `const el = document.querySelector('#mkOthers .prow[data-k="mark"]'); if (el) el.click();`);
await shot('08_night_bedroom');

// 5) 白天 12:30 跟拍咖啡馆（室内补光）
await at(760, 3, `const el = document.querySelector('#mkOthers .prow[data-k="woman"]'); if (el) el.click();`);
await shot('09_day_cafe_grid');

console.log('\n=== 错误 ===');
console.log(errs.length ? errs.slice(0, 8).join('\n') : '0 条（shader 全部编译通过）');
await b.close();
