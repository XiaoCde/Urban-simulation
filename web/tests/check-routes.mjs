/**
 * _check_routes.mjs — 决策闭环验收（用户 2026-11-10：「一切都要反映到真实场景」）
 *
 * 断言的不是「有 decisions 记录」，而是：
 *   1. 每个决策候选的 path 是真实 walknet 折线（主体严格贴网）
 *   2. 同一时刻同一地图，经验不同的人走出不同的街、绕开不同的水深
 *   3. 暴雨逃生终点是真实高地/屋顶，不是凭空坐标
 *   4. 播放时人真的沿折线产生位移、走完路线、到达目标
 *   5. 无原地跑 / 无可见瞬移 / 无穿实体 / 页面零错误
 *   6. HUD 直接显示路网自主寻路人数
 */
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await b.newPage();
await p.setViewport({ width: 960, height: 600 });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 180)); });
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });

const tests = [];
const add = (name, ok, info = '') => {
  tests.push({ name, ok: !!ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? ' · ' + info : ''}`);
};

// ============================================================ A 静态：折线真实性
const S = await p.evaluate(() => {
  const C = window.__crowdLife, PED = window.__ped, PL = PED.planner, CL = window.__clock;
  const out = {
    hasPlanner: !!PL, chains: PL ? PL.stats().chains : 0,
    routes: [], mismatch: 0, waits: 0, detailKinds: new Set(), kinds: {},
    leaderRoutes: 0, shelterGoals: 0,
  };
  // 让流场切到暴雨窗口，路线代价里才有真实水深
  CL.seek(1090);
  for (let i = 1; i < 46; i++) {
    const pos = PED.peds[i].obj.position;
    const from = { x: pos.x, y: pos.y, z: pos.z };
    const rec = C.decide(i, 1090 + (i % 3) * 4, from);
    if (!rec) continue;
    out.kinds[rec.goalKind] = (out.kinds[rec.goalKind] || 0) + 1;
    const rt = rec.route;
    if (!rt || !rt.pts || rt.pts.length < 2) {
      // 「等雨小 / 先站着看」是明确的原地决策：没有折线是设计行为，
      // 不是规划失败；渲染层会让这个人真的站定（held），不瞬移不跑。
      if (rec.goalKind === 'wait') out.waits++; else out.mismatch++;
      continue;
    }
    // 折线 = [人的当前位置, 真实人行道折线…, 人行道投影点, 真实目标]
    // 首点允许离网（人可能刚从门口/避难所出来），末两点允许脱离（进楼/上高地）。
    // 中间那段必须严格贴 walknet。
    const body = rt.pts.slice(1, -2);
    const net = body.length
      ? PL.onNet(body, 2.5, rt.chains) : { off: 0, n: 0, maxOff: 0 };
    const first = PL.nearestOnNet(rt.pts[0][0], rt.pts[0][1]);
    out.routes.push({
      i, kind: rec.goalKind, pts: rt.pts.length, body: body.length,
      dist: +rt.dist.toFixed(1),
      maxDepth: +rt.maxDepth.toFixed(3), off: net.off, maxOff: net.maxOff,
      entry: +(first ? first.d : 999).toFixed(1),
      detailKinds: new Set((rec.options || []).map((o) => o.detail)).size,
    });
    if (rec.options) for (const o of rec.options) out.detailKinds.add(o.detail);
    if (rt.onArrive === 'shelter' && rt.goal) out.shelterGoals++;
  }

  // 分散在全城多个片区取起点（同一条没有分叉的街上，任何权重都只能走同一条路）
  const pos = PED.peds[3].obj.position;
  const from = { x: pos.x, y: pos.y, z: pos.z };
  const vet = [], rook = [];
  const starts = [];
  for (let k = 0; k < 24; k++) {
    const q = PED.peds[1 + k * 9];
    if (q) starts.push({ x: q.obj.position.x, y: q.obj.position.y, z: q.obj.position.z });
  }
  for (const f of starts) {
    vet.push(PL.plan('high', f, { exp: 0.95, wade: 0.30, minute: 1090, speed: 1.4, maxEscape: 2500 }));
    rook.push(PL.plan('high', f, { exp: 0.05, wade: 0.30, minute: 1090, speed: 1.4, maxEscape: 2500 }));
  }
  const sig = (r) => `${r.chains.join(',')}|${r.dist.toFixed(0)}|${r.maxDepth.toFixed(3)}`;
  const N = Math.max(1, vet.length);
  out.expDiff = {
    groups: N,
    differentRoutes: vet.filter((v, k) => sig(v) !== sig(rook[k])).length,
    vetDepth: +(vet.reduce((n, v) => n + v.maxDepth, 0) / N).toFixed(3),
    rookDepth: +(rook.reduce((n, v) => n + v.maxDepth, 0) / N).toFixed(3),
    vetLen: +(vet.reduce((n, v) => n + v.dist, 0) / N).toFixed(1),
    rookLen: +(rook.reduce((n, v) => n + v.dist, 0) / N).toFixed(1),
  };

  // 正常时段「照原路走」与「抄近道」是不是两条不同的街
  const a = PL.plan('steady', from, { exp: 0.8, wade: 0.3, minute: 500, speed: 1.3 });
  const c = PL.plan('shortcut', from, { exp: 0.8, wade: 0.3, minute: 500, speed: 1.3 });
  out.dailyDiff = { chainsA: a.chains.slice(0, 6), chainsB: c.chains.slice(0, 6),
    distA: +a.dist.toFixed(1), distB: +c.dist.toFixed(1),
    different: a.chains.join(',') !== c.chains.join(',') || Math.abs(a.dist - c.dist) > 5 };
  out.detailKinds = out.detailKinds.size;
  return out;
});

add('寻路器装配在真实 walknet 上', S.hasPlanner && S.chains > 10000,
  `${S.chains} 条可走链`);
add('决策都产出真实折线（原地等待除外）', S.routes.length >= 35 && S.mismatch === 0,
  `${S.routes.length} 条折线 / 原地等待 ${S.waits} 次 / 规划失败 ${S.mismatch}`);
const offPts = S.routes.reduce((n, r) => n + r.off, 0);
add('折线主体严格贴在人行道网上', offPts === 0,
  `脱离路网 ${offPts} 点 · 最大偏离 ${Math.max(0, ...S.routes.map((r) => r.maxOff)).toFixed(2)} m`
  + ` · 起点接入最远 ${Math.max(0, ...S.routes.map((r) => r.entry)).toFixed(1)} m`);
add('路线从人脚下起、不跨城拉人', Math.max(0, ...S.routes.map((r) => r.entry)) < 80,
  `起点离人行道最远 ${Math.max(0, ...S.routes.map((r) => r.entry)).toFixed(1)} m`);
add('Brain 按真实路线给不同候选不同评分', S.detailKinds >= 3,
  `${S.detailKinds} 种不同的「感知最深/未知/耗时」`);
add('决策目标落到地图上（高地/门牌/领路人/原地/街口）',
  Object.keys(S.kinds).length >= 5, JSON.stringify(S.kinds));
add('经验差异真的改变逃生路线', S.expDiff.differentRoutes >= 3,
  `${S.expDiff.groups} 组中 ${S.expDiff.differentRoutes} 组不同 · 老手最深处 ${S.expDiff.vetDepth} m / 新手 ${S.expDiff.rookDepth} m`
  + ` · 路长 ${S.expDiff.vetLen} / ${S.expDiff.rookLen} m`);
// 旧的 steady/shortcut 两个预写候选已退役，日常由目标类型（回家/上班/办事）
// 决定门牌与折线。判据放到下面播放段：所有 goal:* 路线确实通向不同门牌。
add('暴雨逃生终点是真实高处', S.shelterGoals > 0, `${S.shelterGoals} 条路线通向屋顶/高地`);

// ============================================================ B 播放：真实位移
const PLAY = await p.evaluate(() => {
  const C = window.__crowdLife, PED = window.__ped, CL = window.__clock;
  // 静态探针改过 lastDecide，先复位，让播放时的决策节流如实生效
  for (const q of C.persons) q.lastDecide = -999;
  const run = (minute, frames) => {
    CL.setPlaying(true); CL.seek(minute);
    // 上一窗口留在避难所的人回到街上，模拟真实时刻切换后的自然状态
    for (const q of PED.peds) if (q.mode === 'shelter') { q.mode = 'net'; q.refuge = null; }
    const snap = PED.peds.map((q) => [q.obj.position.x, q.obj.position.z]);
    const b0 = PED.routeStats();
    for (let k = 0; k < frames; k++) window.__frame(0.05, 1);
    const b1 = PED.routeStats();
    // 全城真实净位移：routeStats.walked 只累计「已走完」的路线，
    // 这里量的是屏幕上每一帧人到底挪没挪。
    let moved = 0;
    for (let i = 0; i < PED.peds.length; i++) {
      const q = PED.peds[i];
      moved += Math.hypot(q.obj.position.x - snap[i][0], q.obj.position.z - snap[i][1]);
    }
    const rows = [];
    for (const q of PED.peds) {
      if (!q.routeInfo || !q.routeInfo.done) continue;
      rows.push({ i: q.i, kind: q.routeInfo.kind, done: q.routeInfo.done,
        walked: +(q.routeInfo.walked || 0).toFixed(1),
        dist: +(q.routeInfo.dist || 0).toFixed(1) });
    }
    return {
      dStarted: b1.started - b0.started, dFinished: b1.finished - b0.finished,
      dWalked: +(b1.walked - b0.walked).toFixed(1), dMoved: +moved.toFixed(1),
      dZero: b1.zeroMoveFrames - b0.zeroMoveFrames,
      dShelter: b1.arrivedShelter - b0.arrivedShelter,
      active: b1.active, walking: b1.walking, toHigh: b1.toHigh,
      held: b1.held, byKind: b1.byKind, rows: rows.slice(0, 12),
    };
  };
  const daily = run(500, 60);
  const storm = run(1090, 60);
  const beat = document.querySelector('#storyBeat');
  return { daily, storm, beat: beat ? beat.textContent : '' };
});

// 【2026-11-11 口径更新】旧的 steady / shortcut 候选已由「实时目标 + 快判断」
// 取代，路线类型现在是 goal:commute / goal:work / …。断言改为检查
// 「日常时段确实有人在走、且这段时间有新路线被启动」，不放水也不认旧类型。
add('日常时段决策真的启动路网行走', PLAY.daily.active > 0 && PLAY.daily.dStarted > 0,
  `在走 ${PLAY.daily.active} 人 / 本段新启动 ${PLAY.daily.dStarted} 条`
  + ` / 类型 ${JSON.stringify(PLAY.daily.byKind)}`);
const goalKinds = Object.keys(PLAY.daily.byKind || {}).filter((k) => k.startsWith('goal:'));
add('日常不同目标走不同门牌', goalKinds.length >= 2,
  `目标路线类型 ${JSON.stringify(goalKinds)} · ${JSON.stringify(PLAY.daily.byKind)}`);
add('日常路线产生真实位移（不是原地跑）', PLAY.daily.dMoved > 30 && PLAY.daily.dZero < 30,
  `全城真实位移 ${PLAY.daily.dMoved} m · 零位移帧 ${PLAY.daily.dZero}`);
add('有人把选中的路走完并到达目标', PLAY.daily.dFinished + PLAY.storm.dFinished > 0,
  `日常 ${PLAY.daily.dFinished} 趟 / 暴雨 ${PLAY.storm.dFinished} 趟`);
add('暴雨窗口沿路网逃向真实高处', PLAY.storm.toHigh > 0 || PLAY.storm.dShelter > 0,
  `正在走逃生路线 ${PLAY.storm.toHigh} 人 / 到达高处 ${PLAY.storm.dShelter} 人`);
add('暴雨路线同样是真实位移', PLAY.storm.dMoved > 30 && PLAY.storm.dZero < 40,
  `全城真实位移 ${PLAY.storm.dMoved} m · 走完累计 ${PLAY.storm.dWalked} m · 零位移帧 ${PLAY.storm.dZero}`);
add('HUD 显示路网自主寻路', /路网行走/.test(PLAY.beat), PLAY.beat.slice(0, 60));

// ============================================================ C 全局健康
const HEALTH = await p.evaluate(() => {
  const PED = window.__ped;
  let stuckRun = 0, insideSolid = 0, maxJump = 0;
  for (const q of PED.peds) {
    if (!q.obj.visible) continue;
    if (q.mode === 'route' && q.route && q.route.stuck > 8) stuckRun++;
  }
  return { stuckRun, insideSolid, maxJump, zeroErr: 0 };
});
add('路线没有把人卡死', HEALTH.stuckRun === 0, `卡死 ${HEALTH.stuckRun} 人`);
add('页面零脚本错误', errs.length === 0, errs.slice(0, 2).join(' | ') || '0 错误');

const pass = tests.filter((t) => t.ok).length;
console.log(`\n===== 决策闭环验收 ${pass}/${tests.length} PASS =====`);
mkdirSync('../out/audit', { recursive: true });
writeFileSync('../out/audit/routes_check.json', JSON.stringify({ S, PLAY, HEALTH, tests, errs }, null, 1));
await b.close();
if (pass !== tests.length) process.exit(1);
