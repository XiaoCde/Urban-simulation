/**
 * _check_hazard_unit.mjs — 纯 Node 对照实验（不启浏览器）。
 *
 * 目的：排除「经验足的人提前避险、因此后来暴露更少」这个混淆，
 * 直接回答「**同一处境下**，有无灾害经验的人会不会做不同决定」。
 * 做法：造两个只差 hazard 的内核，喂完全相同的感知状态，各采样 3000 次，
 * 统计 7 个动作的频率。judge() 是带种子的 softmax 采样，所以看分布。
 *
 * 用法：node _check_hazard_unit.mjs
 */
import { makeKernel, judge } from './src/cohort.js';
import { mulberry32 } from './src/decision.js';

const SAMPLES = 3000;

function kernelWithHazard(hzScore, hzTier, trained) {
  const citizen = {
    ageBand: 'prime', ageGroup: 'adult', experience: 0.55,
    veteran: false, rookie: false, sightM: 40,
    hazard: { score: hzScore, tier: hzTier, trained, runs: hzScore > 0.5 ? 2 : 0,
      drill: false, sightBonus: +(hzScore * 22).toFixed(1) },
  };
  const person = { citizen, role: '写字楼职员', status: '白领', ageBand: 'prime' };
  return makeKernel(1, person, mulberry32(20261111 + 7919), null);
}

const naive = kernelWithHazard(0.02, 'naive', false);
const veteran = kernelWithHazard(0.88, 'veteran', true);

const base = {
  depthHere: 0.02, blocked: false, stuck: 0, overdue: 0, late: false,
  goalType: 'errand', progress: 0.5, pressure: 0.2, timeToDue: 45,
  fatigue: 0.15, rain: 0, wetness: 0.05, hunger: 20, umbrella: 'none',
  expDepth: 0.04, doneToday: 1, abandonToday: 0, detoursToday: 0,
  shelteredSec: 0, homeBias: 0, confidence: 0.6,
  abandonCd: false, detourCd: false, waitCd: false, detours: 0,
  goalLabel: '办事', waitSec: 1.0, farDepth: 0, farDist: 0,
};

function scenario(name, patch, perKernel) {
  const rnd = mulberry32(777 + name.length * 31);
  const run = (k) => {
    const s = { ...base, ...patch };
    if (perKernel) Object.assign(s, perKernel(k));
    const cnt = {};
    for (let n = 0; n < SAMPLES; n++) {
      const a = judge(k, s, rnd).action;
      cnt[a] = (cnt[a] || 0) + 1;
    }
    const out = {};
    for (const a of ['continue', 'slow', 'hurry', 'wait', 'detour', 'turnback', 'abandon'])
      out[a] = +(((cnt[a] || 0) / SAMPLES) * 100).toFixed(1);
    return out;
  };
  return { name, naive: run(naive), veteran: run(veteran) };
}

const cases = [
  scenario('平静（没水没雨）', { depthAhead: 0, rain: 0 }, null),
  scenario('前方 34cm 深积水', { depthAhead: 0.34, depthHere: 0.12, expDepth: 0.10 }, null),
  // 远景预警：只有视野够远的人能看见 26 m 外的深水
  scenario('视线 26m 外有 30cm 深水', { depthAhead: 0.05, rain: 0 }, (k) => {
    const farDist = Math.min(34, Math.max(8, k.sightM * 0.55));
    return { farDist, farDepth: farDist >= 26 ? 0.30 : 0.05, depthAhead: 0.05 };
  }),
];

console.log('===== 同一处境下的动作分布（%）=====');
console.log('内核差异：naive sightM', naive.sightM.toFixed(1), 'wade', naive.wade.toFixed(3),
  'temp', naive.temp.toFixed(3), '| veteran sightM', veteran.sightM.toFixed(1),
  'wade', veteran.wade.toFixed(3), 'temp', veteran.temp.toFixed(3));
for (const c of cases) {
  console.log('\n' + c.name);
  console.log('  无经验 ', JSON.stringify(c.naive));
  console.log('  经验足 ', JSON.stringify(c.veteran));
}

const [calm, deep, far] = cases;
const checks = [
  ['平静时两组都不绕路/掉头/放弃（无依据改道 0）',
    ['detour', 'turnback', 'abandon'].every((a) => calm.naive[a] === 0 && calm.veteran[a] === 0)],
  ['深水时经验足者更少硬闯', deep.veteran.continue < deep.naive.continue],
  ['深水时经验足者更多绕行', deep.veteran.detour > deep.naive.detour],
  ['远景预警时经验足者更多放慢/等待',
    (far.veteran.slow + far.veteran.wait) > (far.naive.slow + far.naive.wait)],
  ['远景预警时经验足者更少加速', far.veteran.hurry < far.naive.hurry],
];
let pass = 0;
console.log('');
for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (ok) pass++; }
console.log(`\n${pass}/${checks.length} 通过`);
if (pass < checks.length) process.exitCode = 1;
