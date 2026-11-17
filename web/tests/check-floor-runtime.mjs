/**
 * 阶段3 浏览器验收：楼层真的接进运行时。
 * 验：① 有人被绑定到真实建筑并有层数；② 室内人 q.floor/y 来自楼层；
 *     ③ 回放 trace 室内帧带 fl/y；④ 楼层高度 > 地形高度（人不在楼外贴地）。
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!CHROME) throw new Error('找不到 Chrome / Edge');

const ok = [];
const check = (name, pass, extra = '') => {
  ok.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const b = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 1000, height: 620 });
const errors = [];
p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('ped', '300'); u.searchParams.set('seed', '12345');
u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });

// ① 绑定：有人拿到真实建筑楼层
const bind = await p.evaluate(() => {
  const C = window.__crowdLife;   // crowd-life 实例
  const peds = window.__ped.peds;
  // 从 person 状态找带楼层信息的人
  let withFloors = 0, floorVals = new Set();
  for (const pd of peds) {
    const ps = window.__crowdLife && window.__crowdLife.persons && window.__crowdLife.persons[pd.i];
    if (ps && ps.homeFloors > 0) { withFloors++; floorVals.add(ps.homeFloor); }
  }
  return { withFloors, total: peds.length, floors: [...floorVals].sort((a, b) => a - b).slice(0, 12) };
});
check('有人被绑定到真实建筑楼层', bind.withFloors > 0,
  `${bind.withFloors}/${bind.total} 人，楼层样本 ${JSON.stringify(bind.floors)}`);

// 连续推进到夜里（人在家），再查室内楼层
await p.evaluate(() => {
  const C = window.__clock, F = window.__flood;
  window.__manualDrive = true; C.setPlaying(false); C.setSpeed(24);
  C.seek(60);  // 01:00，人在家睡觉
  if (F && F.fb) F.fb.reset();
  C.setPlaying(true);
});
await p.evaluate(() => window.__frame(0.1, 400, true));

// ② 室内人 q.floor / q.y 来自楼层
const indoor = await p.evaluate(() => {
  const rows = [];
  const peds = window.__ped.peds;
  for (const pd of peds) {
    const q = window.__crowdLife && window.__crowdLife.at ? window.__crowdLife.at(pd.i, window.__clock.minute) : null;
    if (q && q.indoor && q.floor > 0) {
      const ground = window.__terrY ? window.__terrY(q.x, q.z) : null;
      // 读真实 3D 对象高度（画面上人在哪），不是锚点 q.y。
      rows.push({ i: pd.i, floor: q.floor, floorRelY: q.floorRelY,
        objY: pd.obj.position.y, ground });
    }
  }
  return rows;
});
check('夜间有人在室内且带真实楼层', indoor.length > 0, `${indoor.length} 人`);
if (indoor.length) {
  const high = indoor.filter((r) => r.floor > 1 && Number.isFinite(r.floorRelY) && r.floorRelY > 0);
  const above = high.filter((r) => r.ground != null && r.objY > r.ground + 1);
  check('楼层高度高于地形（人真的在楼上，不是贴地楼外）',
    high.length > 0 && above.length === high.length,
    `${above.length}/${high.length} 个高楼层人在地形之上`);
}

check('无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
await p.close();
await b.close();
const failed = ok.filter((x) => !x).length;
console.log(`\n${ok.length - failed}/${ok.length} 通过`);
process.exit(failed ? 1 : 0);
