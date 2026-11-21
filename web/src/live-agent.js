/**
 * live-agent.js — 每 0.5~1 仿真秒一次「现在该干什么」的判断。
 *
 * 【2026-11-11 用户要求】「0.5 秒到一秒并不是说要确认今天干嘛，而是说在目前
 *  这个状态下，他现在应该干什么」。目标是慢层（一天几个节点），这里是快层：
 *  读此刻的时间、位置、脚下与前方水深、前方阻挡、目标进度、体力、雨强、
 *  周围人的流向，按所属群体的内核做一次带噪声的判断，输出**一个动作**。
 *
 * 动作必须落到真实位移 / 真实路线（由 ped.js 执行），HUD 上的话只是把刚算出的
 * 结果翻译出来。这里没有任何预写台词，也没有「拖到某分钟该说某句话」。
 */
import { createPlan, ARRIVE_R } from './goal.js';
import { makeKernel, judge } from './cohort.js';
import { mulberry32 } from './decision.js';
import { normal } from './kernel/rng.js';
import { peerShares } from './kernel/peer-share.js';
import { ACCESS } from './kernel/access-impediment.js';
import { WALK } from './motion-units.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * 【2026-11-16 决策分层】把连续的水深压成离散档，做保护决定的情境签名。
 * 水从 34 cm 涨到 40 cm 但都还在同一档 → 签名不变 → 沿用上次决定，不重抽；
 * 跨到下一档（更深）或收到预警、换目标、受伤 → 签名变 → 重新判断一次。
 * 分档边界是工程实现，不是文献阈值，台账标「目前自己定的」。
 * 真正的危险分级在 kernel/hazard-input.js 按 DEFRA HR 公式算，这里只做
 * 「情况有没有实质变化」的去抖，不改任何系数、不改伤亡判定。
 */
/**
 * 水深分档，只用于判断「情况有没有实质变化」，不是危险分级本身（危险分级在
 * kernel/hazard-input.js 按 DEFRA HR 与 Thieken 的水深编码算）。
 * 界值对齐已发表的洪水水深分级，不再用随手取的 0.15 / 0.35 / 0.85：
 *  · 0.20 m：国土交通省指南的「行动困难水深」（u²h 0.5–1.0，步行由易转谨慎）
 *  · 0.30 m：同指南的行动限界水深；石垣 2005 问卷里判为避难限界的人最多
 *  · 0.50 m：国交省「浸水想定区域図作成マニュアル」浸水深ランク第一界，也是
 *    「缓流中 0.5 m 以上大人也步行困难」的阈值
 *  · 1.0 m：同ランク第二界（大人腰深）
 *  · 2.0 m：同ランク第三界（1 层檐下）
 * 0.05 m 以下是薄水，项目自己定的「有没有看到水」的起点。
 */
const depthBand = (d) => d < 0.05 ? 0 : d < 0.20 ? 1 : d < 0.30 ? 2
  : d < 0.50 ? 3 : d < 1.0 ? 4 : d < 2.0 ? 5 : 6;
function scenarioKey(s, minute) {
  // 【2026-11-19 第4步：重估窗口不再是一个固定常数】
  // 原来固定 30 分钟一档，等于假设「预报可见度」恒定：毛毛雨和下暴雨同样
  // 半小时才重估一次。现在雨强本身进签名——雨强跨档立刻重估，不等窗口；
  // 窗口只作兜底（防止一个「不保护」的决定冻结一整天）。
  // 依据：预警与重估是两件事，雨强变化是新的信息（Thieken 2023 把
  // 「收到／理解／认为有效」分开测；Silva 2025 的动员曲线也把时间当作
  // 连续量）。窗口取 30 分钟仍是工程实现，标在依据台账里。
  const window = Math.floor(minute / 30);
  const rain = Number(s.rain) || 0;
  // 0 = 无雨/毛毛雨，1 = 小雨 <5，2 = 中雨 <15，3 = 大雨 <30，4 = 暴雨 ≥30 mm/h
  const rainBand = rain < 0.2 ? 0 : rain < 5 ? 1 : rain < 15 ? 2 : rain < 30 ? 3 : 4;
  return [depthBand(s.depthAhead), depthBand(s.depthHere), s.officialWarning ? 1 : 0,
    s.goalType, s.late ? 1 : 0, s.blocked ? 1 : 0, rainBand, window].join('|');
}

/** 檐下避雨时仍能做的判断：继续等 / 放慢 / 加快想走 / 等一下。 */
const SHELTER_POOL = ['continue', 'wait', 'slow', 'hurry'];

/** 快层动作对步速的乘子：对外导出，让 ped.js 的速度自检能跨模块比对。 */
export const ACTION_SPEED_MUL = Object.freeze({
  slow: WALK.SLOW_MUL, hurry: WALK.HURRY_MUL,
});

