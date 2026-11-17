/**
 * hazard.js — 「灾害履历」：这个人以前有没有真的遇到过内涝、有没有受过应急训练。
 *
 * 【2026-11-13 用户追问】「面临突发危险，他有没有一些经验可取，有的人经验
 *  比较足，有的人经验不足」。此前 citizen.experience 只是「年龄基线 + 逐人
 *  噪声」合成的老练度，跟「有没有经历过洪灾 / 受没受过演练」是两回事：
 *  高龄也可能从没遇过内涝，年轻护士可能年年参加防汛演练。
 *
 * 这里补上**独立维度**，三条硬要求：
 *  ① 与年龄解耦：年龄只给一个很弱的基础概率，主要靠独立随机流决定；
 *  ② 与职业相关：医护 / 工地 / 户外零工更可能受过培训，学龄前只能是演练；
 *  ③ 用独立 seed，绝不消耗 crowd-life 里那条 rand()，否则门牌、伞、
 *     班次、圈层的既有确定性分布会整体漂移，前后验收数据就不可比了。
 *
 * hazard.score 不是标签，会真的进 cohort.makeKernel 的打分参数、
 * live-agent.perceive 的预警采样距离、ped.findRefuge 的避险选址偏好。
 * 伤亡判定（incidents.js）按用户要求**不读**这个字段。
 */
import { mulberry32 } from './decision.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const HAZARD_TIERS = {
  naive:   { id: 'naive',   label: '无灾害经验' },
  aware:   { id: 'aware',   label: '有过内涝经历 / 演练' },
  veteran: { id: 'veteran', label: '多次经历且受过训练' },
};

/** 年龄给的只是「活久一点更可能碰上」的弱先验，不能决定结果。 */
const AGE_PRIOR = {
  preschool: 0.05, child: 0.12, teen: 0.18, young: 0.30,
  prime: 0.42, middle: 0.52, senior: 0.58, old: 0.62, oldest: 0.66,
};

/** 岗位 exposure：户外 / 工地 / 医疗更容易亲历或受训。 */
const PLACE_EXPOSURE = {
  street: 0.16, site: 0.13, clinic: 0.09, school: 0.06,
  home: 0.02, office: 0.00, cafe: 0.02,
};

/** 职业身份的受训概率：与 roles.js 的 8 个 status 对齐。 */
const TRAIN_RATE = {
  '专业人士': 0.46, '白领': 0.22, '服务业': 0.18, '蓝领': 0.34,
  '零工': 0.12, '学生': 0.30, '学龄前': 0.05, '退休': 0.10,
};

const MINOR = new Set(['preschool', 'child', 'teen']);

/**
 * @param {number} i 行人序号（决定确定性）
 * @param {object} o { band, status, place, role }
 * @param {number} seed
 * @returns {{runs:number, trained:boolean, drill:boolean, score:number,
 *            tier:string, label:string, sightBonus:number}}
 */
export function makeHazard(i, o = {}, seed = 20261113) {
  const rnd = mulberry32(seed + i * 48611);
  const band = o.band || 'prime';
  const minor = MINOR.has(band);

  // ① 亲历次数 0~3：弱年龄先验 + 岗位暴露，其余全交给独立随机数
  const p1 = clamp((AGE_PRIOR[band] ?? 0.4) * 0.75
    + (PLACE_EXPOSURE[o.place] ?? 0.02), 0.05, 0.75);
  let runs = 0;
  if (rnd() < p1) {
    runs = 1;
    if (rnd() < p1 * 0.70) runs = 2;
    if (runs === 2 && rnd() < p1 * 0.45) runs = 3;
  }

  // ② 受训：未成年人只有学校演练，成年人按职业身份
  const trained = minor ? false : rnd() < (TRAIN_RATE[o.status] ?? 0.15);
  const drill = minor ? rnd() < 0.42 : false;

  // ③ 综合分：亲历 + 训练 + 演练，再叠一点逐人噪声
  const score = clamp(runs * 0.22 + (trained ? 0.34 : 0) + (drill ? 0.12 : 0)
    + (rnd() - 0.5) * 0.08, 0, 1);
  // 三档大致落在 55% / 35% / 10%：既要有明显「经验不足」的一大群，
  // 也要有足够多「经验足」的人，让分组对比有统计意义。
  const tier = score >= 0.50 ? 'veteran' : score >= 0.24 ? 'aware' : 'naive';

  const bits = [];
  if (runs) bits.push(`亲历内涝 ${runs} 次`);
  if (trained) bits.push('受过应急培训');
  if (drill) bits.push('参加过学校演练');
  const label = bits.length ? bits.join(' · ') : '没有灾害经历';

  return {
    runs, trained, drill,
    score: +score.toFixed(3),
    tier, tierLabel: HAZARD_TIERS[tier].label, label,
    // 看得更远：预警采样距离额外加 0~22 m（与 citizen.sightM 叠加）
    sightBonus: +(score * 22).toFixed(1),
  };
}

/** 验收 / HUD 用的汇总：证明这一维度和年龄确实解耦。 */
export function summarizeHazard(persons) {
  const byTier = { naive: 0, aware: 0, veteran: 0 };
  const byBand = {};
  let runs = 0, trained = 0, drill = 0, sum = 0, n = 0;
  let youngVeteran = 0, oldNaive = 0;
  for (const p of persons) {
    const h = p && (p.hazard || (p.citizen && p.citizen.hazard));
    if (!h) continue;
    n++; byTier[h.tier]++; sum += h.score;
    if (h.runs) runs++;
    if (h.trained) trained++;
    if (h.drill) drill++;
    const b = p.ageBand || (p.citizen && p.citizen.ageBand) || 'prime';
    byBand[b] = byBand[b] || { n: 0, veteran: 0, naive: 0, sum: 0 };
    byBand[b].n++; byBand[b].sum += h.score;
    if (h.tier === 'veteran') { byBand[b].veteran++; if (b === 'young' || b === 'prime' || b === 'teen') youngVeteran++; }
    if (h.tier === 'naive') { byBand[b].naive++; if (b === 'old' || b === 'oldest' || b === 'senior') oldNaive++; }
  }
  for (const b of Object.values(byBand)) b.avg = +(b.sum / Math.max(1, b.n)).toFixed(3);
  return {
    n, byTier, byBand, experienced: runs, trained, drill,
    avgScore: +(sum / Math.max(1, n)).toFixed(3),
    youngVeteran, oldNaive,
    // 这两个数 >0 才说明「灾害履历」没有被年龄老练度吞掉
    decoupled: youngVeteran > 0 && oldNaive > 0,
  };
}
