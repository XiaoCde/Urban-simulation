/** 临时冒烟：验证 2026-11-13 的面板收敛 / 圈层 / 驾驶 / 伤亡 / 速度真值。 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const N = Number(process.argv[2] || 300);
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
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
await p.evaluate(() => { window.__manualDrive = true; });

const base = await p.evaluate(() => {
  const f = window.__ped.fullStats();
  const C = window.__clock;
  C.setPlaying(true); C.setSpeed(24);
  return {
    people: window.__ped.peds.length,
    clock: C.minute,
    speedAudit: f.speed,
    circles: f.circles,
    driving: f.driving,
    incidents: { dead: f.incidents.dead, safe: f.incidents.safe },
    panelRows: document.querySelectorAll('#mkOthers .prow').length,
    castKeys: window.__ped.circles.slice(0, 2).map((c) => c && c.id),
  };
});

// 连续推进 600 帧 ×1.2 仿真秒 = 12 分钟，看判断/经历是否真的在跑
await p.evaluate(() => window.__frame(0.05, 600, true));
const after = await p.evaluate(() => {
  const f = window.__ped.fullStats();
  return { minute: window.__clock.minute, judged: f.live.judged,
    simSec: f.live.simSec, actions: f.live.byAction,
    driving: f.driving, incidents: f.incidents };
});

// 跳到早高峰前，再连续跑一段，验证出行方式层 / 驾驶层真的被调用
const drive = await p.evaluate(() => {
  window.__clock.setPlaying(false);
  window.__clock.seek(395);
  window.__clock.setPlaying(true);
  window.__frame(0.05, 900, true);
  const f = window.__ped.fullStats();
  return { minute: window.__clock.minute, judged: f.live.judged,
    requests: f.driving.requests,
    driveChosen: f.driving.driveChosen, walkChosen: f.driving.walkChosen,
    active: f.driving.active, arrivals: f.driving.arrivals,
    byAction: f.driving.byAction, byLaw: f.driving.byLaw,
    speedViolations: f.driving.speedViolations,
    avgSpeedKmh: f.driving.avgSpeedKmh,
    incidents: { dead: f.incidents.dead, stranded: f.incidents.stranded,
      injured: f.incidents.injured, evacuated: f.incidents.evacuated,
      stalled: f.incidents.stalled, redLightWaits: f.incidents.redLightWaits,
      yields: f.incidents.yields, deathsByCause: f.incidents.deathsByCause },
    speedAudit: f.speed };
});

// 跳到暴雨峰值，连续跑 36 分钟，验证被困 / 伤亡 / 熄火真的由状态算出来
const storm = await p.evaluate(() => {
  window.__clock.setPlaying(false);
  window.__clock.seek(1060);
  window.__clock.setPlaying(true);
  window.__frame(0.05, 1800, true);
  const f = window.__ped.fullStats();
  return { minute: window.__clock.minute, judged: f.live.judged,
    incidents: { dead: f.incidents.dead, stranded: f.incidents.stranded,
      injured: f.incidents.injured, wading: f.incidents.wading,
      evacuated: f.incidents.evacuated, rescued: f.incidents.rescued,
      stalled: f.incidents.stalled, abandonedCar: f.incidents.abandonedCar,
      collision: f.incidents.collision, yields: f.incidents.yields,
      redLightWaits: f.incidents.redLightWaits,
      exposed: f.incidents.exposed, maxDepth: f.incidents.maxDepth,
      deathsByCause: f.incidents.deathsByCause,
      incidentsByType: f.incidents.incidentsByType },
    driving: { active: f.driving.active, stalls: f.driving.stalls,
      abandons: f.driving.abandons, arrivals: f.driving.arrivals } };
});

console.log('\n===== 冒烟结果 =====');
console.log('人数/起始分钟/面板行数', base.people, base.clock, base.panelRows);
console.log('速度自检', JSON.stringify(base.speedAudit));
console.log('圈层', JSON.stringify(base.circles));
console.log('连续 12 分钟', JSON.stringify({ minute: after.minute, judged: after.judged,
  simSec: after.simSec, actions: after.actions }));
console.log('早高峰驾驶', JSON.stringify(drive, null, 2));
console.log('暴雨 36 分钟', JSON.stringify(storm, null, 2));
console.log('脚本错误', errs.length, errs.slice(0, 12));
await b.close();
if (errs.length) process.exitCode = 1;
