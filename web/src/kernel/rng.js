/**
 * rng.js — 内核用的确定性随机数。
 *
 * 不放页面对象、不放 3D 对象，纯 Node 命令行能直接跑。
 * 与 decision.js 的 mulberry32 是同一个算法（同一 seed 得到同一串数），
 * 单独放一份是为了让内核层不反向依赖上层的 decision.js。
 *
 * 来源：项目内既有实现，非外部数据集；这是工程工具，不是行为参数。
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 按权重抽一个下标。weights 必须非负、总和大于 0。 */
export function weightedIndex(weights, rnd) {
  // 【修 2026-11-17】weights 为 null / 非数组时原先直接抛 TypeError；
  // 负权重会让累计值倒退；rnd 缺失会在下面调用时抛错。
  if (!Array.isArray(weights) || weights.length === 0) return 0;
  const draw = typeof rnd === 'function' ? rnd : null;
  if (!draw) return 0;
  const w = weights.map((x) => {
    const v = Number(x);
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
  let total = 0;
  for (let i = 0; i < w.length; i++) total += w[i];
  if (!(total > 0)) return 0;
  let u = Math.max(0, Math.min(1, Number(draw()) || 0)) * total;
  for (let i = 0; i < w.length; i++) {
    u -= w[i];
    if (u <= 0) return i;
  }
  return weights.length - 1;
}

/** 标准正态（Box-Muller），随机参数 logit 的个体差异要用。 */
export function normal(rnd) {
  // 【修 2026-11-17】rnd 恒返回 0 时 while 永不退出；返回 >1 或 NaN 时
  // −2·log(u) 为负 / NaN，开方得 NaN。限制重抽次数并校验取值域。
  if (typeof rnd !== 'function') return 0;
  let u = 0;
  for (let k = 0; k < 32 && !(u > 0 && u <= 1); k++) u = Number(rnd());
  if (!(u > 0 && u <= 1)) return 0;
  const v = Number(rnd());
  if (!Number.isFinite(v)) return 0;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
