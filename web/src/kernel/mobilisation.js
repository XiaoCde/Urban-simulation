/**
 * mobilisation.js — 预警扩散与动员时间曲线，来自实测论文，不再用自设 S 形曲线。
 *
 * Silva, A. F. R. et al. (2025), "Assessing the impact of early warning and
 * evacuation on human losses during the 2021 Ahr Valley flood in Germany
 * using agent-based modelling", Natural Hazards and Earth System Sciences
 * 25:1501–1520, DOI 10.5194/nhess-25-1501-2025；
 * 补充材料 DOI 10.5194/nhess-25-1501-2025-supplement，Table S2 与 Eq.(S1)/(S2)。
 * 本地原件：from muse/Silva_2025_NHESS_25_1501_supplement.pdf（2026-11-15 下载核对）。
 *
 * 【之前的问题】choice-model.js 里的 mobilisedBy() 是我自己写的一条
 *   (t/b)^a / (1 + (t/b)^a) × 0.986
 * S 形曲线，形式没有出处；warningReachedBy() 还把 C_t 当成上限乘在整条
 * 曲线外面，导致预警 8 小时后只有约 3% 的人收到消息，和 Table S2 印的
 * 88.8% 完全对不上。第四轮回件 QE1 把公式拿回来了，这里整套换掉。
 *
 * 【换上什么】
 *   Eq.(S2)  P_mobilised(t) = 1 − exp(−(t/bm)^(2/am))   补充材料里清晰可读
 *   Eq.(S1)  P_warned(t) = P_warned(t−1) + Rayleigh_pdf(t;Bt)·(1−P_warned(t−1)) + Ct·(…)
 *            其中 Ct 项在出版社 PDF 文本层里的确切位置无法逐字复原，
 *            回件明确标注「未猜」，所以这里只实现可复原的 Rayleigh 累积结构，
 *            Ct 作为附加效率项处理，并把这一处标为「目前自己定的」。
 *   Table S2 给出五情景 × 三档（upper / most likely / lower）的
 *            Bt / Ct / am / bm 全表，以及 8 / 24 / 72 小时实测动员率。
 *
 * 【t 的单位】补充材料没有印 t 或 bm 的单位。bm=64.0 按分钟解释时，
 * Eq.(S2) 在 8 小时就接近 1，高于 Table S2 实测的 88.8%。因此运行时
 * **绝对概率一律以 Table S2 的实测 8/24/72 小时值做上限**，Eq.(S2) 只
 * 提供 0–8 小时之间的形状。这个「以实测值封顶」的处理是工程决定，
 * 登记在 docs/依据台账.md，不是原文规定。
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Table S2 五情景，每个字段按 [upper, mostLikely, lower] 排列。 */
export const SILVA_SCENARIOS = Object.freeze({
  source: {
    title: 'Assessing the impact of early warning and evacuation on human losses during the 2021 Ahr Valley flood in Germany using agent-based modelling',
    authors: 'Silva, A. F. R. et al.',
    journal: 'Natural Hazards and Earth System Sciences 25:1501–1520', year: 2025,
    doi: '10.5194/nhess-25-1501-2025',
    supplementDoi: '10.5194/nhess-25-1501-2025-supplement',
    table: 'Supplement Table S2；动员公式 Eq.(S2)、警告扩散 Eq.(S1)',
    sample: '底层曲线来自化学品泄漏、危险品运输、火山喷发、山洪等六类历史案例（Sorensen & Mileti 2015a/b；USACE HEC-LifeSim CPD-97 / CPD-97a）',
    url: 'https://nhess.copernicus.org/articles/25/1501/2025/nhess-25-1501-2025-supplement.pdf',
  },
  labels: ['upper', 'mostLikely', 'lower'],
  A1_1_Fast: {
    Bt: [5.0, 9.5, 51.5], Ct: [0.100, 0.098, 0.081],
    am: [1.00, 1.37, 1.80], bm: [25.0, 64.0, 114.0],
    mobilised8h: [1.000, 0.888, 0.771],
    mobilised24h: [1.000, 0.957, 0.911],
    mobilised72h: [1.000, 0.986, 0.972],
    label: '扩散快；准备良好、风险感知可能',
  },
  A1_2_Moderate: {
    Bt: [58.0, 100.0, 142.0], Ct: [0.080, 0.060, 0.043],
    am: [1.35, 1.79, 2.20], bm: [61.8, 111.8, 161.9],
    mobilised8h: [0.815, 0.743, 0.671],
    mobilised24h: [0.950, 0.900, 0.850],
    mobilised72h: [0.985, 0.950, 0.920],
    label: '扩散中等；准备差、风险感知可能',
  },
  A1_3_Slow: {
    Bt: [103.0, 145.0, 150.0], Ct: [0.060, 0.042, 0.040],
    am: [1.35, 1.79, 2.20], bm: [61.8, 111.8, 161.9],
    mobilised8h: [0.659, 0.570, 0.480],
    mobilised24h: [0.887, 0.842, 0.798],
    mobilised72h: [0.928, 0.900, 0.872],
    label: '扩散慢；准备差、风险感知不太可能',
  },
  A1_4: { label: '实测警告扩散曲线 + A1.3 动员' },
  A1_5: { label: '实测动员曲线 + 慢速警告扩散（Bt/Ct 同 A1.3）' },
});

