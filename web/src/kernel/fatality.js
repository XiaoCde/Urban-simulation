/**
 * fatality.js — 洪水致死概率（内核层，纯数值）。
 *
 * 【2026-11-16 第六轮回件 条6】Jonkman 的水深→死亡率函数原文参数已核实，
 * 之前只能标「目前自己定的」的伤亡判定，现在室内被淹这一支换成实测函数。
 *
 * 出处（两份原件都在 from muse/第六轮完整回件-修复版/…/原件/D/）：
 *  · Jonkman, S. N. (2007). *Loss of life estimation in flood risk assessment:
 *    Theory and applications.* PhD thesis, TU Delft，ISBN 978-90-9021950-9。
 *    §7.4 是三区函数的原始出处，本轮逐字核对 Eq. 7-3 / 7-6 / 7-7。
 *  · Jonkman, S. N. & Vrijling, J. K. (2008). "Loss of life due to floods."
 *    *Journal of Flood Risk Management* 1(1):43–56, DOI 10.1111/j.1753-318X.2008.00006.x。
 *    这篇正文只给三区定义与曲线图，解析参数在博士论文第 7 章。
 *
 * 【第五轮转引错了，这里记下来免得再犯】第五轮曾按 UNSW WRL TR 2015/09 的转引
 * 写成 μN=2.00 / σN=5.20，三处都错：
 *  1. remaining zone 是 Eq. 7-7，μN=7.60、σN=2.75（论文 p.209），不是 2.00/5.20；
 *     2.00/5.20 实为第 8 章 New Orleans 个案 Eq. 8-4 的参数，且原文印作
 *     μN=5.20、σN=2.00 —— WRL 转引时把 μ/σ 互换了。
 *  2. breach zone 不是「FD=0.053」，那是 St. Bernard bowl 溃决区的实测平均
 *     死亡率（p.248 案例观测值）；所提方法是 Eq. 7-3：hv≥7 m²/s 且 v≥2 m/s
 *     时 FD=1。
 *  3. 快速涨水区函数 Eq. 7-6（μN=1.46、σN=0.28）第五轮整条漏了。
 * 第五轮当时已标「编码前须核原文」，项目侧也确实没接，所以没有错误进入过代码。
 *
 * 【用在哪、不用在哪 —— 这条必须写清】
 * Jonkman 的 FD(h) 是**区域死亡率**：某地在水深 h 时，死亡人数占总人数的比例。
 * 把它当个体死亡概率，是文献里估算预期死亡人数的标准做法（USACE / FEMA 均用），
 * 但它是「建筑内被淹」这类历史案例拟合出来的，**不是涉水行走的实验数据**。
 * 因此本模块只用于「室内、所在层被淹、无更高干层可退」这一支；
 * 室外涉水仍走失稳判据 + 浸泡时间，不套这个函数。
 *
 * 【没有流速场这个硬限制】离线烘焙的水情帧只存水深，没有流速。
 * breach zone 判据（hv ≥ 7 m²/s 且 v ≥ 2 m/s）需要流速，本项目无法判定，
 * 因此**保守假设不进入溃决区**——也就是不把任何人按 FD=1 处理。
 * 这会让伤亡偏低估，明确记在 docs/依据台账.md 里。
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * 标准正态分布累积函数。Abramowitz & Stegun 26.2.17 近似，
 * 绝对误差 < 7.5e-8，够用（Jonkman 原文的 ΦN 就是标准正态 CDF）。
 */
export function normalCdf(z) {
  const x = Number(z);
  if (!Number.isFinite(x)) return 0;
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x) / Math.SQRT2;
  // 误差函数 erf 的 Abramowitz-Stegun 7.1.26 近似
  const t = 1 / (1 + 0.3275911 * a);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return 0.5 * (1 + s * erf);
}

/** Jonkman 2007 §7.4 的三组参数（原文照抄，欧式小数逗号已换成点）。 */
export const JONKMAN_PARAMS = Object.freeze({
  /** Eq. 7-6 快速涨水区，§7.4.4 p.206；拟合 R²=0.76，50% 死亡率对应 4.3 m。 */
  rapid: { muN: 1.46, sigmaN: 0.28, r2: 0.76,
    fits: 'Netherlands 1953（12 地点）、UK 1953（1）、Japan 1959（2）' },
  /** §7.4.8 pp.214–215：改善到现行标准的建筑质量，一阶估计。 */
  rapidImproved: { muN: 1.68, sigmaN: 0.37, r2: null,
    fits: '同上，按「improved building quality to current standards」修正' },
  /** Eq. 7-7 其余区，§7.4.5 p.209；R²=0.09（拟合很弱），原文说死亡率一般 0–0.02。 */
  remaining: { muN: 7.60, sigmaN: 2.75, r2: 0.09,
    fits: '93 个地点：Japan 1934/1950/1959、Netherlands 与 UK 1953、US 1965' },
  /** Eq. 7-3 溃决区：hv≥7 m²/s 且 v≥2 m/s 时 FD=1（本项目无流速，不判）。 */
  breach: { hvMin: 7, vMin: 2, fd: 1 },
  /** 分区阈值：涨水率 ≥0.5 m/hr（p.205，原文说 0.5–4 之间任取都行）。 */
  rapidRiseRateMhr: 0.5,
  /** 快速涨水区函数只在 h≥2.1 m 时才高于 remaining zone（§7.4.8 图 7-20）。 */
  rapidMinDepthM: 2.1,
});

