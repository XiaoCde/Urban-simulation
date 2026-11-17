/**
 * 内核数值边界与回归自检（2026-11-17 新增）
 *
 * 两部分：
 *  A. 正常输入回归：28 组黄金值，取自修复前的 `out/kernel_baseline_before.json`。
 *     这一节保证「修边界不改动正常路径」——任何一条变了都说明改坏了仿真口径。
 *  B. 非法/越界输入：NaN、Infinity、负数、空表、null、越界索引、恒 0 随机源。
 *     这些是排查中复现出来的崩溃与错误数字，逐条钉死。
 *
 * 纯 Node 运行，不启动浏览器、不依赖 three/window/document。
 * 运行：cd web && node tests/check-kernel-boundaries.mjs
 */
import { wadingSpeed, hazardRatingValue, hazardRating, instability,
  buildHazardInput } from '../src/kernel/hazard-input.js';
import { normalCdf, jonkmanFatality, fatalRiskPerSecond,
  personalThreshold } from '../src/kernel/fatality.js';
import { observedCapAt, warningReachedBy, mobilisationEqS2,
  mobilisedBy } from '../src/kernel/mobilisation.js';
import { floorElevationM, capacityPerFloor, floodFloor, goesToBasement,
  floorsFromHeight, assignFloor } from '../src/kernel/floors.js';
import { hash01 } from '../src/kernel/draw.js';
import { warnAtOf, warningLeadMin, receivesWarning } from '../src/kernel/warning.js';
import { instabilityDepthFor, exposureSecFor } from '../src/kernel/thresholds.js';
import { behaviorBandOf, sampleMarginal } from '../src/kernel/population.js';
import { nhtsAgeBand, buildDayNodes } from '../src/kernel/day-baseline.js';
import * as C from '../src/kernel/choice-model.js';
import { weightedIndex, normal, mulberry32 } from '../src/kernel/rng.js';
import { measuredComfortableSpeedMs } from '../src/kernel/walk-speed.js';
import { attributesFromSim } from '../src/kernel/attributes.js';
import { buildBuildingIndex, assignPersonFloor, assignCohortFloors,
  evaluateFloodOnFloors } from '../src/kernel/floor-occupancy.js';

const results = [];
const check = (name, pass, extra = '') => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};
const fin = (v) => Number.isFinite(v);
const norm = (v) => (v === undefined ? null : v);
const eq = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const near = (a, b, eps = 1e-9) => Number.isFinite(a) && Math.abs(a - b) < eps;

// ---------------------------------------------------------------- A 正常输入回归
const GOLD = {
  wading: [1.67, 1.438571429, 1.207142857, 0.86],
  hazard: [0, 0.3, 1, 2],
  jonkman: [0.000158571, 0.001282046, 0.002858117, 0.007540257, 0.011925202],
  normalCdf: [0.001349967, 0.158655264, 0.500000001, 0.841344736, 0.998650033],
  risk: [0, 0.000007316702, 0.000048135221, 0.000159901743],
  threshold: [0.94729221, 0.999174156, 0.808854881, 0.453053263, 0.33518425, 0.360261805],
  hash: [0.634187014, 0.879223546, 0.093384697, 0.9511723, 0.370393711],
  mobilised: [0, 0.111, 0.888, 0.957, 0.986],
  eqS2: [0, 0.597510157, 0.999999994, 1],
  warnReached: [0.098, 0.102983413, 0.367269942, 0.962905126],
  floors: [1, 2, 4, 6],
  elev: [0.457, 3.757, 7.057, 10.357],
  cap: [2, 10, 43],
  floodFloor: ['safe', 'moveUp', 'moveUp', 'moveUp'],
  warnLead: [54.359699, 73.85031, 52.100233, 279.555884],
  warnAt: [526.14969, 47.899767, 1150.444116],
  instabDepth: [0.5, 1.2, 1.2, 1.2],
  exposure: [80, 150, 150, 150],
  ageBand: ['preschool', 'child', 'prime', 'old'],
  nhtsBand: ['05-17', '05-17', '18-34', '65+'],
  gait: [null, 1.358, 1.434, 1.26, 0.968],
  wIndex: [0, 1, 2],
  normalSamples: [1.736122985, -1.177410023, 0.371374078],
};
const round9 = (v) => (v === null || v === undefined ? v : Number(v.toFixed(9)));
// 预警两项取自 6 位小数的基线表，按同一精度比对，避免把「记录精度」当成回归差异。
const round6 = (v) => (v === null || v === undefined ? v : Number(v.toFixed(6)));

