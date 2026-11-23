import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupHouseholds, HOUSEHOLD_META } from '../src/kernel/household.js';
import { setFlowHrMode, flowHrOn, FLOW_HR_META } from '../src/kernel/flow-hazard.js';
import { samplePerson } from '../src/kernel/population.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`✗ ${name}${extra ? ' → ' + extra : ''}`);
}

// ---------------------------------------------------------------- 1 三元组分组
{
  const recs = [];
  for (let i = 0; i < 2000; i++) recs.push(samplePerson(i, 20261117));
  const { groups, sizeOf, stats } = groupHouseholds(recs);
  ok(groups.length === stats.households, '1.1 户数与统计一致');
  ok(stats.conflictVehicles === 0, '1.2 户内户车数零冲突', `${stats.conflictVehicles} 户冲突`);
  ok(stats.conflictMinor === 0, '1.3 户内「有未成年」零冲突', `${stats.conflictMinor} 户冲突`);
  // 户规模必须等于「成员记录里的户规模」，唯一例外是桶余数（改写成 1 人户）
  let mismatch = 0;
  for (let h = 0; h < groups.length; h++) {
    for (const i of groups[h]) {
      const rec = Math.max(1, Math.min(5, Number(recs[i].householdSize) || 1));
      if (sizeOf[h] !== rec) mismatch++;
    }
  }
  ok(mismatch === stats.rewrittenSize, '1.4 户规模与成员记录一致，例外仅桶余数',
    `不符 ${mismatch} 人，登记 ${stats.rewrittenSize} 人`);
  ok(stats.leftoverPersons > 0 && stats.leftoverPersons === stats.rewrittenSize,
    '1.5 桶余数成 1 人户并被计数', `leftover=${stats.leftoverPersons}`);
  const singletons = groups.filter((g) => g.length === 1).length;
  ok(singletons >= stats.leftoverPersons, '1.5b 余数确实成了单人户');
  const sum = Object.values(stats.bySize).reduce((a, b) => a + b, 0);
  ok(sum === groups.length, '1.6 户规模直方图覆盖全部户');
  const persons = Object.entries(stats.bySize).reduce((a, [k, v]) => a + Number(k) * v, 0);
  ok(persons === 2000, '1.7 每个样本人都落在某个户里', `覆盖 ${persons}`);
  ok(stats.rewrittenSize <= 2000 * 0.05, '1.8 户规模被改写的人 ≤5%', `${stats.rewrittenSize}/2000`);
}

// ---------------------------------------------------------------- 2 分组确定性
{
  const recs = [];
  for (let i = 0; i < 200; i++) recs.push(samplePerson(i, 20261111));
  const a = groupHouseholds(recs);
  const b = groupHouseholds(recs);
  ok(JSON.stringify(a.groups) === JSON.stringify(b.groups), '2.1 同输入同输出（可复现）');
}

// ---------------------------------------------------------------- 3 退化输入
{
  ok(groupHouseholds([]).groups.length === 0, '3.1 空输入不炸');
  ok(groupHouseholds([{ householdSize: 1 }]).groups.length === 1, '3.2 单人成户');
  const r = groupHouseholds([{ householdSize: 9 }, { householdSize: 9 }]);
  ok(r.groups.every((g) => g.length <= 5), '3.3 户规模上限 5');
  const bad = groupHouseholds([{ householdSize: 'x', householdVehicles: -3 }]);
  ok(bad.groups.length === 1 && bad.sizeOf[0] === 1, '3.4 非法字段落到 1 人户 0 车');
}

// ---------------------------------------------------------------- 4 接线
{
  const cl = read('src/crowd-life.js');
  ok(/import \{ groupHouseholds \} from '\.\/kernel\/household\.js'/.test(cl), '4.1 crowd-life 引用 kernel/household.js');
  ok(cl.includes('groupHouseholds(persons.map((p) => p.real || {}))'), '4.2 crowd-life 用逐人 ACS 记录分组');
  ok(cl.includes('r.hhId = h;') && cl.includes('r.hhSize = size;'), '4.3 户号与户规模写进 real');
  ok(/if \(Number\(r\.householdSize\) !== size\) r\.householdSize = size;/.test(cl),
    '4.4 桶余数户把户规模改成实际人数');
  ok(cl.includes('HOUSEHOLD_STATS = stats'), '4.5 统计可诊断');
  ok(/export function householdStats\(\)/.test(cl) && /householdStats \}/.test(cl),
    '4.6 householdStats 导出且挂在返回值上');
  ok(!/let k = 0;\s*\n\s*while \(k < persons\.length\)/.test(cl), '4.7 旧的连续切块逻辑已删除');
}