/**
 * 单个被困者的死亡概率。
 *
 * @param {object} o
 * @param {number} o.depthM 该人**所在层**的积水深度（米）。注意不是室外总水深：
 *   3.95 m 的水、人在 2 楼（地板 3.76 m），他只泡 0.19 m。
 * @param {number} [o.riseRateMhr] 涨水率（米/小时），从水深时间序列算；不给按 0
 * @param {boolean} [o.improvedBuilding] 建筑是否达到现行防洪标准，默认 true
 * @param {number} [o.velocityMs] 流速。本项目没有流速场，默认 0；给到 ≥2 且
 *   hv ≥ 7 时进入溃决区判 FD=1
 * @returns {{fd:number, zone:'breach'|'rapid'|'remaining'|'none', detail:string}}
 */
export function jonkmanFatality(o = {}) {
  const h = clamp(Number(o.depthM) || 0, 0, 20);
  const w = Math.max(0, Number(o.riseRateMhr) || 0);
  const v = Math.max(0, Number(o.velocityMs) || 0);
  const P = JONKMAN_PARAMS;

  if (h <= 0) {
    return { fd: 0, zone: 'none', detail: '该层没有进水' };
  }

  // 溃决区：只有在有流速场时才可能判定。本项目一般走不到这里。
  if (v >= P.breach.vMin && h * v >= P.breach.hvMin) {
    return { fd: P.breach.fd, zone: 'breach',
      detail: `h·v=${(h * v).toFixed(1)} m²/s ≥ 7 且 v=${v.toFixed(1)} ≥ 2，按 Eq.7-3 判 FD=1` };
  }

  // 快速涨水区：涨水率 ≥0.5 m/hr 且水深 ≥2.1 m（低于此值 two-zone 曲线交叉）
  if (w >= P.rapidRiseRateMhr && h >= P.rapidMinDepthM) {
    const p = o.improvedBuilding === false ? P.rapid : P.rapidImproved;
    const z = (Math.log(h) - p.muN) / p.sigmaN;
    return { fd: clamp(normalCdf(z), 0, 1), zone: 'rapid',
      detail: `涨水率 ${w.toFixed(2)} m/hr ≥ 0.5、水深 ${h.toFixed(2)} m ≥ 2.1，`
        + `按 Eq.7-6（μN=${p.muN}、σN=${p.sigmaN}）` };
  }

  // 其余区
  const p = P.remaining;
  const z = (Math.log(h) - p.muN) / p.sigmaN;
  return { fd: clamp(normalCdf(z), 0, 1), zone: 'remaining',
    detail: `水深 ${h.toFixed(2)} m，按 Eq.7-7（μN=${p.muN}、σN=${p.sigmaN}，原文 R²=0.09）` };
}

/**
 * 把「最终死亡概率 FD」换成「按时间累积的风险速率」。
 *
 * FD 是事件结束时死亡的比例，不是每小时概率。要按时间累积，就要一个时间尺度。
 * 这里令「持续暴露 T_REF 小时后，累计死亡概率达到 FD」，用恒定风险率
 * λ = −ln(1−FD)/T_REF，每步 p = 1 − exp(−λ·Δt)。
 *
 * 【目前自己定的】T_REF 取 4 小时。理由：本项目水情是暴雨内涝，从积水到退水
 * 量级是几小时；这个时间尺度只影响「多久达到该概率」，不影响最终值。
 * 改它只改过程、不改结局，已在 docs/依据台账.md 标为自设。
 */
export const TYPICAL_INUNDATION_HOURS = 4.0;

export function fatalRiskPerSecond(fd, tRefHours = TYPICAL_INUNDATION_HOURS) {
  const f = clamp(Number(fd) || 0, 0, 0.999999);
  if (f <= 0) return 0;
  const T = Math.max(1, (Number(tRefHours) || TYPICAL_INUNDATION_HOURS) * 3600);
  return -Math.log(1 - f) / T;
}

/**
 * 每个人一个固定的 [0,1) 阈值，代替随机抽样，保证可复现。
 * 阈值小的人体质差、先死；阈值大的人撑得久。这是确定性的个体差异，
 * 不是每次重抽的随机数。
 */
export function personalThreshold(i) {
  // 加 1 再乘：i=0 时纯乘会让哈希全为 0，阈值变成 0，第一个人会被立刻判死。
  let h = (Math.floor(Number(i) || 0) + 1) * 2654435761;
  h = h >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  return ((h >>> 0) / 4294967296);
}

export const FATALITY_META = Object.freeze({
  source: 'Jonkman 2007 TU Delft 博士论文 §7.4（Eq. 7-3 / 7-6 / 7-7）；'
    + 'Jonkman & Vrijling 2008, JFRM 1(1):43–56, DOI 10.1111/j.1753-318X.2008.00006.x',
  measured: [
    '快速涨水区 Eq.7-6：μN=1.46、σN=0.28，R²=0.76（p.206–207）',
    '改善建筑 Eq.7-6 修正：μN=1.68、σN=0.37（p.214）',
    '其余区 Eq.7-7：μN=7.60、σN=2.75，R²=0.09（p.209）',
    '溃决区判据 Eq.7-3：hv≥7 m²/s 且 v≥2 m/s → FD=1（p.203）',
    '分区阈值：涨水率 0.5 m/hr（p.205）、快速涨水区最低水深 2.1 m（p.214）',
  ],
  selfSet: [
    'TYPICAL_INUNDATION_HOURS = 4 小时：把事件级 FD 换成时间风险速率的尺度，只影响过程不影响结局',
    '没有流速场，因此不判溃决区（等于假设没有人被溃决水流冲毁建筑）——会让伤亡偏低',
  ],
  notApplicable: 'Jonkman 拟合的是建筑内被淹的历史案例，不是涉水行走；室外涉水不套此函数',
});
