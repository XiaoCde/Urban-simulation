/**
 * attributes.js — 把仿真里的米、秒、比例换算成实测论文的自变量。
 *
 * 【之前的问题】cohort.js 里写的是
 *   cost = 距目标米数 × 0.001；travelTime = 距到期 × 0.01；
 *   waitTime = 檐下秒数 × 0.01；walkDistance = 距目标米数 × 0.001
 * 四个 0.001 / 0.01 全是项目自己定的，而且把「米」「秒」直接当成
 * Borowski 2023 Table 4 里的「美元」「分钟」「英里」，量纲根本不对。
 *
 * 【现在】先按物理单位换算（米→英里、秒→分钟、绕路英里→美元），
 * 美元换算用该论文正文印刷的实测补偿值 32.78 美元/英里；
 * 再按 Table 3 印刷的实验设计范围（Cost 0–40 美元、时间 0–60 分钟、
 * 步行距离 0–0.5 英里、同伴留下 0–0.8）归一化到 0–1。
 * 归一化这一步仍是工程映射（原文没说仿真量该怎么喂进模型），
 * 但**基准值全部来自实测设计表**，不再是随手定的常数，登记在台账里。
 *
 * 同伴比例的定义也照该论文原文：不是空间半径里的人数，
 * 而是受访者「自我中心社会网络」中最多 5 人的选择比例（第四轮 QA9）。
 */
import { BOROWSKI_DESIGN } from './evidence-tables.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const METRES_PER_MILE = 1609.344;

/** 按实测设计范围归一化；range 取 BOROWSKI_DESIGN 里的 {min,max}。 */
function normalise(value, range) {
  if (!Number.isFinite(value)) return 0;
  const span = range.max - range.min;
  if (span <= 0) return 0;
  return clamp((value - range.min) / span, 0, 1);
}

/**
 * 把一次判断的路径状态换成 Table 4 的自变量。
 * @param {object} s perceive() 给出的状态
 * @returns {object} { cost, travelTime, waitTime, walkDistance, peersStay, peersRide, raw }
 *   raw 里保留换算后的真实单位，供验收脚本和追溯用。
 */
export function attributesFromSim(s = {}) {
  // 【修 2026-11-17】默认参数不覆盖显式传入的 null。
  const q = s && typeof s === 'object' ? s : {};
  const D = BOROWSKI_DESIGN;
  const metresToGoal = Math.max(0, Number(q.distGoal) || 0);
  const miles = metresToGoal / METRES_PER_MILE;
  const detourMiles = Math.max(0, Number(q.detourMetres) || 0) / METRES_PER_MILE;
  // 绕路的货币成本：正文印刷「每多走一英里需补偿 32.78 美元」。
  const costUSD = (detourMiles || miles) * D.walkingCompensationUSDPerMile;
  // timeToDue 在 perceive() 里是「分钟」；shelteredSec 是「仿真秒」，换分钟。
  const travelTimeMin = Math.max(0, Number(q.timeToDue) || 0);
  const waitTimeMin = Math.max(0, Number(q.shelteredSec) || 0) / 60;
  // 同伴比例：仿真目前还没有把「周围人正在留下／撤离」统计进来，
  // 显式给 0，不编一个比例。第四轮 QA9 拿到了公开定义（自我中心网络
  // 最多 5 人），Table 3 的设计均值 0.19 / 0.27 保存在 BOROWSKI_DESIGN，
  // 等个案回放阶段接上空间统计后从 s 传入，那时才用实测设计均值做缺省。
  // 上限按 Table 3 印刷的实验设计范围截断：同伴留下 0–0.8、同伴搭车 0–1。
  // 之前两者都写成 0–1，同伴留下这一项会超出设计范围 25%，
  // 而它挂的系数是 7.76 与极端危险下的 −21.13，超出量直接放大交互项。
  const peersStay = clamp(Number(q.peersStay) || 0,
    D.peerFractionStay.min, D.peerFractionStay.max);
  const peersRide = clamp(Number(q.peersRide) || 0,
    D.peerFractionRide.min, D.peerFractionRide.max);

  return {
    cost: normalise(costUSD, D.costUSD),
    travelTime: normalise(travelTimeMin, D.travelTimeMin),
    waitTime: normalise(waitTimeMin, D.waitTimeMin),
    walkDistance: normalise(miles, D.walkDistanceMiles),
    peersStay,
    peersRide,
    raw: {
      metresToGoal, miles, detourMiles, costUSD,
      travelTimeMin, waitTimeMin,
      usdPerMile: D.walkingCompensationUSDPerMile,
      design: {
        costUSD: D.costUSD, travelTimeMin: D.travelTimeMin,
        waitTimeMin: D.waitTimeMin, walkDistanceMiles: D.walkDistanceMiles,
      },
    },
  };
}

export const ATTRIBUTE_META = Object.freeze({
  source: BOROWSKI_DESIGN.source,
  conversions: {
    metresToMiles: '1 mile = 1609.344 m（物理换算）',
    secondsToMinutes: '1 min = 60 s（物理换算）',
    distanceToCost: '32.78 美元/英里，Borowski & Stathopoulos 2023 正文印刷的步行补偿值',
  },
  selfSet: [
    '把仿真量归一化到实验设计范围这一步是工程映射，原文没有规定',
    's 里没有同伴比例时显式给 0，不编一个比例',
  ],
  peerDefinition: '自我中心社会网络中最多 5 人的选择比例，不是空间半径内人数；Table 3 设计均值 0.19 / 0.27 已存，待空间统计接入',
  pending: '同伴比例的空间统计（第四轮 QA9 已给公开定义），排在个案回放阶段',
});
