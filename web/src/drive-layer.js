/**
 * drive-layer.js — 分层决策里的「出行方式层 + 驾驶层」。
 *
 * 【2026-11-13 用户要求】「车你也可以给写进去嘛，就是人可以开车嘛，包括通勤啊，
 *  接孩子啊」「开车要涉及到左右道的问题，等红绿灯的问题，还有交管法，避让的问题」
 *  「你要把分层决策的那个，人物的那个决策要分的清清楚楚」。
 *
 * 分层边界（四层各管一件事，互不越权）：
 *   L1 慢层目标   goal.js      —— 今天要办哪几件事、几点、去哪个真实门牌；
 *                                social-circles 按「有学龄子女 + 有车」插入接送节点。
 *   L2 圈层内核   social-circles / cohort.js —— 我是谁、开不开车、什么驾驶风格。
 *   L3 出行方式   chooseTravel —— 这一趟到底步行还是开车（本模块 request）。
 *   L4 快层判断   driveJudge   —— 每 0.5~1 仿真秒：等灯 / 让行 / 跟车 / 减速 /
 *                                涉水熄火 / 弃车 / 继续。
 *   L5 执行层     traffic.js   —— 沿 roadnet 右侧车道真实位移，车速 × 仿真秒。
 *
 * 交管规则（硬约束，写在执行层，风格只影响余量不影响红线）：
 *   · 右侧通行：net.lanePoint 统一右偏 LANE_OFF，dir 决定行进方向，绝不逆行；
 *   · 红灯停：停止线 + 40 s 相位，闯灯次数必须为 0；
 *   · 限速：城市 URBAN_LIMIT，学校/居民区 SCHOOL_LIMIT，积水 WET_LIMIT；
 *   · 让行：斑马线行人优先、路口让右、入口排队、跟车安全距离；
 *   · 涉水：> STALL_DEPTH 熄火，> DROWN_DEPTH 无法行驶，超时可弃车转步行。
 *
 * 人开车时：行人模型隐藏，同一个人的位置 / 水深 / 经历 / 伤亡判定全部按**车**
 * 的真实位置计，不另开一套虚拟状态。人不是「换了个动画」，是真的换了载体。
 */
import { CAR, WALK, RISK } from './motion-units.js';
import { chooseTravel } from './social-circles.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** L4 快层判断：只看这一刻的真实观测量，返回刚算出来的动作与依据。 */
export function driveJudge(info, circle, ctx = {}) {
  if (!info) return { action: 'none', reason: '没有车' };
  const d = info.depth || 0;
  if (info.waitingRed) {
    return { action: 'redLightWait',
      reason: `路口红灯，停在停止线前 ${Math.round(info.waitSec || 0)} 秒` };
  }
  if (info.yielding) {
    return { action: 'yieldPedestrian',
      reason: info.yieldWhy || '斑马线有行人，停车礼让（行人优先）' };
  }
  if (info.stalled) {
    return { action: 'stalled',
      reason: `${Math.round(d * 100)} cm 积水，发动机进水熄火` };
  }
  if (info.pedNear > 0 && info.speed > 1) {
    return { action: 'yieldPedestrian', reason: `前方 ${info.pedNear} 名行人，减速让行` };
  }
  if (info.leadGap > 0 && info.leadGap < CAR.FOLLOW_STOP_GAP) {
    return { action: 'follow', reason: `前车 ${info.leadGap.toFixed(1)} m，保持车距` };
  }
  if (d > CAR.WET_DEPTH) {
    return { action: 'wadeSlow', reason: `路面 ${Math.round(d * 100)} cm 积水，降到 ${CAR.WET_LIMIT} m/s 以内` };
  }
  if (info.schoolZone) {
    return { action: 'schoolZone', reason: `学校/居民区，限速 ${(CAR.SCHOOL_LIMIT * 3.6).toFixed(0)} km/h` };
  }
  return { action: 'proceed',
    reason: `右侧车道通行，当前 ${info.speed ? info.speed.toFixed(1) : '0'} m/s` };
}

/**
 * @param {object} o { traffic, peds, net, clock, flood, circles, incidents, depthAt }
 */
