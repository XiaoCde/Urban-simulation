/**
 * params.js — 内核参数的唯一入口。
 *
 * 这个文件只放数值和出处，不放行为规则，不碰 window / document / three。
 * 浏览器和纯 Node 命令行都能直接 import。
 *
 * 每个参数项都带三样东西：
 *   value   数值或分布
 *   source  真实出处（数据集全名、机构、年份、官方地址；或文章全名、DOI、表号）
 *   kind    中文写明的性质：真实数据集 / 文献里的实测值 / 目前自己定的
 *
 * 运行时当前仍读旧的硬编码参数，切换读取由分块清单第 3 步完成。
 * 这份文件里不保留旧值，旧值只在 docs/依据台账.md 里登记，避免两套参数并存。
 */
import { ACS_DC, NHTS_DAY, KERNEL_DATA_META } from './real-data.js';

const ACS_SOURCE = {
  dataset: 'American Community Survey 2020–2024 5-Year Public Use Microdata Sample, District of Columbia',
  publisher: 'U.S. Census Bureau',
  release: '2026-03-05',
  official: 'https://www2.census.gov/programs-surveys/acs/data/pums/2024/5-Year/',
  local: 'data/real/acs_dc.json；逐文件来源见 from muse/数据来源.md 第 1、2 条',
};

const NHTS_SOURCE = {
  dataset: '2022 National Household Travel Survey (NextGen NHTS), Survey Data V2.1',
  publisher: 'Federal Highway Administration, U.S. Department of Transportation / Oak Ridge National Laboratory',
  release: 'Codebook V2.1, April 2025；调查期 2022-01 至 2023-01',
  official: 'https://nhts.ornl.gov/downloads',
  local: 'data/real/nhts_day.json；逐文件来源见 from muse/数据来源.md 第 5、7 条',
};

function real(value, source, note) {
  return { value, source, kind: '真实数据集', note: note || '' };
}

function measured(value, source, note) {
  return { value, source, kind: '文献里的实测值', note: note || '' };
}

function selfSet(note) {
  return { value: null, source: null, kind: '目前自己定的', note };
}

/** 人群画像：全部来自特区 ACS 微观样本的加权分布。 */
export const POPULATION = {
  ageBand5y: real(
    ACS_DC.distributions.age_band_5y.values,
    ACS_SOURCE,
    '标准 5 岁带，单位是加权人数；替代旧代码自设的 9 档年龄带',
  ),
  sex: real(ACS_DC.distributions.sex.values, ACS_SOURCE, '加权人数，码值见 PUMS 字典 SEX'),
  occupationSocMajor: real(
    ACS_DC.distributions.occupation_soc_major.values,
    ACS_SOURCE,
    '按 2018 SOC 两位数大类归并；NA 表示不适用或未细分，不是删掉的缺失值',
  ),
  commuteJwtrns: real(
    ACS_DC.distributions.commute_jwtrns.values,
    ACS_SOURCE,
    '特区就业者的通勤方式加权分布；bb 是不适用／未工作',
  ),
  householdHasMinor: real(
    ACS_DC.distributions.household_has_minor.values,
    ACS_SOURCE,
    '按户内任一成员年龄小于 18 岁判定，用 PWGTP 加权到人数',
  ),
  householdVehicles: real(
    ACS_DC.distributions.household_vehicles_veh.values,
    ACS_SOURCE,
    'VEH 是户级变量，按 WGTP 加权到户数；运行时按 SERIALNO 关联到人，不能按人重复抽车',
  ),
  householdSize: real(ACS_DC.distributions.household_size_np.values, ACS_SOURCE, '按 WGTP 加权到户数'),
  relationship: real(ACS_DC.distributions.relationship_relshipp.values, ACS_SOURCE, '加权人数'),
  ownChildren: real(ACS_DC.distributions.presence_of_own_children_paoc.values, ACS_SOURCE, '加权人数；PAOC 只对特定人群有值'),
  joint: real(
    ACS_DC.joint.cells,
    ACS_SOURCE,
    '年龄带 × SOC 大类 × 户内有无未成年人 × 通勤方式，共 ' +
      ACS_DC.joint.cell_count + ' 个格子，权重合计 ' + ACS_DC.joint.total_weight +
      '。稀疏格子多，运行时要按边际抽样并设小格合并阈值，不能逐格当概率用',
  ),
};

