/**
 * flow-hazard.js — 流速危险度（FD2321 / ARR），纯函数，不许出现 three / window / fetch。
 *
 * 【为什么单独一支】2026-11-20 之前项目没有流速场，`docs/依据台账.md` 把
 * 「流速取 0」标成目前自己定的，于是「被冲走」「建筑倒塌」两类高危险死亡
 * 在模型里根本不存在。现在 `web/assets/flood/<case>/` 的每一帧带
 * `v%03d.u8`（流速）与 `g%03d.u8`（流向），见 docs/流速场导出_2026-11-20.md。
 *
 * 这一支只回答三件事，全部是可查出处或有明确标注的：
 *   ① 危险度 HR = d·(v+0.5) + DF —— FD2321 Table 3.2 / Cox et al. 2010（实测口径）
 *   ② 人的失稳判据 D·V 与限值静水深 —— ARR Project 10 / Cox, Shand & Blacka 2010
 *   ③ 「失稳/被水流带走 → 淹死」的概率 —— 文献没有，【目前自己定的】，
 *      集中在 SELF_SET，必须做敏感性分析，算出来的死亡数不是实测。
 *
 * 与 thresholds.js 的关系：那里已经放了 MEASURED.hazardRating / instabilityDV
 * 的界值，本文件引用它们，不另写一套数——两套界值混用是最容易出错的地方。
 */
import { MEASURED } from './thresholds.js';

/**
 * FD2321 Table 3.1（城市列）碎屑因子 DF。
 * 水深 <0.25 m 当没有漂移物；0.25–0.75 m 或流速 ≥2 m/s 记 0.5；
 * ≥0.75 m 记 1.0。这是「洪水里带木头/垃圾」的加成，属于实测分级表，
 * 不是拟合参数。
 */
export const DEBRIS = Object.freeze({
  shallowM: 0.25, deepM: 0.75, fastMs: 2.0,
  shallowDf: 0, midDf: 0.5, deepDf: 1.0,
});

/** 危险度分级界值：FD2321 Table 3.2 的人体口径（低 / 部分人 / 多数人 / 所有人）。 */
export const HR_BANDS = Object.freeze({
  some: MEASURED.hazardRating.moderate,       // 0.75
  most: MEASURED.hazardRating.significant,    // 1.25
  all: MEASURED.hazardRating.fd2321Extreme,   // 2.5（不是 FD2320 的 2.0）
});

/** 碎屑因子 DF(d, v)，见上。 */
export function debrisFactor(depthM, speedMs) {
  const d = Math.max(0, Number(depthM) || 0);
  const v = Math.max(0, Number(speedMs) || 0);
  if (d < DEBRIS.shallowM) return DEBRIS.shallowDf;
  if (d >= DEBRIS.deepM || v >= DEBRIS.fastMs) return DEBRIS.deepDf;
  return DEBRIS.midDf;
}

/**
 * 危险度 HR = d·(v + 0.5) + DF。
 * 原式里那个 0.5 是「静止水的基线危险」常数（FD2321 式 3.1 的 n），不是自设参数。
 */
export function hazardRating(depthM, speedMs) {
  const d = Math.max(0, Number(depthM) || 0);
  const v = Math.max(0, Number(speedMs) || 0);
  return d * (v + 0.5) + debrisFactor(d, v);
}

/** HR → 分级标签：low / some（对部分人危险，儿童）/ most（多数人）/ all（所有人）。 */
export function hazardClass(hr) {
  const h = Number(hr) || 0;
  if (h < HR_BANDS.some) return 'low';
  if (h < HR_BANDS.most) return 'some';
  if (h < HR_BANDS.all) return 'most';
  return 'all';
}

/**
 * D·V 乘积（m²/s）。ARR Project 10 的分级：
 * 0.4 儿童低危险、0.6 成人低危险、0.8 受训成人可作业、>1.2 所有人极端危险。
 */
export function dvProduct(depthM, speedMs) {
  return Math.max(0, Number(depthM) || 0) * Math.max(0, Number(speedMs) || 0);
}

/** 一个具体的人失稳的限值：D·V 界值与限值静水深，按年龄/行动能力取。 */
export function stabilityLimits(age, limitedMobility = false) {
  const a = Number.isFinite(age) ? age : 40;
  const child = a < 13;
  const dv = (child ? MEASURED.instabilityDV.childLow : MEASURED.instabilityDV.adultLow)
    * (limitedMobility ? 0.75 : 1);
  const depthM = (child ? MEASURED.instabilityDV.childMaxDepthM
    : MEASURED.instabilityDV.adultMaxDepthM) * (limitedMobility ? 0.8 : 1);
  return { dv, depthM, child, limitedMobility: !!limitedMobility };
}

