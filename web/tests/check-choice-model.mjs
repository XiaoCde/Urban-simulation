/**
 * _check_choice_model.mjs — 纯 Node，验证新离散选择模型。
 *
 * 旧 _check_hazard_unit.mjs 验的是「手写线性打分 + 二元门控」那套实现，
 * 整套已弃用，这里是替换它的新验收。
 *
 * 检查三件事：
 *   1 平静场景（没水没雨没预警）不启动保护行动，不出现无依据改道；
 *   2 概率随危险／预警时长／既往洪水经历／同伴比例按实测系数方向变化；
 *   3 同一处境不同次抽样结果不同（概率抽样，不是阈值开关）。
 *
 * 用法：node _check_choice_model.mjs
 */
import { buildHazardInput } from '../src/kernel/hazard-input.js';
import {
  decideProtectiveAction, waterDepthOrdinalOf, protectiveActionUtilities,
  KNOWLEDGE_LOGIT, ACTION_LOGIT, EVACUATION_LOGIT, MOBILISATION, SCALING, CHOICE_META,
} from '../src/kernel/choice-model.js';
import { MOBILISATION_OBSERVED, mobilisedBy } from '../src/kernel/mobilisation.js';
import { makeKernel, judge, ACTIONS } from '../src/cohort.js';
import { THRESHOLD_META } from '../src/kernel/thresholds.js';
import { mulberry32 } from '../src/kernel/rng.js';

const N = 4000;

function makePerson(runs = 0, trained = false) {
  return {
    role: '管理', status: '白领', ageBand: 'middle',
    real: { age: 48, sex: '1', socCode: '11', hasMinor: true,
      householdVehicles: 1, householdSize: 4 },
    citizen: {
      ageBand: 'middle', ageGroup: 'adult', age: 48, experience: 0.6, sightM: 40,
      veteran: false, rookie: false,
      hazard: { score: runs * 0.3, tier: 'x', trained, runs, sightBonus: 3 },
    },
  };
}

const STATE = {
  depthHere: 0, depthAhead: 0, farDepth: 0, farDist: 0, blocked: false,
  progress: 0.5, late: false, goalType: 'errand', overdue: 0, timeToDue: 45,
  pressure: 0.2, rain: 0, fatigue: 0.15, stuck: 0, detours: 0,
  wetness: 0.05, hunger: 20, umbrella: 'none', expDepth: 0, doneToday: 1,
  abandonToday: 0, detoursToday: 0, shelteredSec: 0, homeBias: 0,
  confidence: 0.6, abandonCd: false, detourCd: false, waitCd: false,
  goalLabel: '办事', waitSec: 1.0, minutesSinceWarning: 0, officialWarning: false,
};

function scenario(runs, patch, seed = 777) {
  const k = makeKernel(3, makePerson(runs), mulberry32(999), null);
  const s = { ...STATE, ...patch };
  const rnd = mulberry32(seed);
  const cnt = {};
  let pSum = 0;
  for (let n = 0; n < N; n++) {
    const o = judge(k, s, rnd);
    cnt[o.action] = (cnt[o.action] || 0) + 1;
    pSum += o.choice.probability;
  }
  return { p: +(pSum / N).toFixed(4), cnt };
}

console.log('===== 离散选择模型验收 =====');
console.log('模型形式:', CHOICE_META.form);
console.log('实测系数来源:', CHOICE_META.coefficientsFrom.length, '份');
console.log('自设项（量纲缩放）:', CHOICE_META.selfSet.join(', '));
console.log('');

const calm = scenario(0, {});
const shallow = scenario(0, { depthAhead: 0.34, depthHere: 0.12, minutesSinceWarning: 5, officialWarning: true });
const warned = scenario(0, { depthAhead: 0.34, depthHere: 0.12, minutesSinceWarning: 120, officialWarning: true });
const deep = scenario(0, { depthAhead: 1.5, depthHere: 0.8, minutesSinceWarning: 240, officialWarning: true });
const exp1 = scenario(1, { depthAhead: 0.34, depthHere: 0.12, minutesSinceWarning: 120, officialWarning: true });
const exp3 = scenario(3, { depthAhead: 0.34, depthHere: 0.12, minutesSinceWarning: 120, officialWarning: true });

const label = (name, r) => console.log(
  `${name.padEnd(30)} 保护概率 ${String(r.p).padEnd(8)} 动作 ${JSON.stringify(r.cnt)}`);
