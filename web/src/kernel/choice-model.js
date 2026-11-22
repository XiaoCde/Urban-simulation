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
import { hazardRating, hazardClass } from './flow-hazard.js';

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
 * 【2026-11-21 全部删除：自设缩放不再存在】
 *
 * 旧版这里有五个自设数：knowledgeToActionScale 0.50、actionToUtilityScale 0.80、
 * borowskiUtilityScale 0.25、threatUtility{none 0, low 0.35, moderate 1.30,
 * extreme 2.60}、baselineExposure 0.15。它们的真实身份是**跨数据集 logit 的
 * 尺度参数 λ 比值**（Swait & Louviere 1993, JMR 30(3):305–314）：把两组不同
 * 样本、不同因变量估出来的系数合并进同一个线性指数之前，必须估计或检验 λ。
 * 拿不到原始数据就估不出 λ，所以正确的做法不是「另定一个能跑的数」，而是
 * **不让它们进同一个式子**——改成串行门之后，这里一个缩放都不需要了。
 *
 * 现在保留的只有实测项：年龄中心与离散度（Thieken Table S1 印刷）与
 * 设计表来源；其余键刻意保持为空，避免有人再往里塞数。
 */
export const SCALING = {
  note: '【2026-11-21】五个自设缩放（0.50/0.80/0.25/威胁主效应/0.15）已删除，'
    + '理由见上：它们是跨论文 logit 的 λ 比值，不估计就不能设。'
    + '决策改为串行门（接收→风险识别→启动→选择→阻碍），各门用自己的原始系数相乘，不需要量纲缩放。',
  ageCentre: 48.0,                // Table S1 印刷的样本年龄均值 48.0 (SD 13.2)，实测
  ageScale: 13.2,                 // 同上，标准差，实测
  attributeSource: BOROWSKI_DESIGN.source,
};

/** 已退役的自设项及其真实身份，写进报告/台账时照抄这一份。 */
export const RETIRED_SELF_SET = Object.freeze({
  knowledgeToActionScale: { value: 0.50, why: '有序 logit 预测子 → 1–6 知识量表的映射，无出处；λ 不可估' },
  actionToUtilityScale: { value: 0.80, why: 'Thieken 线性预测子 → Borowski 效用尺度，无出处；λ 不可估' },
  borowskiUtilityScale: { value: 0.25, why: 'stated-choice 效用 → 归一，无出处；λ 不可估' },
  threatUtility: { value: { none: 0, low: 0.35, moderate: 1.30, extreme: 2.60 }, why: 'Borowski Table 4 未印威胁主效应，四档效用无出处' },
  baselineExposure: { value: 0.15, why: '无雨起点暴露，无出处' },
});

/**
 * 【2026-11-21 加：经验必须能影响「走不走」，否则它只是个标签】
 *
 * 问题：认知层（Thieken 2023 Table S2/S3）算得出「既往洪水经历 → 情境知识 →
 * 保护行为」的线性预测子，但它的量纲是有序 logit 的指数，无法直接塞进
 * Borowski 的效用差，中间必须过 λ（Swait & Louviere 1993）。λ 估不出来，
 * 原来的做法是整条退出主公式——结果是最强的预测子（4 次以上 vs 0 次差
 * 2.001 log-odds，约 7.4 倍优势比）对行为零作用。
 *
 * 现在的做法：不把知识当「加项」塞进效用，而是让它作用在**启动**这一门
 * （门3），即"多快进入保护行动"。这是 Thieken 认知层在因果链上的位置，
 * 也是 Lindell & Perry 序列里「注意—理解—动员」那一段。
 *
 *     r_i = exp(κ · (k_i − k_ref))          经验相对倍数
 *     M_i = clamp( M(t) · r_i , 0, 1 )       门3 的动员率
 *
 * 依据与假设分开写：
 *   · 结构（经验 → 知识 → 动员，只动"多快"不动"去哪"）：Thieken Table S2/S3；
 *   · k_i 的系数：原文印刷值，不改；
 *   · κ：**唯一的自由标量**。默认 1.0 = 完全采用文献估出的相对强度、只在
 *     人群内做相对调整（等价于假设 λ=1）。这个假设必须点名，并在报告里用
 *     κ ∈ {0.5, 1, 2} 做敏感性；
 *   · k_ref：参考人（1 次经历、无官方预警、无意外、中性性别、洪水影响 0），
 *     把相对调整锚在人群中段，避免整体概率被整体抬高或压低；
 *   · ratioClip 0.25–4：纯数值保护，防止极端组合把概率推到 0/1 之后
 *     再也出不来（也让 κ=2 时不会炸）。
 *
 * 关掉：?exp=off（main.js）/ SIM_EXP=off（sim-day.mjs）→ 回到"经验不进
 * 概率"的旧口径，供 A/B 对照。
 */
