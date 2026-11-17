import { hash01 } from './draw.js';

/**
 * 预警接收（内核判定，纯函数，不碰 window / document / three）
 *
 * 【为什么要有这个模块】2026-11-17 之前，运行时把「收到官方预警」写成
 * 「降雨开始之后」——而这批工况的降雨从 0 点起，等于午夜一到全城每个人都
 * 收到了预警，然后一路累积到傍晚十九个小时。认知层的官方预警项（系数
 * +0.571）与时间层的实测动员曲线（Silva 2025）都建立在这个值上，于是
 * 全城被按「最知情」在算，保护行动系统性偏高。
 *
 * 【依据】Thieken 等 2022（NHESS 22:165–185）表 4、表 5，2016 年德国
 * 地表水内涝子样本 n = 448（表 5 的预警来源 n = 448，预警前置时间 n = 141）：
 *   · 完全没收到任何预警、事前也不知道的比例：35.5%
 *   · 预警前置时间：均值 2.5 小时、中位数 1 小时
 *   · 察觉方式里最多的是「自己看到水位」（47.3%），其次才是官方天气预警
 *     （13.6%）与邻里告知（7.6%）
 *
 * 第三条决定了这个模块的形状：内涝里面大多数人不是被广播叫醒的，是看见
 * 水才知道。所以这里把「收到预警的时刻」挂在他**本地水深第一次超过 3 cm**
 * 的前面若干分钟，而不是挂在一个统一的城市时刻上。这是近似，写在下面。
 *
 * 【这是近似，不是实测】前置时间的分布形式（对数正态）是我们选的，
 * 只为同时对上「中位数 1 小时」和「均值 2.5 小时」两个数；论文只给这两个
 * 统计量，没印分布。谁也没测过「某人比他脚下见水早多少分钟收到短信」。
 */

/** 文献里的实测值（Thieken 2022 表 4）。 */
export const WARNING_MEASURED = Object.freeze({
  neverWarnedShare: 0.355,   // 完全没收到预警的比例
  leadMedianMin: 60,         // 前置时间中位数（分钟）
  leadMeanMin: 150,          // 前置时间均值（分钟）
  awareByOwnObservation: 0.473,  // 靠自己看到水察觉
});

/**
 * 【目前自己定的】分布形式与截断。论文只给中位数、均值两个统计量。
 */
export const WARNING_SELF_SET = Object.freeze({
  /** 前置时间按对数正态：由中位数 60、均值 150 反解出 σ 与 μ。 */
  distribution: 'lognormal',
  /** 截断：少于 5 分钟等于没提前；超过 10 小时在内涝里不成立。 */
  leadClipMin: [5, 600],
  /** 本地水深到这个值就算「看见了水」，据此反推收到预警的时刻。 */
  wetThresholdM: 0.03,
});

/** 由中位数与均值反解对数正态参数。 */
function lognormalParams(median, mean) {
  const mu = Math.log(median);
  const sigma = Math.sqrt(2 * Math.log(mean / median));
  return { mu, sigma };
}
const LN = lognormalParams(WARNING_MEASURED.leadMedianMin, WARNING_MEASURED.leadMeanMin);

/** 标准正态分位数（Acklam 有理逼近，误差 < 1.2e-9）。 */
function invNorm(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const pl = 0.02425;
  let q, r;
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * 这个人到底收不收得到官方预警。
 * 35.5% 收不到——依据是 Thieken 2022 表 4 的内涝子样本。
 */
export function receivesWarning(i) {
  return hash01(i, 0x9e37) >= WARNING_MEASURED.neverWarnedShare;
}

/**
 * 这个人的预警前置时间（分钟）。中位数 60、均值 150 的对数正态，截断在 5–600。
 */
export function warningLeadMin(i) {
  const u = Math.min(0.999999, Math.max(1e-6, hash01(i, 0x85eb)));
  const raw = Math.exp(LN.mu + LN.sigma * invNorm(u));
  const [lo, hi] = WARNING_SELF_SET.leadClipMin;
  return Math.min(hi, Math.max(lo, raw));
}

/**
 * 收到预警的时刻（一天分钟）。
 *
 * @param {number} firstWetMin 他所在位置第一次见水的时刻（一天分钟）
 * @param {number} i 人员编号
 * @returns {number} 收到预警的分钟；`Infinity` 表示自始至终没收到
 *
 * 收不到的人返回 Infinity；收得到的人 = 见水时刻 − 前置时间（不低于 0）。
 * 一直没见水的人不收预警：内涝里近一半人本来就是「看见水才知道」，
 * 没水可看就谈不上预警。这一条是近似，写在模块头的说明里。
 */
export function warnAtOf(firstWetMin, i) {
  if (!receivesWarning(i)) return Infinity;
  if (!Number.isFinite(firstWetMin)) return Infinity;
  return Math.max(0, firstWetMin - warningLeadMin(i));
}

/** 供验收与文档引用。 */
export const WARNING_META = Object.freeze({
  measured: [
    '完全没收到预警的比例 35.5%：Thieken et al. 2022, NHESS 22:165–185, Table 4（2016 地表水内涝，n=448）',
    '预警前置时间均值 2.5 h、中位数 1 h：同上 Table 4 与 Table 5（前置时间 n=141）',
    '察觉方式：自己看到水位 47.3%、官方天气预警 13.6%、邻里告知 7.6%：同上 Table 5',
  ],
  selfSet: [
    '前置时间取对数正态（只为对上中位数与均值两个统计量，论文未印分布）',
    '截断 5–600 分钟',
    '预警时刻挂在本地点首次见水（3 cm）之前，而非统一城市时刻；这是按「47.3% 靠自己看到水」做的近似',
    '一直没见水的人不赋预警',
  ],
});
