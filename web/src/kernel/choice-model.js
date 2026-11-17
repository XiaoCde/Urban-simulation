/**
 * choice-model.js — 离散选择：人要不要「启动保护性行动」。
 *
 * 【为什么换掉旧的】旧 cohort.judge() 是一条手写线性打分公式
 *   「继续 = 1.55 + 进度×0.35 − 前方水深×0.8 …」，
 * 系数全是项目自己定的，还用「威胁超过阈值才放开动作池」的二元开关。
 * 录音里导师明确否掉了这种形式。现在整套弃用，不做双实现并存。
 *
 * 【现在的形式】四层，全部是概率，没有阈值开关：
 *   1 认知层  情境知识（知道该怎么做）—— Thieken 2023 补充材料 Table S2 有序 logit
 *   2 行动层  保护性行动倾向       —— Thieken 2023 补充材料 Table S3 有序 logit
 *   3 选择层  继续日常 / 启动保护  —— Borowski & Stathopoulos 2023 Table 4 二元 logit
 *   4 时间层  预警何时到、多久才动 —— Silva 2025 补充材料 Table S2（跨灾种）
 * 选完之后「绕哪条街 / 等在哪 / 走多快」是路径执行，由真实几何与实测步速决定，
 * 不再是一个行为决策模型。这一层在 docs/依据台账.md 标为「目前自己定的」。
 *
 * 【关于量纲，必须说清】这些系数来自不同国家、不同因变量、不同量表的研究。
 * 系数值、符号、显著性照抄原文。第四轮回件把 Borowski 2023 Table 3 的
 * 实验设计范围拿回来了，米→英里、秒→分钟、绕路→美元这三个换算
 * 已按物理单位与实测 32.78 美元/英里做实，见 kernel/attributes.js；
 * 剩下把仿真量归一化到设计范围、认知层缩放、威胁主效应这些仍是
 * **目前自己定的**，全部列在 SCALING 里并做敏感性分析。
 * 绝对概率水平用 Silva 2025 Table S2 印刷的 8/24/72 小时实测动员率，
 * 不拿 logit 的截距当 probability，也不再用自设的 S 形曲线。
 *
 * 【数据来源】全名、机构、年份、表号、DOI、样本量、本地文件见文末附录，
 * 以及 from muse/数据来源.md 第二节。这里每个系数都带出处和 p 值。
 */
import { normal } from './rng.js';
import {
  SILVA_SCENARIOS, MOBILISATION_OBSERVED, MOBILISATION_META,
  mobilisedBy, mobilisedShapeByEquation, warningReachedBy,
} from './mobilisation.js';
import { BOROWSKI_DESIGN } from './evidence-tables.js';

// 这两个函数由 hazard-input.js 从本文件读取，保持导出接口不变。
export { mobilisedBy, warningReachedBy };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sigmoid = (z) => 1 / (1 + Math.exp(-clamp(z, -30, 30)));
// 【修 2026-11-17】?? 只挡 null/undefined，不挡 NaN。这些效用系数一旦乘上
// NaN，整条概率链会静默变成 NaN，决策恒不触发。统一用「有限数或默认值」。
const finiteOr = (v, d) => {
  if (v === null || v === undefined) return d;
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
};
const safeThreat = (t) => (t === 'none' || t === 'low' || t === 'moderate' || t === 'extreme') ? t : 'low';

/**
 * Thieken et al. 2023, NHESS 23:973–990, DOI 10.5194/nhess-23-973-2023,
 * Supplement Table S2：有序 logit，因变量 = 情境知识「洪水来临前是否知道
 * 该怎么保护自己和家人」，n = 1,097，德国 2021 年洪水在线调查。
 * 本地原件 from muse/Thieken_2023_NHESS_23_973_supplement.pdf。
 * 只列 p < 0.05 的系数；不显著的 Age(0.530)、Own search(0.773)、
 * Friends(0.485)、National News(0.074) 按 0 处理并保留说明。
 * 联邦州固定效应是德国两州差异，华盛顿特区场景不适用，不接入。
 */