export const EXPERIENCE_LINK = Object.freeze({
  mode: 'mobilise',
  kappa: 1.0,
  ratioClip: [0.25, 4],
  reference: Object.freeze({
    priorFloods: 1,
    officialWarning: false,
    female: false,
    surprise: 0.1,
    floodImpact: 0,
    note: '参考人：1 次既往洪水、无官方预警、无意外事件、中性性别、洪水影响 0',
  }),
  assumption: 'λ=1（跨论文 logit 尺度参数比取 1），κ 需 0.5/1/2 敏感性',
  source: 'Thieken et al. 2023, NHESS 23:973–990, Table S2（认知层）与 S3（行动层）',
});

let _expLink = true;
export function setExperienceLink(on) { _expLink = on !== false; }
export function experienceLinkOn() { return _expLink; }

// 【2026-11-21 敏感性】κ 是这条通道上唯一的自由标量（λ=1 假设），必须扫 0.5/1/2。
// 之前它写死在 Object.freeze 里，只能改源码再重跑 —— 那不算敏感性分析，那是改代码。
// 现在运行时可设：?kappa=0.5（main.js）/ SIM_KAPPA=2（sim-day.mjs）。
let _kappa = EXPERIENCE_LINK.kappa;
export function setExperienceKappa(v) {
  const x = Number(v);
  if (Number.isFinite(x) && x > 0) _kappa = x;
}
export function experienceKappa() { return _kappa; }


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
  // 【2026-11-19 随机参数的抽取层级】
  // 原论文是随机参数 logit：cost / 同伴搭车 / 同伴留下 各自有均值和标准差，
  // 每个受访者有三个**独立**的偏差。此前的实现有三个问题：
  //  ① 三个随机参数共用同一个 draw（本该独立，等于强行相关）；
  //  ② 每次判断都重抽（每天上万次），个体差异被平均掉，全城收敛到均值 7.76；
  //  ③ 7.76 的标准差 10.87 比均值还大（论文自己写 vary widely），
  //     固定成一个人人相同的数，等于把「有人跟从、有人逆反、有人不受影响」抹平。
  // 现在改为：外面按人抽一次三个独立偏差传进来（q.rplZ），决策时不再重抽。
  // 未传时退回旧的单次抽样，保持内核自检的黄金值不变。
  const z = Array.isArray(q.rplZ) && q.rplZ.length >= 3
    ? [finiteOr(q.rplZ[0], 0), finiteOr(q.rplZ[1], 0), finiteOr(q.rplZ[2], 0)]
    : null;
  const draw = rnd ? normal(rnd) : 0;
  const zCost = z ? z[0] : draw;
  const zRide = z ? z[1] : draw;
  const zStay = z ? z[2] : draw;
  const peersStay = clamp(finiteOr(q.peersStay, 0), 0, 1);
  const peersRide = clamp(finiteOr(q.peersRide, 0), 0, 1);
  // 【修 2026-11-17】非法档名（如 'foo'）会让 threatInteraction 查表得
  // undefined，Ve/Vs 变 NaN。统一收敛到合法档，'none' 按 'low' 的语义处理。
  const threat = safeThreat(q.threat || 'low');

  // ---- 疏散侧 ----
  let Ve = E.evacuateASC
    + (c.cost + c.costSD * zCost) * finiteOr(q.cost, 0)
    + (c.peersRide + c.peersRideSD * zRide) * peersRide
    + c.travelTime * finiteOr(q.travelTime, 0)
    + c.waitTime * finiteOr(q.waitTime, 0)
    + c.walkDistance * finiteOr(q.walkDistance, 0)
    + c.age * ((finiteOr(q.age, S.ageCentre) - S.ageCentre) / S.ageScale);
  if (threat !== 'low') Ve += (E.threatInteraction.peersRide[threat] || 0) * peersRide;

  // ---- 留下侧：同伴效应在这里，ASC 固定 0 ----
  let Vs = (c.peersStay + c.peersStaySD * zStay) * peersStay;
  if (threat !== 'low') Vs += (E.threatInteraction.peersStay[threat] || 0) * peersStay;

  return { evacuate: Ve, stay: Vs };
}

