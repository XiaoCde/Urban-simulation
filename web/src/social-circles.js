/**
 * social-circles.js — 人群圈层（家庭 / 片区 / 通勤 / 用车 / 信息层级）。
 *
 * 【2026-11-15 已换掉拍脑袋的权重表】
 * 旧版有 7 档家庭结构各带自设 `w`、5 档通勤方式带自设 `w`、
 * 4 档驾驶风格带自设 `w`、按 8 档社会地位给自设有车概率 `carBase`，
 * 再靠这些独立抽出来的维度拼成一个「圈层」。这些比例没有一手依据，
 * 也把真实记录里「年龄 × 职业 × 家庭 × 通勤 × 车」的联合关系抹掉了。
 *
 * 现在全部读 kernel/population.js 抽出的那条真实 ACS 个体记录：
 *   家庭结构 ← 户内有无未成年人 + 户规模 + 与户主关系
 *   通勤方式 ← JWTRNS 真实码值
 *   有无车   ← 户车数 VEH（户级变量，不再按人重复抽）
 *   接送孩子 ← NHTS 2022 加权交叉表 WHYTO=10 的真实占比
 *   片区     ← 真实住宅门牌坐标
 *
 * 还留着的「目前自己定的」只有两类，都在 docs/依据台账.md 登记：
 *   ① 片区的 info/wade/risk 修正系数（真实数据里没有「信息层级」这个量）
 *   ② 驾驶风格：两轮检索没有找到真实分布，已删掉 4 档随机分档，
 *      改成单一中性驾驶参数；让行率用 NCHRP 562 的实测均值 0.34。
 */
import { mulberry32 } from './decision.js';
import { WALK, CAR } from './motion-units.js';
import { NHTS_DAY } from './kernel/real-data.js';
import { samplePerson, JWTRNS_LABEL } from './kernel/population.js';
import { HAZARD_THRESHOLDS } from './kernel/params.js';
import { tripsPerDayFor } from './kernel/evidence-tables.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * 家庭结构标签。旧版 7 档各带自设权重，现在只是把真实 ACS 字段
 * 翻译成可读标签，不含任何权重。
 */
export const FAMILIES = [
  { id: 'solo', label: '独居', care: 0, kids: 0 },
  { id: 'dinky', label: '双职工无孩', care: 0, kids: 0 },
  { id: 'schoolkid', label: '有学龄子女', care: 1, kids: 1 },
  { id: 'toddler', label: '有幼儿', care: 2, kids: 2 },
  { id: 'threegen', label: '三代同堂', care: 2, kids: 1 },
  { id: 'empty', label: '空巢老人', care: 0, kids: 0 },
  { id: 'share', label: '合租青年', care: 0, kids: 0 },
];
const FAMILY_BY_ID = new Map(FAMILIES.map((f) => [f.id, f]));

/**
 * 居住片区：按**真实住宅门牌坐标**分区，不是随机贴标签。
 * info/wade/risk 四个修正是【目前自己定的】，真实数据没有「信息层级」，
 * 保留只为让现有的预警距离机制还能跑，不拿来当结论。
 */
export const DISTRICTS = [
  { id: 'core', label: '内环高层', info: 0.92, wade: -0.03, risk: -0.05 },
  { id: 'outer', label: '外环社区', info: 0.70, wade: 0.00, risk: 0.00 },
  { id: 'riverside', label: '滨河低洼', info: 0.62, wade: 0.05, risk: 0.12 },
  { id: 'upland', label: '高地住宅', info: 0.80, wade: -0.02, risk: -0.10 },
];

/**
 * 驾驶参数：旧版 4 档「谨慎/常规/效率/激进」按自设权重抽，全部删掉。
 * 两轮检索没有找到驾驶风格的真实分布，这里只留一组中性值，
 * 其中让行率取自 NCHRP 562 的实测均值 0.34（分母是过街事件数）。
 * 其余数值标为「目前自己定的」，不做敏感性结论。
 */
export const DRIVE_STYLES = [
  { id: 'neutral', label: '中性', limit: 1.0, gap: 1.0, yieldBias: 0.34, wadeBias: 1.0, law: 1.0 },
];
const MEASURED_YIELD_RATE = HAZARD_THRESHOLDS.pedestrianYieldRate.value.mean;

