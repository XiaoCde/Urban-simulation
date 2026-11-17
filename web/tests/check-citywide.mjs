/**
 * _check_citywide.mjs — 全城化专项复核（只读）
 *
 * 连续推帧覆盖早高峰，实测：
 *  ① 行驶中的车是否都有真实车主（owner != null && crew != null）
 *  ② 车「一顿一顿停」的频次（每车每百仿真秒的停车事件数）
 *  ③ 开车/到达次数、行驶轨迹覆盖的全城网格数
 *  ④ 全城路网/人/车/建筑的 500m 网格覆盖
 *
 * 用法：node _check_citywide.mjs [people=300]
 */
import puppeteer from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';

const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
if (!CHROME) throw new Error('找不到 Chrome / Edge');
const N = Number(process.argv[2] || 300);
const FRAMES = Number(process.argv[3] || 6000);

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  protocolTimeout: 900000,
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

const R = await p.evaluate((FRAMES) => {
  const C = window.__clock, PED = window.__ped, T = window.__traffic();
  const RN = window.__roadnet();
  C.setPlaying(true); C.setSpeed(24);
  C.seek(360);                       // 06:00 早高峰
  window.__frame(0.05, 2, true);
  const cars = T.cars;
  const prevV = cars.map(() => 0);
  const g = new Map();
  let frames = 0, movingFrames = 0, ghostMoving = 0, stops = 0, redWaits = 0,
    yields = 0, maxJump = 0, claimSamples = 0, movingMax = 0;
  const F = FRAMES;                 // 每帧 1.2 仿真秒（×24）
  for (let f = 0; f < F; f++) {
    window.__frame(0.05, 1, true);
    frames++;
    let mv = 0;
    for (let k = 0; k < cars.length; k++) {
      const c = cars[k];
      const v = c.parked ? 0 : (c.vLast || 0);
      if (v > 0.2) {
        mv++; movingFrames++;
        if (c.owner === null || !c.crew) ghostMoving++;
        if (Number.isFinite(c.claimJump)) {
          claimSamples++; maxJump = Math.max(maxJump, c.claimJump);
        }
        const a = c.e && c.e.a, q = c.e && c.e.b;
        if (a && q) {
          const x = a.x + (q.x - a.x) * Math.min(1, Math.max(0, c.t));
          const z = a.z + (q.z - a.z) * Math.min(1, Math.max(0, c.t));
          const key = Math.floor(x / 500) + '_' + Math.floor(z / 500);
          g.set(key, (g.get(key) || 0) + 1);
        }
      }
      if (prevV[k] > 0.5 && v === 0) stops++;
      prevV[k] = v;
      if (c.waitingRed) redWaits++;
      if (c.yielding) yields++;
    }
    movingMax = Math.max(movingMax, mv);
  }
  const fs = PED.fullStats();
  const d = fs.driving || {};
  const box = (arr, fx, fz) => {
    let a = Infinity, b = -Infinity, c = Infinity, e = -Infinity;
    for (const o of arr) { const x = fx(o), z = fz(o);
      a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, z); e = Math.max(e, z); }
    return [Math.round(a), Math.round(b), Math.round(c), Math.round(e)];
  };
  const zones = (arr, fx, fz) => {
    const s = new Set();
    for (const o of arr) s.add(Math.floor(fx(o) / 500) + '_' + Math.floor(fz(o) / 500));
    return s.size;
  };
  return {
    people: PED.peds.length, frames,
    minuteStart: 360, minuteEnd: +C.minute.toFixed(1),
    cars: cars.length,
    crew: T.crewStats ? T.crewStats() : null,
    movingFrames, ghostMoving, movingMax,
    stops, stopsPer100s: +(stops / (frames * 1.2 / 100)).toFixed(1),
    redWaits, yields,
    carTrackZones500: g.size, carTrackTop5: [...g.values()].sort((a, b) => b - a).slice(0, 5),
    claimSamples, maxClaimJump: +maxJump.toFixed(0),
    driving: { requests: d.requests, driveChosen: d.driveChosen,
      walkChosen: d.walkChosen, arrivals: d.arrivals, carKm: d.carKm,
      poolFull: d.poolFull, pickups: d.pickups },
    cityNet: window.__cityNet || null,
    roadBBox: box(RN.nodes, (n) => n.x, (n) => n.z),
    roadZones: zones(RN.nodes, (n) => n.x, (n) => n.z),
    pedZones: zones(PED.peds, (q) => q.obj.position.x, (q) => q.obj.position.z),
    carZones: zones(cars, (c) => (c.e.a.x + c.e.b.x) / 2, (c) => (c.e.a.z + c.e.b.z) / 2),
    speed: fs.speed,
  };
}, FRAMES);

console.log('\n===== 全城化专项复核 =====');
console.log('页面错误', errs.length, errs.slice(0, 8));
console.log(JSON.stringify(R, null, 2));
writeFileSync('out/_check_citywide.json', JSON.stringify(R, null, 2));
await b.close();
