/**
 * evidence-tables.js — 第四轮回件带回来的实测数值表，集中存放。
 *
 * 【为什么单独一个文件】之前这些数字散在 PDF、HTML 回件和代码注释里，
 * 用的时候要翻半天，出处还容易写错。这里一律按「一张表 = 一个出处」存，
 * 每条都带文章全名、作者、年份、表号、DOI、样本量，方便文末附录逐条引用，
 * 也方便以后拿到新版本时整表替换，不用在公式里找数字。
 *
 * 【性质】本文件里的数全部是「真实数据集」或「文献里的实测值」，
 * 不是本项目模型跑出来的数。凡是本项目自己定的缩放、映射、阈值，
 * 一律不放在这里，仍集中在 choice-model.js 的 SCALING、
 * thresholds.js 的 SELF_SET、hazard-input.js 的 HAZARD_INPUT_META。
 *
 * 【核对】2026-11-15 从 par.nsf.gov、Copernicus、Crossref 取回原文，
 * 逐项比对了报告抄录的数字：Borowski 全文 15 页 16/16 命中，
 * Ahsanuzzaman 全文 19 页 11/11 命中，Roy & Hasan 全文 34 页 6/6 命中，
 * Arshaghi 全文 XML 11/11 命中。完整检索记录见 from muse/round4-report.md。
 */
import { SILVA_SCENARIOS, MOBILISATION_OBSERVED } from './mobilisation.js';

/**
 * Borowski & Stathopoulos 2023, Table 3 —— stated-choice 实验的属性设计范围。
 * 之前 choice-model.js 的 SCALING 用 0.001 / 0.01 这种随手定的系数，把仿真
 * 的米、秒硬塞进论文属性；现在改用这张实测设计表做归一化基准。
 * 注意 Table 3 是设计变量描述统计，Table 4 才是模型估计结果（别混）。
 */
export const BOROWSKI_DESIGN = Object.freeze({
  source: {
    title: 'Protection or Peril of Following the Crowd in a Pandemic-Concurrent Flood Evacuation',
    authors: 'Borowski, E. & Stathopoulos, A.',
    journal: 'Natural Hazards Review 24(1):04022045', year: 2023,
    doi: '10.1061/(ASCE)NH.1527-6996.0000577',
    table: 'Table 3（设计变量描述统计）', sample: '600 人发放，586 人有效，5,274 个选择结果',
    url: 'https://par.nsf.gov/servlets/purl/10401527',
  },
  costUSD: { min: 0, max: 40, mean: 11.60, sd: 15.65 },
  peerFractionRide: { min: 0, max: 1, mean: 0.27, sd: 0.29 },
  peerFractionStay: { min: 0, max: 0.8, mean: 0.19, sd: 0.22 },
  travelTimeMin: { min: 0, max: 60, mean: 25.96, sd: 23.83 },
  waitTimeMin: { min: 0, max: 60, mean: 18.49, sd: 22.29 },
  walkDistanceMiles: { min: 0, max: 0.5, mean: 0.18, sd: 0.21 },
  /** 正文印刷：每多走一英里，需补偿 32.78 美元。用来把绕路距离换算成 Cost 属性的单位。 */
  walkingCompensationUSDPerMile: 32.78,
  /** 同伴比例不是空间统计，是问卷里「自我中心社会网络」中最多 5 人的选择比例。 */
  egocentricNetworkMaxSize: 5,
  threatLevelsNeverMappedToDepth: true,
});

/**
 * 年龄别舒适步速。Bohannon & Andrews 2011, Table 2；单位 m/s。
 * 【引文更正】第四轮回件确认正确引文是 Bohannon & Andrews, Physiotherapy
 * 97:182–189 (2011)，不是之前清单里写的 Bohannon & Williams / JGPT。
 * 每格样本量在原文 Table 2，范围 83–8,591，本轮回件未逐格取到，故不写死 n。
 * 20 岁以下没有实测值，仍用自设倍率，见 kernel/walk-speed.js。
 */