/**
 * 站不站得住。两条任一成立就算失稳：
 *   ① 当地水深 ≥ 该人的限值静水深（ARR 分级里「走不过去」的深度）；
 *   ② D·V ≥ 该人的 D·V 界值 —— **静水时 v=0，这条自动不成立**，
 *      所以旧的「只看水深」判据没有被放宽，只是多了流速这一维。
 * 这是「失稳」，不是死亡；死亡由 sweptRiskPerSecond 那一步判。
 */
export function isUnstable(depthM, speedMs, age, limitedMobility = false) {
  const lim = stabilityLimits(age, limitedMobility);
  const d = Math.max(0, Number(depthM) || 0);
  if (d >= lim.depthM) return true;
  return dvProduct(d, speedMs) >= lim.dv;
}

/**
 * 【2026-11-21 重写：删掉自设】「被水流冲走」判据。
 *
 * 旧版是两个自设数的组合：一条按 HR 分级的秒级溺亡风险曲线
 * （sweptRiskPerSecond，锚点 0.0002→0.004 /s 全是拍的），外加两道自设门
 * （步速 ≤0.35 m/s、流速 ≥0.5 m/s）。三个数文献里都没有，跑出来 u_p8 30 例、
 * u_p16 95 例「被冲走」，等于把 FD2321 的「危险度分级」直接读成死亡率。
 *
 * 现在只用实测判据，且不再做概率累积：
 *   ① ARR Project 10（Cox, Shand & Blacka 2010）：D·V > 1.2 m²/s 时多数成人
 *      试验出现失稳，危害为 extreme，「不应视为可站立或可涉水」；
 *      儿童按 Keller & Mitsch (1993)（ARR 图 4 引用）失稳区间上限 0.55 m²/s。
 *   ② 必须真的在水流里：D·V 在 v=0 时恒为 0，所以静水深不会被判成冲走。
 *      深水走不动属于「被困」，由 incidents.js 的深水耐受那条线单独记账；
 *      两条按 Cox et al. (2004) 的机理分开——深水低流速更容易在失去立足点后
 *      溺亡，急流是先失稳。
 *
 * 【性质】把「失稳」当成「被冲走死亡」，是**把危险度读成伤亡的上界口径**：
 * 文献只给失稳阈值，没给失稳之后的生存率。所以这一条默认关闭，结果按区间报
 * （SWEPT=off / SWEPT=unstable 两版），两版之差就是这条判据的全部贡献。
 */

/** 儿童失稳 D·V 上限 0.55 m²/s —— Keller & Mitsch (1993)，ARR Project 10 图 4 引用。 */
export const CHILD_UNSTABLE_DV = 0.55;

/** 该年龄的失稳 D·V 限值：成人 1.2（ARR extreme）、儿童 0.55（Keller & Mitsch）。 */
export function sweptDvLimit(age) {
  const a = Number.isFinite(age) ? age : 40;
  return a < 13 ? CHILD_UNSTABLE_DV : MEASURED.instabilityDV.extreme;
}

let _sweptMode = false;
/** 打开/关闭「冲走」判据；默认关闭，主结果不用它。 */
export function setSweptMode(on) { _sweptMode = !!on; }
export function sweptModeOn() { return _sweptMode; }

/**
 * 是否判为「被水流冲走」：判据开着 + 人在流动的水里 + D·V 达到该人的失稳上限。
 * 不看步速、不看最低流速——这两个数旧版是自设的，现在删了。
 */
export function isSweptAway(depthM, speedMs, age) {
  if (!_sweptMode) return false;
  const v = Math.max(0, Number(speedMs) || 0);
  if (v <= 0) return false;
  return dvProduct(depthM, v) >= sweptDvLimit(age);
}

/** 出处与性质，给报告/台账直接引用。 */
export const FLOW_META = Object.freeze({
  measured: {
    hazardRating: 'FD2321 Table 3.1/3.2（HR = d(v+0.5)+DF，界值 0.75/1.25/2.5）',
    dvProduct: 'ARR Project 10 / Cox, Shand & Blacka 2010（0.4/0.6/0.8/1.2）',
    depthLimitM: 'ARR 分级限值静水深：成人 1.2 m、儿童 0.5 m',
    debrisFactor: 'FD2321 / TR1 Table 3.1 城市列',
  },
  selfSet: {
    sweptToDeath: '“失稳 → 被冲走死亡”是把危险度读成伤亡的上界口径，文献无生存率；默认关闭，按 off/unstable 两版报区间',
    limitedMobilityScale: '行动受限者 D·V×0.75、限值深度×0.8，为目前自己定的',
  },
  retired20261121: {
    sweptRiskPerSecond: '已删除：按 HR 分级的秒级溺亡风险锚定曲线（0.0002/0.004/0.01 /s）无出处',
    sweptMinFlowMps: '已删除：0.5 m/s 最低流速门、0.35 m/s 步速门均无出处',
  },
});