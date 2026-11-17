/**
 * roles.js — 职业 → 工作场景 / 场景锚点的单一真值表。
 *
 * 【2026-11-15 已换掉拍脑袋的职业表】
 * 旧版手写 32 个中文职业（「写字楼职员」「FAA 职员」「街头小贩」…），
 * 每个带一个自设 `weight`（1.5 / 0.35 / 0.5 …）用来抽职业。
 * 导师在录音 7:02 问「职业分类从哪来」，问的就是这张表；它既不是
 * 华盛顿特区的真实职业分布，也不是任何官方分类。现在整张弃用。
 *
 * 现在职业来自 ACS 2020–2024 五年期 PUMS 特区人表的 SOC 两位数大类，
 * 由 kernel/population.js 按 PWGTP 权重从真实个体记录里抽出，
 * 随人一起传进来，不再在造人时另抽一次。
 *
 * 保留的只有「SOC 大类 → 3D 场景 place」的映射和场景锚点表。
 * 这是显示层需要的工程映射，ACS 不给工作场所类型，属于
 * 「目前自己定的」，不拿来当真实数据报出去，已登记 docs/依据台账.md。
 *
 * STATUS_BASE 是旧行为模型的 8 档社会地位系数，随决策模型换掉已经
 * 不参与判断；这里只保留导出，供 ped.js 的步速表等显示层兼容读取。
 */
import { SOC_LABEL, SOC_TO_PLACE } from './kernel/population.js';

/**
 * 旧行为模型留下的社会地位基线系数。
 * 【目前自己定的】全部数值无一手依据，新的离散选择模型不读它。
 * 保留导出仅为不破坏 ped.js / cohort.js 的 import，待显示层清理后删除。
 */
export const STATUS_BASE = {
  '白领':      { wade: 0.24, detour: 0.62, wait: 1.2, crowd: 0.22, familiar: 0.75, urgency: 0.74, giveUp: 0.40, speed: 1.40, temp: 0.80, car: 0.55, think: 0.70, umbrella: 0.78 },
  '专业人士':  { wade: 0.25, detour: 0.68, wait: 1.4, crowd: 0.18, familiar: 0.80, urgency: 0.66, giveUp: 0.36, speed: 1.36, temp: 0.74, car: 0.45, think: 0.72, umbrella: 0.80 },
  '服务业':    { wade: 0.28, detour: 0.55, wait: 1.8, crowd: 0.38, familiar: 0.60, urgency: 0.58, giveUp: 0.48, speed: 1.34, temp: 0.95, car: 0.18, think: 0.65, umbrella: 0.56 },
  '蓝领':      { wade: 0.34, detour: 0.48, wait: 1.0, crowd: 0.30, familiar: 0.66, urgency: 0.52, giveUp: 0.30, speed: 1.30, temp: 0.88, car: 0.10, think: 0.60, umbrella: 0.42 },
  '零工':      { wade: 0.33, detour: 0.82, wait: 0.6, crowd: 0.16, familiar: 0.88, urgency: 0.86, giveUp: 0.52, speed: 1.52, temp: 1.05, car: 0.62, think: 0.52, umbrella: 0.66 },
  '学生':      { wade: 0.16, detour: 0.28, wait: 2.2, crowd: 0.72, familiar: 0.35, urgency: 0.44, giveUp: 0.62, speed: 1.00, temp: 1.30, car: 0.00, think: 0.60, umbrella: 0.44 },
  '学龄前':    { wade: 0.09, detour: 0.08, wait: 3.2, crowd: 0.92, familiar: 0.10, urgency: 0.12, giveUp: 0.80, speed: 0.62, temp: 0.60, car: 0.00, think: 0.85, umbrella: 0.30 },
  '退休':      { wade: 0.17, detour: 0.26, wait: 2.8, crowd: 0.46, familiar: 0.72, urgency: 0.20, giveUp: 0.66, speed: 0.88, temp: 0.68, car: 0.12, think: 0.85, umbrella: 0.72 },
};

/** 真实 3D 场景按地点分组，第一项是主场景。显示层需要，保留。 */
export const WORK_BY_PLACE = {
  office: ['sc_office_6f', 'sc_office_lobby', 'sc_office_meeting3f', 'sc_office_stairs'],
  cafe: ['sc_cafe_counter', 'sc_cafe_tables', 'sc_cafe_backdoor'],
  clinic: ['sc_clinic_lobby1f', 'sc_clinic_treatment', 'sc_clinic_or2f', 'sc_clinic_recovery'],
  school: ['sc_school_class3f', 'sc_school_corridor', 'sc_school_gate', 'sc_school_music5f'],
  site: ['sc_site_pit', 'sc_site_shed', 'sc_site_container'],
  street: ['sc_street_ride', 'sc_street_corner', 'sc_road_commute'],
  home: ['sc_home_lobby', 'sc_home_living', 'sc_home_kitchen', 'sc_home_hall9f'],
};