label('平静（没水没雨）', calm);
label('34cm 雨刚下 5 分钟', shallow);
label('34cm 预警 2 小时', warned);
label('1.5m 预警 4 小时', deep);
label('34cm 2h + 经历 1 次', exp1);
label('34cm 2h + 经历 3 次', exp3);

console.log('\n===== 同伴效应随危险衰减（Borowski 2023 Table 4）=====');
function rateWithPeers(depthM, peersStay, threat) {
  const input = { age: 48, female: false, priorFloods: 0, officialWarning: true,
    warningInformation: 2, surprise: 0.2, floodImpact: 0.3, waterDepthM: depthM,
    peersStay, peersRide: 0.1, threat, minutesSinceWarning: 240,
    hazardRatingValue: 1.0, hazardRatingExtremeBound: 2.0 };
  const rnd = mulberry32(31);
  let hit = 0;
  for (let n = 0; n < N; n++) if (decideProtectiveAction(input, rnd).protect) hit++;
  return +(hit / N).toFixed(3);
}
const peerLow = rateWithPeers(0.34, 0.9, 'moderate');
const peerExtreme = rateWithPeers(1.5, 0.9, 'extreme');
console.log(`同伴 90% 留下 · moderate : ${peerLow}`);
console.log(`同伴 90% 留下 · extreme  : ${peerExtreme}（危险越大越不跟着留下）`);

console.log('\n===== 水深编码（Thieken 2023 Table S1）=====');
for (const d of [0, 0.2, 0.6, 1.5, 3, 5]) {
  console.log(`  ${String(d).padEnd(5)} m → ${waterDepthOrdinalOf(d)} 级`);
}

console.log('\n===== 自设项敏感性（实测动员率整体 ×0.5 / ×1.5）=====');
const baseP = warned.p;
const sensBase = { depthAhead: 0.34, depthHere: 0.12, minutesSinceWarning: 120, officialWarning: true };
const sensP = [];
for (const mul of [0.5, 1.5]) {
  const pts = MOBILISATION_OBSERVED.points.map(
    (p) => ({ minutes: p.minutes, rate: Math.min(1, p.rate * mul) }));
  const r = scenario(0, { ...sensBase, mobilisationPoints: pts });
  sensP.push(r.p);
  console.log(`  实测动员率 ×${mul}: 保护概率 ${baseP} → ${r.p}`);
}
console.log('\n===== 实测动员曲线（Silva 2025 Table S2）=====');
for (const t of [0, 120, 480, 1440, 4320]) {
  console.log(`  ${String(t).padEnd(5)} 分钟 → ${+mobilisedBy(t).toFixed(3)}`);
}

const noBadAction = ['detour', 'turnback', 'abandon'].every((a) => !calm.cnt[a]);
const checks = [
  ['平静时不启动保护行动（概率 0）', calm.p === 0],
  ['平静时不出现换街/掉头/放弃', noBadAction],
  ['预警时间越久保护概率越高', warned.p > shallow.p],
  ['水更深保护概率更高', deep.p > warned.p],
  ['既往洪水经历增加保护倾向', exp3.p > exp1.p && exp1.p > warned.p - 0.001],
  ['危险升高时从众效应衰减', peerExtreme > peerLow],
  ['同处境抽样有随机性（非阈值开关）', calm.p === 0 && shallow.p > 0 && shallow.p < 1],
  ['水深编码按 Table S1 单调', waterDepthOrdinalOf(0) === 1 && waterDepthOrdinalOf(5) === 7],
  ['有序 logit 阈值缺失已显式登记', CHOICE_META.limits.some((x) => x.includes('阈值'))],
  ['失稳→伤亡无据已显式登记', THRESHOLD_META.missing.some((x) => x.includes('失稳到伤亡'))],
  ['动员率用 Table S2 实测点而非自设 S 形曲线',
    Math.abs(mobilisedBy(480) - 0.888) < 1e-9 && Math.abs(mobilisedBy(1440) - 0.957) < 1e-9
    && Math.abs(mobilisedBy(4320) - 0.986) < 1e-9],
  ['实测动员率敏感性方向正确', sensP[0] < baseP && sensP[1] > baseP],
  ['Borowski 威胁等级未冒充水深映射',
    CHOICE_META.limits.some((x) => x.includes('从未对应到任何水深'))],
];
console.log('');
let pass = 0;
for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (ok) pass++; }
console.log(`\n${pass}/${checks.length} 通过`);
if (pass < checks.length) process.exitCode = 1;
