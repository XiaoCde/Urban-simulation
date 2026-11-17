/**
 * _probe_bugs.mjs — 综合 bug 实测探针（只读，不改产品代码）。
 *
 * 用户 2026-11-13 提出的四类疑问：
 *  A 人是不是「全程随机穿梭在几万栋楼里」，而不是最终到达某个门牌？
 *  B 汽车避让 / 自由行 / 逆行 / 闯红灯 是不是真的？
 *  C 走路姿态（clip、朝向、零位移）跟真实决策和位移对不对得上？
 *  D 时间轴 seek / 倍率的连续性与状态残留。
 *
 * 做法：真实连续推帧（不 seek），逐帧采样真实对象状态，全部数字由运行时算出。
 * 用法：node _probe_bugs.mjs [people=400] [hours=6]
 */
import puppeteer from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';

const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
if (!CHROME) throw new Error('找不到 Chrome / Edge');
const N = Number(process.argv[2] || 400);
const HOURS = Number(process.argv[3] || 6);

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  protocolTimeout: 1800000,
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
console.log('load', ((Date.now() - t0) / 1000).toFixed(1) + 's');

// ---------------------------------------------------------------- 阶段 1：连续跑
const R = await p.evaluate((hours) => {
  window.__manualDrive = true;   // 整段只由 __frame 驱动，关掉 capture 定时器插帧
  const C = window.__clock, PED = window.__ped, F = window.__flood;
  const T = window.__traffic ? window.__traffic() : null;
  const S = window.__solids;
  const peds = PED.peds, live = PED.live;
  const DT = 0.05, SPEED = 24, SIM_DT = DT * SPEED; // 每个 __frame 推进 1.2 仿真秒
  C.setPlaying(true); C.setSpeed(SPEED);
  const totalFrames = Math.ceil(hours * 3600 / (DT * SPEED));
  const sampleEvery = Math.max(1, Math.round(30 * 60 / (DT * SPEED))); // 每 30 仿真分钟一次

  const acc = {
    people: peds.length, totalFrames, sampleEvery,
    solids: S && S.stats ? S.stats() : null,
    samples: [],
    pose: { frames: 0, zeroMoveWalk: 0, zeroMoveRun: 0, backward: 0,
      clipSlowRun: 0, clipFastWalk: 0, movedSum: 0, clipNames: {} },
    car: { samples: 0, dirNeg: 0, tOver1: 0, tUnder0: 0, waitGE3_2: 0,
      waitingRed: 0, yieldingOwner: 0, yieldingBg: 0, parked: 0, claimed: 0,
      inBuilding: 0, dirFlips: 0, edgeChanges: 0, noRedWhenShould: 0,
      maxWait: 0,       redRan: 0, pedNearNonzero: 0, pedNearOwnerOnly: 0,
      redBothGreen: 0, maxClaimJump: 0 },
    wander: {},
  };
  // 追踪 60 个人的轨迹：累计路程 / 净位移 / 无目标时长
  const trackN = Math.min(60, peds.length);
  const track = [];
  for (let i = 0; i < trackN; i++) {
    const q = peds[i];
    track.push({ i, x0: q.obj.position.x, z0: q.obj.position.z,
      px: q.obj.position.x, pz: q.obj.position.z,
      path: 0, noGoalPath: 0, noGoalFrames: 0, inBuildingFrames: 0,
      goalFrames: 0, atDestFrames: 0, indoorFrames: 0 });
  }

  const prevCarDir = T ? T.cars.map((c) => c.dir) : [];
  const prevCarEdge = T ? T.cars.map((c) => c.e) : [];

  function sample(minute) {
    const qOf = (i) => (PED.crowdLife && PED.crowdLife.at) ? PED.crowdLife.at(i, minute) : null;
    const s = {
      minute: +minute.toFixed(2), floodT: +(F.tMin || 0).toFixed(2),
      outdoorInBuilding: 0, noGoalOutdoor: 0, noGoalIndoor: 0,
      noGoalOutdoorMoving: 0, atDest: 0, farFromDest: 0,
      arrivedNotIndoor: 0, indoor: 0, outdoor: 0,
      homeHold: 0, waitingHome: 0, buildingPushMax: 0,
      modes: {}, goalStates: {}, distToDest: [],
    };
    for (const q of peds) {
      const i = q.i, cq = qOf(i);
      const indoor = !!(cq && cq.indoor);
      if (indoor) s.indoor++; else s.outdoor++;
      const hit = S && S.hit ? !!S.hit(q.obj.position.x, q.obj.position.z, -1.0) : false;
      if (!indoor && hit) s.outdoorInBuilding++;
      s.modes[q.mode || 'null'] = (s.modes[q.mode || 'null'] || 0) + 1;
      const a = live.agent(i);
      const g = a && a.plan ? a.plan.active() : null;
      if (a && a.holdPlace) s.homeHold++;
      if (!g && q.mode === 'route') s.waitingHome++;  // 正在走「回家等」的归位路线
      s.buildingPushMax = Math.max(s.buildingPushMax, q.buildingPush || 0);
      const cs = a && a.plan ? a.plan.counts() : null;
      if (cs) for (const k of Object.keys(cs)) s.goalStates[k] = (s.goalStates[k] || 0) + cs[k];
      if (!g) { if (indoor) s.noGoalIndoor++; else s.noGoalOutdoor++; }
      else {
        const d = g.dest ? Math.hypot(q.obj.position.x - g.dest.x, q.obj.position.z - g.dest.z) : Infinity;
        if (Number.isFinite(d)) s.distToDest.push(d);
        if (d <= 9) s.atDest++;
        if (d > 200) s.farFromDest++;
        if ((g.type === 'home' || g.type === 'work') && g.arrivedAt !== null && !indoor) s.arrivedNotIndoor++;
      }
    }
    s.distToDest.sort((x, y) => x - y);
    s.distMedian = s.distToDest.length ? +s.distToDest[(s.distToDest.length / 2) | 0].toFixed(1) : null;
    s.distMax = s.distToDest.length ? +s.distToDest[s.distToDest.length - 1].toFixed(1) : null;
    delete s.distToDest;
    acc.samples.push(s);

    if (T) {
      let dn = 0, over = 0, under = 0, w32 = 0, red = 0, yo = 0, yb = 0,
        pk = 0, cl = 0, ib = 0, flips = 0, ech = 0, mw = 0,
        ran = 0, pnz = 0, pno = 0;
      T.cars.forEach((c, k) => {
        if (c.dir < 0) dn++;
        if (c.t > 1) over++;
        if (c.t < 0) under++;
        if ((c.wait || 0) >= 3.2) { w32++; if (!c.waitingRed) ran++; }
        mw = Math.max(mw, c.wait || 0);
        if (c.waitingRed) red++;
        if ((c.pedNear || 0) > 0) { pnz++; if (c.owner !== null) pno++; }
        if (c.yielding) { if (c.owner !== null) yo++; else yb++; }
        if (c.parked) pk++;
        if ((c.claimJump || 0) > acc.car.maxClaimJump) acc.car.maxClaimJump = c.claimJump;
        if (c.owner !== null) cl++;
        if (c.dir !== prevCarDir[k]) flips++;
        if (c.e !== prevCarEdge[k]) ech++;
        prevCarDir[k] = c.dir; prevCarEdge[k] = c.e;
        let cx = 0, cz = 0;
        try {
          const P = new window.__THREE.Vector3();
          window.__roadnet().lanePoint(c.e, Math.min(1, Math.max(0, c.t)), c.dir, 2.0, P);
          cx = P.x; cz = P.z;
        } catch (e) { /* ignore */ }
        if (S && S.hit && S.hit(cx, cz, 0)) ib++;
      });
      acc.car.samples++;
      acc.car.dirNeg += dn; acc.car.tOver1 += over; acc.car.tUnder0 += under;
      acc.car.waitGE3_2 += w32; acc.car.waitingRed += red;
      acc.car.yieldingOwner += yo; acc.car.yieldingBg += yb;
      acc.car.parked += pk; acc.car.claimed += cl;
      acc.car.inBuilding += ib; acc.car.dirFlips += flips; acc.car.edgeChanges += ech;
      acc.car.maxWait = Math.max(acc.car.maxWait, mw);
      acc.car.redRan += ran; acc.car.pedNearNonzero += pnz; acc.car.pedNearOwnerOnly += pno;
    }
  }

  const frameXZ = new Float64Array(peds.length * 2);
  for (let f = 0; f < totalFrames; f++) {
    for (let i = 0; i < peds.length; i++) {
      frameXZ[i * 2] = peds[i].obj.position.x;
      frameXZ[i * 2 + 1] = peds[i].obj.position.z;
    }
    window.__frame(DT, 1, true);

    // 轨迹逐帧追踪（只 60 人，便宜）
    for (let i = 0; i < trackN; i++) {
      const q = peds[i], t = track[i];
      const dx = q.obj.position.x - frameXZ[i * 2];
      const dz = q.obj.position.z - frameXZ[i * 2 + 1];
      const moved = Math.hypot(dx, dz);
      t.path += moved;
      const a = live.agent(i);
      const g = a && a.plan ? a.plan.active() : null;
      const cq = (PED.crowdLife && PED.crowdLife.at) ? PED.crowdLife.at(i, C.minute) : null;
      if (cq && cq.indoor) t.indoorFrames++;
      if (!g) { t.noGoalFrames++; t.noGoalPath += moved; }
      else {
        t.goalFrames++;
        if (g.dest && Math.hypot(q.obj.position.x - g.dest.x, q.obj.position.z - g.dest.z) <= 9) t.atDestFrames++;
      }
      if (S && S.hit && S.hit(q.obj.position.x, q.obj.position.z, -1.0) && !(cq && cq.indoor)) t.inBuildingFrames++;
      t.px = q.obj.position.x; t.pz = q.obj.position.z;
    }
    // 姿态抽样：每 3 帧全量一次（抽样仍是「这一帧的位移 vs 这一帧的 clip」，
    // 不是累计三帧，口径不变），把探针自身的正则/取 clip 开销降 2/3。
    if (f % 3 === 0) {
      acc.pose.frames++;
      for (let i = 0; i < peds.length; i++) {
        const q = peds[i];
        if (q.inVehicle) continue;   // 车内人的位移是车的，不计入步行姿态统计
        const dx = q.obj.position.x - frameXZ[i * 2];
        const dz = q.obj.position.z - frameXZ[i * 2 + 1];
        const moved = Math.hypot(dx, dz);
        if (moved > 5) continue; // 一帧 1.2 仿真秒，>5 m 才算瞬移保护帧
        let name = '';
        try { name = q.cur && q.cur.getClip ? String(q.cur.getClip().name) : ''; } catch (e) { /* ignore */ }
        if (name) acc.pose.clipNames[name] = (acc.pose.clipNames[name] || 0) + 1;
        const walking = /walk|run/i.test(name);
        if (moved < 0.005 && walking) {
          if (/run/i.test(name)) acc.pose.zeroMoveRun++; else acc.pose.zeroMoveWalk++;
        }
        if (moved > 0.02 && walking) {
          const fx = Math.sin(q.yaw || 0), fz = Math.cos(q.yaw || 0);
          const dot = (dx * fx + dz * fz) / moved;
          if (dot < -0.3) acc.pose.backward++;
          const v = moved / SIM_DT;
          if (v > 2.1 && /walk/i.test(name) && !/run/i.test(name)) acc.pose.clipFastWalk++;
          if (v < 1.2 && /run/i.test(name)) acc.pose.clipSlowRun++;
        }
        acc.pose.movedSum += moved;
      }
    }
    if (f % sampleEvery === 0) sample(C.minute);
  }
  sample(C.minute);

  for (const t of track) {
    t.net = +Math.hypot(t.px - t.x0, t.pz - t.z0).toFixed(1);
    t.path = +t.path.toFixed(1); t.noGoalPath = +t.noGoalPath.toFixed(1);
  }
  acc.wander = {
    tracked: track.length,
    noGoalPathSum: +track.reduce((a, t) => a + t.noGoalPath, 0).toFixed(1),
    pathSum: +track.reduce((a, t) => a + t.path, 0).toFixed(1),
    noGoalFramesSum: track.reduce((a, t) => a + t.noGoalFrames, 0),
    indoorFramesSum: track.reduce((a, t) => a + t.indoorFrames, 0),
    atDestFramesSum: track.reduce((a, t) => a + t.atDestFrames, 0),
    inBuildingFramesSum: track.reduce((a, t) => a + t.inBuildingFrames, 0),
    top: track.slice().sort((a, b) => b.noGoalPath - a.noGoalPath).slice(0, 8),
  };
  acc.finalMinute = +C.minute.toFixed(2);
  acc.live = live.stats();
  return acc;
}, HOURS);