export const BOHANNON_GAIT = Object.freeze({
  source: {
    title: 'Normal walking speed: a descriptive meta-analysis',
    authors: 'Bohannon, R. W. & Andrews, A. W.',
    journal: 'Physiotherapy 97:182–189', year: 2011,
    table: 'Table 2（年龄 × 性别舒适步速均值）',
    sample: '41 篇研究、23,111 名受试者；每格 n 83–8,591',
    url: 'https://www.academia.edu/22434329/Normal_walking_speed_a_descriptive_meta_analysis',
    local: 'from muse/文献二/Normal_walking_speed_a_descriptive_meta.pdf',
    checked: '2026-11-17 已核原件：9 页，Table 2 在 p.3；分层均值 94.3 cm/s（80–99 岁女性）至 143.4 cm/s（40–49 岁男性），与 cells 表一致',
  },
  /** 年龄段下界 → { male, female }，cm/s。 */
  cells: [
    { from: 20, male: 135.8, female: 134.1, ciMale: [127.0, 144.7], ciFemale: [123.9, 144.3] },
    { from: 30, male: 143.3, female: 134.0 },
    { from: 40, male: 143.4, female: 139.0 },
    { from: 50, male: 143.3, female: 131.0 },
    { from: 60, male: 133.9, female: 124.1, ciFemale: [118.3, 130.0] },
    { from: 70, male: 126.0, female: 113.0 },
    { from: 80, male: 96.8, female: 94.0, ciMale: [83.4, 110.1] },
  ],
});

/** Weidmann 1993 的无阻自由步速，供没有拥挤时的绝对基准核对。 */
export const WEIDMANN = Object.freeze({
  source: {
    title: 'Transporttechnik der Fussgänger', authors: 'Weidmann, U.',
    publisher: 'IVT Schriftenreihe Nr. 90, ETH Zürich', year: 1993,
    local: 'from muse/文献二/sr90_2auflage.pdf',
    checked: '2026-11-17 已核原件：德文第 2 版 115 页，ETH Library 存档；1.34 m/s 见 p.44–54，与 freeSpeedMs 一致',
  },
  freeSpeedMs: 1.34, gammaPerM2: 1.913, jamDensityPerM2: 5.4,
  maxSpecificFlow: 1.22, note: '原文未发表自由速度的标准差，不要自己编一个',
});

/**
 * FHWA 2022 NHTS Summary of Travel Trends 官方每人每天出行次数。
 * 之前 social-circles.js 把 4.058% 的接送出行占比乘以一个自设的 12 来折算
 * 「今天有没有这趟」，day-baseline.js 则是每个时段固定排一个节点。
 * 现在两个都改用这个官方次数。
 * 【限制】官方没有「按户内有无未成年子女」分组的汇总表（第四轮 QD3 复核确认），
 * 该切分只能从原始微观数据算；本表只用于总体与年龄别、目的别。
 */
export const NHTS_TRIPS_PER_DAY = Object.freeze({
  source: {
    title: '2022 NextGen NHTS Summary of Travel Trends',
    publisher: 'U.S. Federal Highway Administration (FHWA)', year: 2022,
    table: '官方汇总表：daily person trips per person；2017 对照值 3.37',
    url: 'https://nhts.ornl.gov/',
  },
  overall: 2.28,
  byAge: { '<16': 2.0, '16-20': 2.0, '21-35': 2.4, '36-65': 2.5, '>65': 2.0 },
  byPurpose: { shoppingErrands: 0.80, socialRecreational: 0.67, work: 0.42, schoolChurch: 0.26 },
  men: 2.3, women: 2.3,
  officialTimeOfDayBins: null,
  note: 'NHTS 没有官方时段分档变量（第四轮 QD1）；项目里的 7 档是实算交叉表口径，属目前自己定的',
});

/**
 * Ahsanuzzaman & Messer 2021, Table 3 —— 「是否继续驶过积水路段」的原始比例。
 * 这是「水深/危险提示 → 继续 vs 绕行」目前唯一带明确分母的实测比例表，
 * 但对象是**驾驶人**不是行人，只能用于驾驶层或作为外部对照，不能冒充行人决策。
 * ⚠ 该文 Table 4 混合 logit 的符号在 PDF 抽取里与正文叙述矛盾，用 Table 3 原始比例。
 */