/**
 * 危险度分级 → Borowski 的危险措辞。这是**工程映射**：Borowski 2023 的
 * moderate / extreme 从未对应到任何水深数值（第四轮 QA2），所以这里只是把
 * FD2321 的分级结果翻成它那两个词，用它的交互项系数，不新增系数。
 */
export const THREAT_OF_HAZARD = Object.freeze({
  low: 'low', some: 'moderate', most: 'extreme', all: 'extreme',
});

/**
 * 一次决策：五道门串行。**不再把三篇文献的系数塞进同一个线性指数。**
 *
 * 门1 接收 —— 由 kernel/warning.js 的收到时刻决定（Silva 2025：35.5% 收不到）。
 *              走到这里的人默认已收到；`received === false` 直接不动。
 * 门2 风险识别 —— 危险等级取自 FD2321 危险度 HR = d(v+0.5)+DF 的分级
 *              （low / some / most / all → low / moderate / extreme）。
 *              这是工程映射，不是实测对应，写在 THREAT_OF_HAZARD 上面。
 * 门3 启动 —— Silva 2025 Table S2 的实测动员率 M(t)（Eq.(S2) 为其形状）。
 * 门4 选择 —— Borowski & Stathopoulos 2023 Table 4 的二元随机参数 logit
 *              **原样**：P(撤离) = σ(Ve − Vs)，不乘任何缩放。
 * 门5 阻碍 —— **改变可行集，不是否决**：
 *              · 没车 → 照走，只是不开车（步行代价由涉水判据算）；
 *              · 值守在岗 → 先履职，危险度到 most 以上自动解除（自保优先）。
 *              判据与出处见 kernel/access-impediment.js。
 *
 * 概率 = M(t) × σ(Ve − Vs)。两个比例相乘是条件概率分解
 * 「先动起来、再在撤与留之间选」，不需要权重，也不需要跨论文换算尺度。
 * 这正是 Silva 2025 自己的结构（预警扩散 → 动员 → 走/留），
 * 也是 Lindell & Perry 2012 的保护性行动决策序列。
 *
 * 认知层（Thieken Table S2/S3）**不进这条路**：它们是「情境知识 / 感知效果」
 * 的有序 logit 预测子，因变量不是行动，也没有印阈值，只能做分层验证。
 * 这里仍然算出来返回，供检验用，不参与 probability。
 */

/**
 * 【2026-11-22 加：单式基线（消融对照用）】
 *
 * 论文要回答的不是「门结构跑得动」，而是「不拆门会怎样」。所以这里把
 * 「单式效用」恢复成一个可运行的基线，两种写法都实现：
 *
 *   merge（默认）—— 把三张表的线性预测子用退役记录里的三个数
 *                    （0.50 / 0.80 / 0.25）压到同一量纲再相加。这是
 *                    「不拆门」时最自然的工程做法，也是 2026-11-21 之前的写法。
 *   raw         —— 完全不做尺度换算，直接把三张表的系数相加。用来验证
 *                    「不换算会怎样」，说明 merge 那一组缩放不是随便挑的。
 *
 * 触发规则也回到旧式：**水深 > 0 即进入决策**（二元触发），没有接收门、
 * 没有动员曲线、没有 AFT 时间轴。这正是导师批评的「触发即逃」。
 *
 * 门5（阻碍）在两种模式下**完全一致**：消融要隔离的是「决策结构」，不是
 * 「可行集」。否则分不清差异来自哪一层。
 *
 * 为什么这两个缩放可以当成「基线」而不是「我们编的数」：它们原本就在
 * RETIRED_SELF_SET 里登记过，值就是 0.50 / 0.80 / 0.25，退役理由是不能把
 * 跨论文 logit 的 λ 比值拍出来（Swait & Louviere 1993）。基线用它们，是因为
 * 「如果非要合并，也只能这么合并」——把不可估的量按旧值填上，然后看结果偏到哪。
 */