export const KNOWLEDGE_LOGIT = {
  source: 'Thieken et al. 2023, NHESS 23:973–990, Supplement Table S2, DOI 10.5194/nhess-23-973-2023, n=1097',
  coefficients: {
    female: 0.493,               // p=0.000
    officialWarning: 0.571,      // p=0.006（base = 未收到预警）
    warningInformation: 0.147,   // p=0.028
    surprise: -0.648,            // p=0.000
    floodImpact: -0.078,         // p=0.019
  },
  /** 既往洪水次数的分档系数，base = 从未经历过。p 全 < 0.002。 */
  priorFloods: { 0: 0, 1: 0.680, 2: 0.901, 3: 2.010, 4: 2.001 },
  omitted: 'Age p=0.530、Own search p=0.773、Friends/neighbours p=0.485、National News p=0.074 不显著，未接入；Federal state 是德国州别固定效应，不适用',
};

/**
 * Thieken et al. 2023 补充材料 Table S3：有序 logit，
 * 因变量 = 感知减损行为（perceived damage reduction），n = 1,003。
 * 本地原件同上。Water depth 是 Table S1 印刷的 1–7 有序编码，不是米：
 *   1 无水 / 2 仅地下室 / 3 ≤0.5 m / 4 >0.5–1 m /
 *   5 >1–2 m / 6 >2–4 m / 7 >4 m
 * 这是目前唯一带数值的「水深 → 保护行为」实测系数。
 */
export const ACTION_LOGIT = {
  source: 'Thieken et al. 2023, NHESS 23:973–990, Supplement Table S3, DOI 10.5194/nhess-23-973-2023, n=1003',
  coefficients: {
    situationalKnowledge: 0.296,   // p=0.000
    age: -0.012,                   // p=0.008
    priorFloods: 0.212,            // p=0.008
    surprise: -0.248,              // p=0.001
    waterDepthOrdinal: -0.28,      // p=0.000
  },
  marginal: {
    female: 0.216,                 // p=0.081，边缘显著，只进敏感性分析
  },
  omitted: 'Warning source p=0.574、Warning information p=0.293 不显著，未接入；Federal state 不适用',
  /**
   * Table S1 印刷的水深编码，把仿真的米换成论文的有序等级：
   * 1 无水 / 2 仅地下室 / 3 ≤0.5 m / 4 >0.5–1 m / 5 >1–2 m / 6 >2–4 m / 7 >4 m。
   * 边界是论文原文，不是自设阈值。「仅地下室」在仿真里没有对应观测量，跳过。
   */
  waterDepthCoding: [
    { max: 0, grade: 1 }, { max: 0.5, grade: 3 }, { max: 1.0, grade: 4 },
    { max: 2.0, grade: 5 }, { max: 4.0, grade: 6 }, { max: Infinity, grade: 7 },
  ],
};

export function waterDepthOrdinalOf(depthM) {
  const d = Math.max(0, Number(depthM) || 0);
  for (const step of ACTION_LOGIT.waterDepthCoding) {
    if (d <= step.max) return step.grade;
  }
  return 7;
}

