/**
 * _check_round4_evidence.mjs — 纯 Node，验收 Muse 第四轮回件接进来的真实数值。
 *
 * 验的是「原来自己定的那批数，现在是不是真的换成了有出处的值」，
 * 不是验模型好不好。跑法：node _check_round4_evidence.mjs
 *
 * 覆盖：实测证据表的出处、属性量纲换算、年龄别步速、官方出行次数与
 * 接送概率、FD2321 碎屑因子、Silva 实测动员率、同伴输入通道与 VR4 定性对照、
 * 几处引文更正，以及代码里是否还残留自设的 ×12 / 0.001 / S 形曲线。
 */
import fs from 'node:fs';
import {
  EVIDENCE_META, BOROWSKI_DESIGN, BOHANNON_GAIT, NHTS_TRIPS_PER_DAY,
  tripsPerDayFor, FD2321_DEBRIS_FACTOR, AHSANUZZAMAN_CONTINUE,
  ARSHAGHI_VR4, HA_EVACUATION_LOGIT, XU_CONDITIONAL_LOGIT,
  ARR_HAZARD_CLASSES, TRANSITION_MATRIX_STATUS,
} from '../src/kernel/evidence-tables.js';
import {
  MOBILISATION_OBSERVED, SILVA_SCENARIOS, mobilisedBy,
  mobilisationEqS2, warningReachedBy, MOBILISATION_META,
} from '../src/kernel/mobilisation.js';
import { attributesFromSim, ATTRIBUTE_META } from '../src/kernel/attributes.js';
import { measuredComfortableSpeedMs, WALK_SPEED_META } from '../src/kernel/walk-speed.js';
import { debrisFactorOf, buildHazardInput } from '../src/kernel/hazard-input.js';
import { buildDayNodes, DAY_BASELINE_META } from '../src/kernel/day-baseline.js';
import { PICKUP_RATE } from '../src/social-circles.js';
import { makeCitizen } from '../src/citizen.js';
import { samplePerson } from '../src/kernel/population.js';
import { makeKernel, judge } from '../src/cohort.js';
import { decideProtectiveAction, CHOICE_META } from '../src/kernel/choice-model.js';
import { mulberry32 } from '../src/kernel/rng.js';

const checks = [];
const ok = (name, cond, detail = '') => checks.push([name, !!cond, detail]);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf-8');

console.log('===== 第四轮回件接入验收 =====\n');

// ---- 1 证据表：每张表都要有真实出处 ----
const tableObjs = {
  BOROWSKI_DESIGN, BOHANNON_GAIT, NHTS_TRIPS_PER_DAY, FD2321_DEBRIS_FACTOR,
  AHSANUZZAMAN_CONTINUE, ARSHAGHI_VR4, HA_EVACUATION_LOGIT, XU_CONDITIONAL_LOGIT,
  ARR_HAZARD_CLASSES, TRANSITION_MATRIX_STATUS, SILVA_SCENARIOS, MOBILISATION_OBSERVED,
};
const missingSource = Object.entries(tableObjs).filter(([, v]) => !v.source);
ok('13 张实测表全部带文章／机构出处', EVIDENCE_META.tables.length === 13 && missingSource.length === 0,
  missingSource.map(([k]) => k).join(','));
ok('证据表里没有混入「目前自己定的」条目', EVIDENCE_META.classification.includes('不含'));

// ---- 2 属性量纲：米→英里、秒→分钟、绕路→美元，基准是 Table 3 ----
const attr = attributesFromSim({ distGoal: 500, timeToDue: 45, shelteredSec: 100 });
ok('500 m 换算成 0.3107 英里', near(attr.raw.miles, 500 / 1609.344),
  attr.raw.miles.toFixed(4));
ok('100 秒换算成 1.667 分钟', near(attr.raw.waitTimeMin, 100 / 60),
  attr.raw.waitTimeMin.toFixed(3));