/** 日常出行基线：只能定日程，不能证明灾害时的决策合理。 */
export const DAY_BASELINE = {
  purpose: real(
    NHTS_DAY.distributions.purpose_whyto.values,
    NHTS_SOURCE,
    '按 WHYTO 出行目的的加权出行量；这是美国全国调查口径，公开文件没有特区子样本',
  ),
  purposeByHouseholdMinor: real(
    NHTS_DAY.distributions.purpose_by_household_minor.values,
    NHTS_SOURCE,
    '出行目的 × 户内有无未成年人；其中 WHYTO=10 是私人接送、WHYTO=04 是工作性接送',
  ),
  purposeByAgeBand: real(NHTS_DAY.distributions.purpose_by_age_band.values, NHTS_SOURCE, '出行目的 × 年龄段'),
  purposeByStartTime: real(NHTS_DAY.distributions.purpose_by_start_time.values, NHTS_SOURCE, '出行目的 × 出发时段'),
  tripMode: real(
    NHTS_DAY.distributions.trip_mode.values,
    NHTS_SOURCE,
    'TRIPMODE 是公开 CSV 里没有的列；派生规则出自 V2.1 Release Notes 第 1 页与 Codebook V2.1（第四轮 QC4 更正：Derived Variables 第 17 页是 TRIPPURP）',
  ),
  meanTravelMinutes: real(
    NHTS_DAY.distributions.mean_travel_minutes.value,
    NHTS_SOURCE,
    '按 WTTRDFIN 加权的平均出行时长，单位分钟',
  ),
  joint: real(
    NHTS_DAY.joint.cells,
    NHTS_SOURCE,
    '与 Muse 实算的 946 行交叉表逐格一致；很多格子未加权样本只有 1 到 3 条，不能直接当比例用',
  ),
  usageLimit: '只能用来定日常日程基线。录音里导师 08:03–08:48 明确说过，用日常行为代理灾害反应需要很强的依据，否则应直接模拟灾害场景。',
};

/** 危险、失稳与运动：来自论文或工程报告的实测值。 */
export const HAZARD_THRESHOLDS = {
  wadingFlowCapacity: measured(
    { '0': 2.05, '0.35': 1.86, '0.60': 1.75, '0.90': 1.50 },
    {
      article: 'Li, X. et al. (2026), Pedestrian dynamics in flooding disasters, Journal of Hydrology 672: 135395',
      doi: '10.1016/j.jhydrol.2026.135395',
      table: '正文 §3.2 基本图印刷值',
      sample: '188 名本科生，静水游泳池，单向行人流',
    },
    '单位 人/(米·秒)；相对无水下降 9.3%／14.6%／26.8%。静水受控实验，不是真实街头内涝，外推要写明限制',
  ),
  wadingFreeSpeed: measured(
    { '0': 1.67, '0.35': 0.86, '0.60': 0.84, '0.90': 0.81 },
    {
      article: 'Li, X. et al. (2026), Journal of Hydrology 672: 135395',
      doi: '10.1016/j.jhydrol.2026.135395',
      table: '正文 §3.2 自由流速度',
    },
    '单位米/秒；有水时自由步长降约 37.7%，自由步频 1.09／0.99／0.91／0.88 Hz',
  ),
  humanInstabilityDV: measured(
    {
      adultLow: 0.6, trainedLimit: 0.8, extreme: 1.2,
      childLow: 0.4, childMaxDepthM: 0.5, adultMaxDepthM: 1.2,
    },
    {
      report: 'Cox, Shand & Blacka (2010), Appropriate Safety Criteria for People, Australian Rainfall and Runoff Project 10 Stage 1 Report P10/S1/006, UNSW Water Research Laboratory',
      url: 'http://www.arr-software.org/pdfs/ARR_Project10_Stage1_report_Final.pdf',
    },
    'D·V 单位 m²/s。第四轮 QB1 更正：成人 1.2 m 是 H3 分级限值静水深、儿童 0.5 m 是 H2 限值，不是实验测得的个体失稳深度；这是「危险／失稳分级」，不是死亡判定；失稳到伤亡的定量函数四轮检索均没有公开依据。'
      + '【2026-11-17 复核】adultLow=0.6／trainedLimit=0.8／childLow=0.4 三个 D·V 界值在本地没有原件（Cox 2010 与 Smith 2014 两份报告都不在 from muse/），按前轮转述沿用；其中 0.6 一般对应 H1「成人低危险」上界，0.8 对应「受训成人可作业」，来源文件待补，见《待补依据清单》',
  ),
  hazardRating: measured(
    { moderate: 0.75, significant: 1.25, extreme: 2.0, formula: 'HR = d * (v + 0.5) + DF' },
    {
      report: 'DEFRA / Environment Agency (2006), Flood Risks to People Phase 2, FD2321/TR2',
      url: 'https://assets.publishing.service.gov.uk/media/602bbc3de90e07055f646148/Flood_risks_to_people_-_Phase_2_Guidance_Document_Technical_report.pdf',
    },
    '第四轮 QB2 更正：0.75／1.25／2.0 属规划口径 FD2320；FD2321 Table 3.2 的 danger for all 界值是 2.5，两套别混用。原式的 n 即 0.5，碎屑因子 DF 见 FD2321/TR1 Table 3.1 城市列',
  ),
  vehicleInstability: measured(
    { yarisPushM: 0.15, yarisFloatM: 0.60, patrolInstabilityM: 0.45, patrolFloatM: 0.95 },
    {
      report: 'Smith, Modra, Tucker, Cox & Felder (2017), Vehicle Stability Testing for Flood Flows, WRL Technical Report 2017/07, UNSW',
      doi: '10.26190/unsworks/27416',
    },
    '全尺寸拖曳水池实验。NOAA「Turn Around Don’t Drown」的 15／30／46–61 cm 是公众宣传口径，不是实测报告',
  ),
  pedestrianYieldRate: measured(
    { rangeLow: 0.07, rangeHigh: 0.75, mean: 0.34, walkSpeed: 1.1, slowWalkSpeed: 0.9 },
    {
      report: 'Fitzpatrick et al. (2006), Improving Pedestrian Safety at Unsignalized Crossings, NCHRP Report 562 / TCRP Report 112, Transportation Research Board',
      url: 'https://nacto.org/wp-content/uploads/2010/08/NCHRP-562-Improving-Pedestrian-Safety-at-Unsignalized-Crossings.pdf',
    },
    '分母是过街事件数，不是每人每天过街机会数；不能直接搬成代码里的概率',
  ),
};