export function createDriveLayer(o = {}) {
  const { traffic = null, peds = [], clock = null, circles = [], incidents = null,
    flood = null, depthAt = null } = o;
  const owned = new Map();      // i -> {carIdx, mode, dest, startMin, reason, thinkT, lastAction, ...}
  const S = {
    requests: 0, driveChosen: 0, walkChosen: 0, poolFull: 0, pickups: 0,
    arrivals: 0, abandons: 0, stalls: 0, active: 0, drivingSec: 0, carKm: 0,
    speedSum: 0, speedSamples: 0, maxSpeed: 0, speedViolations: 0,
    byAction: {}, byLaw: {}, byReason: {}, byCircle: {},
  };
  const minute = () => (clock ? clock.minute : 0);
  let simT = 0;                 // 驾驶层自己的仿真秒（法规事件冷却用）

  function noteLaw(i, type, info) {
    S.byLaw[type] = (S.byLaw[type] || 0) + 1;
    if (incidents) {
      const map = { red: 'redLightWait', yield: 'yield', stall: 'stalled',
        abandon: 'abandonedCar', collision: 'collision', arrive: null };
      const t = map[type];
      if (t) incidents.mark(i, t, (info && info.reason) || type, {
        x: info && info.x, z: info && info.z, depth: info && info.depth,
        band: circles[i] && circles[i].band,
      });
    }
  }

  /** L3：目标刚激活时问一次「这趟怎么去」。理由来自当前水深/距离/雨/车池。 */
  function request(i, goal, ctx = {}) {
    const circle = circles[i] || null;
    S.requests++;
    if (!circle) { S.walkChosen++; return { mode: 'walk', reason: '圈层未就绪' }; }
    const poolFull = traffic && traffic.available ? traffic.available() <= 0 : false;
    const hasOwnCar = traffic && traffic.hasCrewCar ? traffic.hasCrewCar(i) : true;
    const decision = chooseTravel(goal, circle, {
      ...ctx, band: circle.band, noCarAvailable: poolFull || !hasOwnCar,
      hasOwnCar,
      roll: ctx.roll !== undefined ? ctx.roll
        : (((i * 1103515245 + Math.floor(minute() * 7)) >>> 0) % 10000) / 10000,
    });
    if (goal && goal.type === 'pickup') S.pickups++;
    if (decision.mode !== 'drive' || !traffic || !traffic.claim) {
      S.walkChosen++;
      if (decision.mode === 'drive') S.poolFull++;
      return decision;
    }
    const p = peds[i];
    const from = (ctx.from && Number.isFinite(ctx.from.x))
      ? { x: ctx.from.x, z: ctx.from.z }
      : (circle.home && Number.isFinite(circle.home.x))
        ? { x: circle.home.x, z: circle.home.z }
        : (p && p.obj ? { x: p.obj.position.x, z: p.obj.position.z } : { x: 0, z: 0 });
    const dest = goal && goal.dest ? { x: goal.dest.x, z: goal.dest.z } : null;
    if (!dest) { S.walkChosen++; return { mode: 'walk', reason: '目标没有真实门牌，改步行' }; }
    const carIdx = traffic.claim(i, from, dest, {
      ...circle.driver, circleId: circle.id, style: circle.style,
      schoolZone: circle.driver.schoolZone || (goal.type === 'pickup'),
    });
    if (carIdx < 0) {
      S.walkChosen++; S.poolFull++;
      return { mode: 'walk', reason: '附近没有可用车辆，改步行/公交' };
    }
    owned.set(i, { carIdx, mode: 'drive', dest, startMin: minute(),
      reason: decision.reason, thinkT: 0, lastAction: 'proceed', lastReason: '',
      waitRedT: 0, stallT: 0, lawSeen: {} });
    S.driveChosen++;
    S.byReason[circle.style] = (S.byReason[circle.style] || 0) + 1;
    S.byCircle[circle.districtLabel] = (S.byCircle[circle.districtLabel] || 0) + 1;
    if (incidents) incidents.mark(i, 'tripStart', decision.reason, {
      x: from.x, z: from.z, depth: ctx.depthHere || 0, band: circle.band });
    return decision;
  }

  /** L5 执行层每个仿真子步同步一次：车在哪，人就在哪。 */
  function step(h, minuteNow = minute()) {
    if (!(h > 0) || !traffic || !traffic.carInfo) return;
    simT += h;
    for (const [i, rec] of owned) {
      const info = traffic.carInfo(i);
      const p = peds[i];
      if (!info || !p || !p.obj) { release(i, '车辆已归还'); continue; }
      // 同一个人的真实位置 = 车的位置；不另开一套「车内人」坐标
      p.obj.position.x = info.x;
      p.obj.position.z = info.z;
      p.inVehicle = true;
      p.driveSpeed = info.speed;
      p.driveInfo = info;
      if (info.yaw !== undefined) p.obj.rotation.y = info.yaw;
      S.drivingSec += h;
      S.carKm += Math.max(0, info.speed) * h / 1000;
      if (info.speed > 0) { S.speedSum += info.speed; S.speedSamples++; }
      if (info.speed > S.maxSpeed) S.maxSpeed = info.speed;
      if (info.speed > CAR.URBAN_LIMIT + 1e-3) S.speedViolations++;

      // ---- L4 快层：每 0.5~1 仿真秒判断一次「现在该干什么」 ----
      rec.thinkT -= h;
      if (rec.thinkT <= 0) {
        rec.thinkT = 0.5 + ((i % 7) * 0.08);
        const d = driveJudge(info, circles[i], { minute: minuteNow });
        rec.lastAction = d.action;
        rec.lastReason = d.reason;
        S.byAction[d.action] = (S.byAction[d.action] || 0) + 1;
        // 法规事件按 8 仿真秒冷却记一次：同一次等灯不该被 0.5 秒一次的
        // 快判断重复记成十几次；但连续不同的等灯/让行都要留痕。
        if (d.action === 'redLightWait' && simT - (rec.lawSeen.red ?? -99) > 8) {
          rec.lawSeen.red = simT; noteLaw(i, 'red', { ...info, reason: d.reason });
        }
        if (d.action === 'yieldPedestrian' && simT - (rec.lawSeen.yield ?? -99) > 8) {
          rec.lawSeen.yield = simT; noteLaw(i, 'yield', { ...info, reason: d.reason });
        }
      }
      // ---- 熄火 / 弃车：连续状态，不是掷一次骰子 ----
      if (info.stalled) {
        rec.stallT += h;
        if (!rec.lawSeen.stall) {
          rec.lawSeen.stall = true; S.stalls++;
          noteLaw(i, 'stall', { ...info, reason: `${Math.round((info.depth || 0) * 100)} cm 积水，发动机进水熄火` });
        }
        const style = circles[i] ? circles[i].style : 'normal';
        const patience = CAR.STALL_HESITATE + (style === 'cautious' ? -18 : style === 'aggressive' ? 30 : 0);
        if (rec.stallT > patience && (info.depth || 0) > RISK.CAR_TRAP_DEPTH * 0.7) {
          release(i, 'abandonedCar');
          S.abandons++;
          noteLaw(i, 'abandon', { ...info, reason: '熄火后水还在涨，弃车改步行' });
          continue;
        }
      } else rec.stallT = 0;
      // ---- 到达：车停在目的地附近，人下车，目标交给 goal 判完成 ----
      if (info.arrived) {
        S.arrivals++;
        noteLaw(i, 'arrive', info);
        release(i, 'arrived');
      }
    }
    S.active = owned.size;
  }

  function release(i, reason = 'goalDone') {
    const rec = owned.get(i);
    if (!rec) return false;
    const p = peds[i];
    if (p) {
      p.inVehicle = false; p.driveSpeed = 0; p.driveInfo = null;
      // 车停在最近路口：人下车，到门牌那最后一截由步行路线真实走完，
      // 不把人瞬移进楼。live-agent 看到 justParked 会立刻重规划。
      if (reason === 'arrived' && rec.dest) p.justParked = true;
    }
    if (traffic && traffic.release) traffic.release(i);
    owned.delete(i);
    S.active = owned.size;
    void reason;
    return true;
  }

  function syncAll() {
    for (const [i] of owned) {
      const info = traffic && traffic.carInfo ? traffic.carInfo(i) : null;
      const p = peds[i];
      if (info && p && p.obj) {
        p.obj.position.x = info.x; p.obj.position.z = info.z;
        p.inVehicle = true;
      }
    }
  }

  function stats() {
    return { ...S, active: owned.size,
      avgSpeed: S.speedSamples ? +(S.speedSum / S.speedSamples).toFixed(2) : 0,
      avgSpeedKmh: S.speedSamples ? +((S.speedSum / S.speedSamples) * 3.6).toFixed(1) : 0,
      carKm: +S.carKm.toFixed(1), drivingSec: Math.round(S.drivingSec),
      byAction: { ...S.byAction }, byLaw: { ...S.byLaw },
      urbanLimit: CAR.URBAN_LIMIT, schoolLimit: CAR.SCHOOL_LIMIT,
      wetLimit: CAR.WET_LIMIT };
  }

  function debug(i) {
    const rec = owned.get(i);
    if (!rec) return null;
    const info = traffic && traffic.carInfo ? traffic.carInfo(i) : null;
    return { mode: 'drive', carIdx: rec.carIdx, since: +rec.startMin.toFixed(1),
      reason: rec.reason, lastAction: rec.lastAction, lastReason: rec.lastReason,
      dest: rec.dest, car: info,
      circle: circles[i] ? circles[i].label : null,
      style: circles[i] ? circles[i].styleLabel : null };
  }

  function reset() {
    for (const i of [...owned.keys()]) release(i, 'timeSeek');
    for (const k of Object.keys(S)) {
      if (typeof S[k] === 'number') S[k] = 0;
      else if (k !== 'byAction' && k !== 'byLaw' && k !== 'byReason' && k !== 'byCircle') S[k] = {};
    }
    S.byAction = {}; S.byLaw = {}; S.byReason = {}; S.byCircle = {};
  }

  return { request, step, release, syncAll, stats, debug, reset,
    isDriving: (i) => owned.has(i), owned,
    available: () => (traffic && traffic.available ? traffic.available() : 0),
    driveJudge };
}

export { WALK };