/**
 * Borowski & Stathopoulos 2023, Natural Hazards Review 24(1):04022045,
 * DOI 10.1061/(ASCE)NH.1527-6996.0000577, Table 4：
 * 随机参数 logit，疏散（Evacuate）对留下（Stay，ASC 固定 0），
 * stated-choice 在线调查 600 人、建模 n=586 / 5,274 个选择结果。
 * 系数全表见 from muse/DC Flood Pedestrian Simulation Data (1).html 的
 * 「Borowski & Stathopoulos 2023 随机参数 logit 全表」一节。
 * 原始微观数据不公开（人类受试者保护）。
 *
 * 【两个备选项要分开算】论文里 "Stay" ASC 固定为 0，"Evacuate" ASC=4.22。
 * 同伴相关三项（Share peers staying 7.76、Peers staying × moderate −9.27、
 * × extreme −21.13）作用在「留下」这一侧：同伴都留下时人更倾向一起留下；
 * 危险升高时这个跟随效应被抵消甚至反转，人自己走。这正是录音里点名的
 * 「从众随危险衰减」，不用自己编曲线。
 * 论文派生的 WTP 数字也印证这个方向：同伴留下比例 0% → 100% 需要
 * $271.13 的疏散补偿；moderate 威胁下降到 $43.89，extreme 时变成愿付。
 * 所以 P(疏散) = exp(V_e) / (exp(V_e) + exp(V_s))，不能把同伴系数直接
 * 加到疏散效用里 —— 那样危险越大反而越不动，与原文结论相反。
 */
export const EVACUATION_LOGIT = {
  source: 'Borowski & Stathopoulos 2023, Natural Hazards Review 24(1):04022045, Table 4, DOI 10.1061/(ASCE)NH.1527-6996.0000577, n=586/5274 outcomes',
  evacuateASC: 4.22,             // p=0.000；Stay ASC 固定 0
  coefficients: {
    cost: -3.71,                 // p=0.000
    costSD: 1.03,                // 随机参数标准差
    peersRide: -1.27,            // p=0.000
    peersRideSD: 1.91,
    peersStay: 7.76,             // p=0.000
    peersStaySD: 10.87,
    travelTime: -0.02,           // p=0.000
    waitTime: -0.03,             // p=0.000
    walkDistance: -1.08,         // p=0.000
    age: 0.21,                   // p=0.000
  },
  /** 威胁等级交互项；分档来自 Thieken Table S1 水深编码，映射见 hazard-input.js。 */
  threatInteraction: {
    peersRide: { moderate: 0.50, extreme: 1.11 },     // p=0.037 / 0.000
    peersStay: { moderate: -9.27, extreme: -21.13 },  // p=0.000 / 0.000
  },
  omitted: 'Shared seat / Luggage / Disability / Pets / Anxiety / Fear / Major pandemic 等属性在本仿真没有对应观测量，未接入；Flood threat × major pandemic 是疫情期交互，不适用',
};

/**
 * 时间层参数，全部来自 Silva et al. 2025 补充材料 Table S2，
 * 完整五情景 × 三档数值在 kernel/mobilisation.js，不再在本文件里存一份。
 * 第四轮回件 QE1 把 Eq.(S2) 原文公式和 Table S2 全表取回来了，
 * 之前那条自设 S 形曲线「(t/b)^a/(1+(t/b)^a)×0.986」已删除。
 * 绝对概率直接用 Table S2 印刷的 8/24/72 小时实测值。
 */
export const MOBILISATION = {
  source: MOBILISATION_OBSERVED.source,
  scenario: 'A1.1 Fast, most likely',
  table: SILVA_SCENARIOS,
  observedPoints: MOBILISATION_OBSERVED.points,
  warningRayleighB: SILVA_SCENARIOS.A1_1_Fast.Bt[1],   // 9.5，实测
  warningBroadcastC: SILVA_SCENARIOS.A1_1_Fast.Ct[1],  // 0.098，实测
  mobilisationA: SILVA_SCENARIOS.A1_1_Fast.am[1],      // 1.37，实测
  medianMinutes: SILVA_SCENARIOS.A1_1_Fast.bm[1],      // 64.0，实测
  observedRate: { h8: 0.888, h24: 0.957, h72: 0.986 }, // Table S2 实测
  equationS2: 'P_mobilised(t) = 1 − exp(−(t/bm)^(2/am))',
  runtime: 'mobilisedBy() 用实测 8/24/72 小时点插值；Eq.(S2) 只作形状参考',
  limitations: MOBILISATION_META.selfSet,
  underlyingCases: SILVA_SCENARIOS.source.sample,
};

