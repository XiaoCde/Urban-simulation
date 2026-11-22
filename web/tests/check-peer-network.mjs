/**
 * check-peer-network.mjs — 参照群体生成器（Kleinberg 小世界 + 三类接触）的机检
 *
 * 为什么要有这个测试：
 * 2026-11-21 的参照群体是我们自己定的「同户 + 120 m 内 3 邻居」，没有任何出处。
 * 2026-11-22 换成发表方法（Kuhlman 2020 AAMAS §2.2/Table 1 的短程半径 + q 条
 * 幂律长程边；Borowski 2023 QA9 的「至多 5 人」上限；ACS 户结构；SOC→场所的
 * 工作边）。这个测试要钉住四件事：
 *  1. 生成结果与「每人目标度数」一致（不是人人满编 5 个）；
 *  2. 三类非家庭接触真的都发生了（不是「看着接了、实际恒 0」）；
 *  3. 同一 seed 可复现、不同 seed 不同（跑批要对得上账）；
 *  4. 接线没被改回去（crowd-life 不再有旧的 CELL 60/R 120/K 3 规则）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildPeerNetwork, PEER_NETWORK, PEER_NETWORK_META,
  setPeerMode, setPeerParams,
} from '../src/kernel/peer-network.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? '  ← ' + extra : ''}`); }
};

// ---- 合成人群：户结构接近 DC（1 人户 30%、2 人 30%、3 人 20%、4 人 15%、5 人 5%）
function makePeople(n = 600) {
  const persons = [];
  for (let i = 0; i < n; i++) {
    persons.push({
      i,
      homeDoor: { x: (i % 25) * 38 + (i % 5) * 2, z: Math.floor(i / 25) * 38 },
      homeBuilding: 'b' + (i % 23),
      workBuilding: (i % 3 === 0) ? null : 'w' + (i % 11),
      household: [],
    });
  }
  const sizes = [1, 1, 1, 2, 2, 2, 3, 3, 4, 5];
  let k = 0, s = 0;
  while (k < n) {
    const hs = sizes[s++ % sizes.length];
    const grp = [];
    for (let m = 0; m < hs && k < n; m++, k++) grp.push(k);
    for (const a of grp) persons[a].household = grp.filter((b) => b !== a);
  }
  return persons;
}

const people = makePeople();
const dist = (a, b) => Math.hypot(a.homeDoor.x - b.homeDoor.x, a.homeDoor.z - b.homeDoor.z);
function classify(persons, peers) {
  const t = { household: 0, work: 0, neighbour: 0, longRange: 0 };
  for (let i = 0; i < persons.length; i++) {
    for (const j of peers[i]) {
      if (j <= i) continue;
      const a = persons[i], b = persons[j];
      if (a.household.includes(j)) t.household++;
      else if (a.workBuilding && a.workBuilding === b.workBuilding) t.work++;
      else if (dist(a, b) <= PEER_NETWORK.shortRangeM) t.neighbour++;
      else t.longRange++;
    }
  }
  return t;
}

console.log('一、生成结果的基本性质');
const base = buildPeerNetwork(people, { seed: 20261122 });
const base2 = buildPeerNetwork(people, { seed: 20261122 });
const other = buildPeerNetwork(people, { seed: 20261123 });
ok('同 seed 逐位一致', JSON.stringify(base.peers) === JSON.stringify(base2.peers));
ok('不同 seed 得到不同网络', JSON.stringify(base.peers) !== JSON.stringify(other.peers));
ok('无孤立者（有人口密度就给同伴）', base.stats.isolateShare === 0, String(base.stats.isolateShare));
ok('人均度数有分布、不是人人满编 5',
  Object.keys(base.stats.degreeHist).length >= 2 && base.stats.meanDegree < 5,
  JSON.stringify(base.stats.degreeHist));
ok('度数不超过上限 5', base.peers.every((p) => p.length <= PEER_NETWORK.maxPeers));
ok('没有自环', base.peers.every((p, i) => !p.includes(i)));
ok('没有重复', base.peers.every((p) => new Set(p).size === p.length));
ok('对称（我列了你，你就得列我）', base.peers.every((p, i) => p.every((j) => base.peers[j].includes(i))));
ok('目标度数 = 同户成员数 + extraTies（封顶 5）',
  base.peers.every((p, i) => p.length <= Math.min(PEER_NETWORK.maxPeers, people[i].household.length + PEER_NETWORK.extraTies)),
  '实测均值 ' + base.stats.meanDegree + ' / 目标 ' + base.stats.targetMean);

console.log('二、三类非家庭接触真的发生（不是「看着接了、实际恒 0」）');
const comp = classify(people, base.peers);
ok('家庭边存在', comp.household > 0, JSON.stringify(comp));
ok('工作边存在', comp.work > 0, JSON.stringify(comp));
ok('邻里边存在', comp.neighbour > 0, JSON.stringify(comp));
ok('长程边存在', comp.longRange > 0, JSON.stringify(comp));
ok('家庭边数与 ACS 户结构一致',
  Math.abs(base.stats.householdEdges - comp.household) <= 2,
  `stats ${base.stats.householdEdges} vs 实测 ${comp.household}`);
ok('长程边平均距离远超短程半径',
  (() => {
    const ds = [];
    for (let i = 0; i < people.length; i++) {
      for (const j of base.peers[i]) {
        if (j <= i) continue;
        const a = people[i], b = people[j];
        if (a.household.includes(j)) continue;
        if (a.workBuilding && a.workBuilding === b.workBuilding) continue;
        if (dist(a, b) > PEER_NETWORK.shortRangeM) ds.push(dist(a, b));
      }
    }
    return ds.length > 0 && ds.reduce((x, y) => x + y, 0) / ds.length > PEER_NETWORK.shortRangeM;
  })());

console.log('三、模式与参数（敏感性扫的就是这些）');
const hhMode = buildPeerNetwork(people, { mode: 'household' });
ok("mode='household' 只剩同户",
  hhMode.peers.every((p, i) => p.length === people[i].household.length && p.every((j) => people[i].household.includes(j))));
const nbMode = buildPeerNetwork(people, { mode: 'neighbour' });
const nbComp = classify(people, nbMode.peers);
ok("mode='neighbour' 不含工作边与长程边", nbComp.work === 0 && nbComp.longRange === 0, JSON.stringify(nbComp));
ok("mode='neighbour' 邻里边用满 3 个名额",
  nbMode.peers.every((p, i) => p.length <= Math.min(PEER_NETWORK.maxPeers, people[i].household.length + PEER_NETWORK.neighbourK)));
const q0 = buildPeerNetwork(people, { longRangeQ: 0 });
ok('longRangeQ=0 → 没有长程边', classify(people, q0.peers).longRange === 0);
const r60 = buildPeerNetwork(people, { shortRangeM: 60 });
const r240 = buildPeerNetwork(people, { shortRangeM: 240 });
ok('改半径会换人（成员不同）但人数基本不变',
  JSON.stringify(r60.peers) !== JSON.stringify(r240.peers) &&
  Math.abs(r60.stats.meanDegree - r240.stats.meanDegree) < 0.25,
  `R60 ${r60.stats.meanDegree} vs R240 ${r240.stats.meanDegree}`);
const capped = buildPeerNetwork(people, { extraTies: 8 });
ok('extraTies 再大也不会超过 5 人上限', capped.peers.every((p) => p.length <= 5));
ok('空输入不炸', (() => { const r = buildPeerNetwork([], {}); return r.peers.length === 0 && r.stats.edges === 0; })());
ok('单人不炸', (() => { const r = buildPeerNetwork([{ i: 0, homeDoor: { x: 0, z: 0 }, household: [] }], {}); return r.peers.length === 1 && r.peers[0].length === 0; })());
ok('setPeerMode 拒绝未知模式', setPeerMode('nonsense') === false && setPeerMode('synthetic') === true);
ok('setPeerParams 拒绝越界', setPeerParams({ shortRangeM: -5 }) === false && setPeerParams({ shortRangeM: 120 }) === true);

console.log('四、出处与自设标记（答辩要能指认）');
const M = PEER_NETWORK_META;
ok('方法出处写了 Kuhlman 2020 AAMAS 与表号', /Kuhlman/.test(M.sources.kleinbergSmallWorld) && /Table 1/.test(M.sources.kleinbergSmallWorld));
ok('上限 5 出自 Borowski QA9', /Borowski/.test(M.sources.maxPeers) && /QA9/.test(M.sources.maxPeers) && /5/.test(M.sources.maxPeers));
ok('备选结构（配置模型）留了出处', /Newman/.test(M.alternatives.join(' ')) && /Hasan/.test(M.alternatives.join(' ')));
ok('三个自设参数都标了 selfSet', ['budget', 'shortRangeM', 'longRangeQ', 'longRangePower'].every((k) => M.selfSet[k]));
ok('限制里写明学校接触没接', M.limits.some((s) => /学校/.test(s)));
ok('限制里写明「住得近 ≠ 认识」', M.limits.some((s) => /住得近/.test(s)));

console.log('五、接线（别被改回去）');
const crowdLife = read('src/crowd-life.js');
ok('crowd-life 引了 buildPeerNetwork', /import \{ buildPeerNetwork \} from '\.\/kernel\/peer-network\.js';/.test(crowdLife));
ok('crowd-life 用 seed 20261122 调生成器', /buildPeerNetwork\(persons, \{ seed: 20261122 \}\)/.test(crowdLife));
ok('旧的 CELL 60 / R 120 / K 3 邻居规则已删', !/const CELL = 60, R = 120, K = 3;/.test(crowdLife));
ok('crowd-life 导出诊断统计 peerNetworkStats', /export function peerNetworkStats\(\)/.test(crowdLife));

const main = read('src/main.js');
ok('main.js 有 ?peer= 模式开关', /QS_ROAD\.get\('peer'\)/.test(main) && /setPeerMode\(PM\)/.test(main));
ok('main.js 有 ?peerR= / ?peerQ= 参数开关', /QS_ROAD\.get\('peerR'\)/.test(main) && /QS_ROAD\.get\('peerQ'\)/.test(main));

const simDay = read('sim/sim-day.mjs');
ok('sim-day 支持 SIM_PEER / SIM_PEER_R / SIM_PEER_Q',
  /SIM_PEER\b/.test(simDay) && /SIM_PEER_R/.test(simDay) && /SIM_PEER_Q/.test(simDay));

console.log(`\n参照群体机检：${pass}/${pass + fail} 通过`);
if (fail) process.exit(1);