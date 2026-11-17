/**
 * population.js — 从真实 ACS 微观样本抽「一个人」。
 *
 * 旧做法（已弃用）：9 档自设年龄带按比例抽、32 个手写职业按自设权重抽、
 * 7 种家庭结构和 5 种通勤方式按自设权重各抽一次。这些比例全是项目自己定的，
 * 而且各维度独立抽，人与人之间的「年龄 × 职业 × 家庭 × 通勤」联合关系被抹掉。
 *
 * 现在：按 PWGTP 权重从 ACS 2020–2024 五年期 PUMS 特区人表里抽**一行真实记录**。
 * 一行就是一个人，年龄、性别、职业、通勤、户内有无未成年人、户车数、户规模
 * 全部来自同一条记录，联合分布天然成立，不需要把几个边际比例拼起来。
 *
 * 真实数据出处：
 *   U.S. Census Bureau, American Community Survey 2020–2024 5-Year
 *   Public Use Microdata Sample (PUMS), District of Columbia, 2026-03-05 发布。
 *   官方目录 https://www2.census.gov/programs-surveys/acs/data/pums/2024/5-Year/
 *   本地原件 from muse/csv_pdc (2)/psam_p11.csv、from muse/csv_hdc/psam_h11.csv
 *   派生文件 data/real/acs_dc.json、web/src/kernel/real-data.js
 *
 * 下面这些是**建模映射，不是真实数据**，全部在 docs/依据台账.md 标为「目前自己定的」：
 *   SOC 两位数大类 → 3D 场景 place（ACS 不给工作场所类型）
 *   真实年龄 → 9 档行为分档边界（ACS 给的是 5 岁带）
 *   JWTRNS 通勤码 → 仿真里 walk / drive / transit 三种执行方式
 *   SOC = NA 时按年龄判断学生 / 退休 / 未就业
 * 这四项是工程分组，不拿来当人口分布报出去，也不写进结论。
 */
import { ACS_DC } from './real-data.js';
import { weightedIndex, mulberry32 } from './rng.js';

const ROWS = ACS_DC.microsample.rows;
const COLS = ACS_DC.microsample.columns;
const COL = {};
COLS.forEach((name, i) => { COL[name] = i; });

/** 预先算好权重数组，避免每次造人都遍历 3 万行。 */
const WEIGHTS = ROWS.map((r) => r[COL['PWGTP权重']]);

/** SOC 两位数大类中文名，来自 PUMS 字典与 2018 SOC 码表。 */
export const SOC_LABEL = {
  '11': '管理', '13': '商业与金融', '15': '计算机与数学', '17': '建筑与工程',
  '19': '生命、物理与社会科学', '21': '社区与社会服务', '23': '法律',
  '25': '教育与图书馆', '27': '艺术、娱乐与媒体', '29': '医疗执业与技术人员',
  '31': '医疗辅助', '33': '安保服务', '35': '餐饮制备与服务',
  '37': '建筑清洁与场地维护', '39': '个人护理与服务', '41': '销售',
  '43': '办公室与行政支持', '45': '农林渔', '47': '施工与开采',
  '49': '安装、维护与修理', '51': '生产', '53': '运输与物料搬运',
  '55': '军职', 'NA': '未细分／不适用',
};

/** JWTRNS 码 → 中文名，来自 PUMS 2020–2024 数据字典。 */
export const JWTRNS_LABEL = {
  '01': '小汽车、卡车或厢式车', '02': '公交', '03': '地铁或高架铁路',
  '04': '通勤铁路', '05': '渡轮', '06': '出租车', '07': '摩托车或自行车',
  '08': '步行', '09': '在家工作', '10': '其他', '11': '轻轨／有轨电车',
  '12': '长途巴士', 'NA': '不适用／未工作',
};

/**
 * SOC 大类 → 3D 场景 place。
 * 【目前自己定的】ACS 只给职业大类，不给这人在哪类建筑上班。
 * 这个映射是为了让现有的 7 类室内场景还能用，属于工程分组，不是实测。
 */
export const SOC_TO_PLACE = {
  '11': 'office', '13': 'office', '15': 'office', '17': 'office',
  '19': 'office', '23': 'office', '43': 'office', '33': 'office',
  '25': 'school', '21': 'school',
  '29': 'clinic', '31': 'clinic',
  '27': 'cafe', '35': 'cafe', '41': 'cafe', '39': 'cafe',
  '37': 'site', '47': 'site', '49': 'site', '51': 'site', '45': 'site',
  '53': 'street', '55': 'street', 'NA': null,
};

/**
 * 真实年龄 → 9 档行为分档 id。
 * 【目前自己定的】边界是行为模型需要的粗分组，ACS 原始数据是 5 岁带。
 * 只用来挂步速／体力／应激等「目前自己定的」行为系数，不用来决定人口占比。
 */
export function behaviorBandOf(age) {
  // 【修 2026-11-17】NaN / undefined 参与裸比较全为 false，会落到最老的
  // 'oldest' 档；null 又会被当成 0 落到 'preschool'。取不到年龄时走成年档，
  // 与 incidents.js 的 vulnerabilityOf 一致。
  if (age === null || age === undefined || !Number.isFinite(Number(age))) return 'prime';
  const a = Number(age);
  if (a < 5) return 'preschool';
  if (age < 13) return 'child';
  if (age < 18) return 'teen';
  if (age < 25) return 'young';
  if (age < 40) return 'prime';
  if (age < 56) return 'middle';
  if (age < 65) return 'senior';
  if (age < 75) return 'old';
  return 'oldest';
}

