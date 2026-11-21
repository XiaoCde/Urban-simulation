/**
 * check-no-car-no-drive.mjs — 纯 Node，验「家里没车的人开不了车」这条口径真的闭合。
 *
 * 背景（A4）：身份层早就算出 hasCar / license（社会圈层按真实 ACS 户车数与年龄，
 * 见 social-circles.js），出行方式也先判「没车没驾照就步行」。但 traffic.js
 * 的 bindCrews 第二轮会无条件把剩下的车塞给任何人，于是 ACS 户车数为 0、
 * 未成年的居民也拿到「车主」身份，traffic.hasCrewCar(i) 变成 true ——
 * 身份层与数据层互相打架。这个文件验收四件事：
 *   ① 户车数 0 → hasCar=false、license=false（身份层）；
 *   ② 没车/没驾照 → chooseTravel 一律 walk（出行方式层）；
 *   ③ bindCrews 只给「有车且有驾照」的人配车，且没有无条件补车兜底；
 *   ④ 车比能开的人多时不硬塞（一车一人，不再 k % owners.length 复用同一个人）。
 *
 * 用法：cd web && node tests/check-no-car-no-drive.mjs
 */
import { readFileSync } from 'node:fs';
import { circleOf, chooseTravel } from '../src/social-circles.js';

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? `  ← ${detail}` : ''}`); }
};

const person = (veh, age, extra = {}) => ({
  ageBand: age < 18 ? 'teen' : age >= 65 ? 'senior' : 'prime',
  status: '服务业', role: '服务业',
  real: {
    age, sex: '1', socCode: '41', hasMinor: true, householdSize: 3,
    householdVehicles: veh, jwtrns: '01', travelMode: 'drive',
    ...extra,
  },
});

const GOAL = { type: 'commute', label: '上班', dest: { x: 100, z: 0 }, dueMin: 600 };

// ---- 1 身份层：ACS 户车数说了算 ----
const noCar = circleOf(7, person(0, 34), null, 20261113);
ok(noCar.hasCar === false, '户车 0 → hasCar=false');
ok(noCar.license === false, '户车 0 → license=false');
const oneCar = circleOf(8, person(1, 34), null, 20261113);
ok(oneCar.hasCar === true && oneCar.license === true, '户车 1 + 34 岁 → 有车有驾照');
const minor = circleOf(9, person(1, 15), null, 20261113);
ok(minor.hasCar === false && minor.license === false, '未成年即使家里有车也不能算「有车」');
const oldest = circleOf(10, person(1, 90), null, 20261113);
ok(oldest.hasCar === true && oldest.license === false, '90 岁：户里有车但没有驾照（88 岁上限）');

// ---- 2 出行方式：没车/没驾照一律步行 ----
{
  const d = chooseTravel(GOAL, noCar, { hasOwnCar: true, dist: 3000, depthHere: 0, rain: 0 });
  ok(d.mode === 'walk', '户车 0 即使 pool 给了车也走不到 drive', d.reason);
  const d2 = chooseTravel(GOAL, oldest, { hasOwnCar: true, dist: 3000 });
  ok(d2.mode === 'walk', '没驾照的人不开车', d2.reason);
  const d3 = chooseTravel(GOAL, oneCar, { hasOwnCar: true, dist: 3000, depthHere: 0, rain: 0 });
  ok(d3.mode === 'drive', '有车有驾照、路可通行时才允许开车', d3.reason);
  const d4 = chooseTravel(GOAL, oneCar, { hasOwnCar: false, dist: 3000 });
  ok(d4.mode === 'walk', 'traffic 没配到车时退回步行', d4.reason);
}

// ---- 3 车队绑定：只给有车有驾照的人，没有无条件补车 ----
{
  const src = readFileSync(new URL('../src/traffic.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function bindCrews'), src.indexOf('function crewStats'));
  ok(/!c\.hasCar \|\| !c\.license/.test(body), 'bindCrews 只认 hasCar && license');
  ok(!/if \(!used\.has\(i\)\) \{ used\.add\(i\); owners\.push\(i\); \}/.test(body),
    '无条件补车的第二轮已删除');
  ok(!/owners\[k % owners\.length\]/.test(body), '不再把同一个人复用到多辆车（一车一人）');
  ok(/k < cars\.length && k < owners\.length/.test(body), '车多于人时多出来的车不硬塞');
  ok(/c\.commute === 'drive'/.test(body) === false,
    '不再按「通勤方式是 drive」配车（真实共乘/单位车的人家里可能没车）');
}

// ---- 4 认领处也守住：没车的车不认识 ----
{
  const src = readFileSync(new URL('../src/traffic.js', import.meta.url), 'utf8');
  ok(/cars\[k\]\.crew && cars\[k\]\.crew\.i === i/.test(src),
    'claim 只认自己 crew 的车');
  const dl = readFileSync(new URL('../src/drive-layer.js', import.meta.url), 'utf8');
  ok(/noCarAvailable:\s*poolFull \|\| !hasOwnCar/.test(dl),
    'drive-layer 把「没配到车」如实传给 chooseTravel');
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);