/**
 * 真实职业表：ACS PUMS 的 SOC 两位数大类（24 类，含 NA）。
 * 权重不在这里 —— 权重是 ACS 的 PWGTP，抽样在 kernel/population.js。
 * 这张表只给「职业名 → 场景」的映射，供显示层与验收统计用。
 */
/** 具名演示角色的旧头衔 → 真实职业标签，保证不落到默认组。 */
const ALIAS = {
  '小学三年级': '学生', '小学教师': '教育与图书馆',
  '公司合伙人': '管理', '外科医生': '医疗执业与技术人员',
  'FAA 职员': '办公室与行政支持', '钢筋工': '施工与开采',
  '咖啡馆店员': '餐饮制备与服务', '外卖骑手': '运输与物料搬运',
};

/** SOC 两位数大类 → 旧的 8 档地位标签。纯映射，不依赖查找表。 */
function socStatusOf(code, label) {
  if (code === 'NA' || !code) return label === '学生' ? '学生'
    : label === '学龄前儿童' ? '学龄前'
      : label === '退休居民' ? '退休' : '服务业';
  if (['29', '31', '25', '21', '15', '17', '23', '19'].includes(code)) return '专业人士';
  if (['11', '13', '43', '41'].includes(code)) return '白领';
  if (['47', '49', '51', '37', '45'].includes(code)) return '蓝领';
  if (['53', '55', '33'].includes(code)) return '零工';
  return '服务业';
}

export const ROLES = Object.keys(SOC_LABEL).map((code) => ({
  role: SOC_LABEL[code],
  socCode: code,
  place: SOC_TO_PLACE[code] || 'home',
  status: socStatusOf(code, SOC_LABEL[code]),
  scene: (WORK_BY_PLACE[SOC_TO_PLACE[code] || 'home'] || WORK_BY_PLACE.home)[0],
  outdoor: ['site', 'street'].includes(SOC_TO_PLACE[code]),
  outdoorScene: null,
  night: false,
  weight: null,   // 旧版自设权重已删；真实权重来自 ACS 微观样本
}));

const ROLE_BY_NAME = new Map(ROLES.map((r) => [r.role, r]));

export function roleOf(name) {
  return ROLE_BY_NAME.get(ALIAS[name] || name) || null;
}

/**
 * 社会地位标签：由真实 SOC 大类映射到旧的 8 档标签。
 * 【目前自己定的】仅为兼容旧导出，新的离散选择模型不读它。
 */
export function statusOf(name) {
  const r = roleOf(name);
  if (!r) return '服务业';
  return socStatusOf(r.socCode, ALIAS[name] || name);
}

/**
 * 备伞率：旧 STATUS_BASE 的 umbrella 列，【目前自己定的】，
 * 只是显示层的视觉差异，不进决策。两轮检索没有一手依据。
 */
export function umbrellaChance(name, band) {
  const r = roleOf(name);
  const base = (STATUS_BASE[r ? r.status : '服务业'] || STATUS_BASE['服务业']).umbrella;
  if (band === 'oldest') return base * 0.8;
  if (band === 'preschool' || band === 'child') return base * 0.75;
  return base;
}

/**
 * 取一个人的职业条目。职业来自真实 ACS 记录，不再按年龄带 + 自设权重抽。
 * @param {object} real kernel/population.js 的 samplePerson 返回值
 * @returns 与旧 pickRole 相同的字段结构（role / place / scene / outdoor / night / weight）
 */
export function pickRole(real) {
  const entry = ROLE_BY_NAME.get(real && real.roleLabel)
    || ROLES.find((r) => r.socCode === (real && real.socCode))
    || ROLES[ROLES.length - 1];
  const place = (real && real.place) || entry.place;
  return {
    ...entry,
    // 未就业／学生／退休是 ACS 里 SOC=NA 的真实记录，按年龄给的身份标签
    // 比「未细分／不适用」更可读，但 socCode 仍保留 NA，统计时不会混进某类职业。
    role: (real && real.roleLabel) || entry.role,
    socCode: (real && real.socCode) || entry.socCode,
    place,
    scene: (WORK_BY_PLACE[place] || WORK_BY_PLACE.home)[0],
    outdoor: ['site', 'street'].includes(place),
    outdoorScene: null,
    night: false,
  };
}
