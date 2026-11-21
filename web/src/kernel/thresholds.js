/**
 * thresholds.js — 水 / 伤亡 / 车辆阈值的唯一真值表。
 *
 * 【2026-11-15 已换掉拍脑袋的阈值】
 * 旧版散在 motion-units.js 的 RISK、incidents.js 的 VULNERABILITY 里：
 *   幼儿 62 cm / 高龄 66 cm / 青壮 115 cm 致死水深、70~165 秒耐受时间、
 *   滑倒概率 0.14~0.60、熄火 0.35 m、车门淹没 0.95 m …
 * 三轮检索（Muse 第 1/2/3 轮回件）都明确答复没有一手依据。
 * 导师在录音 5:21–6:11 问「困死溺亡你是怎么判断出来的」，问的就是这里。
 *
 * 现在分两类，不混：
 *   ① 有实测出处的：涉水步速与通行能力、行人失稳 D·V 分级、
 *      HR 危险分级、车辆失稳／漂浮深度、行人让行率。
 *   ② 仍没有依据的：失稳 → 伤亡的定量函数、按年龄的致死静水深、
 *      浸泡时长 / 水温 / 体力 → 死亡。这些**不能删**，仿真需要一个
 *      判定才能往下走，但必须显式标「目前自己定的」、集中放在 SELF_SET、
 *      做敏感性分析，且不许把伤亡数当实测结论报出去。
 *
 * 本文件不 import real-data.js，避免把 5 MB 数据拖进底层速度模块。
 * 完整出处（机构、全名、年份、表号、DOI、本地路径）见
 * from muse/数据来源.md 与 docs/依据台账.md 文末附录。
 */

/** ① 实测值 —— 每一项都能指到具体论文或工程报告的表号。 */
export const MEASURED = Object.freeze({
  /** 涉水自由流步速，m/s。Li et al. 2026, Journal of Hydrology 672:135395，静水受控实验，188 名本科生。 */
  wadingFreeSpeed: { '0': 1.67, '0.35': 0.86, '0.60': 0.84, '0.90': 0.81 },
  /** 单向行人流最大通行能力，人/(米·秒)；相对无水下降 9.3% / 14.6% / 26.8%。同上。 */
  wadingFlowCapacity: { '0': 2.05, '0.35': 1.86, '0.60': 1.75, '0.90': 1.50 },
  /**
   * 行人危险的 D·V 分级，单位 m²/s。
   * Cox, Shand & Blacka (2010), ARR Project 10 Stage 1 Report P10/S1/006,
   * UNSW WRL；H1–H6 完整分级见 Smith, Davey & Cox (2014),
   * WRL Technical Report 2014/07（第四轮 QB1 核实）。
   *
   * ⚠ 第四轮 QB1 更正性质：这里用的「成人 1.2 m / 儿童 0.5 m」是
   * **H3 / H2 危险分级系统里的限值静水深**，不是实验测得的个体失稳深度。
   * D·V 判据的参考值：0.4 儿童低危险、0.8 受训成人可作业、>1.2 所有人极端危险。
   * 这些是「失稳／危险分级」，不是死亡判定。
   */
  instabilityDV: {
    adultLow: 0.6, trainedLimit: 0.8, extreme: 1.2,
    childLow: 0.4, childMaxDepthM: 0.5, adultMaxDepthM: 1.2,
  },
  /**
   * HR 危险等级，HR = d × (v + 0.5) + DF（原式中的 n 就是 0.5，第四轮 QB2 确认）。
   * 界值 0.75 / 1.25 / **2.0** 属于 FD2320 规划口径；
   * FD2321 Table 3.2 的 danger-for-some / significant 上界是 **2.5**，
   * 两套不能混着引用。碎屑因子 DF 按 FD2321/TR1 Table 3.1 城市列取，
   * 见 kernel/evidence-tables.js 与 hazard-input.js。
   */
  hazardRating: { moderate: 0.75, significant: 1.25, extreme: 2.0, fd2321Extreme: 2.5 },
  /**
   * 车辆涉水失稳／漂浮深度，米；
   * Smith, Modra, Tucker, Cox & Felder (2017), Vehicle Stability Testing
   * for Flood Flows, WRL Technical Report 2017/07, UNSW，全尺寸拖曳水池实验。
   * NOAA「Turn Around Don't Drown」的 15 / 30 / 46–61 cm 是公众宣传口径，不是实测报告。
   */
  vehicle: {
    smallCarPushM: 0.15, smallCarFloatM: 0.60,
    largeCarInstabilityM: 0.45, largeCarFloatM: 0.95,
  },
  /**
   * 无信号交叉口机动车让行率；
   * Fitzpatrick et al. (2006), NCHRP Report 562 / TCRP Report 112, TRB。
   * 分母是过街事件数，不是每人每天过街机会数。
   */
  pedestrianYield: { rangeLow: 0.07, rangeHigh: 0.75, mean: 0.34 },
});

