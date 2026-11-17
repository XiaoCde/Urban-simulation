/**
 * 确定性伪随机（内核工具，纯函数，不碰 window / document / three）
 *
 * 用途：需要"同一个人永远得到同一个抽样"的地方——预警收没收、要不要下地下室、
 * 个人致死风险阈值等。用哈希而不是全局随机流，有三个好处：
 *   1. 换机器、换会话、重跑同一场景，同一个人得到同一个值；
 *   2. 不消耗全局随机数序列，加减一个功能不会把别人的结果全打乱；
 *   3. 可以单独验收：给定 i 和 salt，输出是固定的。
 *
 * 实现是三轮 xor-multiply（murmur3 的 fmix32 变体）。第一版只做了一轮，
 * 实测在 0..999 上均值 0.478、明显偏低（会让"收不到预警"的人多出 4 个
 * 百分点）；改三轮后 5000 人样本均值 0.505、低于 0.355 的占 34.6%。
 */

/** @param {number} i 人员编号 @param {number} salt 用途盐，区分不同用途的抽样 */
export function hash01(i, salt) {
  // 【修 2026-11-17】i=−1 时 +1 归零、Infinity 经 ToUint32 也归零，会让整条
  // 哈希链退化成 0（同一个人每次都得到同一个极端值）。先规范成有限非负整数。
  const n = Number(i);
  const idx = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  let h = Math.imul(idx + 1, 0x27d4eb2d) ^ (Number(salt) >>> 0);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