/** 默认情景：A1.1 most likely（准备良好、扩散快），与上一版口径一致，便于对比。 */
export const DEFAULT_SCENARIO = 'A1_1_Fast';
export const DEFAULT_BAND = 1; // mostLikely

/** Table S2 的 8/24/72 小时实测动员率，按小时点插值，作为绝对概率上限。 */
export const MOBILISATION_OBSERVED = Object.freeze({
  source: SILVA_SCENARIOS.source,
  scenario: DEFAULT_SCENARIO,
  points: [
    { minutes: 0, rate: 0 },
    { minutes: 480, rate: 0.888 },
    { minutes: 1440, rate: 0.957 },
    { minutes: 4320, rate: 0.986 },
  ],
  note: '这四个点是 Table S2 印刷的实测值（0 为起点）；中间线性插值属工程处理，已登记台账',
});

/** Eq.(S2) 原文公式，参数全部来自 Table S2，没有自设系数。 */
export function mobilisationEqS2(minutes, am, bm) {
  const t = Math.max(0, Number(minutes) || 0);
  if (t === 0) return 0;
  // 【修 2026-11-17】原先 Number(am)||1.37 会把显式传入的 0 也吞成默认值。
  // 改成「有限且为正才用传入值」，既保留显式合法值，也挡住 0 导致的除零。
  const av = Number(am), bv = Number(bm);
  const a = Number.isFinite(av) && av > 0 ? av : 1.37;
  const b = Number.isFinite(bv) && bv > 0 ? bv : 64.0;
  return clamp(1 - Math.exp(-Math.pow(t / b, 2 / a)), 0, 1);
}

/** 按 Table S2 实测点插值的动员率上限。 */
export function observedCapAt(minutes, points = MOBILISATION_OBSERVED.points) {
  const t = Math.max(0, Number(minutes) || 0);
  // 【修 2026-11-17】空点表原先读 points[-1].rate 直接抛错；相邻点时刻相同
  // 会除零得到 NaN；插值结果也没夹在 [0,1]。这三条都会让 NaN 流进决策概率。
  if (!Array.isArray(points) || points.length === 0) return 0;
  const finiteRate = (v) => clamp(Number.isFinite(Number(v)) ? Number(v) : 0, 0, 1);
  if (t <= Number(points[0].minutes) || points.length === 1) return finiteRate(points[0].rate);
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1], p1 = points[i];
    if (t <= Number(p1.minutes)) {
      const span = Number(p1.minutes) - Number(p0.minutes);
      const f = span > 0 ? clamp((t - Number(p0.minutes)) / span, 0, 1) : 1;
      const r0 = finiteRate(p0.rate), r1 = finiteRate(p1.rate);
      return clamp(r0 + (r1 - r0) * f, 0, 1);
    }
  }
  return finiteRate(points[points.length - 1].rate);
}

