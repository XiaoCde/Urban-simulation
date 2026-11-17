/**
 * _check_real_population.mjs — 纯 Node，验证仿真人群与真实 ACS 分布一致。
 *
 * 对应录音里导师 05:04 的追问「怎么样去保证我们的仿真和它的分布是一致的」。
 * 做法：按 PWGTP 权重从真实个体记录抽 N 个人，把抽出来的边际分布
 * 与 ACS 官方加权边际逐项比，算总变差距离（每个维度各分类绝对差之和的一半）。
 * 不做「必须完全相等」的硬断言 —— 抽样本来就有误差，只报数值。
 *
 * 用法：node _check_real_population.mjs
 */
import { ACS_DC } from '../src/kernel/real-data.js';
import { samplePerson, POPULATION_META, SOC_LABEL } from '../src/kernel/population.js';
import { makeCitizen } from '../src/citizen.js';
import { pickRole } from '../src/roles.js';
import { NHTS_DAY } from '../src/kernel/real-data.js';

const N = 3000;
const SEED = 20261115;

/** 把 ACS 的带标签键归一成 joint 里的裸码，便于和微观样本直接对拍。 */
const strip = (k) => String(k).split('|')[0];

function officialMarginal(name) {
  const vals = ACS_DC.distributions[name].values;
  const total = Object.values(vals).reduce((a, b) => a + b, 0);
  const out = {};
  for (const [k, v] of Object.entries(vals)) {
    let key = strip(k);
    // 户车数：population.js 把 VEH=NA 归成 0 辆（建模映射），
    // 官方边际按同一口径合并后再比，否则口径差会被误读成分布不一致。
    if (name === 'vehicles_shared_to_person' && key === 'NA') key = '0';
    out[key] = (out[key] || 0) + v / total;
  }
  return out;
}

function sampleMarginal(extract) {
  const c = {};
  for (let i = 0; i < N; i++) {
    const p = samplePerson(i, SEED);
    const k = extract(p);
    c[k] = (c[k] || 0) + 1;
  }
  const out = {};
  for (const [k, v] of Object.entries(c)) out[k] = v / N;
  return out;
}

function tvd(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let s = 0, worst = ['', 0];
  for (const k of keys) {
    const d = Math.abs((a[k] || 0) - (b[k] || 0));
    s += d;
    if (d > worst[1]) worst = [k, d];
  }
  return { tvd: +(s / 2).toFixed(4), worstClass: worst[0], worstGap: +(worst[1] * 100).toFixed(2) };
}

const dims = [
  ['标准 5 岁年龄带', 'age_band_5y', (p) => p.ageBand5y],
  ['性别', 'sex', (p) => p.sex],
  ['SOC 职业大类', 'occupation_soc_major', (p) => p.socCode],
  ['JWTRNS 通勤方式', 'commute_jwtrns', (p) => p.jwtrns],
  ['户内有无未成年人', 'household_has_minor', (p) => p.hasMinor ? '有未成年' : '无未成年'],
  ['户车数（关联到人）', 'vehicles_shared_to_person', (p) => String(p.householdVehicles)],
];

console.log('===== 仿真人群 vs ACS 2020–2024 DC 加权分布 =====');
console.log(`抽样人数 ${N}，真实记录 ${POPULATION_META.rows} 行，权重合计 ${POPULATION_META.weightSum}`);
console.log('指标：总变差距离（0 = 完全一致，1 = 完全不一致）；抽样误差随 N 增大下降\n');
const results = [];
for (const [label, key, extract] of dims) {
  const o = officialMarginal(key);
  const s = sampleMarginal(extract);
  const r = tvd(o, s);
  results.push({ label, ...r });
  console.log(`${label.padEnd(22)} 总变差 ${String(r.tvd).padEnd(8)} 最大偏差类 ${r.worstClass.padEnd(18)} ${r.worstGap}%`);
}

// ---- 联合一致性：不是把几个边际拼起来，而是一行真实记录 ----
console.log('\n===== 联合分布（同一条真实记录）=====');
let minor_and_drive = 0, child_and_work = 0, elder_and_work = 0;
for (let i = 0; i < N; i++) {
  const p = samplePerson(i, SEED);
  if (p.hasMinor && p.travelMode === 'drive') minor_and_drive++;
  if (p.age < 13 && p.socCode !== 'NA') child_and_work++;
  if (p.age >= 65 && p.socCode !== 'NA') elder_and_work++;
}
console.log(`有未成年且自驾 ${minor_and_drive} 人 (${(minor_and_drive / N * 100).toFixed(1)}%)`);
console.log(`13 岁以下却有职业码 ${child_and_work} 人（应为 0，儿童不该被派去上班）`);
console.log(`65 岁以上仍有职业码 ${elder_and_work} 人（ACS 真实记录，含仍在工作的人，不是 bug）`);

// ---- 造人链路端到端 ----
const roleCount = {}, bandCount = {};
let planNodes = 0;
for (let i = 0; i < N; i++) {
  const R = samplePerson(i, SEED);
  const c = makeCitizen(i, SEED, R);
  roleCount[pickRole(R).role] = (roleCount[pickRole(R).role] || 0) + 1;
  bandCount[c.ageBand] = (bandCount[c.ageBand] || 0) + 1;
}
console.log('\n===== 造人链路 =====');
console.log('真实 SOC 职业标签种数', Object.keys(roleCount).length, '（旧版手写 32 个职业）');
console.log('年龄行为分档人数', JSON.stringify(bandCount));
console.log('NHTS 交叉表格子数', NHTS_DAY.joint.cell_count);

const maxTvd = Math.max(...results.map((r) => r.tvd));
const checks = [
  // 第四轮 E3 复核：Grimm 2005 / ODD 2006,2010 / Windrum 2007 / Hartig 2011 /
  // Lee 2015 都只给质性、模式导向判据，没有公认的卡方或总变差数值容差。
  // 下面 0.05 是**本项目自己定的工程阈值**，不是文献标准。
  ['六个维度总变差距离都小于 0.05（本项目自定阈值，非文献标准）', maxTvd < 0.05],
  ['13 岁以下不派职业', child_and_work === 0],
  ['真实职业标签不少于 20 种', Object.keys(roleCount).length >= 20],
  ['ACS 权重合计与官方一致', Math.abs(POPULATION_META.weightSum - 681294) < 1],
];
console.log('');
let pass = 0;
for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (ok) pass++; }
console.log(`\n${pass}/${checks.length} 通过`);
if (pass < checks.length) process.exitCode = 1;