export const SINGLE_UTILITY = Object.freeze({
  variants: Object.freeze({
    merge: Object.freeze({
      lambdaKnowledge: 0.50,
      lambdaAction: 0.80,
      lambdaUtility: 0.25,
      note: '退役记录里的三个 λ 比值：0.50 知识→行动、0.80 行动→效用、0.25 效用归一',
    }),
    raw: Object.freeze({
      lambdaKnowledge: 1,
      lambdaAction: 1,
      lambdaUtility: 1,
      note: '不做任何尺度换算，三张表系数直接相加',
    }),
  }),
  threatUtility: Object.freeze({ none: 0, low: 0.35, moderate: 1.30, extreme: 2.60 }),
  trigger: '水深 > 0 即进入决策（二元触发）；无接收门、无动员曲线、无 AFT 时间轴',
  source: 'RETIRED_SELF_SET（0.50 / 0.80 / 0.25 / 威胁四档）+ Thieken Table S2/S3 + Borowski Table 4；'
    + 'λ 不可估的依据：Swait & Louviere 1993, JMR 30(3):305–314',
  limits: Object.freeze([
    '这是「不拆门」的对照基线，不是要替代五道门；它的存在是为了让消融有对照组',
    '三个 λ 比值不可估（Swait & Louviere 1993），所以基线的绝对概率没有解释意义，只看差异方向',
    '门5 阻碍在两种模式下一模一样，差异只来自接收/动员/时间轴这一层',
    '水位 > 0 触发是工程规则，没有任何文献支持它是「人开始决策」的阈值',
  ]),
});

export const DECIDE_MODES = Object.freeze(['gate', 'single']);

let _decideMode = 'gate';
let _singleVariant = 'merge';

export function setDecideMode(mode) {
  const x = String(mode || '').toLowerCase();
  if (DECIDE_MODES.includes(x)) _decideMode = x;
  return _decideMode;
}
export function decideMode() { return _decideMode; }
export function setSingleVariant(v) {
  const x = String(v || '').toLowerCase();
  if (SINGLE_UTILITY.variants[x]) _singleVariant = x;
  return _singleVariant;
}
export function singleVariant() { return _singleVariant; }

/** 危险度 → 措辞（门2 与单式基线共用，保证两边用的是同一套分级）。 */
function threatForInput(q) {
  if (q.threat) return safeThreat(q.threat);
  const hr = Number.isFinite(Number(q.hazardRatingValue))
    ? Number(q.hazardRatingValue)
    : hazardRating(Number(q.waterDepthM) || 0, Number(q.flowSpeedMs) || 0);
  return THREAT_OF_HAZARD[hazardClass(hr)] || 'low';
}

/** 单式基线的线性指数 V 与概率 σ(V)。 */
export function singleUtilityScore(input, rnd) {
  const q = input && typeof input === 'object' ? input : {};
  const L = SINGLE_UTILITY.variants[_singleVariant] || SINGLE_UTILITY.variants.merge;
  const k = knowledgeScore(q);
  const a = actionScore(q, k);
  const threat = threatForInput(q);
  const U = protectiveActionUtilities({ ...q, threat }, rnd);
  const v = L.lambdaKnowledge * k
    + L.lambdaAction * a
    + L.lambdaUtility * (U.evacuate - U.stay)
    + (SINGLE_UTILITY.threatUtility[threat] || 0);
  return { v, probability: sigmoid(v), threat, knowledge: k, actionScore: a, utilities: U };
}