/** JWTRNS → 仿真执行的出行方式。【目前自己定的】工程映射。 */
export function travelModeOf(code) {
  if (code === '01' || code === '06') return 'drive';
  if (code === '07' || code === '08') return 'walk';
  if (code === '09') return 'home';
  if (code === 'NA' || code === '10') return 'walk';
  return 'transit';
}

/**
 * 抽一个真实特区居民。
 * @param {number} i 行人序号，只用来定 seed，保证同 seed 可复现
 * @param {number} seed
 * @returns 真实字段 + 少量显式标注的工程派生字段
 */
export function samplePerson(i, seed = 20261115) {
  const rnd = mulberry32(seed + i * 7919);
  const row = ROWS[weightedIndex(WEIGHTS, rnd)];
  const age = row[COL['年龄']];
  const soc = String(row[COL['SOC两位数大类']]);
  const jw = String(row[COL['JWTRNS通勤码']]);
  const vehRaw = String(row[COL['户车数']]);
  // 【目前自己定的】PUMS 的 VEH 有 NA（不适用／未报告）。仿真需要数值，
  // 这里把 NA 归成 0 辆；这是建模映射，不是真实车数，已在台账登记，
  // 验收脚本按同一口径对拍，避免把口径差当成分布不一致。
  const vehicles = /^\d+$/.test(vehRaw) ? Number(vehRaw) : 0;
  const hasMinor = row[COL['户内有未成年(1/0)']] === 1;

  // SOC=NA 是真实记录里「未细分／不适用」（含儿童、学生、退休、失业）。
  // 按真实年龄补一个身份标签，这是建模映射，不是新数据。
  let roleLabel;
  let place;
  if (soc !== 'NA') {
    roleLabel = SOC_LABEL[soc] || `SOC ${soc}`;
    place = SOC_TO_PLACE[soc] || 'office';
  } else if (age < 5) {
    roleLabel = '学龄前儿童'; place = 'home';
  } else if (age < 18) {
    roleLabel = '学生'; place = 'school';
  } else if (age >= 65) {
    roleLabel = '退休居民'; place = 'home';
  } else {
    roleLabel = '未就业／未报告'; place = 'home';
  }

  return {
    // ---- 真实字段（ACS PUMS 原始记录）----
    age,
    ageBand5y: row[COL['五岁带']],
    sex: String(row[COL['性别']]),                    // 1 男 / 2 女，PUMS 字典
    socCode: soc,
    socLabel: SOC_LABEL[soc] || `SOC ${soc}`,
    jwtrns: jw,
    jwtrnsLabel: JWTRNS_LABEL[jw] || `JWTRNS ${jw}`,
    hasMinor,
    householdVehicles: vehicles,
    householdSize: Number(row[COL['户规模']]) || 1,
    relationship: String(row[COL['与户主关系码']]),
    weight: row[COL['PWGTP权重']],
    // ---- 工程派生（目前自己定的，见文件头）----
    behaviorBand: behaviorBandOf(age),
    roleLabel,
    place,
    travelMode: travelModeOf(jw),
    source: 'ACS 2020–2024 5-Year PUMS, District of Columbia',
  };
}

/** 给验收脚本用：抽样分布的边际，和 ACS 官方加权分布对拍。 */
export function sampleMarginal(n = 3000, seed = 20261115) {
  // 【修 2026-11-17】n=Infinity / NaN 会让 for 循环跑不完或立刻结束，
  // 抽样数必须是有限非负整数。上限只挡病态输入，不参与任何正常计算。
  const raw = Number(n);
  const count = Number.isFinite(raw) ? Math.max(0, Math.min(100000, Math.floor(raw))) : 3000;
  const rnd = mulberry32(seed * 31 + 17);
  const out = { ageBand5y: {}, sex: {}, socCode: {}, jwtrns: {}, hasMinor: {}, householdVehicles: {} };
  for (let k = 0; k < count; k++) {
    const row = ROWS[weightedIndex(WEIGHTS, rnd)];
    const bump = (key, v) => { const m = out[key]; m[v] = (m[v] || 0) + 1; };
    bump('ageBand5y', row[COL['五岁带']]);
    bump('sex', String(row[COL['性别']]));
    bump('socCode', String(row[COL['SOC两位数大类']]));
    bump('jwtrns', String(row[COL['JWTRNS通勤码']]));
    bump('hasMinor', row[COL['户内有未成年(1/0)']] === 1 ? '有未成年' : '无未成年');
    bump('householdVehicles', String(row[COL['户车数']]));
  }
  return out;
}

export const POPULATION_META = {
  rows: ROWS.length,
  weightSum: ACS_DC.microsample.weight_sum,
  columns: COLS,
  source: 'U.S. Census Bureau, ACS 2020–2024 5-Year PUMS, District of Columbia',
  official: 'https://www2.census.gov/programs-surveys/acs/data/pums/2024/5-Year/',
};