// ---------------------------------------------------------------- 阶段 2：时间轴连续性
const SEEK = await p.evaluate(() => {
  const C = window.__clock, PED = window.__ped, F = window.__flood;
  const T = window.__traffic ? window.__traffic() : null;
  const before = {
    minute: +C.minute.toFixed(3), floodT: +(F.tMin || 0).toFixed(3),
    simSec: PED.live.stats().simSec,
    modes: {}, holdT: 0, route: 0, liveClipT: 0, inVehicle: 0, justParked: 0,
    carClaimed: T ? T.cars.filter((c) => c.owner !== null).length : 0,
    carWaitGE3_2: T ? T.cars.filter((c) => (c.wait || 0) >= 3.2).length : 0,
    expWalked: PED.experience ? PED.experience.stats().walkedM : null,
    hidden: 0,
  };
  for (const q of PED.peds) {
    before.modes[q.mode || 'null'] = (before.modes[q.mode || 'null'] || 0) + 1;
    if (q.holdT > 0) before.holdT++;
    if (q.route) before.route++;
    if (q.liveClipT > 0) before.liveClipT++;
    if (q.inVehicle) before.inVehicle++;
    if (q.justParked) before.justParked++;
    if (q.visible === false || q.obj.visible === false) before.hidden++;
  }
  // seek 到 12:00
  C.seek(720);
  const atSeek = {
    minute: +C.minute.toFixed(3), floodT: +(F.tMin || 0).toFixed(3),
    simSec: PED.live.stats().simSec,
    holdT: 0, route: 0, liveClipT: 0, inVehicle: 0, justParked: 0,
    carClaimed: T ? T.cars.filter((c) => c.owner !== null).length : 0,
    carWaitGE3_2: T ? T.cars.filter((c) => (c.wait || 0) >= 3.2).length : 0,
    expWalked: PED.experience ? PED.experience.stats().walkedM : null,
    hidden: 0,
  };
  const x0 = PED.peds.map((q) => q.obj.position.x);
  const z0 = PED.peds.map((q) => q.obj.position.z);
  for (const q of PED.peds) {
    if (q.holdT > 0) atSeek.holdT++;
    if (q.route) atSeek.route++;
    if (q.liveClipT > 0) atSeek.liveClipT++;
    if (q.inVehicle) atSeek.inVehicle++;
    if (q.justParked) atSeek.justParked++;
  }
  window.__frame(0.05, 1, true);
  let maxMove = 0;
  for (let i = 0; i < PED.peds.length; i++) {
    const q = PED.peds[i];
    maxMove = Math.max(maxMove, Math.hypot(q.obj.position.x - x0[i], q.obj.position.z - z0[i]));
    if (q.visible === false || q.obj.visible === false) atSeek.hidden++;
  }
  atSeek.maxMoveFirstFrame = +maxMove.toFixed(2);
  // 再跑 10 帧：看隐藏的人能不能自己恢复（不恢复 = 拖完时间轴全城消失）
  window.__frame(0.05, 10, true);
  let hiddenAfter10 = 0;
  for (const q of PED.peds) if (q.visible === false || q.obj.visible === false) hiddenAfter10++;
  atSeek.hiddenAfter10Frames = hiddenAfter10;
  atSeek.simSecAfter10 = PED.live.stats().simSec;
  atSeek.expWalkedAfter10 = PED.experience ? PED.experience.stats().walkedM : null;
  return { before, atSeek };
});

