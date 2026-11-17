/**
 * motion-units.js — 全项目唯一的「时间 / 速度」真值源。
 *
 * 【2026-11-13 用户要求】「尤其这个速度，我发现你这个速度经常就是不一致啊，
 *  你这个一定要把所有的这个查清楚」。
 *
 * 之前的问题（实测清查结果）：
 *   1. 步速基准散了 6 套：ped.js 1.42 / citizen.js 1.42 / crowd-life.js 1.42
 *      / day-motion.js 1.25 / day-think.js 1.35 / people.js CLIP_V0.walk 1.35；
 *   2. 动画侧重复乘倍率：main.js 传下去的 h 已经含 CLOCK.speed，
 *      people.js / mark.js 的 mixer.update 又乘了一次 min(clock.speed, 2)；
 *   3. 位移按 h 一次，动画按 h×倍率×LOD3，同一帧人和影子不同步；
 *   4. timeScale 三套口径（绝对值 / 相对基准 / 不设）；
 *   5. 分钟↔秒换算散落 10 处，车速和步速混用同一批 magic number。
 *
 * 规则（所有模块必须遵守，assertSpeedConsistency() 会在启动时自检）：
 *   · 一个「仿真秒」= 1 秒城市时间，已经乘过 CLOCK.speed；
 *   · 所有位移 = m/s × 仿真秒，动画 = 同一个仿真秒，绝不再乘倍率；
 *   · 所有 m/s 常量从这里取；所有时间换算从这里取；
 *   · 倍率只由 clock.js 加一次，其他任何地方不许再乘 clock.speed。
 *
 * 涉水 / 伤亡 / 车辆的阈值不在这里定义，统一从 kernel/thresholds.js 取，
 * 那里逐项写清「实测」还是「目前自己定的」。
 */
import { MEASURED, SELF_SET } from './kernel/thresholds.js';

export const SEC = Object.freeze({ MINUTE: 60, HOUR: 3600, DAY: 86400 });
export const secFromMin = (m) => Number(m) * SEC.MINUTE;
export const minFromSec = (s) => Number(s) / SEC.MINUTE;
export const kmh = (mps) => mps * 3.6;
export const mpsFromKmh = (v) => v / 3.6;

/** 步行：唯一的绝对基准。1.35 m/s = Mixamo walk clip 的设计步速。 */
export const WALK = Object.freeze({
  BASE: 1.35,
  RUN: 3.10,
  FLEE: 3.30,
  RAIN: 1.70,
  MIN: 0.42,          // 最高龄/学龄前也不会低于
  MAX: 1.85,          // 青壮年常态步速上限
  ROUTE_MIN: 0.55,    // 执行层夹取
  ROUTE_MAX: 3.20,
  KERNEL_MAX: 1.75,   // 群体内核步速上限（比 MAX 略保守）
  SLOW_MUL: 0.72,     // slow 动作：决策层与执行层必须同一个值
  SLOW_FLOOR: 0.5,    // 放慢后的步速下限
  HURRY_MUL: 1.30,    // hurry 动作：同上（旧版决策层 1.26 / 执行层 1.30）
  HURRY_CAP: 2.60,
  CROWD_MUL: 0.55,    // 前方有人
  FLEE_MUL: 1.35,     // 逃难相对本人步速的倍率
  ENTER_MIN: 0.55,    // 进楼过渡的最小步速
  RUN_THRESHOLD: 2.1,  // 超过此值播 run clip
  METABOLIC_RUN: 2.6,  // 生理层判定「跑动消耗」的阈值（与动画 clip 阈值不同概念）
  INDOOR: 0,
});