ok('绕路美元用正文实测 32.78 美元/英里',
  near(attr.raw.costUSD, attr.raw.miles * BOROWSKI_DESIGN.walkingCompensationUSDPerMile),
  attr.raw.costUSD.toFixed(2) + ' USD');
ok('四个属性都按实测设计范围归一化到 0–1',
  ['cost', 'travelTime', 'waitTime', 'walkDistance'].every(
    (k) => attr[k] >= 0 && attr[k] <= 1));
ok('Cost 归一化基准是 Table 3 的 0–40 美元', BOROWSKI_DESIGN.costUSD.max === 40);
ok('同伴比例定义是自我中心网络最多 5 人',
  BOROWSKI_DESIGN.egocentricNetworkMaxSize === 5
  && ATTRIBUTE_META.peerDefinition.includes('自我中心'));

// ---- 3 年龄别步速 ----
ok('25 岁男性舒适步速用 Bohannon & Andrews 实测 1.358 m/s',
  near(measuredComfortableSpeedMs(25, false), 1.358, 1e-9));
ok('85 岁女性用实测 0.94 m/s', near(measuredComfortableSpeedMs(85, true), 0.94, 1e-9));
ok('20 岁以下没有实测值，返回 null', measuredComfortableSpeedMs(10, false) === null);
ok('正确引文是 Bohannon & Andrews / Physiotherapy 97:182–189',
  BOHANNON_GAIT.source.authors.includes('Andrews')
  && BOHANNON_GAIT.source.journal.includes('Physiotherapy 97:182'));
const adult = makeCitizen(11, 20261115, { ...samplePerson(11, 20261115), age: 45, sex: '1' });
const child = makeCitizen(12, 20261115, { ...samplePerson(12, 20261115), age: 8, sex: '2' });
ok('成年人步速标为实测出处', adult.speedSource.includes('Bohannon & Andrews'));
ok('儿童步速显式标「目前自己定的」', child.speedSource.includes('目前自己定的'));
ok('Weidmann 自由速度 1.34 m/s 没有冒充标准差',
  WALK_SPEED_META.freeFlow.freeSpeedMs === 1.34
  && WALK_SPEED_META.freeFlow.note.includes('未发表'));

// ---- 4 官方出行次数与接送概率 ----
ok('官方全员 2.28 次/人/日', NHTS_TRIPS_PER_DAY.overall === 2.28);
ok('年龄档次数：36–65 岁 2.5、>65 岁 2.0',
  tripsPerDayFor(45) === 2.5 && tripsPerDayFor(80) === 2.0);
ok('NHTS 无官方时段分档已写明', NHTS_TRIPS_PER_DAY.officialTimeOfDayBins === null
  && DAY_BASELINE_META.selfSet[0].includes('无官方'));
const R = samplePerson(11, 20261115);
const dayNodes = buildDayNodes(R, mulberry32(9), []);
const outCount = dayNodes.filter((n) => n.type !== 'home').length;
ok('一天外出节点数按官方出行次数，不再固定 7 个',
  Math.abs(outCount - Math.round(tripsPerDayFor(R.age))) <= 1,
  `官方 ${tripsPerDayFor(R.age)}，实际外出 ${outCount}，节点总数 ${dayNodes.length}`);
ok('接送概率用官方次数与组内占比，不再乘自设的 12',
  PICKUP_RATE.withMinorWithinGroup > 0
  && !read('../src/social-circles.js').includes('pickupRate * 12'));
const lambda = tripsPerDayFor(45) * PICKUP_RATE.withMinorWithinGroup;
const pickupP = 1 - Math.exp(-lambda);
ok('有未成年子女家庭每天有接送的概率在合理量级（<30%）',
  pickupP > 0 && pickupP < 0.30, (pickupP * 100).toFixed(2) + '%');