// ---------------------------------------------------------------- 阶段 3：倍率同层
const SCALE = await p.evaluate(() => {
  const C = window.__clock, PED = window.__ped, F = window.__flood;
  const run = (sp) => {
    C.seek(0); C.setPlaying(true); C.setSpeed(sp);
    const m0 = C.minute, f0 = F.tMin, s0 = PED.live.stats().simSec;
    window.__frame(0.05, 300, true);
    return { minuteDelta: +(C.minute - m0).toFixed(3),
      floodDelta: +(F.tMin - f0).toFixed(3),
      simSecDelta: +(PED.live.stats().simSec - s0).toFixed(2),
      judged: PED.live.stats().judged };
  };
  const a = run(1), b = run(24);
  return { x1: a, x24: b,
    minuteRatio: +(b.minuteDelta / (a.minuteDelta || 1)).toFixed(2),
    floodRatio: +(b.floodDelta / (a.floodDelta || 1)).toFixed(2),
    simSecRatio: +(b.simSecDelta / (a.simSecDelta || 1)).toFixed(2) };
});

const out = { errors: errs, run: R, seek: SEEK, scale: SCALE };
writeFileSync('out/_probe_bugs.json', JSON.stringify(out, null, 2));

// ---------------------------------------------------------------- 输出摘要
const f = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v));
console.log('\n===== A 行人：随机漫游 / 目的地 / 穿楼 =====');
console.log('建筑可见实体', JSON.stringify(R.solids), '· 人数', R.people, '· 帧数', f(R.totalFrames));
console.log('样本（每 30 分钟）:');
for (const s of R.samples) {
  console.log(`  ${String(s.minute).padStart(7)}分 水${String(s.floodT).padStart(7)} 室内${String(s.indoor).padStart(4)} 室外${String(s.outdoor).padStart(4)}` +
    ` | 室外却在楼内 ${String(s.outdoorInBuilding).padStart(4)}` +
    ` | 无目标(室外/室内) ${s.noGoalOutdoor}/${s.noGoalIndoor}` +
    ` | 到点 ${String(s.atDest).padStart(4)} 距目标中位 ${s.distMedian} 最远 ${s.distMax}` +
    `     | 已到家却不在室内 ${s.arrivedNotIndoor}` +
    ` | 归位在家 ${s.homeHold} 归位途中 ${s.waitingHome} 推楼累计 ${s.buildingPushMax}` +
    ` | 目标态 ${JSON.stringify(s.goalStates)}`);
}
console.log('轨迹追踪', JSON.stringify(R.wander, null, 2));
console.log('\n===== B 车辆 =====');
console.log(JSON.stringify(R.car, null, 2));
console.log('\n===== C 姿态 =====');
console.log(JSON.stringify(R.pose, null, 2));
console.log('\n===== D 时间轴 / 倍率 =====');
console.log('seek 前', JSON.stringify(SEEK.before));
console.log('seek 后', JSON.stringify(SEEK.atSeek));
console.log('倍率', JSON.stringify(SCALE));
console.log('\n脚本错误', errs.length, errs.slice(0, 10));
console.log('完整数据 out/_probe_bugs.json');
await b.close();