/** 通勤方式标签：真实 JWTRNS 码 → 仿真执行方式，映射在 population.js。 */
export const COMMUTES = [
  { id: 'walk', label: '步行', mode: 'walk', speed: 1.00, car: 0.00 },
  { id: 'transit', label: '公交', mode: 'walk', speed: 1.06, car: 0.00 },
  { id: 'drive', label: '自驾', mode: 'drive', speed: 1.00, car: 1.00 },
  { id: 'carpool', label: '拼车', mode: 'drive', speed: 1.00, car: 0.80 },
  { id: 'bike', label: '骑行', mode: 'walk', speed: 1.18, car: 0.00 },
  { id: 'home', label: '在家工作／不出行', mode: 'walk', speed: 1.00, car: 0.00 },
];
const COMMUTE_BY_ID = new Map(COMMUTES.map((c) => [c.id, c]));

const ADULT_MIN = 18;
const RETIRE_AGE = 65;

/** 按真实门牌坐标分到片区：内环 / 滨河 / 高地 / 外环。 */
function districtOf(home, i) {
  if (!home || !Number.isFinite(home.x)) return DISTRICTS[i % DISTRICTS.length];
  const h = Math.abs(Math.sin(home.x * 0.013 + home.z * 0.009));
  const r = Math.hypot(home.x, home.z);
  if (Math.abs(home.z) % 97 < 22) return DISTRICTS[2];
  if (r < 180) return DISTRICTS[0];
  if (h > 0.72) return DISTRICTS[3];
  return DISTRICTS[1];
}

/**
 * NHTS 2022 真实加权出行占比：有未成年子女家庭的私人接送（WHYTO=10）。
 * 用来决定这个人今天有没有「接送孩子」这趟出行，不再用自设的 0.72 / 0.86。
 */
export const PICKUP_RATE = (() => {
  const cells = NHTS_DAY.distributions.purpose_by_household_minor.values;
  const total = Object.values(cells).reduce((a, b) => a + b, 0);
  const withMinor = cells['10|with_minor_child'] || 0;
  const noMinor = cells['10|no_minor_child'] || 0;
  // 组内占比：分母只取「有未成年子女家庭」的全部出行，比拿全样本做分母
  // 更贴「这类家庭一天有多少次接送」的口径。两者都是同一份真实调查数据，
  // 只是分母不同，写清楚避免混用。
  const withMinorTotal = Object.entries(cells)
    .filter(([k]) => k.endsWith('|with_minor_child'))
    .reduce((a, [, v]) => a + v, 0);
  return {
    withMinor: withMinor / total,
    noMinor: noMinor / total,
    withMinorWithinGroup: withMinorTotal ? withMinor / withMinorTotal : 0,
    source: 'FHWA 2022 NextGen NHTS V2.1, WHYTO=10 私人接送，按 WTTRDFIN 加权',
  };
})();


/** 出发时段来自 NHTS 交叉表，按「目的 × 有无未成年 × 年龄段」取加权最高的时段。 */
function pickupMinutes(real) {
  const age = real.age;
  const band = age < 18 ? '05-17' : age < 35 ? '18-34' : age < 50 ? '35-49'
    : age < 65 ? '50-64' : '65+';
  const minor = real.hasMinor ? 'with_minor_child' : 'no_minor_child';
  const prefix = `10|${minor}|${band}|`;
  let best = null, bestW = -1;
  for (const [k, w] of Object.entries(NHTS_DAY.joint.cells)) {
    if (k.startsWith(prefix) && w > bestW) { bestW = w; best = k.split('|')[3]; }
  }
  const range = { '00-05': [0, 300], '06-08': [360, 480], '09-11': [540, 660],
    '12-13': [720, 780], '14-16': [840, 960], '17-19': [1020, 1140],
    '20-23': [1200, 1380] }[best] || [840, 960];
  return range;
}

/**
 * 给第 i 个人造圈层。确定性：同 seed + 同人 → 同圈层。
 * @param {object} person crowd-life 的 person（含 real：真实 ACS 记录）
 */
