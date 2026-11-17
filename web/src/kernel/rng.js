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
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i];
  if (!(total > 0)) return 0;
  let u = rnd() * total;
  for (let i = 0; i < weights.length; i++) {
    u -= weights[i];
    if (u <= 0) return i;
  }
  return weights.length - 1;
}

/** 标准正态（Box-Muller），随机参数 logit 的个体差异要用。 */
export function normal(rnd) {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}
