/**
 * day-baseline.js — 一天的活动怎么排，来自真实出行调查。
 *
 * 【2026-11-15 已换掉自设的 9 节点模板】
 * 旧 goal.js 手写 4 套模板（work 9 个节点 / student 9 个 / retired 8 个 /
 * night 6 个），几点起床、几点吃饭、几点下班全是项目自己定的分钟数，
 * 而且同一类人一天干的事一模一样。导师在录音 10:15 点名问
 * 「接送孩子 39 次是不是合理」，问的就是这套自设日程。
 *
 * 现在按 FHWA 2022 NextGen NHTS V2.1 的加权交叉表生成：
 *   WHYTO 出行目的 × 户内有无未成年人 × 年龄段 × 出发时段
 * 每个人按自己的真实年龄和真实家庭结构，从对应格子里加权抽
 * 「这个时段出不出行、出去干嘛」，同一类人也不再是同一张表。
 *
 * 【只能定日常基线】录音里导师 08:03–08:48 明确说过，用日常行为代理
 * 灾害时的反应需要很强的依据。这里生成的只是「今天本来打算干什么」，
 * 灾害来了之后改不改、怎么改，由 kernel/choice-model.js 的离散选择决定，
 * 不拿 NHTS 证明灾害决策合理。
 *
 * 【外出次数】2026-11-15 第四轮后改用 FHWA《2022 Summary of Travel Trends》
 * 官方每人每天出行次数（全员 2.28，按年龄档 2.0–2.5），不再每个时段
 * 都排一个活动节点。节点总数仍等于时段数，是为了让状态机全天无缝覆盖；
 * 其中「外出」的节点数由官方次数决定。
 *
 * 【目前自己定的】逐条登记在 docs/依据台账.md 与 DAY_BASELINE_META.selfSet：
 *   ① 7 个时段分档本身没有官方定义（第四轮 QD1：NHTS 无官方 TOD 变量），
 *      是实算交叉表口径；档之间还有间隙，边界取相邻档中点补齐。
 *   ② WHYTO 目的 → 仿真里的 destKey / type 映射，NHTS 不给门牌。
 *   ③ 官方出行次数四舍五入成整数、按各时段加权出行量抽哪几个时段出门。
 */
import { NHTS_DAY } from './real-data.js';
import { weightedIndex } from './rng.js';
import { tripsPerDayFor, NHTS_TRIPS_PER_DAY } from './evidence-tables.js';

const cells = NHTS_DAY.joint.cells;
const purposeLabels = NHTS_DAY.distributions.whyto_labels;

/** NHTS 交叉表的 7 个出发时段；右边界取相邻档中点，让 0–1440 无缝覆盖。 */
export const TIME_SLOTS = [
  { code: '00-05', start: 0, due: 360 },
  { code: '06-08', start: 360, due: 540 },
  { code: '09-11', start: 540, due: 720 },
  { code: '12-13', start: 720, due: 840 },
  { code: '14-16', start: 840, due: 1020 },
  { code: '17-19', start: 1020, due: 1200 },
  { code: '20-23', start: 1200, due: 1440 },
];

/** WHYTO → 仿真目标类型／门牌。建模映射，见文件头。 */
const PURPOSE_TO_NODE = {
  '01': { type: 'home', destKey: 'home', label: '在家活动' },
  '03': { type: 'work', destKey: 'work', label: '去上班' },
  '04': { type: 'pickup', destKey: 'street', label: '工作性接送' },
  '06': { type: 'work', destKey: 'work', label: '去上学' },
  '07': { type: 'pickup', destKey: 'street', label: '照护家人' },
  '08': { type: 'meal', destKey: 'meal', label: '外出用餐' },
  '10': { type: 'pickup', destKey: 'street', label: '私人接送' },
  '11': { type: 'errand', destKey: 'street', label: '就医' },
  '13': { type: 'errand', destKey: 'street', label: '购物' },
  '20': { type: 'errand', destKey: 'street', label: '社交娱乐' },
  '30': { type: 'errand', destKey: 'street', label: '医疗牙科' },
  '40': { type: 'errand', destKey: 'street', label: '购物杂事' },
  '50': { type: 'errand', destKey: 'street', label: '社交休闲' },
  '70': { type: 'pickup', destKey: 'street', label: '交通接送' },
  '80': { type: 'meal', destKey: 'meal', label: '餐饮' },
  '97': { type: 'errand', destKey: 'street', label: '其他出行' },
};

/** 真实年龄段分档，和 NHTS 交叉表里的维度一致。 */
export function nhtsAgeBand(age) {
  if (age < 5) return '05-17';       // NHTS 没有 0–4 单独档，最小的 05-17 兜底
  if (age < 18) return '05-17';
  if (age < 35) return '18-34';
  if (age < 50) return '35-49';
  if (age < 65) return '50-64';
  return '65+';
}