export const AHSANUZZAMAN_CONTINUE = Object.freeze({
  source: {
    title: "Motorists' willingness to drive through flooded roads: Evidence from a stated preference experiment",
    authors: 'Ahsanuzzaman, Md & Messer, K. D.',
    journal: 'Journal of Flood Risk Management 14(4):e12753', year: 2021,
    doi: '10.1111/jfr3.12753', table: 'Table 3（各处理组选择继续的原始比例）',
    sample: 'n=714 名成人，1,782 个选择观测；美国中大西洋沿岸',
    url: 'https://par.nsf.gov/servlets/purl/10333417',
  },
  control: 0.28, roadFloodedSignOnly: 0.20,
  depthUnder4in: 0.29, depth4to8in: 0.29, depth9to12in: 0.30, depthOver12in: 0.33,
  carSymbolOnly: 0.15, oneWave: 0.25, twoWaves: 0.29, overTwoWaves: 0.23,
  meanAcrossScenarios: 0.25,
  signWarning: 'Table 4 符号与正文叙述矛盾，本表只用 Table 3 原始比例',
});

/**
 * Arshaghi et al. 2026, Table 2 (VR4) —— 同伴行为与水位对安全路线选择的影响。
 * 这是「从众随危险衰减」唯一带实测比例的 VR 实验，用来给同伴效应做定性对照。
 * ⚠ 水位只有身体部位定义（踝 / 髋至腰 / 胸至肩），原文没有厘米换算，
 * 不能把这里的 Low/High 当成我们仿真里的具体水深。
 */
export const ARSHAGHI_VR4 = Object.freeze({
  source: {
    title: 'Human decision-making in crowds in a virtual flood scenario',
    authors: 'Arshaghi, B., Lawson, G., Briganti, R. & Siebers, P.-O.',
    journal: 'Natural Hazards and Earth System Sciences 26:981–1000', year: 2026,
    doi: '10.5194/nhess-26-981-2026', table: 'Table 2（VR4）',
    sample: '84 名参与者；VR4 组 24 人；人群规模 5 / 15 / 20 名 NPC',
    url: 'https://nhess.copernicus.org/articles/26/981/2026/nhess-26-981-2026.xml',
  },
  conditions: [
    { crowd: 'safe', water: 'high', safeRoutePct: 100.0, riskyRoutePct: 0, preMoveSec: 8.3, sd: 4.5 },
    { crowd: 'risky', water: 'high', safeRoutePct: 79.1, riskyRoutePct: 20.8, preMoveSec: 9.4, sd: 4.6 },
    { crowd: 'safe', water: 'low', safeRoutePct: 83.3, riskyRoutePct: 16.6, preMoveSec: 7.9, sd: 3.9 },
    { crowd: 'risky', water: 'low', safeRoutePct: 33.3, riskyRoutePct: 66.6, preMoveSec: 9.5, sd: 4.8 },
  ],
  cmConversionExists: false,
});

/**
 * Ha, Dinh & Mizunoya 2025, Table 5 —— 二元 logit 的完整实测系数。
 * 因变量是「是否撤离」，与 Borowski 的「搭车疏散 / 留下」不是同一个量表，
 * 所以**不并入主效用**（上一轮把不同因变量的系数加进同一效用曾导致方向反转）。
 * 这里只作为外部对照数据保存：例如 X4 户内有脆弱成员 +0.39、
 * X9 洪水不可预测 +1.14、X11 信任自身准备 −0.80、X12 信任政府 −0.84、
 * X13 信任邻居 −0.51。方向只做定性比较，不做数值对齐。
 */
export const HA_EVACUATION_LOGIT = Object.freeze({
  source: {
    title: 'Staying or leaving: Unraveling the dynamics of evacuation decisions among floodplain residents in central Vietnam',
    authors: 'Ha, V. H., Dinh, N. C. & Mizunoya, T.',
    journal: 'International Journal of Disaster Risk Reduction 119:105315', year: 2025,
    doi: '10.1016/j.ijdrr.2025.105315', table: 'Table 5（B / Exp(B)）',
    sample: 'N=407 户，越南承天顺化省 2020 年洪水，入户访谈；171 户（42.01%）撤离',
    url: 'https://tsukuba.repo.nii.ac.jp/record/2014735/files/IJDRR_119-105315.pdf',
  },
  coefficients: {
    genderMale: 0.58, ageOrdinal: 0.12, education: -0.33,
    vulnerableMembers: 0.39, highRiskHousing: 0.64,
    ownPastEmergency: 0.19, othersPastEmergency: 0.27,
    floodIntensityIncreasing: 0.18, floodUnpredictable: 1.14,
    trustHousingSolidity: -0.36, trustOwnPreparedness: -0.80,
    trustLocalGovernment: -0.84, trustNeighbours: -0.51,
    concernShelterArrangements: -0.19, concernPropertyLoss: -0.38,
    constant: 4.56,
  },
  fit: { minus2LogLikelihood: 312.96, nagelkerkeR2: 0.60, hosmerLemeshowP: 0.182, classificationPct: 82.1 },
  note: '显著项以原文星号为准；本表只作方向对照，不进运行时效用',
});

