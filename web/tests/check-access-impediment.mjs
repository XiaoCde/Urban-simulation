/**
 * check-access-impediment.mjs — 门 5「阻碍」接线自检（2026-11-21 新增）
 *
 * 验的是三件事：
 *   ① 户车数缺失（PUMS VEH = NA）不能被当成「无车」；
 *   ② 无车 + 目标超出步行上限 → 门 5 命中、撤离概率为 0；
 *   ③ 值守岗位在岗 → 门 5 命中，同样压到 0；不在岗时恢复正常。
 */
import { mulberry32 } from '../src/decision.js';
import { makeKernel } from '../src/cohort.js';
import { judge } from '../src/cohort.js';
import { isDutyMission, vehicleFree, impedimentOf, IMPEDIMENT, ACCESS, ACCESS_META } from '../src/kernel/access-impediment.js';

let pass = 0;
let total = 0;
function ok(name, cond, detail = '') {
  total += 1;
  if (cond) { pass += 1; console.log(`PASS  ${name}${detail ? ` (${detail})` : ''}`); }
  else console.log(`FAIL  ${name}${detail ? ` (${detail})` : ''}`);
}

// ---- 纯函数
ok('值守岗位识别：医疗/安保/教育/军职命中', ['29', '31', '33', '25', '55'].every(isDutyMission));
ok('值守岗位识别：管理与金融不命中', !isDutyMission('11') && !isDutyMission('13'));

ok('户车数=0 且场景无车 → 无车', vehicleFree({ householdVehicles: 0, hasCar: false }));
ok('户车数=1 → 不算无车', !vehicleFree({ householdVehicles: 1, hasCar: false }));
ok('户车数缺失（NA）不判无车', !vehicleFree({ householdVehicles: NaN, hasCar: false }));
ok('有车可用时即使户车数=0 也不判', !vehicleFree({ householdVehicles: 0, hasCar: true }));

ok('无车 + 3 km 目标 → no_vehicle',
  impedimentOf({ householdVehicles: 0, hasCar: false, socCode: '13' }, { distGoal: 3000 }).id === IMPEDIMENT.NO_VEHICLE);
ok('无车 + 500 m 目标 → 不触发（走得到）',
  impedimentOf({ householdVehicles: 0, hasCar: false, socCode: '13' }, { distGoal: 500 }) === null);
ok('值守岗位在岗 → on_duty',
  impedimentOf({ householdVehicles: 2, hasCar: true, socCode: '33' }, { atWork: true, distGoal: 300 }).id === IMPEDIMENT.ON_DUTY);
ok('值守岗位但已到家 → 不触发',
  impedimentOf({ householdVehicles: 2, hasCar: true, socCode: '33' }, { atWork: false, distGoal: 300 }) === null);
ok('非值守岗位在岗 → 不触发',
  impedimentOf({ householdVehicles: 2, hasCar: true, socCode: '13' }, { atWork: true, distGoal: 300 }) === null);
ok('步行上限有敏感性区间', Array.isArray(ACCESS.walkLimitRangeM) && ACCESS.walkLimitRangeM.length === 3);
ok('元数据登记了未接的三项', ACCESS_META.limits.length >= 3);

// ---- 全链路：同一个上班族，只改「在岗 / 在家」与户车数
function personFor(socCode, vehicles) {
  return {
    role: '管理', status: '白领', ageBand: 'middle',
    real: { age: 45, sex: '1', socCode, hasMinor: true, householdVehicles: vehicles, householdSize: 3 },
    citizen: { ageBand: 'middle', ageGroup: 'adult', age: 45, experience: 0.5,
      sightM: 40, veteran: false, rookie: false,
      hazard: { score: 0.3, tier: 'x', trained: false, runs: 1, sightBonus: 3 } },
  };
}
const baseState = {
  depthHere: 0.12, depthAhead: 0.40, farDepth: 0.6, farDist: 12, blocked: false,
  progress: 0.5, late: false, goalType: 'errand', overdue: 0, timeToDue: 45,
  pressure: 0.2, rain: 8, fatigue: 0.15, stuck: 0, detours: 0, wetness: 0.1,
  hunger: 20, umbrella: 'none', expDepth: 0, doneToday: 1, abandonToday: 0,
  detoursToday: 0, shelteredSec: 0, homeBias: 0, confidence: 0.6, abandonCd: false,
  detourCd: false, waitCd: false, goalLabel: '办事', waitSec: 1, distGoal: 3000,
  minutesSinceWarning: 120, officialWarning: true,
};

function protectShare(k, patch, n = 400) {
  const rnd = mulberry32(20261117);
  let hit = 0;
  for (let i = 0; i < n; i++) hit += judge(k, { ...baseState, ...patch }, rnd).score.protectiveActionProbability > 0 ? 1 : 0;
  return hit / n;
}

const dutyAtWork = makeKernel(7, personFor('33', 2), mulberry32(11), null);
const normalAtWork = makeKernel(7, personFor('13', 2), mulberry32(11), null);
const noCar = makeKernel(8, personFor('13', 0), mulberry32(12), null);

ok('值守岗位在岗：撤离概率恒为 0（门 5 挡死）',
  protectShare(dutyAtWork, { atWork: true }) === 0);
ok('同一人已到家：撤离概率恢复为正',
  protectShare(dutyAtWork, { atWork: false }) > 0);
ok('非值守岗位在岗：撤离概率不受影响',
  protectShare(normalAtWork, { atWork: true }) > 0);
// 【2026-11-21 改口】无车不再一刀切清零：人不是僵硬的，没车就走着去。
// 这一条验的是「概率没有被打成 0」+「姿态被判成 walk」。
const noCarAtWork = judge(noCar, { ...baseState, atWork: false }, mulberry32(5));
ok('无车 + 3 km：不再被清零，判成步行撤离（posture=walk）',
  protectShare(noCar, { atWork: false }) > 0
  && noCarAtWork.choice.gates.posture === 'walk'
  && noCarAtWork.choice.gates.impediment === 'no_vehicle',
  `posture=${noCarAtWork.choice.gates.posture}`);
ok('无车但目标只 800 m：仍可撤离',
  protectShare(noCar, { atWork: false, distGoal: 800 }) > 0);

// 值守在岗不是永久锁死：自身位置危险度升到「danger for most」以上就自保优先。
const dutyLow = judge(dutyAtWork, { ...baseState, atWork: true, depthAhead: 0.3 }, mulberry32(6));
const dutyDeep = judge(dutyAtWork, { ...baseState, atWork: true, depthAhead: 1.2, depthHere: 1.2 }, mulberry32(7));
ok('值守在岗 + 低危险：仍在履职（概率 0）',
  dutyLow.choice.gates.posture === 'stay_on_duty' && dutyLow.choice.gates.impedimentLifted === false);
ok('值守在岗 + 危险度 danger-for-all：阻碍自动解除（自保优先）',
  dutyDeep.choice.gates.impedimentLifted === true
  && dutyDeep.choice.gates.posture !== 'stay_on_duty',
  `${dutyDeep.choice.gates.hazardClass} / lifted=${dutyDeep.choice.gates.impedimentLifted}`);

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