// ---- 5 FD2321 碎屑因子 ----
ok('DF 按 FD2321 Table 3.1 城市列：0.1 m→0、0.4 m→1、1.0 m→1',
  debrisFactorOf(0.1) === 0 && debrisFactorOf(0.4) === 1 && debrisFactorOf(1.0) === 1);
ok('流速 >2 m/s 时 DF=1', debrisFactorOf(0.1, 2.5) === 1);
ok('HR 界值归属写明 FD2320 是 2.0、FD2321 是 2.5',
  FD2321_DEBRIS_FACTOR.hazardRatingBands.fd2320Planning.extreme === 2.0
  && FD2321_DEBRIS_FACTOR.hazardRatingBands.fd2321.significant === 2.5);
const hi = buildHazardInput({ depthM: 0.34, minutesSinceWarning: 120, officialWarning: true });
ok('34 cm 水的 HR 不再把 DF 一律取 0', hi.hazardRatingValue > 0.34 * 0.5);

// ---- 6 动员曲线 ----
ok('运行时动员率用 Table S2 实测点，不是自设 S 形曲线',
  near(mobilisedBy(480), 0.888, 1e-9) && near(mobilisedBy(1440), 0.957, 1e-9)
  && MOBILISATION_META.runtime.includes('实测点'));
ok('Eq.(S2) 原文公式已存，形式正确',
  near(mobilisationEqS2(64, 1.37, 64), 1 - Math.exp(-1), 1e-9)
  && MOBILISATION_META.equations.S2.includes('1 − exp'));
ok('Table S2 五情景三档参数齐全',
  ['A1_1_Fast', 'A1_2_Moderate', 'A1_3_Slow'].every(
    (k) => SILVA_SCENARIOS[k].am.length === 3 && SILVA_SCENARIOS[k].bm.length === 3));
ok('警告到达不再把 Ct 当上限（8 小时 >10%）', warningReachedBy(480) > 0.10,
  (warningReachedBy(480) * 100).toFixed(1) + '%');

// ---- 7 同伴输入通道与 VR4 定性对照 ----
function rate(patch, n = 3000) {
  const person = { role: '管理', status: '白领', ageBand: 'middle',
    real: { age: 48, sex: '1', socCode: '11', hasMinor: true,
      householdVehicles: 1, householdSize: 4 },
    citizen: { ageBand: 'middle', ageGroup: 'adult', age: 48, experience: 0.6,
      sightM: 40, veteran: false, rookie: false,
      hazard: { score: 0.3, tier: 'x', trained: false, runs: 1, sightBonus: 3 } } };
  const k = makeKernel(3, person, mulberry32(999), null);
  const s = { depthHere: 0.12, depthAhead: 0.34, farDepth: 0, farDist: 0,
    blocked: false, progress: 0.5, late: false, goalType: 'errand', overdue: 0,
    timeToDue: 45, pressure: 0.2, rain: 0, fatigue: 0.15, stuck: 0, detours: 0,
    wetness: 0.05, hunger: 20, umbrella: 'none', expDepth: 0, doneToday: 1,
    abandonToday: 0, detoursToday: 0, shelteredSec: 0, homeBias: 0,
    confidence: 0.6, abandonCd: false, detourCd: false, waitCd: false,
    goalLabel: '办事', waitSec: 1, minutesSinceWarning: 120,
    officialWarning: true, ...patch };
  const rnd = mulberry32(777);
  let p = 0;
  for (let i = 0; i < n; i++) p += judge(k, s, rnd).choice.probability;
  return p / n;
}
const noPeers = rate({});
const stayPeers = rate({ peersStay: 0.9 });
ok('同伴比例输入通道已打开（不再是写死的 0）', Math.abs(noPeers - stayPeers) > 0.005,
  `0 → ${noPeers.toFixed(3)}，90% 留下 → ${stayPeers.toFixed(3)}`);
ok('同伴都留下时保护倾向下降（方向与 Borowski Table 4 一致）', stayPeers < noPeers);
ok('VR4 四组实测比例齐全', ARSHAGHI_VR4.conditions.length === 4
  && ARSHAGHI_VR4.conditions[0].safeRoutePct === 100
  && ARSHAGHI_VR4.conditions[3].safeRoutePct === 33.3);