check('回归：涉水步速 0/0.1/0.2/0.35 m',
  eq([0, 0.1, 0.2, 0.35].map((d) => round9(wadingSpeed(d))), GOLD.wading));
check('回归：HR 连续值', eq([0, 0.3, 1, 2].map((d) => round9(hazardRatingValue(d, 0.5, 0))), GOLD.hazard));
check('回归：Jonkman 死亡率 5 档',
  eq([0.1, 0.5, 1, 2.5, 4].map((h) => round9(jonkmanFatality({ depthM: h, riseRateMhr: 0 }).fd)), GOLD.jonkman));
check('回归：标准正态 CDF', eq([-3, -1, 0, 1, 3].map((z) => round9(normalCdf(z))), GOLD.normalCdf));
check('回归：风险速率', eq([0, 0.1, 0.5, 0.9].map((f) => Number(fatalRiskPerSecond(f).toFixed(12))), GOLD.risk));
check('回归：个人阈值哈希', eq([0, 1, 2, 10, 100, 999].map((i) => round9(personalThreshold(i))), GOLD.threshold));
check('回归：hash01（带 salt）', eq([0, 1, 2, 10, 999].map((i) => round9(hash01(i, 0x5bd1))), GOLD.hash));
check('回归：实测动员率插值', eq([0, 60, 480, 1440, 4320].map((t) => round9(mobilisedBy(t))), GOLD.mobilised));
check('回归：Eq.(S2) 形状', eq([0, 60, 480, 1440].map((t) => round9(mobilisationEqS2(t, 1.37, 64))), GOLD.eqS2));
check('回归：预警到达比例', eq([0, 60, 480, 1440].map((t) => round9(warningReachedBy(t))), GOLD.warnReached));
check('回归：高度→层数', eq([3.3, 8, 12, 20].map((h) => floorsFromHeight(h)), GOLD.floors));
check('回归：楼层高程', eq([1, 2, 3, 4].map((f) => Number(floorElevationM(f).toFixed(6))), GOLD.elev));
check('回归：每层容量', eq([100, 500, 2000].map((a) => capacityPerFloor({ area_m2: a, function: 'residential' })), GOLD.cap));
check('回归：楼层淹没状态',
  eq([[0.1, 1, 3], [2, 1, 3], [5, 1, 3], [10, 3, 5]].map(([w, c, t]) =>
    floodFloor({ waterDepthM: w, currentFloor: c, totalFloors: t }).status), GOLD.floodFloor));
check('回归：预警前置时间', eq([0, 1, 50, 999].map((i) => round6(warningLeadMin(i))), GOLD.warnLead));
check('回归：预警到达时刻', eq([[600, 1], [100, 50], [1430, 999]].map(([m, i]) => round6(warnAtOf(m, i))), GOLD.warnAt));
check('回归：失稳深度按年龄', eq([5, 20, 40, 70].map(instabilityDepthFor), GOLD.instabDepth));
check('回归：暴露耐受时长', eq([5, 20, 40, 70].map(exposureSecFor), GOLD.exposure));
check('回归：行为分档', eq([3, 10, 30, 70].map(behaviorBandOf), GOLD.ageBand));
check('回归：NHTS 年龄带', eq([3, 10, 30, 70].map(nhtsAgeBand), GOLD.nhtsBand));
check('回归：实测步速（含 20 岁以下返回 null）',
  eq([5, 20, 40, 70, 90].map((a) => { const v = measuredComfortableSpeedMs(a, false); return v === null ? null : round9(v); }), GOLD.gait));