/** 每类实测值的出处，供文档附录与自检脚本取用。 */
export const MEASURED_SOURCES = Object.freeze({
  wading: 'Li, X. et al. (2026), Journal of Hydrology 672:135395, DOI 10.1016/j.jhydrol.2026.135395, 正文 §3.2 基本图；作者接受稿 from muse/Li_2026_JHydrol_672_135395_accepted_manuscript.pdf',
  instabilityDV: 'Cox, Shand & Blacka (2010), ARR Project 10 Stage 1 Report P10/S1/006, UNSW WRL, http://www.arr-software.org/pdfs/ARR_Project10_Stage1_report_Final.pdf；H1–H6 分级见 Smith, Davey & Cox (2014), WRL Technical Report 2014/07（第四轮 QB1 核实 1.2 m / 0.5 m 是分级限值）',
  hazardRating: 'DEFRA / Environment Agency (2006), Flood Risks to People Phase 2, FD2321/TR2；界值 2.0 属 FD2320 规划口径，FD2321 为 2.5（第四轮 QB2）；DF 见 2008-05 补充说明 FD2321/TR1 Table 3.1',
  vehicle: 'Smith et al. (2017), WRL Technical Report 2017/07, UNSW, DOI 10.26190/unsworks/27416',
  pedestrianYield: 'Fitzpatrick et al. (2006), NCHRP Report 562, Transportation Research Board',
});

/**
 * ② 目前自己定的 —— 三轮检索明确「没有」一手依据。
 * 保留是因为仿真需要一个判定才能往下走，但：
 *   · 不许把由这些数算出的伤亡数当实测结论报出去；
 *   · 必须做敏感性分析（把整组乘 0.5 / 2 各跑一次，看结论是否翻转）；
 *   · docs/依据台账.md 逐条登记「待补依据」。
 */
export const SELF_SET = Object.freeze({
  /**
   * 「失稳 → 伤亡」的判定门槛。
   * 有出处的是 ARR 的 H3 / H2 **危险分级限值静水深**（成人 1.2 m / 儿童 0.5 m），
   * 不是实测个体失稳深度；文献止于危险等级的定性描述，
   * 没有「失稳多久会死亡」的函数。第四轮 QB3 还确认 Jonkman 的
   * 水深→死亡率函数与失稳判据是两条不同的链，不能拿来当这个函数用
   * （其对数正态参数 μN/σN 系二手转引且未核原稿，故不接入）。
   * 这里用分级限值当暴露起点，再乘一个自设的暴露时长。
   */
  casualty: {
    depthAdultM: MEASURED.instabilityDV.adultMaxDepthM,   // 1.2，来自 ARR，不是自设
    depthChildM: MEASURED.instabilityDV.childMaxDepthM,   // 0.5，来自 ARR
    exposureSecAdult: 150,
    exposureSecChild: 80,
    note: '暴露时长没有一手依据；水温、体力、浸泡时长到死亡的定量函数三轮检索均未找到',
  },
  /** 涉水滑倒概率：没有实测研究，旧版 0.14~0.60 全为自设。 */
  slipProbability: 0.30,
  /** 旧「动多久算被困」的 90 s。2026-11-21 起判定改用 endurance×0.5，此值仅留作对照。 */
  strandedSec: 90,
  /** 车内彻底开不动的深度：用实测的小型车漂浮深度，不是自设。 */
  carFloatM: MEASURED.vehicle.smallCarFloatM,
  /**
   * 状态标签的两个水深分界，2026-11-21 由「拍的数」改成实测折点：
   * · 0.35 m = Li et al. 2026（188 人静水实验）步速第一次折半的深度
   *   （0.86/1.67 ≈ 0.52，即走路上限掉了一半），所以从这儿起算「在涉水」。
   * · 0.90 m = 同一实验的最深一档（0.81 m/s）。超过 0.90 m 没有任何步速实测，
   *   模型进入外推，因此标签改成「深水」，不代表另一条死亡判据。
   */
  wadingDepthM: 0.35,
  deepWaterM: 0.90,
});