/**
 * 运行时用的动员累计概率：**直接用 Table S2 印刷的 8/24/72 小时实测值**。
 *
 * 为什么不把 Eq.(S2) 直接拿来算：补充材料没印 t / bm 的单位，且 Table S2
 * 的 8/24/72 小时值是「警告扩散 × 动员」的联合结果，不是纯动员曲线。
 * 拿单位不明的公式去拟合联合值会变成自己编一条曲线，正是上一轮的问题。
 * 所以绝对概率以实测点为准（中间线性插值），Eq.(S2) 作为形状参考单独导出，
 * 供敏感性分析与文档引用。这样运行时不再有任何自设的 S 形曲线。
 */
export function mobilisedBy(minutes, points = MOBILISATION_OBSERVED.points) {
  return observedCapAt(minutes, points);
}

/** Eq.(S2) 的形状，仅用于对照与敏感性分析，不进运行时概率。 */
export function mobilisedShapeByEquation(minutes, scenarioName = DEFAULT_SCENARIO,
  band = DEFAULT_BAND) {
  const sc = SILVA_SCENARIOS[scenarioName];
  if (!sc || !sc.am) return 0;
  return mobilisationEqS2(minutes, sc.am[band], sc.bm[band]);
}

/**
 * 警告到达比例。Eq.(S1) 可复原的结构是 Rayleigh 累积：
 *   P_warned(t) = 1 − exp(−t² / (2·Bt²))
 * 其中 t 按小时、Bt 是 Table S2 的形状参数。Ct（非官方渠道效率）在原文
 * (S1) 里的确切位置无法逐字复原，这里把它作为附加的线性效率项处理，
 * 明确标为「目前自己定的」，不冒充实测公式。
 */
export function warningReachedBy(minutes, scenarioName = DEFAULT_SCENARIO, band = DEFAULT_BAND) {
  const sc = SILVA_SCENARIOS[scenarioName];
  // 【修 2026-11-17】band 越界时 sc.Bt[band] 是 undefined，2·Bt² 变 NaN，
  // 而 clamp 不拦 NaN，整条概率链被静默污染。取不到有效参数就退回默认值，
  // 与同文件 mobilisedShapeByEquation 的口径保持一致。
  const pick = (arr, fallback) => {
    const v = Number(Array.isArray(arr) ? arr[band] : NaN);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const Bt = pick(sc && sc.Bt, 9.5);
  const Ct = (() => {
    const v = Number(Array.isArray(sc && sc.Ct) ? sc.Ct[band] : NaN);
    return Number.isFinite(v) ? clamp(v, 0, 1) : 0.098;
  })();
  const hours = Math.max(0, Number(minutes) || 0) / 60;
  const rayleigh = 1 - Math.exp(-(hours * hours) / (2 * Bt * Bt));
  return clamp(rayleigh + Ct * (1 - rayleigh), 0, 1);
}

export const MOBILISATION_META = Object.freeze({
  equations: {
    S2: 'P_mobilised(t) = 1 − exp(−(t/bm)^(2/am))，补充材料清晰可读',
    S1: 'Rayleigh 递推结构可复原；Ct 项位置因出版社 PDF 文本层残损未核实',
  },
  measured: ['Table S2 五情景 Bt/Ct/am/bm 全表', '8/24/72 小时动员率', 'Eq.(S2) 形式'],
  runtime: '主概率用 Table S2 实测点插值；Eq.(S2) 只作形状参考，不进运行时',
  selfSet: [
    '实测点之间线性插值',
    'Ct 在 (S1) 中的位置及其作为附加效率项的处理',
    '默认选 A1.1 most likely 情景',
  ],
});