/**
 * 【目前自己定的】量纲缩放。
 * 三张系数表的自变量是问卷题项、stated-choice 属性、有序等级，
 * 仿真里的量是米、秒、0–1 比例。
 * 第四轮回件把 Borowski 2023 Table 3 的实验设计范围取回来了，
 * 米→英里、秒→分钟、绕路→美元这三个换算已改到 kernel/attributes.js，
 * 基准值全部是实测设计表，本文件不再有 0.001 / 0.01 那种随手系数。
 * 剩下的缩放集中在这里，改一个就能做敏感性分析，不藏在公式里。
 */
export const SCALING = {
  note: '除 ageCentre / ageScale 外，全部为目前自己定的量纲映射，不是实测；用于把仿真观测量送进上面的实测 logit 系数。改动任何一个都要重跑敏感性表。',
  knowledgeToActionScale: 0.50,   // 有序 logit 线性预测子 → Table S3 的 1–6 情境知识量表
  actionToUtilityScale: 0.80,     // Thieken 线性预测子 → Borowski 效用尺度
  borowskiUtilityScale: 0.25,     // stated-choice 效用（ASC 4.22 量级）→ 归一
  /**
   * 危险等级进入疏散效用的主系数。
   * 【目前自己定的】Borowski Table 4 只印了「同伴 × 威胁」交互项，
   * 没有印威胁等级的主效应；缺这一项的话，没有同伴时危险再大也不会
   * 提高保护行动概率。第四轮 QA2 还确认：该文的 moderate / extreme
   * **从未对应到任何水深数值**，所以这里的分档也不能说成实测深度。
   * 危险等级本身来自 DEFRA HR 分级（实测工程分级）。
   */
  threatUtility: { none: 0, low: 0.35, moderate: 1.30, extreme: 2.60 },
  /** 雨刚下时仍有一小部分人会动，不该是 0；这个起点是目前自己定的。 */
  baselineExposure: 0.15,
  ageCentre: 48.0,                // Table S1 印刷的样本年龄均值 48.0 (SD 13.2)，实测
  ageScale: 13.2,                 // 同上，标准差，实测
  attributeSource: BOROWSKI_DESIGN.source,
};

/**
 * 认知层：算「情境知识」的线性预测子。
 * 有序 logit 的阈值（cut points）补充材料没有印，所以这里只给相对分数，
 * **不输出绝对概率** —— 这个限制写进 docs/依据台账.md。
 */
export function knowledgeScore(input) {
  const q = input && typeof input === 'object' ? input : {};
  const c = KNOWLEDGE_LOGIT.coefficients;
  const floods = clamp(Math.round(finiteOr(q.priorFloods, 0)), 0, 4);
  return c.female * (q.female ? 1 : 0)
    + c.officialWarning * (q.officialWarning ? 1 : 0)
    + c.warningInformation * clamp(finiteOr(q.warningInformation, 0), 0, 4)
    + c.surprise * clamp(finiteOr(q.surprise, 0), 0, 1)
    + c.floodImpact * clamp(finiteOr(q.floodImpact, 0), 0, 1)
    + KNOWLEDGE_LOGIT.priorFloods[floods];
}

/** 行动层：Table S3 的线性预测子。 */
export function actionScore(input, knowledge) {
  const q = input && typeof input === 'object' ? input : {};
  const c = ACTION_LOGIT.coefficients;
  return c.situationalKnowledge * finiteOr(knowledge, 0)
    + c.age * (finiteOr(q.age, SCALING.ageCentre) - SCALING.ageCentre)
    + c.priorFloods * clamp(finiteOr(q.priorFloods, 0), 0, 4)
    + c.surprise * clamp(finiteOr(q.surprise, 0), 0, 1)
    + c.waterDepthOrdinal * waterDepthOrdinalOf(q.waterDepthM);
  // Table S3 的 Gender 系数 0.216 只有 p=0.081，边缘显著，默认不接入；
  // 敏感性分析时在 CHOICE_META 里登记后单独打开，不混进主结果。
}