export function decideProtectiveAction(input, rnd) {
  const q = input && typeof input === 'object' ? input : {};
  const draw = typeof rnd === 'function' ? rnd : null;

  // ---- 门1 接收 ----
  const received = q.received === undefined ? true : !!q.received;

  // ---- 门2 风险识别 ----
  // 显式传入的 threat 优先（敏感性分析、个案回放用）；否则由危险度分级推出来。
  // 这条映射是工程映射，不是实测对应，见 THREAT_OF_HAZARD 上方注释。
  const hr = Number.isFinite(Number(q.hazardRatingValue))
    ? Number(q.hazardRatingValue)
    : hazardRating(Number(q.waterDepthM) || 0, Number(q.flowSpeedMs) || 0);
  const hcls = hazardClass(hr);
  const threat = q.threat ? safeThreat(q.threat) : (THREAT_OF_HAZARD[hcls] || 'low');

  // ---- 门3 启动（含经验修正：多快进入保护行动）----
  const knowledge = knowledgeScore(q);
  // 参考人 = 与这个人完全相同、只是「经历过 1 次」的另一个自己。
  // 这样相对倍数只反映经验差，不会被「官方预警有没有收到」等共同项整体抬高/压低
  // （第一版拿固定参考人算，warning 打开时全人群的倍数被统一抬到 1.77 倍，是错的）。
  const kRef = Number.isFinite(Number(q.knowledgeRef))
    ? Number(q.knowledgeRef)
    : knowledgeScore({ ...q, priorFloods: 1 });
  const expRatio = _expLink
    ? clamp(Math.exp(_kappa * (knowledge - kRef)),
      EXPERIENCE_LINK.ratioClip[0], EXPERIENCE_LINK.ratioClip[1])
    : 1;
  const points = q.mobilisationPoints || MOBILISATION_OBSERVED.points;
  const sinceWarn = finiteOr(q.minutesSinceWarning, 0);
  const mobilisationBase = mobilisedBy(sinceWarn, points);
  // 【AFT 形式】Hasan et al. 2013, TR-C 27:108–116：
  //   k_h(t|X) = k0[t·e^{β'X}]·e^{β'X} —— 协变量**重标时间轴**，不是乘概率。
  //   所以经验多的人不是"概率乘倍数"，而是"同样一分钟对他等于更多分钟"：
  //   mobilisation = M(t·ratio)；ratio=1 时与没有经验修正完全一致。
  //   时间轴重标的函数形式来自该文（Weibull 基线，P=3.906），M(t) 仍用 Silva 实测曲线。
  const mobilisation = clamp(
    mobilisedBy(sinceWarn * expRatio, points), 0, 1);

  // ---- 门4 选择（Borowski 原样）----
  const U = protectiveActionUtilities({ ...q, threat }, draw);
  const pChoice = sigmoid(U.evacuate - U.stay);

  // ---- 【2026-11-22 消融】单式基线：把上面四道门塌成一条效用方程 ----
  // 只在本模块被 setDecideMode('single') 打开时生效（?decide=single / SIM_DECIDE=single）。
  // 读数：v 是单式线性指数，pSingle 是 σ(v)；触发放在这里，因为旧式没有「动员」这一层。
  const singleMode = _decideMode === 'single';
  const depthNow = finiteOr(q.waterDepthM, 0);
  const triggered = depthNow > 0;
  const single = singleMode
    ? singleUtilityScore({ ...q, threat }, draw)
    : null;
  const pSingle = single ? single.probability : 0;

  // ---- 门5 阻碍：改可行集，不是否决动机 ----
  // PADM（Lindell & Perry 2012）把「阻碍」放在**行动实施**环节，不是动机环节：
  // 有阻碍的人不是不动，而是改成他动得了的那个动作。洪水里的两条实证方向：
  //  ① Ahr 谷 2021：34% 离家或获救（Silva 2025），没走的多数往上走（垂直撤离），
  //     不是站在原地看着水涨——生命损失最小的正是上楼那批。
  //  ② 没车的人本来就是走或坐公交（PADM §4 的原文里点名 transit dependent），
  //     仿真里所有行人都是步行的，所以他不是「走不了」，只是不开车走。
  // 因此：
  //  · no_vehicle —— 不改概率，只改「怎么走」。长距离步行更慢、涉水暴露更久，
  //    代价由涉水判据（wadingSpeed / 耐受 / 失稳）自己算，不再由门 5 一刀切 0。
  //  · on_duty —— 履职优先，但这个优先权会被自身危险解除：危险度到 most
  //    （FD2321「danger for most」，HR ≥ 1.25）时自保优先，与 PADM 的
  //    威胁评估回路一致（威胁上来要重启决策，不是一条道走到黑）。
  const impediment = q.impediment && q.impediment !== 'none' ? String(q.impediment) : 'none';
  // 解除口径统一为「自保优先」：
  //  · no_vehicle —— 本来就不是否决，只改「怎么走」，所以直接算已解除；
  //  · on_duty   —— 危险度到 most（FD2321「danger for most」，HR ≥ 1.25）时自保优先；
  //  · care_child —— 孩子已经在身边（minorWith）或危险度到 most 时解除：
  //    照护责任的语义是「不能一个人先走」，不是「陪着一起不动」。
  const impedimentLifted = impediment === 'none'
    ? false
    : (impediment === 'no_vehicle' ? true
      : (impediment === 'care_child' ? (q.minorWith === true || hcls === 'most' || hcls === 'all')
        : (hcls === 'most' || hcls === 'all')));
  const dutyHold = impediment === 'on_duty' && !impedimentLifted;
  // 孩子在身边之前，不单独撤离；与 dutyHold 分开命名，统计上要能分开看。
  const careHold = impediment === 'care_child' && !impedimentLifted;
  const posture = dutyHold ? 'stay_on_duty'
    : (careHold ? 'gather_child'
      : (impediment === 'no_vehicle' ? 'walk' : 'evacuate'));

  // 【修 2026-11-17】clamp 不拦 NaN：概率必须是有限数，否则 rnd() < NaN 恒 false。
  // 【2026-11-22 消融】单式基线：不加接收门、不乘动员、只看「泡到水没有」。
  // 阻碍照旧生效（dutyHold / careHold），这是两模式共用的门5，不属于消融变量。
  const raw = singleMode
    ? ((triggered && !dutyHold && !careHold) ? pSingle : 0)
    : ((!received || dutyHold || careHold) ? 0 : mobilisation * pChoice);
  const probability = Number.isFinite(raw) ? clamp(raw, 0, 1) : 0;

  const aScore = actionScore(q, knowledge);

  return {
    protect: draw ? draw() < probability : false,
    probability,
    // 兼容字段：utility 现在是 Borowski 的效用差本身（不做任何缩放）
    utility: U.evacuate - U.stay,
    utilities: U,
    knowledge,
    actionScore: aScore,
    mobilisation,
    gates: {
      mode: singleMode ? 'single' : 'gate',
      singleVariant: singleMode ? _singleVariant : null,
      triggered: singleMode ? triggered : null,
      received,
      hazardRating: +hr.toFixed(3),
      hazardClass: hcls,
      threat,
      mobilisation: singleMode ? (triggered ? 1 : 0) : +mobilisation.toFixed(4),
      mobilisationBase: +mobilisationBase.toFixed(4),
      experienceRatio: +expRatio.toFixed(3),
      knowledgeLinearPredictor: +knowledge.toFixed(4),
      choiceProbability: singleMode ? +pSingle.toFixed(4) : +pChoice.toFixed(4),
      singleUtility: single ? +single.v.toFixed(4) : null,
      impediment,
      impedimentLifted,
      posture,
    },
    components: {
      warning: q.officialWarning ? 1 : 0,
      priorFloods: clamp(finiteOr(q.priorFloods, 0), 0, 4),
      experienceRatio: +expRatio.toFixed(3),
      waterDepthOrdinal: waterDepthOrdinalOf(q.waterDepthM),
      peersStay: clamp(finiteOr(q.peersStay, 0), 0, 1),
      threat,
      mobilisation: +mobilisation.toFixed(3),
    },
  };
}