/** 车辆：城市道路法规与动力学的唯一数值表。 */
export const CAR = Object.freeze({
  URBAN_LIMIT: 13.0,      // m/s ≈ 46.8 km/h，城市道路最高限速
  SCHOOL_LIMIT: 8.3,      // m/s ≈ 30 km/h，学校/居民区
  WET_LIMIT: 6.0,         // m/s，积水路段限速
  MIN_CREEP: 1.2,         // m/s，犹豫后爬行
  SPAWN_MIN: 7.5,         // m/s，背景车流随机下限
  SPAWN_MAX: 13.0,        // m/s，不得超过 URBAN_LIMIT
  WET_DEPTH: 0.12,        // m，超过即减速（【目前自己定的】驾驶层减速触发）
  WET_MUL: 0.45,
  // 车辆涉水阈值改取 UNSW WRL 2017/07 全尺寸拖曳水池实测：
  // 小型车 0.15 m 被推移、0.60 m 漂浮；大型车 0.45 m 失稳、0.95 m 漂浮。
  STALL_DEPTH: MEASURED.vehicle.smallCarPushM,      // 实测：小型车开始被水推移 0.15 m
  DROWN_DEPTH: MEASURED.vehicle.largeCarFloatM,     // 实测：大型车漂浮深度 0.95 m
  STALL_HESITATE: 45,     // 仿真秒，犹豫后尝试脱困
  CREEP_MUL: 0.30,
  STORY_WADE_MUL: 0.55,  // 旧故事车在积水里的折减（纳入真值表，不再散落）
  FOLLOW_STOP_GAP: 3.8,   // m，跟车停住（旧 6.5：全城短路段下几乎每路口都停死）
  FOLLOW_SLOW_GAP: 9.0,   // m，开始收油
  ENTRY_BUSY: 2.0,        // m，路口入口排队（旧 8：短路段里整段都算占用）
  YIELD_DIST: 12.0,       // m，斑马线让行探测：人行道中心离车道约 8~9 m
  YIELD_STOP: 6.0,        // m，行人已进入车行道则停住
  STOP_LINE: 0.86,        // 路段里程比，红灯停止线
  // 信号周期 100 s：DDOT《Transportation Operations and Safety》白皮书（2011）
  // 载明辖区高峰时段信号周期取 100 s、疏散预案取 240 s。旧值 40 s 是自设，
  // 比真实城市信号周期短得多（常见 60–120 s），会让红灯等待系统性偏短。
  RED_CYCLE: 100,         // 仿真秒，信号周期
  RED_NS: 18,             // 南北向红灯时长
  GREEN_EW: 20,           // 东西向放行起点
  TURN_RATE: 2.6,         // rad/s，方向盘转速上限
  LANE_OFF: 2.0,          // m，右侧通行：车道中心离路中线右偏
  PARK_OFF: 5.2,          // m，停放车贴路缘（不占车道中心）
  ARRIVE_R: 14,           // m，到达目的地判定
  CLAIM_RADIUS: 1200,     // m，认领车辆的最大距离：再远就改步行/公交（原版 3 km 跨城瞬移）
  WHEEL_CIRC: 0.32,       // m，车轮视觉转速
});

/** 动画：唯一 timeScale 口径。speed 是绝对 m/s，clip 是设计步速 m/s。 */
export const ANIM = Object.freeze({
  CLIP_V0: Object.freeze({
    walk: 1.35, run: 3.10, stairs_up: 0.90, stairs_down: 1.10,
    side_l: 1.10, side_r: 1.10, turn180: 1.00, idle: 0,
  }),
  MIN: 0.50,
  MAX: 2.00,
  /** 动画时间 = 仿真秒，禁止再乘 CLOCK.speed（dt 已经含倍率）。 */
  animDt(simDt) { return Math.max(0, Number(simDt) || 0); },
  /** 唯一 timeScale：实际速度 / 该 clip 的设计速度。 */
  timeScale(speed, clip = 'walk') {
    const v0 = ANIM.CLIP_V0[clip] || WALK.BASE;
    if (!(v0 > 0)) return 1;
    return Math.max(ANIM.MIN, Math.min(ANIM.MAX, (Number(speed) || 0) / v0));
  },
  /** 动作 clip 的阈值也统一：超过 RUN_THRESHOLD 才播跑。 */
  clipFor(speed) { return (Number(speed) || 0) > WALK.RUN_THRESHOLD ? 'run' : 'walk'; },
});