/**
 * 选择层：二元 logit 的两个备选项效用。
 * V_e = 疏散／启动保护行动，V_s = 留下／继续日常。
 * 随机参数（cost / peersRide / peersStay 的 SD）按个体抽一次正态偏差，
 * 这是原论文 random-parameter logit 的规格，不是自己加的噪声。
 */
export function protectiveActionUtilities(input, rnd) {
  const q = input && typeof input === 'object' ? input : {};
  const E = EVACUATION_LOGIT;
  const c = E.coefficients;
  const S = SCALING;
  const draw = rnd ? normal(rnd) : 0;
  const peersStay = clamp(finiteOr(q.peersStay, 0), 0, 1);
  const peersRide = clamp(finiteOr(q.peersRide, 0), 0, 1);
  // 【修 2026-11-17】非法档名（如 'foo'）会让 threatInteraction 查表得
  // undefined，Ve/Vs 变 NaN。统一收敛到合法档，'none' 按 'low' 的语义处理。
  const threat = safeThreat(q.threat || 'low');

  // ---- 疏散侧 ----
  let Ve = E.evacuateASC
    + (c.cost + c.costSD * draw) * finiteOr(q.cost, 0)
    + (c.peersRide + c.peersRideSD * draw) * peersRide
    + c.travelTime * finiteOr(q.travelTime, 0)
    + c.waitTime * finiteOr(q.waitTime, 0)
    + c.walkDistance * finiteOr(q.walkDistance, 0)
    + c.age * ((finiteOr(q.age, S.ageCentre) - S.ageCentre) / S.ageScale);
  if (threat !== 'low') Ve += (E.threatInteraction.peersRide[threat] || 0) * peersRide;

  // ---- 留下侧：同伴效应在这里，ASC 固定 0 ----
  let Vs = (c.peersStay + c.peersStaySD * draw) * peersStay;
  if (threat !== 'low') Vs += (E.threatInteraction.peersStay[threat] || 0) * peersStay;

  return { evacuate: Ve, stay: Vs };
}

/**
 * 一次决策。
 * 返回 { protect, probability, utility, knowledge, actionScore, components }。
 * protect 是抽样出来的布尔值，不是阈值比较；同一处境不同人、不同次都不同。
 *
 * 认知层／行动层的线性预测子（Thieken Table S2/S3）在这里只作为**先验**，
 * 通过明确标注为自设的缩放进入疏散效用；它们是有序 logit 的预测子，
 * 因变量分别是「情境知识」和「感知减损效果」，不是行动概率，
 * 补充材料也没有印阈值，所以不直接当概率用。
 * 绝对概率上限用 Silva 2025 实测动员率校准，避免把 stated-choice 的
 * 截距 4.22 直接当成「99% 的人都会撤离」。
 */
