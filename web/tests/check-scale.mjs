/**
 * _check_scale.mjs — 页面默认 3000 人配置的回归检查。
 *
 * 24h 连续验收为了在 24× 下跑完，用的是 500 人；但用户打开页面默认是
 * 3000 人。这个脚本只加载 + 少量推帧，确认新架构（圈层 / 驾驶 / 伤亡 /
 * 速度真值 / 面板收敛）在 3000 人规模下也能正常装配、不扎堆、不悬空。
 *
 * 用法：node _check_scale.mjs [people=3000]
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const N = Number(process.argv[2] || 3000);
if (!CHROME) throw new Error('找不到 Chrome / Edge');

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 1000, height: 620 });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1');
u.searchParams.set('ped', String(N));
u.searchParams.set('v', String(Date.now()));
const t0 = Date.now();
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
await p.evaluate(() => { window.__manualDrive = true; });
const loadSec = +((Date.now() - t0) / 1000).toFixed(1);

const r = await p.evaluate(() => {
  const PED = window.__ped, C = window.__clock;
  const f = PED.fullStats();
  const grid = new Map();
  let indoor = 0, outdoor = 0, airborne = 0, driving = 0;
  for (const q of PED.peds) {
    const s = PED.crowdLife && PED.crowdLife.at
      ? PED.crowdLife.at(q.i, C.minute) : null;
    if (s && s.indoor) indoor++; else outdoor++;
    if (q.obj.position.y > 60) airborne++;
    if (q.inVehicle) driving++;
    const k = Math.floor(q.obj.position.x / 50) + '_' + Math.floor(q.obj.position.z / 50);
    grid.set(k, (grid.get(k) || 0) + 1);
  }
  const cells = [...grid.values()].sort((a, b) => b - a);
  return {
    people: PED.peds.length, minute: +C.minute.toFixed(2),
    indoor, outdoor, airborne, driving,
    gridCells: grid.size, densestCell: cells[0] || 0,
    top5: cells.slice(0, 5),
    circles: f.circles, speed: f.speed,
    incidents: { dead: f.incidents.dead, exposed: f.incidents.exposed },
    panelRows: document.querySelectorAll('#mkOthers .prow').length,
    traffic: window.__street ? window.__street.moving : null,
  };
});

// 少量连续推帧，确认 3000 人规模下子步循环不报错、决策确实在跑
await p.evaluate(() => { window.__clock.setPlaying(true); window.__clock.setSpeed(24);
  window.__frame(0.05, 120, true); });
const after = await p.evaluate(() => {
  const f = window.__ped.fullStats();
  return { minute: +window.__clock.minute.toFixed(2), judged: f.live.judged,
    simSec: f.live.simSec, speed: f.speed, incidents: f.incidents.dead };
});

console.log('\n===== ' + N + ' 人规模回归 =====');
console.log('加载耗时', loadSec, 's · 页面错误', errs.length, errs.slice(0, 8));
console.log(JSON.stringify(r, null, 2));
console.log('推 120 帧后', JSON.stringify(after));
await b.close();
if (errs.length) process.exitCode = 1;