/** Xu et al. 2026 通惠河 SP 条件 logit：研究「怎么撤」，没有水深属性。 */
export const XU_CONDITIONAL_LOGIT = Object.freeze({
  source: {
    title: 'Micro-Behavioral Responses for Enhancing Urban Flood Resilience: Stated Preference Analysis of Residents\' Evacuation Choices in High-Density Urban Areas',
    authors: 'Xu et al.', journal: 'Journal of Flood Risk Management', year: 2026,
    doi: '10.1111/jfr3.70272', table: 'Table 3',
    sample: '335 份问卷、307 份有效、2,456 个选择任务、4,912 个选择观测；北京朝阳区通惠河',
    url: 'https://onlinelibrary.wiley.com/doi/10.1111/jfr3.70272',
  },
  coefficients: {
    undergroundPassage: -1.482, riverCrossingBridge: -0.762,
    evacuationDistance: 0.055, noSignalControlSelfNavigation: -0.471,
    intelligentSignalsPlannedRoutes: 0.632,
  },
  nonSignificant: { privateCarEvacuation: -0.1468, communityOrganisedEvacuation: 0.168 },
  fit: { observations: 4912, logLikelihood: -1693.5151, pseudoR2: 0.0052 },
  noWaterDepthAttribute: true,
});

/**
 * DEFRA / Environment Agency (2008) 补充说明，FD2321/TR1 Table 3.1 的碎屑因子 DF。
 * 之前 hazard-input.js 把 DF 一律取 0（自设），现在按城市地表这一列的实测工程表取。
 * 注意 FD2320/TR2 的取法不同（≤0.25 m 取 0.5，>0.25 m 取 1.0），两套别混。
 */
export const FD2321_DEBRIS_FACTOR = Object.freeze({
  source: {
    title: 'Supplementary Note on Flood Hazard Ratings and Thresholds for Development Planning and Control Purpose',
    publisher: 'Environment Agency / HR Wallingford', year: 2008,
    table: 'FD2321/TR1 Table 3.1（澄清 FD2321/TR1 p.10 §3.5 与 FD2320/TR2 Table 13.1）',
    url: 'https://docs.planning.org.uk/20210521/28/QTGCTMTY0PT00/ze3hnpzxd6iubjvc.pdf',
  },
  urban: [
    { maxDepthM: 0.25, df: 0 },
    { maxDepthM: 0.75, df: 1 },
    { maxDepthM: Infinity, df: 1 },
  ],
  fd2320Alternative: 'DF = 0.5（水深 ≤0.25 m）、1.0（水深 >0.25 m）',
  hazardRatingBands: {
    fd2321: { low: 0.75, moderate: 1.25, significant: 2.5 },
    fd2320Planning: { low: 0.75, moderate: 1.25, extreme: 2.0 },
  },
});

/**
 * ARR Project 10 的 H1–H6 危险分级（Smith et al. 2014, WRL TR 2014/07）。
 * 第四轮 QB1 明确：项目里用的成人 1.2 m 是 H3 限值静水深、儿童 0.5 m 是 H2 限值，
 * 属**危险分级限值**，不是实验测得的个体失稳深度。
 */