/**
 * 人群涉水 / 事故的阈值，和伤亡统计共用，避免两处各写一套。
 * 数值统一从 kernel/thresholds.js 取，那里逐项写清是「实测」还是「目前自己定的」。
 * 旧版 1.15 m 致命水深、150 秒耐受时间全部没有一手依据，已弃用。
 * 由这些数算出的伤亡／被困是**模型输出，不是实测**，必须附敏感性分析。
 */
export const RISK = Object.freeze({
  WADING: SELF_SET.wadingDepthM,                    // 目前自己定的，状态标签用
  DEEP: SELF_SET.deepWaterM,                        // 目前自己定的
  LETHAL: MEASURED.instabilityDV.adultMaxDepthM,    // ARR 成人失稳最大深度（不是死亡判定）
  STRANDED_SEC: SELF_SET.strandedSec,               // 目前自己定的
  LETHAL_SEC: SELF_SET.casualty.exposureSecAdult,   // 目前自己定的
  CAR_TRAP_DEPTH: MEASURED.vehicle.smallCarFloatM,  // 实测：小型车漂浮深度 0.60 m
  CAR_LETHAL_DEPTH: SELF_SET.carFloatM,             // 同实测值
  CAR_ABANDON_SEC: SELF_SET.carAbandonSec,          // 目前自己定的
  /** 失稳深度按真实年龄取，只有儿童／成人两档，见 thresholds.js。 */
  CHILD_INSTABILITY_M: MEASURED.instabilityDV.childMaxDepthM,
});

/**
 * 启动自检：把散落各处的旧 magic number 与真值比对，不一致直接报警。
 * 这个函数只读常量、不改状态，验收脚本也会调它。
 */
export function assertSpeedConsistency(probe = {}) {
  const bad = [];
  const eq = (name, got, want) => {
    if (got === undefined) return;
    if (Math.abs(Number(got) - Number(want)) > 1e-6) bad.push(`${name}: ${got} ≠ ${want}`);
  };
  eq('WALK.BASE', probe.walkBase, WALK.BASE);
  eq('WALK.RUN', probe.walkRun, WALK.RUN);
  eq('CLIP_V0.walk', probe.clipWalk, ANIM.CLIP_V0.walk);
  eq('CLIP_V0.run', probe.clipRun, ANIM.CLIP_V0.run);
  eq('CAR.URBAN_LIMIT', probe.carLimit, CAR.URBAN_LIMIT);
  eq('CAR.LANE_OFF', probe.laneOff, CAR.LANE_OFF);
  eq('CAR.STOP_LINE', probe.stopLine, CAR.STOP_LINE);
  // 【散落点一致性】同一概念不许两处写两个值。
  if (probe.slowDecision !== undefined && Math.abs(probe.slowDecision - WALK.SLOW_MUL) > 1e-6) {
    bad.push(`决策层 slow 系数 ${probe.slowDecision} ≠ 执行层 ${WALK.SLOW_MUL}`);
  }
  if (probe.hurryDecision !== undefined && Math.abs(probe.hurryDecision - WALK.HURRY_MUL) > 1e-6) {
    bad.push(`决策层 hurry 系数 ${probe.hurryDecision} ≠ 执行层 ${WALK.HURRY_MUL}`);
  }
  if (probe.statusSpeeds) {
    for (const [name, v] of Object.entries(probe.statusSpeeds)) {
      if (v < WALK.MIN || v > WALK.MAX) bad.push(`${name} 步速 ${v} 超出 [${WALK.MIN},${WALK.MAX}]`);
    }
  }
  if (CAR.SPAWN_MAX > CAR.URBAN_LIMIT) bad.push('背景车流上限超过法定限速');
  if (CAR.SCHOOL_LIMIT > CAR.URBAN_LIMIT) bad.push('学区限速高于城市限速');
  if (ANIM.CLIP_V0.walk !== WALK.BASE) bad.push('clip 设计步速与步行基准不一致');
  return { ok: bad.length === 0, errors: bad, truth: {
    walkBase: WALK.BASE, walkRun: WALK.RUN, carLimit: CAR.URBAN_LIMIT,
    minuteSec: SEC.MINUTE, redCycle: CAR.RED_CYCLE,
  } };
}