export function decideProtectiveAction(input, rnd) {
  const q = input && typeof input === 'object' ? input : {};
  const draw = typeof rnd === 'function' ? rnd : null;
  const S = SCALING;
  const knowledge = knowledgeScore(q);
  const aScore = actionScore(q, knowledge * S.knowledgeToActionScale);
  const U = protectiveActionUtilities(q, draw);
  const prior = (knowledge * S.knowledgeToActionScale + aScore)
    * S.actionToUtilityScale;
  // 危险等级主效应进入疏散效用；界值来自 DEFRA HR 分级，系数是目前自己定的。
  const threatMain = S.threatUtility[safeThreat(q.threat || 'low')] ?? 0;
  const V = (U.evacuate - U.stay) * S.borowskiUtilityScale + prior + threatMain;
  const raw = sigmoid(V);
  // 「危险暴露」是连续权重，不是二元门控。
  // 水深用 Thieken 2023 Table S1 印刷的 1–7 有序编码归一（实测编码，
  // 不是自设厘米阈值）；无水=1 级 → 暴露 0，人不会凭空启动保护行动。
  // 再乘 Silva 2025 的实测动员曲线：预警刚发出时几乎没人动，
  // 随暴露时长连续上升，24 小时到 95.7%。
  const grade = waterDepthOrdinalOf(q.waterDepthM);
  const depthExposure = clamp((grade - 1) / 6, 0, 1);
  // 时间暴露直接用 Silva 2025 Table S2 印刷的实测动员率（插值），
  // mobilisationPoints 只供敏感性分析注入，正常运行时不传。
  const timeExposure = mobilisedBy(finiteOr(q.minutesSinceWarning, 0),
    q.mobilisationPoints || MOBILISATION_OBSERVED.points);
  const baseline = S.baselineExposure;
  const exposure = clamp(
    depthExposure * (baseline + (1 - baseline) * timeExposure), 0, 1);
  // 不再额外乘一次 h24：timeExposure 本身已经是实测动员率，
  // 上一版乘两次时间把概率压低了，这里去掉重复。
  // 【修 2026-11-17】clamp 不拦 NaN；概率与暴露都必须是有限数，否则
  // rnd() < NaN 恒 false，人会静默「永远不动」而不报错。
  const probability = Number.isFinite(raw * exposure) ? clamp(raw * exposure, 0, 1) : 0;
  const safeExposure = Number.isFinite(exposure) ? exposure : 0;
  return {
    protect: draw ? draw() < probability : false,
    probability,
    utility: V,
    utilities: U,
    knowledge,
    actionScore: aScore,
    components: {
      warning: q.officialWarning ? 1 : 0,
      priorFloods: clamp(finiteOr(q.priorFloods, 0), 0, 4),
      waterDepthOrdinal: waterDepthOrdinalOf(q.waterDepthM),
      peersStay: clamp(finiteOr(q.peersStay, 0), 0, 1),
      threat: safeThreat(q.threat || 'low'),
      exposure: +safeExposure.toFixed(3),
    },
  };
}

/** Eq.(S2) 的形状，只用于对照与敏感性分析；运行时概率用实测点。 */
export function mobilisationShape(minutes) {
  return mobilisedShapeByEquation(minutes);
}

export const CHOICE_META = {
  form: '两层有序 logit 认知／行动 + 二元随机参数 logit 选择 + Table S2 实测动员率',
  coefficientsFrom: [
    KNOWLEDGE_LOGIT.source, ACTION_LOGIT.source,
    EVACUATION_LOGIT.source,
    'Silva et al. 2025, NHESS 25:1501–1520, Supplement Table S2 / Eq.(S2), DOI 10.5194/nhess-25-1501-2025-supplement',
  ],
  measuredTables: [
    BOROWSKI_DESIGN.source, MOBILISATION_OBSERVED.source,
  ],
  selfSet: Object.keys(SCALING).filter((k) => k !== 'note' && k !== 'attributeSource'),
  limits: [
    'Table S2/S3 是有序 logit，第四轮 QA1 再次确认任何版本都没印阈值，只能给相对分数',
    '三张表来自德国 2021 洪水调查、美国六州 stated-choice、跨灾种历史案例，外推到华盛顿特区需写明',
    'Borowski 2023 的 moderate / extreme 从未对应到任何水深，分档是工程映射（QA2）',
    '实测设计范围之间的归一化、认知层缩放、威胁主效应仍是目前自己定的，必须做敏感性分析',
    '「水深 → 涉水／绕行／等待」三分动作仍无实测比例（QA5 第四轮复检仍为「没有」），细动作降级为路径执行',
    '同伴比例尚未从周围人状态统计，显式给 0；公开定义已在 QA9 拿到，待个案回放阶段接入',
  ],
};
