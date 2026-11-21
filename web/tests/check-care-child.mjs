/**
 * check-care-child.mjs — 纯 Node，验门 5 的第三条「照护责任」（A7）真的接上、且不会锁死人。
 *
 * 起因：门 5 此前只接了两条（无车、值守在岗），「需照顾家人」和「行动受限」一直空着，
 * 口径表里写着「无数据源恒不触发」。ACS 微样本确实没有 DIS，但它有
 * 「户内有未成年(1/0)」「户规模」「与户主关系码」三列 —— 户内两个人 + 有一个未成年
 * 就等于「一个大人 + 一个未成年」，即单亲带娃，这不是自设系数，是逻辑唯一解。
 *
 * 验收五件事：
 *   ① 推导本身：哪些户判、哪些户不判（户规模≥3 不判，宁可漏判）；
 *   ② 关系码必须是 PUMS 的 20/21/22 —— 旧代码写成 01/02（旧版 RELP 码），
 *      实测加权命中 0 人，这条钉成回归；
 *   ③ 覆盖率与 ACS 加权实测一致（1.21%），不是拍脑袋；
 *   ④ 门 5 语义：care_child → probability 0、posture 'gather_child'；
 *      孩子到身边（minorWith）或危险度到 most 时解除，**不会永久锁死**；
 *   ⑤ 全链路：cohort 把 careChildDuty / minorWith 送进内核，live-agent 算得出来。
 *
 * 用法：cd web && node tests/check-care-child.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  careChildDutyOf, impedimentOf, IMPEDIMENT, HOUSEHOLDER_RELP, ACCESS, ACCESS_META,
} from '../src/kernel/access-impediment.js';
import { decideProtectiveAction } from '../src/kernel/choice-model.js';
import { mulberry32 } from '../src/kernel/rng.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? `  ← ${detail}` : ''}`); }
};

const real = (o = {}) => ({
  age: 34, sex: '1', socCode: '41', hasMinor: true,
  householdSize: 2, householdVehicles: 1, jwtrns: '01',
  relationship: '20', travelMode: 'walk', ...o,
});

// ---- 1 推导：只判「一大人 + 一未成年」 ----
ok(careChildDutyOf(real()) === true, '户规模 2 + 有未成年 + 户主 + 34 岁 → 照护责任');
ok(careChildDutyOf(real({ relationship: '21' })) === true, '配偶（RELP 21）同户也判');
ok(careChildDutyOf(real({ householdSize: 3 })) === false,
  '户规模 3 不判（分不清「两大人+一娃」还是「一大人+两娃」，宁漏不猜）');
ok(careChildDutyOf(real({ hasMinor: false })) === false, '户内没有未成年 → 不判');
ok(careChildDutyOf(real({ age: 12 })) === false, '本人是未成年人 → 不判');
ok(careChildDutyOf(real({ age: 90 })) === false, '90 岁不判（照护者年龄上限与驾照同一口径 88）');
ok(careChildDutyOf(real({ relationship: '25' })) === false, '寄住的成年子女（RELP 25）不算户主，不判');
ok(careChildDutyOf(null) === false && careChildDutyOf({}) === false, '空输入不判，也不抛');

// ---- 2 关系码口径：必须是 PUMS 的 20/21/22，不是旧版 01/02 ----
ok(HOUSEHOLDER_RELP.includes('20'), 'HOUSEHOLDER_RELP 用 PUMS 户主码 20（不是 01）');
ok(!HOUSEHOLDER_RELP.includes('01'), '不再出现旧版 RELP 01 —— 用它的时候实测命中 0 人');

// ---- 3 覆盖率与 ACS 加权实测一致 ----
{
  const acs = JSON.parse(readFileSync(join(ROOT, 'data', 'real', 'acs_dc.json'), 'utf8'));
  const cols = acs.microsample.columns;
  const ix = Object.fromEntries(cols.map((c, i) => [c, i]));
  let tot = 0, hit = 0;
  for (const r of acs.microsample.rows) {
    const w = Number(r[ix['PWGTP权重']]) || 0;
    tot += w;
    if (careChildDutyOf({
      age: Number(r[ix['年龄']]),
      hasMinor: r[ix['户内有未成年(1/0)']] === 1,
      householdSize: Number(r[ix['户规模']]),
      relationship: String(r[ix['与户主关系码']]),
    })) hit += w;
  }
  const share = hit / tot;
  ok(Math.abs(share - ACCESS_META.measured.careChildShare) < 0.001,
    'ACCESS_META 里登记的 1.21% 与 ACS 现场重算一致',
    `重算 ${(share * 100).toFixed(3)}% vs 登记 ${(ACCESS_META.measured.careChildShare * 100).toFixed(3)}%`);
  ok(share > 0, '加权命中人数 > 0（旧码 01/02 时这里是 0 人）');
}

// ---- 4 门 5 语义 ----
const k = { socCode: '41', hasCar: true, householdVehicles: 1, careChildDuty: true, householdSize: 2 };
{
  const imp = impedimentOf(k, { atWork: false, distGoal: 200, minorWith: false });
  ok(imp && imp.id === IMPEDIMENT.CARE_CHILD, '孩子不在身边 → 命中 care_child', imp && imp.id);
  ok(impedimentOf(k, { atWork: false, distGoal: 200, minorWith: true }) === null,
    '孩子已在身边（9 m 内）→ 阻碍解除');
  ok(impedimentOf({ ...k, careChildDuty: false }, { atWork: false, distGoal: 200, minorWith: false }) === null,
    '没有照护责任的人不受这条影响');
}

const hazard = (cls) => ({
  received: true, waterDepthM: cls === 'extreme' ? 1.2 : 0.1,
  hazardRatingValue: cls === 'extreme' ? 2.4 : 0.4,
  cost: 0, travelTime: 0, waitTime: 0, walkDistance: 0,
  peersStay: 0, peersRide: 0, age: 34, priorFloods: 1, minutesSinceWarning: 240,
  rplZ: [0, 0, 0],
});

{
  const base = { ...hazard('low'), received: true };
  const held = decideProtectiveAction({ ...base, impediment: 'care_child', minorWith: false },
    mulberry32(1));
  ok(held.probability === 0, 'care_child 且孩子不在身边 → 不单独先撤（probability 0）',
    String(held.probability));
  ok(held.gates.posture === 'gather_child', '姿态是「先去接孩子」', held.gates.posture);

  const withChild = decideProtectiveAction({ ...base, impediment: 'care_child', minorWith: true },
    mulberry32(1));
  ok(withChild.probability > 0, '孩子带上之后照常判撤离（不是把人焊死）',
    String(withChild.probability));
  ok(withChild.gates.posture === 'evacuate', '解除后姿态回到 evacuate');

  const extreme = decideProtectiveAction({
    ...hazard('extreme'), impediment: 'care_child', minorWith: false,
  }, mulberry32(1));
  ok(extreme.probability > 0 && extreme.gates.posture === 'evacuate',
    '危险度到 most 时自保优先解除阻碍（与 on_duty 同一条解除口径）',
    `${extreme.probability} / ${extreme.gates.posture}`);

  const none = decideProtectiveAction({ ...base, impediment: 'none', minorWith: false }, mulberry32(1));
  ok(none.gates.posture === 'evacuate', '无障碍时不受照护责任影响');
}

// ---- 5 全链路接线 ----
{
  const co = readFileSync(join(ROOT, 'web', 'src', 'cohort.js'), 'utf8');
  ok(/careChildDuty: careChildDutyOf\(real\)/.test(co), 'cohort 把 careChildDuty 写进 kernel');
  ok(/minorWith: s\.minorWith === true/.test(co), 'cohort 把 minorWith 送进决策输入');

  const la = readFileSync(join(ROOT, 'web', 'src', 'live-agent.js'), 'utf8');
  ok(/function minorNearbyOf/.test(la), 'live-agent 有「孩子在不在身边」的判定');
  ok(/minorWith: kin\.withMinor/.test(la), '判定结果进了决策状态');
  ok(ACCESS.childWithM === 9, 'childWithM = 9 m（半自设，登记在 ACCESS）');
  ok(ACCESS_META.selfSet.some((t) => t.includes('childWithM')),
    'ACCESS_META 标了这条是自设阈值');

  const cl = readFileSync(join(ROOT, 'web', 'src', 'crowd-life.js'), 'utf8');
  ok(/persons\[a\]\.household = grp\.filter/.test(cl), 'crowd-life 单独存了同户成员（不含邻居）');
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);