/** 取某个人的真实加权分布：这个时段、这个目的有多少出行量。 */
export function slotDistribution(real, slotCode) {
  const band = nhtsAgeBand(real.age);
  const minor = real.hasMinor ? 'with_minor_child' : 'no_minor_child';
  const prefix = `|${minor}|${band}|${slotCode}`;
  const out = [];
  for (const [key, w] of Object.entries(cells)) {
    if (key.endsWith(prefix)) out.push({ purpose: key.split('|')[0], weight: w });
  }
  return out;
}

function homeNode(slot, label) {
  return {
    id: `nhts_${slot.code}_home`, label,
    type: 'home', destKey: 'home',
    start: slot.start, due: slot.due, purpose: '01', slot: slot.code,
  };
}

/**
 * 给一个人排一天。返回节点数组，字段与旧 GOAL_TEMPLATES 的节点一致，
 * goal.js 的状态机一行都不用改。
 *
 * 【2026-11-15 第四轮后改动】之前每个时段都抽一个目的，等于每人每天固定
 * 7 个活动节点，和 FHWA 官方「每人每天 2.28 次出行」对不上。现在：
 *   ① 外出次数取官方按年龄档的值（2.0–2.5 次/人/日，四舍五入）；
 *   ② 哪几个时段外出，按该人真实交叉表里各时段的加权出行量抽；
 *   ③ 外出去干嘛，按该时段的「目的」加权分布抽；
 *   ④ 其余时段填「在家」，让状态机全天无缝覆盖。
 * 所以节点总数仍是时段数（工程覆盖），但**外出节点数**来自真实调查，
 * 不再是我拍的固定 9 个或固定 7 个。
 */
export function buildDayNodes(real, rnd, extras = []) {
  const trips = Math.max(0, Math.round(tripsPerDayFor(real.age)));
  // 各时段的总加权出行量，作为「这个时段会不会出门」的抽样权重。
  const slotWeights = TIME_SLOTS.map((slot) =>
    slotDistribution(real, slot.code).reduce((a, d) => a + d.weight, 0));
  const remaining = TIME_SLOTS.map((_, i) => i);
  const outSlots = new Set();
  for (let n = 0; n < trips && remaining.length; n++) {
    const pick = weightedIndex(remaining.map((i) => slotWeights[i]), rnd);
    outSlots.add(remaining[pick]);
    remaining.splice(pick, 1);
  }

  const out = TIME_SLOTS.map((slot, si) => {
    if (!outSlots.has(si)) return homeNode(slot, '在家（官方出行次数之外）');
    const dist = slotDistribution(real, slot.code);
    // 真实交叉表里这一格没有记录（稀疏），这一时段按在家处理，不编目的。
    if (!dist.length) return homeNode(slot, '在家（该时段无出行记录）');
    const purpose = dist[weightedIndex(dist.map((d) => d.weight), rnd)].purpose;
    const mapped = PURPOSE_TO_NODE[purpose] || PURPOSE_TO_NODE['97'];
    return {
      id: `nhts_${slot.code}_${purpose}`,
      label: purposeLabels[purpose] || mapped.label,
      type: mapped.type,
      destKey: mapped.destKey,
      start: slot.start,
      due: slot.due,
      purpose,
      slot: slot.code,
    };
  });

  // 接送孩子这类额外目标由 social-circles 按 NHTS 真实占比 + 官方出行次数生成。
  for (const e of extras) {
    out.push({
      id: `pickup_${e.minute}`, label: e.label,
      type: 'pickup', destKey: e.destKey || 'street',
      start: Math.max(0, e.minute - 25), due: Math.min(1440, e.minute + 20),
      purpose: '10', slot: null,
    });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

export const DAY_BASELINE_META = {
  source: 'FHWA / ORNL, 2022 NextGen NHTS V2.1, WHYTO × LIF_CYC × R_AGE × STRTTIME 加权交叉表（946 格）+ 2022 Summary of Travel Trends 官方每人每天出行次数',
  officialTripsPerDay: NHTS_TRIPS_PER_DAY,
  weight: 'WTTRDFIN',
  local: 'data/real/nhts_day.json；web/src/kernel/real-data.js',
  slots: TIME_SLOTS.length,
  note: '节点总数等于时段数是为了全天覆盖；外出节点数来自官方出行次数',
  limit: '只能定日常日程基线，不能证明灾害时的决策合理',
  selfSet: [
    '7 个时段分档本身没有官方定义（第四轮 QD1：NHTS 无官方 TOD 变量），是实算交叉表口径',
    '时段边界取相邻档中点补齐空隙',
    '官方出行次数四舍五入成整数、按加权时段量抽哪几个时段外出',
    'WHYTO → 门牌／目标类型的映射（NHTS 不给门牌）',
    '稀疏格按在家处理',
  ],
};