export function createLiveAgents({ peds, crowd, seed = 20261111, experience = null,
  circles = [], drive = null, incidents = null } = {}) {
  const EXP = experience;
  const DRIVE = drive;
  const INC = incidents;
  const PERSONS = (crowd && crowd.persons) ? crowd.persons : null;
  const atFn = (i, m) => (crowd && crowd.at) ? crowd.at(i, m) : null;
  const agents = [];
  // 【2026-11-19】随机参数 logit 的个体偏差：每人三个独立标准正态，全天固定。
  // 用独立随机流（不改主 rnd 的消耗序列），保证同种子可复现且不扰动既有结果。
  // 依据：Borowski & Stathopoulos 2023 Table 4 给了三个随机参数的均值与标准差
  // （同伴留下 7.76±10.87、同伴搭车 −1.27±1.91、成本 −3.71±1.03），
  // 标准差比均值还大是论文自己的结论（vary widely），不能当成全城统一系数。
  const rplOf = (i) => {
    const r = mulberry32(((seed ^ 0x9e3779b9) >>> 0) + i * 7919 + 104729);
    return [normal(r), normal(r), normal(r)];
  };
  for (const p of peds) {
    const rnd = mulberry32(seed + p.i * 7919);
    const person = (crowd && crowd.persons) ? crowd.persons[p.i] : null;
    const kernel = makeKernel(p.i, person, rnd, circles[p.i] || null);
    const jitter = Math.round((rnd() - 0.5) * 40);   // ±20 分钟错峰
    agents[p.i] = {
      i: p.i, rnd, kernel, person, rplZ: rplOf(p.i),
      plan: createPlan(p.i, atFn, jitter, person, circles[p.i] || null), jitter,
      t: 0, nextThink: rnd() * 0.6, planDelay: (p.i % 96) * 0.5,
      detours: 0, lastAction: 'continue',
      holdUntil: -1, holdSpeed: 0, waitSec: 1, q: null,
      pendingGoal: null, lastPlanT: -99, planRetryT: 0, recent: [],
      // 【2026-11-16 决策分层】保护行动的「情境签名 + 上次决定」。
      // 签名只由离散的关键状态构成（水深档/危险档/是否预警/目标类型/是否受伤），
      // 签名不变就沿用上次决定，不每个 think 重抽概率——治「走两步停一下」和
      // 「两个水坑间往返」。新情况出现（水位跨档、收到预警、换目标、受伤）才重估。
      // 依据：Springer 2023 三层决策（战略/战术层低频、操作层逐步）、
      // Mostafizi 等海啸 ABM 的 milling time；本项目把「是否启动保护」归到
      // 低频的战略/战术层。签名分档是工程实现，台账标「目前自己定的」。
      protectKey: null, protectHeld: null, protectMinute: -1e9,
    };
  }

  let simT = 0, bucket = -1, used = 0;
  const events = [];                 // 非「继续」的判断（验收程序读）
  const counters = {
    judged: 0, replans: 0, budgetBlocked: 0, overflow: 0, earlyWarnings: 0,
    peersSum: 0, peersNonZero: 0,
    // 【2026-11-19】peersStay 的十档直方图（0–0.1、…、0.9–1.0），
    // 用来和 Sadri et al. 2017 桑迪样本的实测对照：撤离者同伴撤离率 39.6%、
    // 不撤离者 15.1%（即 peersStay 约 0.60 与 0.85）。只计数，不参与任何判定。
    peerBins: new Array(10).fill(0),
    byAction: { continue: 0, slow: 0, hurry: 0, wait: 0, detour: 0, turnback: 0, abandon: 0 },
    goals: { done: 0, abandoned: 0, timeout: 0, activate: 0 },
  };
  const EVENT_CAP = 40000;

  /** 每个仿真秒给一次全局重规划预算：1000 人同时想换街时排队，不把页面卡死。 */
  function canPlan() {
    const b = Math.floor(simT);
    if (b !== bucket) { bucket = b; used = 0; }
    const cap = Math.max(24, Math.floor(peds.length * 0.06));
    if (used >= cap) { counters.budgetBlocked++; return false; }
    used++; counters.replans++;
    return true;
  }

  /**
   * 参照群体状态 → Borowski 的两个同伴比例（kernel/peer-share.js）。
   * 合成网络见 crowd-life.js（同户 + 120 m 内最多 3 个邻居，规模≈论文的「最多 5 人」）。
   *
   * 【2026-11-21 修】旧实现只有 peersStay 一条，且只排除 flee/shelter，
   * 把「已经开车撤离的人」算进 stay —— 同伴开车走反而抬高 stay 占比，
   * 与论文方向相反。peersRide 则从来没赋值过，Table 4 的 −1.27 与
   * threat × peersRide 交互项恒乘 0。现在两条都由同一个分类函数给出。
   */
  function peerSharesOf(a) {
    const list = a.person && a.person.peers;
    if (!list || !list.length) return peerShares([]);
    const states = [];
    for (const j of list) {
      const q = peds[j];
      if (!q) continue;
      states.push({ mode: q.mode, inVehicle: q.inVehicle === true });
    }
    return peerShares(states);
  }

  /**
   * 照护责任（门 5 的第三条，A7）：同户未成年成员此刻在不在身边。
   *
   * 返回 { withMinor, childPos, dist }：
   *  · 同户（crowd-life 合成户）里有未成年成员 → 取最近那个，
   *    dist ≤ ACCESS.childWithM(9 m) 算「已经带上了」；
   *  · 户内没有可判定的未成年成员（ACS 有「户内有未成年=1」但合成户里
   *    没配上孩子，或本人根本不带娃）→ withMinor = false，childPos = null。
   *    这时门 5 不会命中 care_child，也就不会因为「没有孩子」被永久锁死。
   *    宁可漏判，不凭空造一个孩子出来。
   */
  function minorNearbyOf(a) {
    const none = { withMinor: false, childPos: null, dist: Infinity };
    const hh = a.person && a.person.household;
    const self = peds[a.i];
    if (!hh || !hh.length || !self || !self.obj) return none;
    const x = self.obj.position.x, z = self.obj.position.z;
    let best = null, bestD = Infinity;
    for (const j of hh) {
      const pp = PERSONS && PERSONS[j];
      const q = peds[j];
      if (!pp || !pp.real || !q || !q.obj) continue;
      if (!(Number(pp.real.age) < 18)) continue;
      const d = Math.hypot(q.obj.position.x - x, q.obj.position.z - z);
      if (d < bestD) { bestD = d; best = q.obj.position; }
    }
    if (!best) return none;
    return {
      withMinor: bestD <= ACCESS.childWithM,
      childPos: { x: +best.x.toFixed(1), z: +best.z.toFixed(1) },
      dist: +bestD.toFixed(1),
    };
  }

  /** 感知：全部来自这一子步的真实世界，不用任何预置剧本。 */
  // 【门1 接收 2026-11-21】这个人此刻是否知道「有洪水」。
  // 只有两条有记录的时刻可以当依据：收到预警的时刻 receiveAt（kernel/warning.js 按人算，
  // 由 ped.js 写入 p）和脚下第一次见水的时刻 seeAt。两者任一到达即为知道。
  // 不能拿「收不到预警」当永不知道：那 35.6% 会被冻在原地，与现实相反。
  function knowThereIsFlood(p, ctx) {
    const now = Number(ctx && ctx.minute);
    if (!Number.isFinite(now)) return true;      // 没有时钟信息时不拦人
    const reached = (t) => Number.isFinite(t) && now >= t;
    return reached(p.receiveAt) || reached(p.seeAt);
  }

  function perceive(p, a, ctx) {
    const x = p.obj.position.x, z = p.obj.position.z;
    const fx = Math.sin(p.yaw || 0), fz = Math.cos(p.yaw || 0);
    const ds = { d: 0, wet: false };
    const read = (px, pz) => {
      if (!ctx.dInfo) return 0;
      ds.d = 0; ctx.dInfo(px, pz, ds);
      return Number.isFinite(ds.d) ? ds.d : 0;
    };
    const depthHere = read(x, z);
    const depthAhead = Math.max(read(x + fx * 4, z + fz * 4), read(x + fx * 9, z + fz * 9) * 0.85);
    // 【个体化危险预警距离】视野半径 = 年龄/老练度给的 sightM + 灾害履历
    // 加成，由 makeKernel 算好。经验足的人看得更远，水还没到脚下就先察觉。
    // 多这一次采样仍是 O(1)；是否真的当成威胁由 cohort.judge 严格门控。
    const farDist = clamp((a.kernel.sightM || 40) * 0.55, 8, 34);
    const farDepth = read(x + fx * farDist, z + fz * farDist);
    if (depthAhead > 0.01 && farDepth > depthAhead + 0.08) {
      counters.earlyWarnings++;
      a.earlyWarn = (a.earlyWarn || 0) + 1;
    }
    const blocked = ctx.blocked ? !!ctx.blocked(x + fx * 3.2, z + fz * 3.2, 0.4) : false;
    const g = a.plan.active();
    const distGoal = g && g.dest ? Math.hypot(x - g.dest.x, z - g.dest.z) : 0;
    const timeToDue = g ? g.dueMin - ctx.minute : 999;
    const q = a.q;
    const stamina = (q && q.phys && Number.isFinite(q.phys.stamina)) ? q.phys.stamina : 80;
    // 同伴比例一次决策只算一遍（同一子步内参照群体状态不会变）。
    const shares = peerSharesOf(a);
    const kin = minorNearbyOf(a);
    const s = {
      depthHere, depthAhead, farDepth: +farDepth.toFixed(3),
      farDist: +farDist.toFixed(1), blocked,
      progress: clamp(1 - distGoal / 220, 0, 1),
      // 【2026-11-21 门5 联动修正】原来只给了 progress（0–1 的进度），
      // 没给真实距离，access-impediment.js 的 `Number(s.distGoal) > 2000`
      // 拿到 NaN 恒为 false —— 判定逻辑写好了，但在真跑里从不触发。
      distGoal: +distGoal.toFixed(1),
      // 值守岗位判据要知道「此刻是不是在工作场所」；人群时段表给出 where=work。
      atWork: !!(ctx && ctx.atWork),
      // 在家休息 / 睡觉 / 上班本身没有「迟到」这回事，人才不会凌晨赶着回家
      late: !!g && timeToDue < 25 && g.type !== 'home' && g.type !== 'work',
      goalType: g ? g.type : '',
      overdue: g ? Math.max(0, ctx.minute - g.dueMin) / 60 : 0,
      timeToDue, pressure: clamp(1 - timeToDue / 60, 0, 1),
      rain: ctx.rainMMH || 0,
      // 预警到达时长 / 是否收到预警，一律由 kernel/warning.js 按人算（见 ped.js），
      // 送进 Silva 2025 的实测动员曲线，不是自设的倒计时。
      minutesSinceWarning: ctx.minutesSinceWarning || 0,
      officialWarning: !!ctx.officialWarning,
      // 【门1 接收 2026-11-21】这一门问的是「这个人现在知不知道有洪水」。
      // 收到预警的人从 receiveAt 起知道；没收到的人（receiveAt 为无穷）
      // 在脚下见到水（seeAt）时也会知道 —— 不能把 35.6% 收不到的人判成
      // 永远不知道，那等于把他们全体冻在原地。
      received: knowThereIsFlood(p, ctx),
      // 从众：参照群体里「留下」与「选择乘车」的各占多少（合成网络，见 crowd-life.js /
      // kernel/peer-share.js）。Borowski 2023 Table 4 的两个系数要的就是这两个比例，
      // 此前 peersRide 从未赋值、peersStay 又把开车走的人算成留下，两条都不对。
      peersStay: shares.peersStay,
      peersRide: shares.peersRide,
      // 门 5 照护责任：孩子是否已在身边（同户未成年成员的水平距离）。
      minorWith: kin.withMinor,
      childPos: kin.childPos,
      rplZ: a.rplZ,          // 人级随机参数偏差（三个独立正态），全天不变
      fatigue: clamp(1 - stamina / 100, 0, 1),
      stuck: p.route ? (p.route.stuck || 0) : 0,
      detours: a.detours,
      // 冷却：人不会每 0.7 秒就放弃一次目标 / 换一条街 / 停一下
      abandonCd: a.t < (a.abandonCdT || -99),
      detourCd: a.t < (a.detourCdT || -99),
      waitCd: a.t < (a.waitCdT || -99),
      goalLabel: g ? g.label : '',
      waitSec: 0.6 + a.rnd() * 1.4,
    };
    // 【今日经历进场】这些数由 ped.js 每子步量出来的真实位移 / 水深 /
    // 淋湿 / 伞，以及下面 note() 记下的动作与目标事件累积而成，直接进入
    // judge() 的每一项分数。没有这一层，「经历过什么」就只是一句文案。
    if (EXP) {
      const e = EXP.state(p.i);
      if (e) Object.assign(s, e);
      if (s.blocked) EXP.note(p.i, 'blocked');
    }
    return s;
  }

  function pushEvent(a, p, act, s, minute) {
    counters.judged++;
    counters.byAction[act] = (counters.byAction[act] || 0) + 1;
    // 【2026-11-18】诊断从众支路是否真的取到值：peersStay 之前恒 0，
    // 这两个计数让验收程序能看出它是否变成非零（不是每个判断都 >0，
    // 独居者没有同伴，本来就是 0）。
    if (s.peersStay) { counters.peersSum += s.peersStay; counters.peersNonZero++; }
    if (Number.isFinite(s.peersStay)) {
      const b = Math.min(9, Math.max(0, Math.floor(s.peersStay * 10)));
      counters.peerBins[b]++;
    }
    if (act === 'continue') return;                    // 继续占绝大多数，只计数不存
    if (events.length >= EVENT_CAP) { counters.overflow++; return; }
    const g = a.plan.active();
    events.push({
      i: p.i, minute: +minute.toFixed(3), action: act,
      goal: g ? g.id : null, status: g ? g.state : null,
      depth: +s.depthAhead.toFixed(3), rain: +s.rain.toFixed(1),
      farDepth: +(s.farDepth || 0).toFixed(3), farDist: +(s.farDist || 0).toFixed(1),
      // 【决策依据可追溯】绕路 / 掉头 / 放弃不一定是因为水或雨：前方被静态
      // 障碍挡住、路线卡住、目标已迟到，都是正当理由。验收脚本据此判定
      // 「无依据改道」，不能只看水深雨强就把合理绕路误报成瞎走。
      blocked: !!s.blocked, stuck: +(s.stuck || 0).toFixed(1),
      overdue: +(s.overdue || 0).toFixed(3), late: !!s.late,
      x: +p.obj.position.x.toFixed(1), z: +p.obj.position.z.toFixed(1),
      reason: a.lastReason || '',
    });
  }

  /** 目标事件：完成 / 放弃 / 超时 / 到点，全部记进统计。 */
  function goalEvent(a, p, e, minute) {
    if (counters.goals[e.type] !== undefined) counters.goals[e.type]++;
    if (EXP) EXP.note(p.i, e.type, e.reason);
    if (events.length < EVENT_CAP) events.push({
      i: p.i, minute: +minute.toFixed(3), action: `goal:${e.type}`,
      goal: e.goal ? e.goal.id : null, status: e.goal ? e.goal.state : null,
      x: +p.obj.position.x.toFixed(1), z: +p.obj.position.z.toFixed(1),
      reason: e.reason,
    });
  }

  /** 每帧（子步循环开始前）调一次：累计仿真秒，重规划预算按秒重置。 */
  function begin(dt) { simT += Math.max(0, dt || 0); }

  /**
   * 一个人一个子步。返回 null（什么都不做）或一个动作对象，由 ped.js 执行。
   * @param ctx {minute, dInfo, blocked, rainMMH, far}
   */
  function stepOne(p, dt, ctx) {
    const a = agents[p.i];
    if (!a) return null;
    a.t += Math.max(0, dt || 0);
    const minute = ctx.minute;
    // 已经困死的人不再做任何判断，位置冻结（伤亡台账里可回查原因）。
    if (INC && INC.isDead(p.i)) return null;
    // 【2026-11-16 阶段2A】被困的人不再每 0.5~1 秒重抽保护行动、反复
    // detour/turnback。被困是人身处深水走不动的真实状态，应停在那里等
    // 水退 / 救援，而不是在两个水坑之间往返。这里直接跳过快层判断；
    // 伤亡台账的暴露累计照常（由 ped.js 的 INC.tick 每子步推进）。
    if (INC && INC.isStranded(p.i)) return null;

    // ① 慢层：目标状态只由「到点 / 走到门牌 / 超时 / 放弃」推进
    const evs = a.plan.step(minute, p.obj.position);
    for (const e of evs) {
      goalEvent(a, p, e, minute);
      // 目标结束（走到 / 超时 / 自己放弃）就把车还回车池，人下车恢复步行。
      if (DRIVE && (e.type === 'done' || e.type === 'timeout' || e.type === 'abandoned')) {
        DRIVE.release(p.i, e.type);
      }
      // 通勤到了就进入目的地等下一节点：早到的人不该在雨里站到上班/睡觉时间。
      if (e.type === 'done' && e.goal && e.goal.type === 'commute') {
        // 学生 / 夜班 / 上班族的通勤节点名字不同，按「去哪个门牌」判断。
        if (e.goal.destKey === 'work') a.holdPlace = 'work';
        else if (e.goal.destKey === 'home') a.holdPlace = 'home';
      }
    }
    const activate = evs.find((e) => e.type === 'activate');
    if (activate) {
      a.holdPlace = null;
      // ---- L3 出行方式层：目标刚到点，按「此刻」的距离/水深/雨/车池决定
      // 这趟是步行还是开车。不是日程表写死的，也不是每次判断都重问一次。
      if (DRIVE && activate.goal) {
        const g = activate.goal;
        // 【从真实门牌出发，不是室内锚点】人在屋里时 obj.position 是房间
        // 锚点（可能离自己的门牌几公里），拿它去「找 500 m 内的车」会
        // 永远找不到。出发地按这件事本身取：回家从岗位出发，其余从家出发。
        const doors = a.q && a.q.doors;
        const fromDoor = doors
          ? (g.destKey === 'home' ? (doors.work || doors.home) : (doors.home || doors.work))
          : null;
        const from = (fromDoor && Number.isFinite(fromDoor.x))
          ? fromDoor : { x: p.obj.position.x, z: p.obj.position.z };
        const dist = g.dest && Number.isFinite(g.dest.x)
          ? Math.hypot(from.x - g.dest.x, from.z - g.dest.z) : 0;
        const d0 = { d: 0, wet: false };
        if (ctx.dInfo) ctx.dInfo(from.x, from.z, d0);
        const decision = DRIVE.request(p.i, g, {
          from, dist, depthHere: Number.isFinite(d0.d) ? d0.d : 0,
          rain: ctx.rainMMH || 0, minute, roll: a.rnd(),
        });
        g.travel = decision.mode;
        g.travelReason = decision.reason;
        a.lastReason = decision.reason;
        if (events.length < EVENT_CAP) events.push({
          i: p.i, minute: +minute.toFixed(3), action: `travel:${decision.mode}`,
          goal: g.id, reason: decision.reason, rain: ctx.rainMMH || 0,
          depth: +(d0.d || 0).toFixed(3),
          x: +p.obj.position.x.toFixed(1), z: +p.obj.position.z.toFixed(1),
        });
      }
    }
    const finished = evs.find((e) => e.type === 'done' || e.type === 'timeout');
    // 刚从车里下来：立刻规划「路口 → 真实门牌」这段步行，别在路口干等
    // 20 秒兜底重规划。车位与门牌之间是有真实距离的，人要走过去。
    if (p.justParked) {
      p.justParked = false;
      a.pendingGoal = a.plan.active();
      a.lastPlanT = -99; a.planRetryT = 0;
    }

    // ② 等待结束恢复步速
    if (a.holdUntil > 0 && a.t >= a.holdUntil) {
      a.holdUntil = -1;
      a.lastAction = 'continue';        // 等完了，动作立刻从 idle 回到走
      return { type: 'resume', speed: a.holdSpeed || a.kernel.speed,
        reason: '等完了，接着走' };
    }
    if (a.holdUntil > 0) return null;

    // ③ 新目标到点：先挂起，等这个人自己的判断时刻错峰规划，避免全城
    // 240/1000 人同一子步一起跑 A*。人不会站着等 —— 他仍在沿步行网走。
    if (activate) a.pendingGoal = activate.goal;
    // 兜底：目标在进行中，但路线走完 / 规划被挡后回到了随机走网 ——
    // 隔几秒重新挂起一次，保证「有目标的人最终一定往目标走」。
    const cur = a.plan.active();
    if (cur && cur.state === 'active' && !a.pendingGoal
      && p.mode !== 'route' && p.mode !== 'flee' && p.mode !== 'shelter'
      && a.t - (a.lastPlanT || -99) > 20) a.pendingGoal = cur;
    if (finished && !a.plan.active()) {
      return { type: 'idle', reason: finished.reason };
    }
    if (a.pendingGoal && a.t >= (a.planRetryT || 0) && a.t >= a.planDelay) {
      if (!canPlan()) {
        // 预算被占满只推迟「重试规划」，绝不推迟这个人的快判断 ——
        // 否则 3000 人排队规划时会被整体降频，违背 0.5~1 秒判断一次。
        a.planRetryT = a.t + 0.35;
      } else {
        const g = a.pendingGoal;
        a.pendingGoal = null;
        a.planRetryT = 0;
        // 【相机解耦 2026-11-20】旧版这里是 `a.kernel.think * (ctx.far ? 2.2 : 1)`，
        // ctx.far 来自 p.visible===false，于是同一个人只因为相机离他远近，
        // 规划之后的再判断间隔就差 2.2 倍。判断频率是模型参数，不能由机位决定。
        a.nextThink = a.t + a.kernel.think;
        a.lastPlanT = a.t;
        return { type: 'goal', goal: g, reason: `到点了，${g.label}` };
      }
    }

    // ④ 快层：每 0.5~1 仿真秒一次「现在该干什么」
    // 人在屋里（睡觉 / 上班）时不判断走路，但计时照常推进；到点出门由上面的
    // activate 事件触发，applySocial 下一子步就把他放回街上。
    // 正在避险（积水/暴雨）时由避险系统接管，快判断不插嘴，但计时照走
    if (ctx.indoor || ctx.busy) return null;
    // 开车的人此刻由 L4 driveJudge 判断（等灯 / 让行 / 跟车 / 熄火 / 弃车），
    // 不再同时做一套「行人要不要绕街」的判断。两条执行层不许叠在一起。
    if (DRIVE && DRIVE.isDriving(p.i)) return null;
    // 所有人一律 0.5~1 仿真秒判断一次：判断是 O(1) 查表 + 噪声，很便宜；
    // 真正贵的是 A*，已经由 canPlan() 的全局预算限流，不该拿「远处的人」
    // 当借口把他变蠢。
    const farMul = 1;
    if (a.t < a.nextThink) return null;
    a.nextThink = a.t + a.kernel.think * farMul;

    // ③-c 【空档归位】目标被放弃 / 超时 / 办完而下一件还没到点时，人不会
    // 在街上漫无目的地随机换链，而是判断「手头没事 → 先回家等下一件」。
    // 这是有明确门牌的慢层决策：A* 真规划、执行层真走路、到点后由
    // applySocial 收进室内。20h 实测旧版最多 74% 的人长期无目标站在街上，
    // 看起来就像「全城随机乱走、谁也没到过任何地点」。
    if (!a.plan.active() && !a.holdPlace && !a.lastIndoor
      && p.mode !== 'route' && p.mode !== 'flee' && p.mode !== 'shelter'
      && a.t >= (a.homeGoalT || 0)) {
      const home = a.q && a.q.doors ? a.q.doors.home : null;
      if (home) {
        // 错峰 + 冷却，避免全城无目标的人在同一子步一起抢 A* 预算。
        a.homeGoalT = a.t + 30 + (a.i % 29);
        const dHome = Math.hypot(p.obj.position.x - home.x, p.obj.position.z - home.z);
        if (dHome > 14 && canPlan()) {
          counters.goHome = (counters.goHome || 0) + 1;
          return { type: 'goal', reason: '手头没有在办的事，先回家等下一件',
            goal: { id: 'waitHome', label: '先回家等下一件事', type: 'home',
              destKey: 'home', dest: { x: home.x, z: home.z } } };
        }
        if (dHome <= 14) a.holdPlace = 'home';
      }
    }

    const s = perceive(p, a, ctx);
    const noGoal = !a.plan.active();
    // 两个目标之间的空档：没有在办的事，就不该出现「换条街 / 掉头 / 放弃目标」
    // 这种针对具体目标的动作。旧版这时仍走全动作池，24h 实测凭空冒出
    // 两万多次「放弃」和大量无依据的换街 —— 不是自主决策，是空转。
    const pool = ctx.sheltered ? SHELTER_POOL
      : (noGoal ? ['continue', 'slow', 'hurry', 'wait'] : null);
    // 【决策分层】情境签名没变就沿用上次的保护决定，不再每个 think 重抽。
    // 这不冻结动作本身：executionAction/routineAction 仍按这一刻的真实几何
    // 选具体动作（前方水深、被挡、迟到），只是「要不要启动保护」不来回翻。
    const key = scenarioKey(s, minute);
    const held = (a.protectKey === key) ? a.protectHeld : null;
    // 【2026-11-21 个体追溯】judge 内部要往 trace 里写"这一条判断发生在第几分钟"，
    // 而 s 里原本没有时间字段（于是 trace 的 judge 记录 t 全是 null，事件和
    // 逐分钟轨迹就对不上）。在调用前把当前分钟挂上去，一个字段的代价。
    s.minute = +minute.toFixed(3);
    const out = judge(a.kernel, s, a.rnd, pool, held);
    a.protectKey = key;
    a.protectHeld = out.protectHeld;
    if (EXP) EXP.note(p.i, out.action, out.reason);
    a.lastAction = out.action;
    a.lastReason = out.reason;
    a.recent.push({ minute: +minute.toFixed(2), action: out.action, reason: out.reason });
    if (a.recent.length > 12) a.recent.shift();
    pushEvent(a, p, out.action, s, minute);

    if (out.action === 'continue') return null;
    if (out.action === 'wait') {
      a.holdUntil = a.t + s.waitSec;
      a.holdSpeed = p.route ? p.route.speed : a.kernel.speed;
      a.waitCdT = a.t + 30;
      return { type: 'wait', seconds: s.waitSec, reason: out.reason };
    }
    if (out.action === 'slow' || out.action === 'hurry') {
      return { type: out.action, reason: out.reason };
    }
    if (out.action === 'abandon') {
      // 没有正在办的目标时，「算了」不等于放弃了一个目标：记成等下一件事，
      // 不许把没发生的放弃写进统计和经历。
      if (!a.plan.active()) return { type: 'idle', reason: '现在没有在办的事，等下一件' };
      if (DRIVE) DRIVE.release(p.i, 'abandon');
      const goal = a.plan.active();
      a.plan.abandon(out.reason);
      counters.goals.abandoned++;
      if (events.length < EVENT_CAP) events.push({
        i: p.i, minute: +minute.toFixed(3), action: 'goal:abandoned',
        goal: goal ? goal.id : null, status: 'abandoned',
        x: +p.obj.position.x.toFixed(1), z: +p.obj.position.z.toFixed(1),
        reason: out.reason,
      });
      a.detours = 0;                       // 换目标后绕路次数清零，别越积越容易放弃
      a.abandonCdT = a.t + 600;            // 10 分钟内不再放弃，避免暴雨里连环放弃
      const next = a.plan.nextPending(minute);
      // 只接「现在确实该办」的下一件事；未来的节点等它自己到点再激活。
      // 旧版不判断时间，把 17:00 的「下班回家」在早上 7 点就激活，
      // 于是被 plan.step 连环判超时 —— 实测 144 秒里 1017 次假超时。
      const target = (next && next.startMin <= minute + 5 && next.dueMin > minute)
        ? a.plan.forceActivate(next, minute) : null;
      return { type: 'abandon', reason: out.reason, from: goal, goal: target,
        needPlan: target ? canPlan() : false };
    }
    if (out.action === 'detour' || out.action === 'turnback') {
      // 冷却在判断时就开始，不管这次重规划有没有抢到预算 —— 否则预算
      // 被占满的人会每个判断周期都「想绕一次」，暴雨里人均绕几十趟。
      a.detourCdT = a.t + 120;
      // 只有真的能重规划才算「绕了一次」：预算被占满时人仍在判断，
      // 但没有换街动作，不该把没发生的经历记进账本。
      if (!canPlan()) return null;
      a.detours++;
      return { type: out.action, goal: a.plan.active(), detours: a.detours, reason: out.reason };
    }
    return null;
  }

  /** 目标与真实社会状态对齐：还在赶目标的人必须在街上走，不许被作息表收进屋里。 */
  function applySocial(q, p) {
    const a = agents[p.i];
    if (!a || !q) return q;
    a.q = q;
    // 【人开车时不能被作息表收进屋里】同一个人的位置就是车的位置，
    // 社会层、HUD、伤亡判定读到的都是这一个坐标。
    if (DRIVE && DRIVE.isDriving(p.i)) {
      q.indoor = false; q.clip = 'walk'; q.where = 'street'; q.place = 'street';
      q.sceneId = q.streetSceneId || q.sceneId;
      q.segment = 'live_driving'; q.activity = '驾车中';
      q.inVehicle = true;
      q.speedAbs = Math.max(0, (p && p.driveSpeed) || 0);
      q.wantDecision = false;
      return q;
    }
    const busy = p && (p.mode === 'flee' || p.mode === 'shelter');
    const g = a.plan.active();
    if (busy) {
      // 避险的人站在街边檐下，不是「在屋里」——否则社会层与行人层打架，
      // 验收会看到「室内却播走跑」。
      q.indoor = false; q.clip = 'walk'; q.where = 'street'; q.place = 'street';
      q.sceneId = q.streetSceneId || q.sceneId;   // 不能还挂着卧室/办公室的室内锚点
      q.wantDecision = false;
    } else if (g && g.state === 'active') {
      const dist = g.dest && p
        ? Math.hypot(p.obj.position.x - g.dest.x, p.obj.position.z - g.dest.z) : Infinity;
      // arrivedAt 是“已经走到过这个门牌”的事实；人进屋后坐标离门口会超过
      // 阈值，不能再用当前距离反推，否则会在室内/街上每帧翻转。
      const settled = (g.type === 'home' || g.type === 'work')
        && (g.arrivedAt !== null || dist <= ARRIVE_R + 1);
      if (g.dest) q.dest = { id: g.dest.id, x: g.dest.x, z: g.dest.z, cap: q.dest.cap || 8 };
      q.segment = `live_${g.id}`; q.activity = g.label;
      if (settled) {
        // 真的到了自己的家/岗位才算“在场景里”。工地工人、外卖骑手到岗后
        // 仍在室外工作，不能因为“到岗”就被收进不存在的室内。
        const outdoorJob = g.type === 'work' && !!a.person.outdoor;
        q.indoor = !outdoorJob;
        q.clip = outdoorJob ? 'walk' : 'sit';
        const sf = EXP ? EXP.speedFactor(p.i) : 1;
        q.speedAbs = outdoorJob ? a.kernel.speed * 0.6 * sf : 0;
        q.where = g.type; q.place = g.type === 'home' ? 'home' : (a.person.workPlace || 'office');
        q.sceneId = g.type === 'home' ? a.person.homeScene : a.person.workScene;
        q.interiorVisible = !outdoorJob && (g.type === 'home'
          ? a.person.interiorVisible : a.person.workInteriorVisible);
        const spot = q.spots && q.spots[g.type];
        if (spot) {
          q.x = spot.x; q.y = spot.y; q.z = spot.z;
          // 【阶段3】楼层随场景锚点一起带过来（真实建筑高度派生）。
          q.floor = spot.floor || 0;
          q.floorRelY = spot.floorRelY;   // 相对楼层高度，显示层叠加地形用
        }
        a.lastIndoor = q.indoor ? { indoor: true, clip: 'sit', where: q.where, place: q.place,
          sceneId: q.sceneId, interiorVisible: q.interiorVisible, x: q.x, y: q.y, z: q.z,
          floor: q.floor, floorRelY: q.floorRelY } : null;
      } else {
        q.indoor = false; q.clip = 'walk'; q.where = 'street'; q.place = 'street';
        q.sceneId = q.streetSceneId || q.sceneId;
        // 【动作跟着决策走】快判断说「放慢 / 加快」，步速就真的变；下一次
        // 判断（0.5~1 仿真秒后）说继续，才恢复常速。不是只改一句 HUD 文案。
        // 【速度一致性】旧版这里写 0.74 / 1.26，而执行层 ped.js 用 0.72 / 1.30：
        // 决策说「放慢」时，HUD/生理按 0.74 算，真实位移却按 0.72 走。
        // 现在两层同读 motion-units.WALK 的同一组系数。
        const actMul = a.lastAction === 'slow' ? WALK.SLOW_MUL
          : a.lastAction === 'hurry' ? WALK.HURRY_MUL : 1;
        q.speedAbs = +(a.kernel.speed * (EXP ? EXP.speedFactor(p.i) : 1) * actMul).toFixed(3);
        a.lastIndoor = null;
      }
      q.wantDecision = false;      // 旧 Brain 的预写候选让位给实时判断
    } else {
      // 两个目标之间不许拿旧作息相位补一段“动画”。刚在屋里的人继续留在
      // 原场景；通勤提前到达的人进入自己的岗位/家等下一节点；其余人保持
      // 当前真实位置，等下一个目标到点。
      if (a.holdPlace) {
        const wp = a.holdPlace === 'work';
        q.indoor = true; q.clip = 'sit'; q.speedAbs = 0;
        q.where = a.holdPlace; q.place = wp ? (a.person.workPlace || 'office') : 'home';
        q.sceneId = wp ? a.person.workScene : a.person.homeScene;
        q.interiorVisible = wp ? a.person.workInteriorVisible : a.person.interiorVisible;
        const spot = q.spots && q.spots[a.holdPlace];
        if (spot) {
          q.x = spot.x; q.y = spot.y; q.z = spot.z;
          q.floor = spot.floor || 0;   // 【阶段3】楼层随锚点带过来
          q.floorRelY = spot.floorRelY;
        }
        q.activity = wp ? '在岗等待' : '在家';
        a.lastIndoor = { indoor: true, clip: 'sit', where: q.where, place: q.place,
          sceneId: q.sceneId, interiorVisible: q.interiorVisible, x: q.x, y: q.y, z: q.z };
      } else if (a.lastIndoor) Object.assign(q, a.lastIndoor);
      else {
        // 两个目标之间的人仍然在街上走（等下一件事），不是插一个 idle 动画。
        q.indoor = false; q.clip = 'walk'; q.where = 'street'; q.place = 'street';
        q.sceneId = q.streetSceneId || q.sceneId;
        q.activity = '在街上等下一件事';
      }
      q.segment = 'live_wait';
      q.speedAbs = q.indoor ? 0
        : +(a.kernel.speed * (EXP ? EXP.speedFactor(p.i) : 1)).toFixed(3);
      q.wantDecision = false;
    }
    return q;
  }

  /** ped.js 执行动作后回填：目标状态由 plan 自己管，这里只记上次规划时刻，
   *  绝不把已完成 / 已放弃 / 已超时的目标重新激活（旧版因此连环假超时）。 */
  function noteAction(i, act) {
    const a = agents[i];
    if (!a) return;
    if (act && act.type === 'goal') a.lastPlanT = a.t;
  }

  /** 拖时间轴（或换工况）时把目标状态重放到这一刻：过去的算错过，
   *  未来的保持待办，当前该办的立刻激活。连续播放时不会被调用。 */
  function reset(minute, peds) {
    for (const a of agents) {
      if (!a) continue;
      const pos = (peds && peds[a.i] && peds[a.i].obj) ? peds[a.i].obj.position : { x: 0, z: 0 };
      // 同种子可复现：连随机序列一起重建，否则「拖回同一时刻再跑一遍」
      // 会因为前半段消耗过的随机数得到完全不同的决策。
      a.rnd = mulberry32(seed + a.i * 7919);
      a.rplZ = rplOf(a.i);   // 个体偏差不随重置变化，同一个人始终是同一套偏好
      a.kernel = makeKernel(a.i, a.person, a.rnd, circles[a.i] || null);
      const jitter = Math.round((a.rnd() - 0.5) * 40);
      a.jitter = jitter;
      a.plan = createPlan(a.i, atFn, jitter, a.person, circles[a.i] || null);
      a.plan.step(minute, pos);
      a.pendingGoal = null; a.detours = 0; a.lastPlanT = -99; a.planRetryT = 0;
      a.abandonCdT = -99; a.detourCdT = -99; a.waitCdT = -99;
      a.holdUntil = -1; a.t = 0; a.nextThink = a.rnd() * 0.6;
      a.planDelay = (a.i % 96) * 0.5;
      a.lastAction = 'continue'; a.lastReason = ''; a.recent.length = 0;
      a.lastIndoor = null; a.holdPlace = null;
    }
    if (EXP) EXP.reset();
    // 拖时间轴是「查这一刻的快照」：出行方式、车、伤亡台账一并从头重来，
    // 不把上一段时间线里的车祸/遇难带进新的一刻。
    if (DRIVE) DRIVE.reset();
    if (INC) INC.reset();
    events.length = 0;
    simT = 0; bucket = -1; used = 0;
    // 补跑（拖轴 catchUp）产生的判断不是连续播放的结果，计数一并清零
    counters.judged = 0; counters.replans = 0; counters.budgetBlocked = 0;
    counters.overflow = 0;
    for (const k of Object.keys(counters.byAction)) counters.byAction[k] = 0;
    for (const k of Object.keys(counters.goals)) counters.goals[k] = 0;
  }

  /**
   * 拖时间轴后的“这一刻初值”：只把当前正在家/在岗的人放回各自门牌，
   * 其余在通勤/办事途中的人保留当前位置。它不是动画轨迹，拖动后接下来
   * 仍然连续判断、走路、绕水；不拖时完全不会调用。
   */
  function restore(peds) {
    if (!Array.isArray(peds)) return;
    for (const a of agents) {
      if (!a) continue;
      const g = a.plan.active(), p = peds[a.i];
      if (!g || !p || !g.dest) continue;
      // 拖动就是“查这一刻的城市快照”：正在家/在岗的节点直接落在他的门牌。
      // 连续播放不调用这里，所以不会把人凭空传送；通勤/办事途中仍保留途中位置。
      if (g.type === 'home' || g.type === 'work') {
        // 同一个门牌会有多人，快照也不能叠成一个点。按人序黄金角散开
        // 1.2–4.4 m：既仍在这栋楼/这个岗位，又读得出是一群人各自在活动。
        const ang = (a.i * 2.399963) % (Math.PI * 2);
        const rad = 1.2 + (a.i % 5) * 0.8;
        p.obj.position.x = g.dest.x + Math.cos(ang) * rad;
        p.obj.position.z = g.dest.z + Math.sin(ang) * rad;
        if (g.arrivedAt === null) g.arrivedAt = -1;   // 快照已在家/在岗
        p.mode = 'net'; p.route = null; p.enterWalk = null;
        a.lastIndoor = null;
      }
    }
  }

  function debug(i) {
    const a = agents[i];
    if (!a) return null;
    const g = a.plan.active();
    return {
      i, cohort: a.kernel.id, role: a.kernel.role,
      kernel: { wade: +a.kernel.wade.toFixed(2), detour: +a.kernel.detour.toFixed(2),
        wait: +a.kernel.wait.toFixed(2), urgency: +a.kernel.urgency.toFixed(2),
        temp: +a.kernel.temp.toFixed(2), speed: +a.kernel.speed.toFixed(2),
        think: +a.kernel.think.toFixed(2) },
      ageBand: a.person ? a.person.ageBand : null,
      status: a.kernel.status,
      circle: a.kernel.circleLabel || null,
      circleId: a.kernel.circleId || null,
      hasCar: !!a.kernel.hasCar,
      info: a.kernel.info ?? null,
      driver: DRIVE ? DRIVE.debug(i) : null,
      incident: INC ? INC.snapshot(i) : null,
      goal: g ? { id: g.id, label: g.label, state: g.state, start: g.startMin,
        due: g.dueMin, dest: g.dest, travel: g.travel, travelReason: g.travelReason } : null,
      goals: a.plan.counts(), detours: a.detours, lastAction: a.lastAction,
      lastReason: a.lastReason || '', recent: a.recent.slice(-6),
      experience: EXP ? EXP.snapshot(i) : null,
    };
  }

  function stats() {
    return { ...counters, simSec: +simT.toFixed(1), people: agents.length,
      events: events.length, byAction: { ...counters.byAction },
      goals: { ...counters.goals },
      circles: circles.filter(Boolean).length,
      driving: DRIVE ? DRIVE.stats().active : 0 };
  }

  return { begin, stepOne, applySocial, noteAction, reset, restore, debug, stats,
    get events() { return events; },
    agent: (i) => agents[i] };
}