/**
 * 【2026-11-16 Muse 回件】DC 本地驾驶人合规 / 让行实测（登记，不直接替换运行时概率）。
 * 运行时让行由 traffic.js 的斑马线确定性规则处理（head>0.62 减速），
 * 这里保留 DC 本地实测供对照：分母口径与 NCHRP 562 的 0.34 不同，不能混用。
 * 来源见文末来源附录（FHWA-HRT-10-043/-046、DDOT 2009 PHB、DC 2012 电话调查）。
 */
export const DC_LOCAL_COMPLIANCE = Object.freeze({
  rrfbYieldBaselinePct: 26,      // Brentwood Rd & 13th St，基线
  rrfbYield180dPct: 80,          // 同站点 180 天；22 站点均值基线 4% → 730 天 84%
  rrfbAllSitesBaselinePct: 4,
  rrfbAllSites730dPct: 84,
  phbDriverRedCompliancePct: 97, // Georgia Ave & Hemlock St，分母=红灯相位应停车车辆数
  phbExample: { stop: 230, shouldStop: 247, pct: 93.1 },
  pedSelfReportedRedCrossingPct: 43, // 自报，分母=受访行人，不是红灯到达机会，不能当合规率
  denominatorNote: 'RRFB/让行率分母=过街机会时接近车辆；PHB 合规分母=红灯相位应停车车辆；三者与 NCHRP 0.34（过街事件）口径不同',
  noData: '以行人红灯到达次数为分母的 DC 实测行人红灯合规率：没有（二轮/四轮两度确认）',
});

/** 目前自己定的：两轮检索都找不到一手依据，逐条写待补依据。 */
export const SELF_SET = {
  legacyJudgementCoefficients: selfSet('旧线性加权打分的全部系数与阈值门控；整套实现弃用，不做双实现并存，见 docs/依据台账.md 第四节'),
  lethalWaterDepthByAge: selfSet('幼儿 62／高龄 66／青壮 115 cm 致死静水深；三路检索均无此表述，须做敏感性分析'),
  instabilityToCasualty: selfSet('失稳到伤亡的定量函数；文献止于危险等级的定性描述'),
  disasterHistoryPriors: selfSet('灾害履历的年龄先验、岗位暴露、受训率；可用 Thieken 2023 补充材料 Table S1/S2 校准既往洪水次数'),
  bodyAndTemperamentCoefficients: selfSet('体力、应激、耐心、涉水意愿、风险偏好等身体系数；无一手依据'),
  decisionFormCoefficients: selfSet('新决策形式的系数与状态转移数值；水深到涉水／绕行／等待的实测比例、马尔可夫转移矩阵、贝叶斯网络条件概率表都还没有'),
  drivingStyleMix: selfSet('4 种驾驶风格的占比与限速余量、跟车间距；无实测分布'),
  districtQuotaAndWarnings: selfSet('500 m 片区轮转配额、视距、预警采样距离；门牌坐标是真实的，配额和距离不是'),
};

export const KERNEL_META = {
  ...KERNEL_DATA_META,
  boundary: '本目录只放纯计算，不引用页面对象和 3D 对象；边界检查脚本 web/_check_kernel_boundary.mjs',
};

/** 给自检脚本用的摘要，不参与仿真。 */
export function paramsSummary() {
  const count = (o) => Object.keys(o).length;
  return {
    populationItems: count(POPULATION),
    dayBaselineItems: count(DAY_BASELINE) - 1,
    hazardThresholdItems: count(HAZARD_THRESHOLDS),
    selfSetItems: count(SELF_SET),
    acsJointCells: ACS_DC.joint.cell_count,
    nhtsJointCells: NHTS_DAY.joint.cell_count,
    acsWeightSum: ACS_DC.validation['人表加权合计'],
    nhtsWeightSum: NHTS_DAY.validation['全部出行加权合计'],
  };
}