/** Eq.(S2) 的形状，只用于对照与敏感性分析；运行时概率用实测点。 */
export function mobilisationShape(minutes) {
  return mobilisedShapeByEquation(minutes);
}

export const CHOICE_META = {
  form: '五道门串行：接收（Silva 扩散）→ 风险识别（FD2321 危险度）→ 启动（Silva 动员率 × 经验相对倍数）→ 选择（Borowski 二元随机参数 logit，原样）→ 阻碍（改可行集：无车改步行、值守在岗在自身危险时解除）',
  ablationBaseline: 'setDecideMode("single")（?decide=single / SIM_DECIDE=single）：把三张表的线性预测子用 RETIRED_SELF_SET 的 0.50/0.80/0.25 压到同一量纲相加，水深>0 即触发，无接收门/无动员曲线/无 AFT；门5 两模式一致。见 SINGLE_UTILITY',
  coefficientsFrom: [
    KNOWLEDGE_LOGIT.source, ACTION_LOGIT.source,
    EVACUATION_LOGIT.source,
    'Silva et al. 2025, NHESS 25:1501–1520, Supplement Table S2 / Eq.(S2), DOI 10.5194/nhess-25-1501-2025-supplement',
  ],
  measuredTables: [
    BOROWSKI_DESIGN.source, MOBILISATION_OBSERVED.source,
  ],
  selfSet: [
    'THREAT_OF_HAZARD：FD2321 分级 → Borowski 的 moderate/extreme 措辞，工程映射（该文两个词从未对应水深）',
    'SCALING.ageCentre / ageScale 为实测印刷值，不是自设',
    'EXPERIENCE_LINK.kappa = 1.0：唯一的自由标量，含义是"跨论文 λ 取 1、只做人群内相对调整"；'
      + '必须点名，并用 κ ∈ {0.5, 1, 2} 做敏感性（ratioClip 0.25–4 只是数值保护）',
    'EXPERIENCE_LINK.reference：参考人取 1 次经历（中位），把相对倍数锚在人群中段',
  ],
  retired20261121: Object.keys(RETIRED_SELF_SET),
  limits: [
    'Table S2/S3 是有序 logit，第四轮 QA1 再次确认任何版本都没印阈值，只能给相对分数；'
      + '本文件不直接用它的绝对概率，而是把它的相对结构接到门3（经验 → 多快动员），'
      + '绝对水平仍由 Silva 的实测动员曲线给',
    '三张表来自德国 2021 洪水调查、美国六州 stated-choice、跨灾种历史案例，外推到华盛顿特区需写明',
    'Borowski 2023 的 moderate / extreme 从未对应到任何水深，分档是工程映射（QA2）',
    '门5 只接了两条（无车 / 值守在岗，来自 ACS）；「需照顾家人」「行动受限」没有数据源，未接。无车只把姿态改成步行、不清零概率',
    '「水深 → 涉水／绕行／等待」三分动作仍无实测比例（QA5 第四轮复检仍为「没有」），细动作降级为路径执行',
    '同户同伴的「留下比例」peersStay 与「选择乘车比例」peersRide 都由 live-agent 的 peerSharesOf() '
      + '按合成参照群体（同户 + 120 m 内最多 3 个邻居，≈论文的「最多 5 人」）实时统计，'
      + '见 kernel/peer-share.js；「乘车」用在车状态 ped.inVehicle 判定，是本仿真唯一可观测代理',
    '参照群体是按住址就近配对合成的，不是真实社会网络调查；拿到真实网络数据应替换',
    '属性仍按 Borowski 表 3 的实测设计范围截断（成本 0–40 美元、时间 0–60 分钟、'
      + '步行 0–0.5 英里、同伴留下 0–0.8）；超出设计范围的个案要单独标注，不能直接外推',
  ],
};