check('回归：按权重抽下标', eq([0.1, 0.5, 0.9].map((u) => weightedIndex([1, 2, 3], () => u)), GOLD.wIndex));
check('回归：Box-Muller 正态', eq([0.1, 0.5, 0.9].map((u) => round9(normal(() => u))), GOLD.normalSamples));
check('回归：mulberry32 同种子可复现', near(mulberry32(42)(), 0.601103752));

// ---------------------------------------------------------------- B 边界与异常输入
check('边界：水深 >0.35 m 不再返回 NaN（查表键名 0.60/0.90）',
  [0.4, 0.5, 0.6, 0.8, 0.9, 1.2].every((d) => fin(wadingSpeed(d)) && wadingSpeed(d) > 0));
check('边界：buildHazardInput 的 walkSpeedMs 是有限正数',
  fin(buildHazardInput({ depthM: 0.5 }).walkSpeedMs));
check('边界：HR 输入 undefined 返回 0 而不是 NaN',
  hazardRatingValue(undefined) === 0 && hazardRating(NaN) === 'none');
check('边界：instability(NaN) 不判失稳且 dv 有限',
  instability(undefined).unstable === false && fin(instability(NaN).dv));
check('边界：buildHazardInput(null) 不抛错且字段有限', (() => {
  const x = buildHazardInput(null);
  return fin(x.waterDepthM) && fin(x.walkSpeedMs) && fin(x.hazardRatingValue);
})());
check('边界：normalCdf(+∞)=1 / (−∞)=0', normalCdf(Infinity) === 1 && normalCdf(-Infinity) === 0);
check('边界：负的参考时长不再把风险率放大几千倍',
  near(fatalRiskPerSecond(0.5, -5), fatalRiskPerSecond(0.5), 1e-12));
check('边界：personalThreshold(−1/∞) 不退化为 0',
  personalThreshold(-1) > 0 && personalThreshold(Infinity) > 0);
check('边界：hash01(−1/∞) 不退化为 0', hash01(-1, 0) > 0 && hash01(Infinity, 0) > 0);
check('边界：动员点表相邻时刻相同不产生 NaN',
  fin(observedCapAt(0, [{ minutes: 0, rate: 0 }, { minutes: 0, rate: 1 }])));
check('边界：动员点表为空返回 0 而不抛错', observedCapAt(100, []) === 0);
check('边界：动员点表 rate 越界被夹到 [0,1]',
  observedCapAt(10, [{ minutes: 0, rate: -5 }, { minutes: 20, rate: 9 }]) <= 1);
check('边界：warningReachedBy 越界 band 返回有限概率',
  fin(warningReachedBy(480, 'A1_1_Fast', 3)) && fin(warningReachedBy(480, 'A1_1_Fast', -1)));
check('边界：Eq.(S2) 形状参数 0 不产生 Infinity/NaN',
  fin(mobilisationEqS2(10, 0, 64)) && fin(mobilisationEqS2(10, 1.37, 0)));
check('边界：楼层高程不接受 Infinity 层号 / NaN 基础高度',
  fin(floorElevationM(Infinity)) && !Number.isNaN(floorElevationM(2, NaN)));
check('边界：Infinity 占地面积不产生 Infinity 容量',
  capacityPerFloor({ area_m2: Infinity }) === 0);
check('边界：assignFloor 面对 Infinity 面积把人判室外',
  assignFloor({ height_m: 10, area_m2: Infinity, function: 'residential' }, 5).indoor === false);
check('边界：floodFloor 面对 Infinity 层数返回有限目标层', (() => {
  const r = floodFloor({ waterDepthM: 1, currentFloor: 1, totalFloors: Infinity });
  return fin(r.targetFloor) && fin(r.safeFloor);
})());
check('边界：goesToBasement 的 share 为 NaN / >1 / <0 时行为确定', (() => {
  const a = goesToBasement(1, NaN), b = goesToBasement(1, 2), c = goesToBasement(1, -1);
  return typeof a === 'boolean' && b === true && c === false;
})());
check('边界：warnAtOf 的见水时刻超过一天量程时仍可收到预警',
  fin(warnAtOf(2000, 1)) && warnAtOf(2000, 1) <= 1440);