export const ARR_HAZARD_CLASSES = Object.freeze({
  source: {
    title: 'Flood Hazard', authors: 'Smith, G. P., Davey, E. K. & Cox, R. J.',
    publisher: 'WRL Technical Report 2014/07, UNSW', year: 2014,
    table: 'H1–H6 分级表（ARR 2019 Book 6 采用）',
    url: 'http://www.arr-software.org/pdfs/ARR_Project10_Stage2_Vehicle_Stability_Final.pdf',
  },
  classes: [
    { id: 'H1', dvMax: 0.3, depthMaxM: 0.3, velocityMaxMs: 2.0, label: 'Generally safe for vehicles, people and buildings' },
    { id: 'H2', dvMax: 0.6, depthMaxM: 0.5, velocityMaxMs: 2.0, label: 'Unsafe for small vehicles' },
    { id: 'H3', dvMax: 0.6, depthMaxM: 1.2, velocityMaxMs: 2.0, label: 'Unsafe for vehicles, children and the elderly' },
    { id: 'H4', dvMax: 1.0, depthMaxM: 2.0, velocityMaxMs: 2.0, label: 'Unsafe for vehicles and people' },
    { id: 'H5', dvMax: 4.0, depthMaxM: 4.0, velocityMaxMs: 4.0, label: 'All buildings subject to structural damage' },
    { id: 'H6', dvMax: Infinity, depthMaxM: null, velocityMaxMs: null, label: 'All building types vulnerable to failure' },
  ],
  criterion: 'D·V ≤ 0.4 儿童低危险；0.8 受训成人可作业；>1.2 所有人极端危险',
});

/**
 * 导师举例的「状态之间按条件概率转移」，第四轮仍确认没有可引用的完整数值矩阵。
 * Roy & Hasan 2021 是 IO-HMM 不是贝叶斯网络，80 个系数是飓风 Twitter 数据、
 * 时间尺度小时级、状态是活动类型（Home/Office/Other/Evacuation），
 * 与本项目 0.5–1 仿真秒的动作判断不是一回事，不套用。此表只存书目供台账说明。
 */
export const TRANSITION_MATRIX_STATUS = Object.freeze({
  source: {
    title: 'Modeling the dynamics of hurricane evacuation decisions from twitter data: An input output hidden markov modeling approach',
    authors: 'Roy, K. C. & Hasan, S.',
    journal: 'Transportation Research Part C 123:102976', year: 2021,
    doi: '10.1016/j.trc.2021.102976', table: 'Table 3（转移模型系数）',
    sample: '>1 亿条推文训练词向量；38,256 条标注推文、2,571 名用户、飓风 Irma',
    url: 'https://par.nsf.gov/servlets/purl/10291203',
  },
  modelType: 'IO-HMM（输入输出隐马尔可夫），不是贝叶斯网络',
  coefficientsPublished: 80,
  completeNumericMatrixPublished: false,
  whyNotUsed: '输入依赖导致不存在单一固定转移矩阵；只有 Figure 5 四个情景热图与个别文本值；时间尺度与状态定义都不匹配本项目逐秒决策',
});

/**
 * FHWA 官方「每人每天出行次数」按年龄档取值。
 * 原表没有按户内有无未成年子女分组（第四轮 QD3 复核确认），
 * 所以这是全样本年龄档，用到有子女家庭时口径限制要写清楚。
 */
export function tripsPerDayFor(age) {
  const a = Number(age);
  if (!Number.isFinite(a)) return NHTS_TRIPS_PER_DAY.overall;
  if (a < 16) return NHTS_TRIPS_PER_DAY.byAge['<16'];
  if (a <= 20) return NHTS_TRIPS_PER_DAY.byAge['16-20'];
  if (a <= 35) return NHTS_TRIPS_PER_DAY.byAge['21-35'];
  if (a <= 65) return NHTS_TRIPS_PER_DAY.byAge['36-65'];
  return NHTS_TRIPS_PER_DAY.byAge['>65'];
}

/** 供文末附录与自检脚本枚举。 */
export const EVIDENCE_META = Object.freeze({
  tables: [
    'BOROWSKI_DESIGN', 'BOHANNON_GAIT', 'WEIDMANN', 'NHTS_TRIPS_PER_DAY',
    'AHSANUZZAMAN_CONTINUE', 'ARSHAGHI_VR4', 'HA_EVACUATION_LOGIT',
    'XU_CONDITIONAL_LOGIT', 'FD2321_DEBRIS_FACTOR', 'ARR_HAZARD_CLASSES',
    'SILVA_SCENARIOS', 'MOBILISATION_OBSERVED', 'TRANSITION_MATRIX_STATUS',
  ],
  reexported: { SILVA_SCENARIOS, MOBILISATION_OBSERVED },
  round: 'Muse 第四轮回件，2026-11-15；逐项报告 from muse/round4-report.md，索引 from muse/INDEX.md',
  classification: '本文件全部条目属于「真实数据集」或「文献里的实测值」，不含模型输出，也不含「目前自己定的」',
});
