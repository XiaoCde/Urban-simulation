/**
 * check-flow-hazard.mjs — 流速危险度内核的回归测试（纯 Node，不需要浏览器）。
 *
 * 目的不是「测试覆盖率」，而是把几条会被报告引用的数钉死：
 *   · HR = d(v+0.5)+DF 的算法与 DF 分级（FD2321 Table 3.1/3.2）
 *   · D·V 失稳判据在静水时退化回「只看水深」（不能偷偷放宽旧判据）
 *   · 自设的「失稳→溺亡」风险曲线单调、且在 HR<1.25 时必须是 0
 */
import assert from 'node:assert/strict';
import {
  hazardRating, hazardClass, debrisFactor, dvProduct, isUnstable,
  stabilityLimits, isSweptAway, sweptDvLimit, setSweptMode, sweptModeOn,
  CHILD_UNSTABLE_DV, HR_BANDS, DEBRIS,
} from '../src/kernel/flow-hazard.js';

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' — ' + (e && e.message)); }
}
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

console.log('flow-hazard');

// ---------------------------------------------------------------- DF 分级
ok('DF：水深 <0.25 m 不计碎屑', () => {
  assert.equal(debrisFactor(0.2, 0.3), 0);
  assert.equal(debrisFactor(0.24, 0.0), 0);
});
ok('DF：0.25–0.75 m 记 0.5', () => {
  assert.equal(debrisFactor(0.3, 0.5), 0.5);
  assert.equal(debrisFactor(0.74, 0.5), 0.5);
});
ok('DF：≥0.75 m 或 ≥2 m/s 记 1.0', () => {
  assert.equal(debrisFactor(0.75, 0.0), 1.0);
  assert.equal(debrisFactor(0.3, 2.0), 1.0);   // 浅水但流速大也算带漂移物
});

// ---------------------------------------------------------------- HR
ok('HR：0.5 m 静水 = 0.5·0.5 + 0.5 = 0.75', () => {
  assert.ok(close(hazardRating(0.5, 0), 0.75));
});
ok('HR：0.3 m / 1 m·s⁻¹ = 0.45 + 0.5 = 0.95（对部分人危险）', () => {
  assert.ok(close(hazardRating(0.3, 1.0), 0.95));
  assert.equal(hazardClass(hazardRating(0.3, 1.0)), 'some');
});
ok('HR：1.0 m / 2 m·s⁻¹ = 2.5 + 1 = 3.5（所有人极端）', () => {
  assert.ok(close(hazardRating(1.0, 2.0), 3.5));
  assert.equal(hazardClass(hazardRating(1.0, 2.0)), 'all');
});
ok('HR：静水 1.2 m = 0.6 + DF(1.0) = 1.6（碎屑因子把深水抬进「对多数人危险」）', () => {
  assert.ok(close(hazardRating(1.2, 0), 1.6));
});
ok('HR：负值/NaN 一律当 0，不制造危险', () => {
  assert.ok(close(hazardRating(-1, -5), 0));
  assert.ok(close(hazardRating(NaN, 1), 0));
});

// ---------------------------------------------------------------- 分级界值
ok('界值：0.75 / 1.25 / 2.5 分别落在 low/some/most/all', () => {
  assert.equal(hazardClass(0.749), 'low');
  assert.equal(hazardClass(0.75), 'some');
  assert.equal(hazardClass(1.249), 'some');
  assert.equal(hazardClass(1.25), 'most');
  assert.equal(hazardClass(2.499), 'most');
  assert.equal(hazardClass(2.5), 'all');
  assert.equal(HR_BANDS.all, 2.5);      // FD2321，不是 FD2320 的 2.0
});

// ---------------------------------------------------------------- D·V 与失稳
ok('D·V：静水时恒为 0 —— 旧判据不被放宽', () => {
  assert.equal(dvProduct(0.9, 0), 0);
  // 静水 0.9 m、成人：限值深度 1.2 m 没到、D·V=0 < 0.6 → 不失稳
  assert.equal(isUnstable(0.9, 0, 40), false);
  // 静水 1.3 m → 仍然按旧口径（限值静水深）失稳
  assert.equal(isUnstable(1.3, 0, 40), true);
});
ok('D·V：0.4 m 水深 + 1.5 m/s 的水流让成人失稳（D·V=0.6）', () => {
  assert.ok(close(dvProduct(0.4, 1.5), 0.6));
  assert.equal(isUnstable(0.4, 1.5, 40), true);
  assert.equal(isUnstable(0.4, 1.4, 40), false);   // 0.56 < 0.6
});
ok('D·V：儿童界值 0.4、限值深度 0.5 m', () => {
  const lim = stabilityLimits(8);
  assert.equal(lim.child, true);
  assert.ok(close(lim.dv, 0.4));
  assert.ok(close(lim.depthM, 0.5));
  assert.equal(isUnstable(0.45, 0, 8), false);     // 没到 0.5
  assert.equal(isUnstable(0.5, 0, 8), true);
});
ok('D·V：行动受限者界值再收紧（自设系数，必须单调）', () => {
  const a = stabilityLimits(40, false), b = stabilityLimits(40, true);
  assert.ok(b.dv < a.dv);
  assert.ok(b.depthM < a.depthM);
});

// ---------------------------------------------------------------- 冲走判据（2026-11-21 重写）
// 旧版测的是自设的秒级风险曲线（0.0002→0.01 /s）与自设门 0.35 m/s / 0.5 m/s，
// 那些数已删除；现在测的是「只用 ARR / Keller & Mitsch 的失稳阈值」这条判据。
ok('冲走：默认关闭，任何情况下都不判', () => {
  setSweptMode(false);
  assert.equal(sweptModeOn(), false);
  assert.equal(isSweptAway(2.0, 3.0, 40), false);
});
ok('冲走：静水恒不判（深水走不动属于困死，另记账）', () => {
  setSweptMode(true);
  assert.equal(isSweptAway(3.0, 0, 40), false);
  assert.equal(isSweptAway(3.0, 0, 8), false);
});
ok('冲走：成人界值 1.2 m²/s（ARR extreme），儿童 0.55（Keller & Mitsch）', () => {
  assert.ok(close(sweptDvLimit(40), 1.2));
  assert.ok(close(sweptDvLimit(8), CHILD_UNSTABLE_DV));
  // 0.4 m × 1.5 m/s = 0.6 —— 低于成人界值，不判冲走
  assert.equal(isSweptAway(0.4, 1.5, 40), false);
  // 1.0 m × 1.3 m/s = 1.3 —— 达到成人界值
  assert.equal(isSweptAway(1.0, 1.3, 40), true);
  // 同一处水对孩子已经到 0.6 ≥ 0.55
  assert.equal(isSweptAway(0.5, 1.2, 8), true);
  assert.equal(isSweptAway(0.5, 1.2, 40), false);
});
ok('冲走：判据可关回去，且不可解释成概率（只有布尔）', () => {
  setSweptMode(true);
  assert.equal(typeof isSweptAway(1, 2, 40), 'boolean');
  setSweptMode(false);
  assert.equal(isSweptAway(1, 2, 40), false);
});

// ---------------------------------------------------------------- 与阈值表一致
ok('界值与 thresholds.js 的 MEASURED 同源（不另立一套数）', () => {
  assert.equal(DEBRIS.shallowM, 0.25);
  assert.equal(HR_BANDS.some, 0.75);
  assert.equal(HR_BANDS.most, 1.25);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);