ok('VR4 水位没有厘米换算，未冒充水深', ARSHAGHI_VR4.cmConversionExists === false);
function vr4Direction(peersStay, peersRide, threat) {
  const rnd = mulberry32(31);
  let hit = 0;
  for (let n = 0; n < 3000; n++) {
    const o = decideProtectiveAction({ age: 48, female: false, priorFloods: 0,
      officialWarning: true, warningInformation: 2, surprise: 0.2,
      floodImpact: 0.3, waterDepthM: 0.34, peersStay, peersRide, threat,
      minutesSinceWarning: 240, hazardRatingValue: 1.0,
      hazardRatingExtremeBound: 2.0 }, rnd);
    if (o.protect) hit++;
  }
  return hit / 3000;
}
const safeCrowd = vr4Direction(0, 0.9, 'moderate');
const riskyCrowdLow = vr4Direction(0.9, 0, 'moderate');
const riskyCrowdHigh = vr4Direction(0.9, 0, 'extreme');
ok('同伴效应方向与 VR4 一致：安全人群更愿保护、危险人群更不愿',
  safeCrowd > riskyCrowdLow);
ok('危险升高时从众衰减（VR4 高水位 79.1% vs 低水位 33.3% 的同向趋势）',
  riskyCrowdHigh > riskyCrowdLow);

// ---- 8 外部对照数据只存不用 ----
ok('Ha 2025 Table 5 全表已存档（X1–X15 + 常数项）',
  Object.keys(HA_EVACUATION_LOGIT.coefficients).length === 16
  && HA_EVACUATION_LOGIT.source.sample.includes('407'));
ok('Ha 2025 明确标「不进运行时效用」', HA_EVACUATION_LOGIT.note.includes('不进运行时'));
ok('Xu 2026 条件 logit 标注无水深属性', XU_CONDITIONAL_LOGIT.noWaterDepthAttribute === true);
ok('转移矩阵仍无可引用数值，说明理由已登记',
  TRANSITION_MATRIX_STATUS.completeNumericMatrixPublished === false
  && TRANSITION_MATRIX_STATUS.whyNotUsed.length > 20);
ok('Ahsanuzzaman Table 3 比例是驾驶人数据，标注了符号警告',
  AHSANUZZAMAN_CONTINUE.source.sample.includes('714')
  && AHSANUZZAMAN_CONTINUE.signWarning.includes('矛盾'));
ok('ARR 1.2/0.5 m 标为危险分级限值',
  ARR_HAZARD_CLASSES.criterion.includes('D·V')
  && ARR_HAZARD_CLASSES.classes.find((c) => c.id === 'H3').depthMaxM === 1.2);

// ---- 9 旧的自设项确实删掉了 ----
const cohortSrc = read('../src/cohort.js');
const choiceSrc = read('../src/kernel/choice-model.js');
ok('cohort.js 里不再有 0.001 / 0.01 的属性缩放',
  !cohortSrc.includes('* 0.001') && !cohortSrc.includes('* 0.01'));
ok('choice-model.js 里不再有自设 S 形动员曲线（改为引用实测模块）',
  !choiceSrc.includes('function mobilisedBy(')
  && !choiceSrc.includes('function warningReachedBy(')
  && choiceSrc.includes('export { mobilisedBy, warningReachedBy }'));
ok('模型元数据不再声称「量纲缩放全是自设」',
  CHOICE_META.limits.some((x) => x.includes('实测设计范围')));

console.log('');
let pass = 0;
for (const [name, cond, detail] of checks) {
  console.log(`${cond ? 'PASS ' : 'FAIL '} ${name}${detail ? '  [' + detail + ']' : ''}`);
  if (cond) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);
if (pass < checks.length) process.exitCode = 1;
