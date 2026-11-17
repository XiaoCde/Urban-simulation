/**
 * _check_final.mjs — 最终快速复核（只读，不改产品代码）。
 * 专查三件 20h 探针口径说不清的事：
 *  1 可见范围内的人拖完时间轴会不会消失（hidden 是不是纯距离裁剪）；
 *  2 车辆认领最大跳跃距离（不得跨城瞬移）；
 *  3 时钟 / 积水 / 判断 / 动作在倍率下同层。
 * 用法：node _check_final.mjs [people=300]
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
if (!CHROME) throw new Error('找不到 Chrome / Edge');
const N = Number(process.argv[2] || 300);
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

const r = await p.evaluate(() => {
  window.__manualDrive = true;
  const C = window.__clock, PED = window.__ped, F = window.__flood;
  const T = window.__traffic ? window.__traffic() : null;
  const CAM = window.__camera;
  const visCount = () => PED.peds.filter((q) => q.visible !== false && q.obj.visible !== false).length;
  const hiddenFar = () => PED.peds.filter((q) => (q.visible === false || q.obj.visible === false)
    && (q.dist || 0) > 360).length;

  // 把相机放到第 0 个人附近，造出一批真正可见的人
  const q0 = PED.peds[0];
  CAM.position.set(q0.obj.position.x + 25, q0.obj.position.y + 30, q0.obj.position.z + 25);
  if (window.__controls) { window.__controls.target.set(q0.obj.position.x, q0.obj.position.y, q0.obj.position.z); window.__controls.update(); }
  C.setPlaying(true); C.setSpeed(24);
  window.__frame(0.05, 20, true);
  const before = { minute: +C.minute.toFixed(2), visible: visCount(), hiddenFar: hiddenFar(),
    hiddenAll: PED.peds.length - visCount() };

  // 拖到 12:00
  C.seek(720);
  const atSeek = { minute: +C.minute.toFixed(2), visible: visCount(), hiddenFar: hiddenFar(),
    hiddenAll: PED.peds.length - visCount(), simSec: PED.live.stats().simSec };
  window.__frame(0.05, 10, true);
  const after10 = { minute: +C.minute.toFixed(2), visible: visCount(), hiddenFar: hiddenFar(),
    hiddenAll: PED.peds.length - visCount(), simSec: PED.live.stats().simSec };

  // 连续跑：从 6:00 到 9:00（覆盖出门上班/上学的通勤窗口，才有认领车）
  C.seek(360);
  const drv0 = PED.drive ? PED.drive.stats().driveChosen : 0;
  let maxJump = 0, claimSeen = 0, tOver1 = 0, yieldingBg = 0, yieldingOwner = 0;
  for (let k = 0; k < 9000; k++) {
    window.__frame(0.05, 1, true);
    if (k % 20 === 0 && T) for (const c of T.cars) {
      if (Number.isFinite(c.claimJump)) { claimSeen++; maxJump = Math.max(maxJump, c.claimJump); }
      if (c.t > 1 || c.t < 0) tOver1++;
      if (c.yielding) { if (c.owner !== null) yieldingOwner++; else yieldingBg++; }
    }
  }
  const live = PED.live.stats();
  return {
    claimRadius: window.__traffic ? 500 : null,
    visibleSeek: { before, atSeek, after10 },
    cars: { maxJump: +maxJump.toFixed(1), claimFieldSamples: claimSeen,
      driveChosen: (PED.drive ? PED.drive.stats().driveChosen : 0) - drv0,
      arrivals: PED.drive ? PED.drive.stats().arrivals : 0,
      tOutOfRange: tOver1, yieldingBg, yieldingOwner },
    final: { minute: +C.minute.toFixed(2), floodT: +F.tMin.toFixed(2),
      judged: live.judged, simSec: live.simSec, goHome: live.goHome || 0,
      speed: PED.fullStats().speed },
  };
});

console.log('\n===== 最终快速复核 =====');
console.log('可见性（相机贴近人群）', JSON.stringify(r.visibleSeek, null, 2));
console.log('车辆', JSON.stringify(r.cars, null, 2));
console.log('连续 2h 后', JSON.stringify(r.final, null, 2));
console.log('脚本错误', errs.length, errs.slice(0, 8));
await b.close();
if (errs.length) process.exitCode = 1;