/**
 * 按真实年龄给失稳深度。
 * 儿童／成人两档来自 ARR；其余年龄带的细分没有依据，
 * 所以不再像旧版那样写 9 档各一个「致死水深」。
 */
export const BODY = Object.freeze({
  // 【2026-11-21 补出处】身高不再用「常被引用但没核原表」的数，改为 NHANES 实测均值：
  //   NCHS, Vital and Health Statistics Series 3 No.39（2016-08），
  //   《Anthropometric Reference Data for Children and Adults: United States, 2011–2014》
  //   表 7（2–19 岁，分性别年龄的身高均值，cm）
  //   表 11（男性 20+ 均值 175.7 cm）／表 9（女性 20+ 均值 161.8 cm）
  //   PDF: https://www.cdc.gov/nchs/data/series/sr_03/sr03_039.pdf
  // 旧值 175.3/161.3 差异 <0.5 cm 但确实不是这张表；旧值「儿童 140 cm」更离谱——
  // 4 岁均值 106.7 cm、8 岁 131.7 cm、12 岁 155.8 cm，一个数盖不住 2–12 岁。
  heightCmByAge: {
    // 键是周岁，2–19 岁；<2 岁按 2 岁档，≥20 岁走成人档
    male: {
      2: 92.2, 3: 99.0, 4: 106.7, 5: 113.8, 6: 120.0, 7: 126.4, 8: 131.7,
      9: 136.5, 10: 143.0, 11: 150.3, 12: 155.8, 13: 163.4, 14: 169.4,
      15: 173.4, 16: 173.9, 17: 174.9, 18: 175.6, 19: 176.3,
    },
    female: {
      2: 90.0, 3: 98.1, 4: 105.8, 5: 112.3, 6: 118.7, 7: 124.5, 8: 131.7,
      9: 137.7, 10: 144.3, 11: 150.7, 12: 156.2, 13: 158.5, 14: 160.3,
      15: 161.1, 16: 162.3, 17: 162.5, 18: 161.7, 19: 163.0,
    },
  },
  heightCm: { adultMale: 175.7, adultFemale: 161.8, adultMean: 168.75, childAt2: 91.1 },
  // 气道（口鼻）高度占站高的比例。**这是本文件里唯一还没有一手数据支撑的比例**：
  // 物理上溺亡＝水面高过口鼻，但口鼻高度是人体测量里很少单独公布的量，
  // 检索到的分段比例表（Drillis & Contini 1966 经 Winter 转引）只给「头高 ≈ 0.130 H」，
  // 据此推算口鼻约在 0.87–0.90 H。取 0.85 是偏保守（更早判溺亡），
  // 敏感性 0.85 / 0.90 必须随结果一起报。不把它写成「文献值」。
  airwayOfHeight: 0.85,
  airwayOfHeightRange: [0.85, 0.90],
  source: 'NHANES 2011–2014（NCHS Series 3 No.39，表 7/9/11）',
  note: '身高已核原表；0.85 的口鼻/身高比仍是半自设，见 airwayOfHeightRange',
});