export function circleOf(i, person, atFn = null, seed = 20261113) {
  const rnd = mulberry32(seed + i * 104729);
  const R = (person && person.real) || samplePerson(i, seed);
  const c = person && person.citizen ? person.citizen : null;
  const band = (c && c.ageBand) || (person && person.ageBand) || 'prime';
  const status = (person && person.status) || '服务业';
  const role = (person && person.role) || '服务业';
  const isMinor = R.age < ADULT_MIN;
  const isElder = R.age >= RETIRE_AGE;

  let home = null;
  try { const q = atFn && atFn(i, 0); home = q && q.doors && q.doors.home; } catch (e) { /* 社会层未就绪 */ }

  // ---- 家庭结构：真实 ACS 的户内未成年 / 户规模 / 与户主关系 ----
  let famId;
  if (isMinor) famId = R.hasMinor ? 'schoolkid' : 'dinky';
  else if (isElder) famId = R.householdSize >= 3 ? 'threegen' : 'empty';
  else if (R.hasMinor) famId = R.householdSize >= 5 ? 'threegen'
    : R.householdSize >= 4 ? 'toddler' : 'schoolkid';
  else famId = R.householdSize <= 1 ? 'solo'
    : R.householdSize === 2 ? 'dinky' : 'share';
  const fam = FAMILY_BY_ID.get(famId);

  const dist = districtOf(home, i);

  // ---- 有无车：真实户车数 VEH，不再按社会地位给自设概率 ----
  const hasCar = R.householdVehicles > 0 && !isMinor;
  const license = hasCar && (R.age >= 18 && R.age < 88);

  // ---- 通勤方式：真实 JWTRNS 码 ----
  const modeId = R.travelMode;
  const commute = COMMUTE_BY_ID.get(modeId) || COMMUTE_BY_ID.get('walk');

  // ---- 驾驶参数：单一中性值 + 实测让行率 ----
  const style = DRIVE_STYLES[0];

  // ---- 信息层级：【目前自己定的】，真实数据没有这个量 ----
  const info = clamp(dist.info * (0.78 + rnd() * 0.42)
    + (status === '专业人士' ? 0.06 : 0) - (isElder ? 0.12 : 0), 0.25, 1);
  const infoTier = info > 0.82 ? '预警及时' : info > 0.62 ? '偶尔看手机' : '信息滞后';

  // ---- 圈层修正系数：【目前自己定的】，见台账，不进离散选择决策 ----
  const jitter = (amp) => (rnd() - 0.5) * amp;
  const mod = {
    wade: clamp(dist.wade + jitter(0.07), -0.10, 0.12),
    detour: clamp((info - 0.6) * 0.22 + (fam.care ? -0.05 : 0) + jitter(0.12), -0.20, 0.25),
    wait: clamp((fam.care ? 0.18 : 0) + (isElder ? 0.22 : 0) + jitter(0.20), -0.25, 0.45),
    urgency: clamp((fam.care ? 0.12 : 0) + (commute.id === 'drive' ? 0.05 : 0)
      + jitter(0.12), -0.18, 0.30),
    speed: clamp((commute.speed - 1) * 0.5 + jitter(0.10), -0.18, 0.16),
    temp: clamp((1 - info) * 0.20 + (isMinor ? 0.12 : 0) + jitter(0.14), -0.20, 0.35),
    giveUp: clamp((isElder ? 0.10 : 0) + (fam.care ? -0.06 : 0) + jitter(0.10), -0.15, 0.20),
    crowd: clamp((isMinor ? 0.14 : 0) + jitter(0.12), -0.15, 0.22),
    familiar: clamp((dist.id === 'core' ? 0.08 : 0) + jitter(0.12), -0.15, 0.18),
  };

  // ---- 接送孩子：NHTS 真实占比决定是否发生，时段来自真实交叉表 ----
  const pickups = [];
  // 【2026-11-15 第四轮后换掉自设的 ×12】
  // 旧版把 4.058% 的出行占比随手乘 12 折成「今天有没有这趟」，12 没有出处。
  // 现在：λ = FHWA 官方每人每天出行次数（按年龄档） × NHTS 组内接送出行占比，
  // 再用「至少发生一次」的泊松概率 1−e^(−λ) 决定。
  // 泊松假设是工程处理（目前自己定的），但 λ 的两个因子都是真实数据。
  // 官方没有「按有无未成年子女分组」的出行次数汇总（第四轮 QD3 复核确认），
  // 所以年龄档用全样本值，这一处口径限制写进 docs/依据台账.md。
  const tripsPerDay = tripsPerDayFor(R.age);
  const lambda = tripsPerDay * PICKUP_RATE.withMinorWithinGroup;
  const pickupProbability = 1 - Math.exp(-lambda);
  if (hasCar && R.hasMinor && !isMinor && rnd() < pickupProbability) {
    const [lo, hi] = pickupMinutes(R);
    pickups.push({ minute: Math.round(lo + (hi - lo) * rnd()),
      label: '按日常调查记录的私人接送', destKey: 'street' });
  }

  const id = [fam.id, dist.id, commute.id, style.id, infoTier].join('/');
  return {
    i, id, label: `${dist.label} · ${fam.label} · ${commute.label} · ${infoTier}`,
    family: fam.id, familyLabel: fam.label,
    district: dist.id, districtLabel: dist.label,
    commute: commute.id, commuteLabel: commute.label,
    jwtrns: R.jwtrns, jwtrnsLabel: JWTRNS_LABEL[R.jwtrns] || R.jwtrnsLabel,
    style: style.id, styleLabel: style.label,
    home: home ? { x: home.x, z: home.z, id: home.id } : null,
    hasCar, license, carpool: false,
    careDuty: fam.care, kids: fam.kids, pickups,
    info, infoTier, band, status, role,
    // 真实身份字段，供决策内核读先验
    age: R.age, sex: R.sex, socCode: R.socCode,
    householdHasMinor: R.hasMinor, householdVehicles: R.householdVehicles,
    householdSize: R.householdSize,
    riskBias: clamp(dist.risk + jitter(0.12), -0.20, 0.25),
    conformity: clamp(0.45 + (isMinor ? 0.25 : 0) + jitter(0.30), 0.05, 0.95),
    mod,
    driver: {
      limit: CAR.URBAN_LIMIT * style.limit,
      gapMul: style.gap,
      yieldBias: MEASURED_YIELD_RATE,
      wadeBias: style.wadeBias,
      law: style.law,
      schoolZone: fam.kids > 0,
    },
  };
}