check('边界：null / NaN 年龄走保守成人档',
  instabilityDepthFor(null) === 1.2 && exposureSecFor(NaN) === 150);
check('边界：无效年龄分档不再落到 oldest / 05-17',
  behaviorBandOf(undefined) === 'prime' && nhtsAgeBand(NaN) === '18-34');
check('边界：extras 分钟越界不产生 start>due 的倒挂节点', (() => {
  for (const m of [2000, -100, NaN, 1400]) {
    const nodes = buildDayNodes({ age: 40, hasMinor: false }, () => 0.5, [{ minute: m }]);
    if (nodes.some((n) => n.start > n.due)) return false;
  }
  return true;
})());
check('边界：buildDayNodes(extras=null) 不抛错',
  Array.isArray(buildDayNodes({ age: 40, hasMinor: false }, () => 0.5, null)));
check('边界：sampleMarginal(Infinity) 收敛到默认 3000 人', (() => {
  const m = sampleMarginal(Infinity);
  return Object.values(m.ageBand5y).reduce((a, b) => a + b, 0) === 3000;
})());
check('边界：decideProtectiveAction(null, null) 不抛错且概率有限', (() => {
  const r = C.decideProtectiveAction(null, null);
  return fin(r.probability) && r.probability >= 0 && r.probability <= 1;
})());
check('边界：knowledgeScore / actionScore 无参不抛错',
  fin(C.knowledgeScore()) && fin(C.actionScore(null, 0)));
check('边界：非法威胁档不产生 NaN 效用', (() => {
  const u = C.protectiveActionUtilities({ threat: 'foo' }, null);
  return fin(u.evacuate) && fin(u.stay);
})());
check('边界：NaN 年龄不产生 NaN 概率', (() => {
  const r = C.decideProtectiveAction({ age: NaN, waterDepthM: 0.5, threat: 'low' }, () => 0.5);
  return fin(r.probability) && fin(r.utility);
})());
check('边界：注入空动员点表不抛错',
  fin(C.decideProtectiveAction({ waterDepthM: 0.5, mobilisationPoints: [] }, () => 0.5).probability));
check('边界：weightedIndex(null / 负权重 / 缺 rnd) 不抛错',
  weightedIndex(null, () => 0.5) === 0 && weightedIndex([-1, NaN], () => 0.5) === 0
  && weightedIndex([1, 2], null) === 0);
check('边界：normal(恒 0 随机源) 不死循环、越界源不返回 NaN', (() => {
  const a = normal(() => 0);
  const b = normal(() => 1.5);
  const c = normal(() => NaN);
  return a === 0 && fin(b) && fin(c);
})());
check('边界：20 岁以下无实测步速，返回 null 而不是抛错',
  measuredComfortableSpeedMs(3) === null);
check('边界：attributesFromSim(null) 不抛错且 cost 有限',
  fin(attributesFromSim(null).cost));
check('边界：离线楼层索引带 function 与 floorHeightM（与运行时同口径）', (() => {
  const idx = buildBuildingIndex([
    { id: 'a', center: [0, 0], height_m: 12, function: 'office', area_m2: 600, name: 'A' },
    { id: 'b', center: [10, 10], height_m: 9, function: 'residential', area_m2: 300, name: 'B' },
  ]);
  const one = assignPersonFloor(idx, 0, 0, 0, 'work');
  return one.function === 'office' && fin(one.floorHeightM) && one.floorHeightM > 0;
})());
check('边界：离线淹没评估拿到功能层高而不是默认 3.3', (() => {
  const idx = buildBuildingIndex([
    { id: 'o', center: [0, 0], height_m: 12, function: 'office', area_m2: 600, name: 'O' },
  ]);
  const c = assignCohortFloors(idx, [{ x: 0, z: 0, kind: 'work' }]);
  return c.people[0].floorHeightM > 3.3 && fin(evaluateFloodOnFloors(c.people, () => 0.2).counts.safe);
})());

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：' + failed.map((r) => r.name).join('；'));
  process.exit(1);
}
