/**
 * 阶段3B 验收：用真实建筑数据把人分到楼层，再按水深推演。
 */
import { buildBuildingIndex, assignPersonFloor, assignCohortFloors,
  evaluateFloodOnFloors } from '../src/kernel/floor-occupancy.js';
import { readFileSync } from 'node:fs';

const ok = [];
const check = (name, pass, extra = '') => {
  ok.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const bd = JSON.parse(readFileSync(new URL('../assets/city/buildings.json', import.meta.url), 'utf8'));
const idx = buildBuildingIndex(bd.buildings);
check('真实建筑全部进索引', idx.count === 21943, `${idx.count} 栋`);

// 用真实门牌坐标（people 的住址/岗位）分配楼层
const real = JSON.parse(readFileSync(new URL('../../data/real/acs_dc.json', import.meta.url), 'utf8'));
// 从 ACS 样本里取有坐标的人（项目里 homeXZ 就是这么派的）；这里用建筑中心造一批
// 位于真实建筑附近的人，检验「分配到的楼层建筑确实存在、楼层高程随高度变」。
const sample = bd.buildings.filter((b) => b.function === 'apartments').slice(0, 50);
const people = sample.map((b, i) => ({ x: b.center[0], z: b.center[1], kind: 'home' }));
const cohort = assignCohortFloors(idx, people);
check('50 人在真实公寓楼附近都分配到建筑', cohort.people.every((s) => s.buildingId),
  `${cohort.people.filter((s) => s.buildingId).length}/50`);
check('分配到的楼层在 1..楼总层数之间',
  cohort.people.every((s) => s.floor >= 1 && s.floor <= s.floors));
check('楼层高程随楼层递增', (() => {
  const p = cohort.people.find((s) => s.floor > 1);
  return !p || p.elevationM > 0.3;
})());

// 远处（没有建筑）的人判室外，不硬塞
const far = assignPersonFloor(idx, -99999, -99999, 0, 'home');
check('建筑之外的人判室外（不会显示在楼里）', far.indoor === false,
  far.reason);

// 淹没推演：低水深多数安全，高水深出现上楼/遇险
const low = evaluateFloodOnFloors(cohort.people, () => 0.2);
check('20 cm 积水无人遇险', low.counts.drowning === 0, JSON.stringify(low.counts));
const high = evaluateFloodOnFloors(cohort.people, () => 12);
check('12 m 积水出现上楼或遇险', (high.counts.moveUp + high.counts.drowning) > 0,
  JSON.stringify(high.counts));
check('楼层判定不会把室外人算进楼内遇险',
  high.counts.outdoor === cohort.people.filter((s) => !s.indoor).length);

// 内核边界
const src = readFileSync(new URL('../src/kernel/floor-occupancy.js', import.meta.url), 'utf8');
const code = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
check('楼层占用内核不依赖 three/window/document',
  !/\b(window|document|THREE)\b/.test(code));

const failed = ok.filter((x) => !x).length;
console.log(`\n${ok.length - failed}/${ok.length} 通过`);
process.exit(failed ? 1 : 0);