// ---------------------------------------------------------------- 5 家车按户封顶
{
  const tr = read('src/traffic.js');
  ok(tr.includes('allocByHousehold'), '5.1 bindCrews 按户记账');
  ok(/const cap = r \? Math\.max\(0, Math\.min\(4, Number\(r\.householdVehicles\) \|\| 0\)\) : 1;/.test(tr),
    '5.2 户车数作为每户配额');
  ok(/if \(got >= cap\) \{ cappedByHousehold\+\+; continue; \}/.test(tr), '5.3 配额用完不再分配');
  ok(tr.includes('const PERSONS = (crowd && crowd.persons) ? crowd.persons : null;'),
    '5.4 从 CROWD_LIFE 取逐人记录');
  ok(!tr.includes('owners[k % owners.length]'), '5.5 不再循环复用车主');
}

// ---------------------------------------------------------------- 6 死者不进同伴比例
{
  const la = read('src/live-agent.js');
  ok(/if \(INC && INC\.isDead\(j\)\) continue;/.test(la), '6.1 同伴统计里剔除死者');
  ok(/peerSharesOf\(a\)/.test(la), '6.2 仍用统一的 peerSharesOf');
}

// ---------------------------------------------------------------- 7 避险口径拆分
{
  const inc = read('src/incidents.js');
  ok(inc.includes('floorEscapes'), '7.1 垂直避险单独计数');
  ok(/if \(r\.everFloorEscaped\) \{ floorEscapes\+\+; everFloorEscaped\+\+; \}/.test(inc),
    '7.2 按人重算而不是按事件累加');
  ok(inc.includes('floorEscaped: !!r.everFloorEscaped,'), '7.3 个案摘要带垂直避险标记');
  ok(inc.includes('r.everFloorEscaped = true;'), '7.4 上楼时置标记');
}

// ---------------------------------------------------------------- 8 出处字段
{
  ok(typeof HOUSEHOLD_META.method === 'string' && HOUSEHOLD_META.method.length > 20, '8.1 方法有描述');
  ok(Array.isArray(HOUSEHOLD_META.selfSet) && HOUSEHOLD_META.selfSet.length >= 3, '8.2 自设项逐条登记');
  ok(/SERIALNO/.test(HOUSEHOLD_META.why), '8.3 写明为什么必须合成（无户号）');
}

// ---------------------------------------------------------------- 9 流速口径
{
  const fh = read('src/kernel/flow-hazard.js');
  ok(flowHrOn() === false, '9.1 决策层流速口径默认关（保持历史结果可复现）');
  setFlowHrMode(true);
  ok(flowHrOn() === true, '9.2 开关可打开');
  setFlowHrMode(false);
  ok(flowHrOn() === false, '9.3 开关可关回');
  ok(/export function setFlowHrMode/.test(fh) && /export function flowHrOn/.test(fh),
    '9.4 开关有独立读写口');
  ok(FLOW_HR_META.default === 0 && /整批重跑/.test(FLOW_HR_META.why),
    '9.5 meta 写明默认值与重跑要求');

  const co = read('src/cohort.js');
  ok(/velocityMs: flowHrOn\(\) \? vFlow : 0,/.test(co), '9.6 决策层 HR 受开关控制');
  ok(/flowSpeedMs: vFlow,/.test(co), '9.7 真实流速单列传给内核（不论开关）');
  ok(/const vFlow = Math\.max\(0, Number\(s\.flowSpeed\) \|\| 0\);/.test(co), '9.8 流速从感知层读入');

  const la = read('src/live-agent.js');
  ok(/flowSpeed: Math\.max\(0, Number\(ctx\.flowSpeed\) \|\| 0\),/.test(la), '9.9 感知层带流速');

  const ped = read('src/ped.js');
  ok(/liveCtx\.flowSpeed = \(ds0 && ds0\.sp > 0\) \? ds0\.sp : 0;/.test(ped),
    '9.10 位置层把流速交给决策层（与伤亡层同源）');

  const main = read('src/main.js');
  ok(/setFlowHrMode\(FH === 'on' \|\| FH === '1'\)/.test(main), '9.11 ?flowhr= 接线');
  const day = read('sim/sim-day.mjs');
  ok(/SIM_FLOW_HR/.test(day) && /flowHr:/.test(day), '9.12 SIM_FLOW_HR 接线并写进 meta');
}

console.log(`模型审计（户结构 / 家车配额 / 死者同伴 / 避险口径 / 流速口径）：${pass}/${pass + fail} 通过`);
if (fail) process.exit(1);