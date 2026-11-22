/**
 * 决策结构消融的单元检查（2026-11-22）
 *
 * 检查的是「单式基线」这个对照组本身有没有按设计工作：
 *  · 默认必须是五道门（gate），不能被某次改动悄悄改成 single；
 *  · single 必须真的没有接收门、没有动员曲线、只在泡到水时触发；
 *  · single 的线性指数必须等于 λk·k + λa·a + λu·(Ve−Vs) + 威胁档位；
 *  · merge 与 raw 两种合并方式必须真的不同（否则「用退役三个数合并」这句话是空的）；
 *  · 门5 在两种模式里必须一致（消融只隔离决策结构，不隔离可行集）。
 *
 * 跑法：cd web && node tests/check-decide-modes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideProtectiveAction, singleUtilityScore,
  setDecideMode, decideMode, setSingleVariant, singleVariant,
  SINGLE_UTILITY, DECIDE_MODES, knowledgeScore, actionScore,
  protectiveActionUtilities, CHOICE_META,
} from '../src/kernel/choice-model.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
let pass = 0; let fail = 0;
function check(name, fn) {
  try { const t = fn(); if (t === false) throw new Error('返回 false'); pass++; }
  catch (e) { fail++; console.log('FAIL', name, '·', e.message); }
}
function near(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }

const base = {
  age: 48, female: false, priorFloods: 1, cost: 12, travelTime: 20, waitTime: 5,
  walkDistance: 0.2, peersStay: 0.3, peersRide: 0.1, threat: 'low',
  waterDepthM: 0.3, hazardRatingValue: 0.9, minutesSinceWarning: 30,
  rplZ: [0, 0, 0],
};

// ---- 模式开关 ----
check('默认模式是 gate', () => decideMode() === 'gate');
check('设置 single 生效', () => setDecideMode('single') === 'single' && decideMode() === 'single');
check('非法模式被忽略', () => { setDecideMode('whatever'); return decideMode() === 'single'; });
check('DECIDE_MODES 只列两种', () => DECIDE_MODES.length === 2 && DECIDE_MODES.includes('gate'));
check('默认变体是 merge', () => singleVariant() === 'merge');
check('设置 raw 生效', () => setSingleVariant('raw') === 'raw');
check('非法变体被忽略', () => { setSingleVariant('xxx'); return singleVariant() === 'raw'; });
setSingleVariant('merge');

// ---- 门结构（gate）语义 ----
setDecideMode('gate');
check('gate：没收到预警 → 概率 0', () => {
  const r = decideProtectiveAction({ ...base, received: false }, () => 0.5);
  return r.probability === 0 && r.gates.mode === 'gate';
});
check('gate：概率 = 动员 × 选择（不是相加、不是取大）', () => {
  const r = decideProtectiveAction(base, () => 0.5);
  const expect = r.gates.mobilisation * r.gates.choiceProbability;
  return near(r.probability, expect, 2e-4);
});
check('gate：刚收到预警时动员尚未到 1（有时间轴）', () => {
  const r = decideProtectiveAction({ ...base, minutesSinceWarning: 0 }, () => 0.5);
  return r.gates.mobilisation < 0.2 && r.gates.triggered === null;
});

// ---- 单式基线（single）语义 ----
setDecideMode('single');
check('single：没收到预警也不清零（没有接收门）', () => {
  const r = decideProtectiveAction({ ...base, received: false }, () => 0.5);
  return r.probability > 0 && r.gates.mode === 'single';
});
check('single：没泡到水就不动（二元触发）', () => {
  const r = decideProtectiveAction({ ...base, waterDepthM: 0, hazardRatingValue: 0 }, () => 0.5);
  return r.probability === 0 && r.gates.triggered === false;
});
check('single：泡到水即触发，动员置 1（没有动员曲线）', () => {
  const r = decideProtectiveAction({ ...base, minutesSinceWarning: 0 }, () => 0.5);
  return r.gates.triggered === true && r.gates.mobilisation === 1;
});
check('single：线性指数 = λk·k + λa·a + λu·(Ve−Vs) + 威胁档', () => {
  const q = { ...base, threat: 'moderate' };
  const k = knowledgeScore(q);
  const a = actionScore(q, k);
  const U = protectiveActionUtilities(q, null);
  const L = SINGLE_UTILITY.variants.merge;
  const v = L.lambdaKnowledge * k + L.lambdaAction * a
    + L.lambdaUtility * (U.evacuate - U.stay) + SINGLE_UTILITY.threatUtility.moderate;
  const s = singleUtilityScore(q, null);
  return near(s.v, v, 1e-9) && near(s.probability, 1 / (1 + Math.exp(-v)), 1e-12);
});
check('single：威胁档位越高指数越大（extreme > moderate > low）', () => {
  const f = (threat) => decideProtectiveAction({ ...base, threat }, () => 0.5).gates.singleUtility;
  return f('extreme') > f('moderate') && f('moderate') > f('low');
});
check('merge 与 raw 两种合并给出不同指数（三个缩放确实在起作用）', () => {
  setSingleVariant('merge');
  const m = singleUtilityScore(base, null).v;
  setSingleVariant('raw');
  const r = singleUtilityScore(base, null).v;
  setSingleVariant('merge');
  return Math.abs(m - r) > 1e-6;
});

// ---- 门5 两模式一致 ----
check('门5 一致：care_child 未解除时两模式概率都是 0', () => {
  const q = { ...base, impediment: 'care_child', minorWith: false };
  const g = (() => { setDecideMode('gate'); return decideProtectiveAction(q, () => 0.5); })();
  const s = (() => { setDecideMode('single'); return decideProtectiveAction(q, () => 0.5); })();
  return g.probability === 0 && s.probability === 0
    && g.gates.posture === 'gather_child' && s.gates.posture === 'gather_child';
});
check('门5 一致：on_duty 未解除时两模式概率都是 0', () => {
  const q = { ...base, threat: 'moderate', impediment: 'on_duty' };
  const g = (() => { setDecideMode('gate'); return decideProtectiveAction(q, () => 0.5); })();
  const s = (() => { setDecideMode('single'); return decideProtectiveAction(q, () => 0.5); })();
  return g.probability === 0 && s.probability === 0;
});
check('门5 一致：no_vehicle 不改概率、只改姿态', () => {
  setDecideMode('single');
  const a = decideProtectiveAction({ ...base, impediment: 'none' }, () => 0.5);
  const b = decideProtectiveAction({ ...base, impediment: 'no_vehicle' }, () => 0.5);
  return b.probability > 0 && b.gates.posture === 'walk' && near(a.probability, b.probability, 1e-9);
});

// ---- 元数据与接线 ----
check('SINGLE_UTILITY 写明出处与限制（≥3 条）', () => {
  return SINGLE_UTILITY.source.includes('Swait') && SINGLE_UTILITY.limits.length >= 3
    && SINGLE_UTILITY.trigger.includes('水深');
});
check('CHOICE_META 登记了消融基线', () => {
  return typeof CHOICE_META.ablationBaseline === 'string'
    && CHOICE_META.ablationBaseline.includes('SIM_DECIDE');
});
check('main.js 接了 ?decide 与 ?single', () => {
  const s = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  return /QS_ROAD\.get\('decide'\)/.test(s) && /QS_ROAD\.get\('single'\)/.test(s)
    && /setDecideMode\(DM\)/.test(s) && /setSingleVariant\(SV\)/.test(s);
});
check('sim-day.mjs 接了 SIM_DECIDE 与 SIM_SINGLE', () => {
  const s = fs.readFileSync(path.join(SRC, '../sim/sim-day.mjs'), 'utf8');
  return /SIM_DECIDE/.test(s) && /SIM_SINGLE/.test(s)
    && /searchParams\.set\('decide'/.test(s) && /searchParams\.set\('single'/.test(s);
});
check('cohort 仍走 decideProtectiveAction（没有为消融另开一条路）', () => {
  const s = fs.readFileSync(path.join(SRC, 'cohort.js'), 'utf8');
  return /decideProtectiveAction\(input, rnd\)/.test(s);
});

setDecideMode('gate');
setSingleVariant('merge');
console.log(`\n${pass}/${pass + fail} 通过`);
if (fail) process.exit(1);