/** 圈层统计：给验收/HUD 看「到底分了多少种、是不是所有人一个样」。 */
export function summarize(circles) {
  const by = {};
  let withCar = 0, care = 0, pickup = 0, driveMode = 0;
  for (const c of circles) {
    if (!c) continue;
    by[c.id] = (by[c.id] || 0) + 1;
    if (c.hasCar) withCar++;
    if (c.careDuty) care++;
    if (c.pickups.length) pickup++;
    if (c.commute === 'drive' || c.commute === 'carpool') driveMode++;
  }
  const sizes = Object.values(by);
  const max = sizes.length ? Math.max(...sizes) : 0;
  return { people: circles.length, distinctCircles: sizes.length,
    largestCircle: max, largestShare: circles.length ? +(max / circles.length).toFixed(3) : 0,
    withCar, careDuty: care, withPickups: pickup, driveCommute: driveMode };
}

/**
 * 出行方式选择（慢层目标与快层判断之间）。
 * 这里保留工程约束（没车不能开、未成年不能开、门口水深不敢动车），
 * 但把旧版自设的「want = 0.54 + …」抽签删掉：
 * 能不能开由真实户车数、真实水深、真实距离决定，不再按自设概率掷骰子。
 */
export function chooseTravel(goal, circle, ctx = {}) {
  if (!circle) return { mode: 'walk', reason: '没有圈层信息，按步行' };
  if (!goal) return { mode: 'walk', reason: '当前没有目标' };
  const g = goal.type || '';
  const canDriveKind = g === 'commute' || g === 'pickup' || g === 'errand';
  if (!canDriveKind) return { mode: 'walk', reason: `${goal.label}是室内活动，不需要用车` };
  if (!circle.hasCar || !circle.license) return { mode: 'walk', reason: '家里没有车 / 没有驾照' };
  if (ctx.hasOwnCar === false) return { mode: 'walk', reason: '家里没配到车，步行/公交' };
  if (ctx.band === 'preschool' || ctx.band === 'child' || ctx.band === 'teen') {
    return { mode: 'walk', reason: '未成年人不能驾车' };
  }
  const dist = Number(ctx.dist) || 0;
  if (dist < 320) return { mode: 'walk', reason: `只有 ${Math.round(dist)} m，走路更省事` };
  if ((ctx.depthHere || 0) > 0.30) return { mode: 'walk', reason: `门口已经 ${Math.round((ctx.depthHere || 0) * 100)} cm 积水，不敢动车` };
  if (ctx.noCarAvailable) return { mode: 'walk', reason: '车都被开出去了，改步行/公交' };
  if ((ctx.rain || 0) > 35 && HAZARD_THRESHOLDS.pedestrianYieldRate.value.walkSpeed < 1.0) {
    return { mode: 'walk', reason: `雨 ${Math.round(ctx.rain)} mm/h 视线差，放弃开车` };
  }
  return { mode: 'drive', reason: `去 ${Math.round(dist)} m 外${goal.label}，家里有车且路可通行，开车` };
}

export { WALK };