/** 按 NHANES 分性别年龄均值取站高（cm）。年龄缺失时走成人均值。 */
export function statureCmFor(age, sex) {
  const a = Number(age);
  const known = age !== null && age !== undefined && Number.isFinite(a);
  const s = String(sex);
  const bySex = s === '2' ? BODY.heightCmByAge.female
    : (s === '1' ? BODY.heightCmByAge.male : null);
  if (known && a < 20) {
    const key = Math.max(2, Math.round(a));       // <2 岁按 2 岁档
    if (bySex) return bySex[key];
    // 性别缺失：两性同年龄均值
    return +(((BODY.heightCmByAge.male[key] + BODY.heightCmByAge.female[key]) / 2).toFixed(1));
  }
  if (s === '2') return BODY.heightCm.adultFemale;
  if (s === '1') return BODY.heightCm.adultMale;
  return BODY.heightCm.adultMean;
}

export function airwayDepthFor(age, sex) {
  const h = statureCmFor(age, sex);
  return +(h / 100 * BODY.airwayOfHeight).toFixed(3);
}

export function instabilityDepthFor(age) {
  // 【修 2026-11-17】NaN 与 null 原先会落到错误档：NaN 走成人、null 走儿童
  // （null < 13 为真）。取不到真实年龄时应走保守的成人档，与 incidents.js
  // 的 vulnerabilityOf 口径一致。
  const a = Number(age);
  if (age === null || age === undefined || !Number.isFinite(a)) {
    return MEASURED.instabilityDV.adultMaxDepthM;
  }
  return a < 13 ? MEASURED.instabilityDV.childMaxDepthM
    : MEASURED.instabilityDV.adultMaxDepthM;
}

/** 暴露耐受时长，只有儿童／成人两档，来自上面的自设表。 */
/**
 * 【2026-11-21 敏感性旋钮】暴露时长的整体倍数。默认 1.0，逐位等于上表。
 *
 * 为什么必须有这个旋钮：暴露时长（成人 150 s / 儿童 80 s）是本项目**最没依据**
 * 的两个数（三轮检索没有「失稳后多久死亡」的定量函数）。没有旋钮，「整组 ×0.5 / ×2
 * 各跑一次看结论是否翻转」就只能改源码，改源码等于没有可复现的敏感性。
 * 用法：?casscale=0.5|2（页面）/ SIM_CAS_SCALE=0.5|2（跑批）。
 */
let _casScale = 1.0;
export function setCasualtyScale(x) {
  const v = Number(x);
  if (Number.isFinite(v) && v > 0) _casScale = Math.min(10, Math.max(0.05, v));
}
export function casualtyScale() { return _casScale; }

export function exposureSecFor(age) {
  const a = Number(age);
  const base = (age === null || age === undefined || !Number.isFinite(a))
    ? SELF_SET.casualty.exposureSecAdult
    : (a < 13 ? SELF_SET.casualty.exposureSecChild : SELF_SET.casualty.exposureSecAdult);
  return base * _casScale;
}

export const THRESHOLD_META = Object.freeze({
  measured: Object.keys(MEASURED),
  selfSet: Object.keys(SELF_SET),
  warning: '由 SELF_SET 算出的伤亡／被困／滑倒是模型输出，不是实测，不能当研究结论报出去；必须附敏感性分析。',
  missing: [
    '失稳到伤亡的定量函数',
    '按年龄分组的致死静水深',
    '浸泡时长 / 水温 / 体力到死亡的定量函数',
    '水深到涉水／绕行／等待的三分选择实测比例',
    '可引用的马尔可夫／HMM 状态转移矩阵、贝叶斯网络条件概率表',
    '公开的真实疏散逐人轨迹基准',
    '特区按红灯到达次数为分母的合规率',
  ],
});
