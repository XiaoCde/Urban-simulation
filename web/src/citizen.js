/**
 * citizen.js — 全城市民的「年龄 / 经验」分层档案。
 *
 * 【用户 2026-11-10 要求】「全城随机加人…要考虑到老人、小孩、中年人他们
 * 之间不同的移动速度和不同的心理状态，和做决策的思考方向，因为有的人
 * 经验好，有的人经验不足」。
 *
 * 不是给三档人各写一套行为脚本，而是让**同一套 Brain**吃到不同的权重：
 *   年龄 → 基础步速 / 体力 / 应激放大 / 耐心 / 走路费力度
 *   经验 → 视线半径 / 决策噪声 / 风险厌恶 / 涉水线 / 是否想得出「绕行」这个候选
 * 再把「思考方向」落到候选集：老手想得出「沿熟路绕到高处」并看得清路况；
 * 新手只看得见「跟着人群 / 先站着看别人」；小孩找大人；老人倾向等雨小、
 * 且因为走得慢，绕远路的时间代价真的更高。
 *
 * 所有差异都能在 window.__crowdLife.debug() 里逐人查到，不进展示面板。
 */
import { mulberry32 } from './decision.js';
import { WALK } from './motion-units.js';
import { behaviorBandOf, samplePerson } from './kernel/population.js';
import { measuredComfortableSpeedMs } from './kernel/walk-speed.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * 【2026-11-15 已换掉拍脑袋的人口比例】
 * 旧版这里 9 档各带一个 `share`（0.035 / 0.105 / 0.275 …），人按比例抽，
 * 比例全是项目自己定的，导师在录音 7:02 问「人口分布从哪来」问的就是它。
 * 现在人的年龄、性别、职业、家庭、通勤全部来自 ACS 2020–2024 五年期
 * PUMS 特区真实个体记录（见 kernel/population.js），按 PWGTP 权重抽一行。
 *
 * 下面 9 档**不再是人口分布**，只是把真实年龄映射到行为分档的标签。
 * 【2026-11-15 第四轮回件后】20 岁及以上的**步速**已换成
 * Bohannon & Andrews 2011 (Physiotherapy 97:182–189) 实测的年龄 × 性别
 * 舒适步速（见 kernel/walk-speed.js），不再用下面的 walk 倍率。
 * 20 岁以下该 meta 分析没有数据，仍用这里的 walk 倍率，显式标
 * 「目前自己定的」。其余行为系数（stamina / stressGain / patience / risk …）
 * 也全是自设，在 docs/依据台账.md 逐条登记，不拿来当真实数据报出去。
 * `lo` / `hi` 只用于展示分档范围，不再参与抽人。
 */
export const AGE_BANDS = [
  { id: 'preschool', label: '学龄前', lo: 0, hi: 5, group: 'child',
    walk: 0.46, run: 0.42, stamina: 0.55, stressGain: 1.62, mood: '好奇', duty: 0.18,
    patience: -0.30, risk: 0.30, wade: -0.15, effort: 0.24, sight: -14, expBase: 0.04 },
  { id: 'child', label: '儿童', lo: 5, hi: 13, group: 'child',
    walk: 0.84, run: 0.74, stamina: 0.68, stressGain: 1.42, mood: '好奇', duty: 0.55,
    patience: -0.22, risk: 0.16, wade: -0.09, effort: 0.10, sight: -7, expBase: 0.17 },
  { id: 'teen', label: '青少年', lo: 13, hi: 18, group: 'child',
    walk: 1.06, run: 1.18, stamina: 1.05, stressGain: 1.12, mood: '活跃', duty: 0.62,
    patience: -0.10, risk: -0.06, wade: 0.01, effort: -0.02, sight: 0, expBase: 0.32 },
  { id: 'young', label: '青年', lo: 18, hi: 25, group: 'adult',
    walk: 1.08, run: 1.10, stamina: 1.10, stressGain: 1.02, mood: '积极', duty: 0.92,
    patience: -0.06, risk: -0.04, wade: 0.02, effort: -0.04, sight: 2, expBase: 0.42 },
  { id: 'prime', label: '青壮年', lo: 25, hi: 40, group: 'adult',
    walk: 1.04, run: 1.04, stamina: 1.06, stressGain: 0.98, mood: '平稳', duty: 1.05,
    patience: 0.02, risk: 0.00, wade: 0.01, effort: -0.02, sight: 4, expBase: 0.58 },
  { id: 'middle', label: '中年', lo: 40, hi: 56, group: 'adult',
    walk: 0.98, run: 0.94, stamina: 0.96, stressGain: 1.00, mood: '稳重', duty: 1.12,
    patience: 0.10, risk: 0.06, wade: 0.00, effort: 0.03, sight: 3, expBase: 0.68 },
  { id: 'senior', label: '中老年', lo: 56, hi: 65, group: 'adult',
    walk: 0.86, run: 0.76, stamina: 0.80, stressGain: 0.94, mood: '谨慎', duty: 0.98,
    patience: 0.16, risk: 0.14, wade: -0.03, effort: 0.12, sight: -1, expBase: 0.75 },
  { id: 'old', label: '老人', lo: 65, hi: 75, group: 'elderly',
    walk: 0.70, run: 0.58, stamina: 0.62, stressGain: 0.88, mood: '谨慎', duty: 0.84,
    patience: 0.24, risk: 0.22, wade: -0.07, effort: 0.22, sight: -2, expBase: 0.78 },
  { id: 'oldest', label: '高龄', lo: 75, hi: 120, group: 'elderly',
    walk: 0.56, run: 0.44, stamina: 0.48, stressGain: 0.84, mood: '求稳', duty: 0.66,
    patience: 0.30, risk: 0.30, wade: -0.11, effort: 0.32, sight: -4, expBase: 0.80 },
];
export const bandOf = (id) => AGE_BANDS.find((B) => B.id === id) || AGE_BANDS[4];

/** 三大类只用于汇总展示，不再带任何自设占比；真实占比由 ACS 记录现算。 */
export const AGE_GROUPS = {
  child: { id: 'child', label: '儿童/青少年' },
  adult: { id: 'adult', label: '青壮/中年' },
  elderly: { id: 'elderly', label: '老人/高龄' },
};

/**
 * 造一个市民档案。确定性：同一 seed+i 永远得到同一人。
 *
 * @param {number} i 行人序号
 * @param {number} seed
 * @param {object|null} real kernel/population.js 抽出的真实 ACS 个体记录。
 *   由 crowd-life 在造人循环里抽一次，年龄／职业／家庭／通勤共用同一条记录，
 *   保证联合分布一致。不传时自己抽一条（供独立调用与验收脚本用）。
 * @returns {object} { ageGroup, ageBand, age, experience, speedAbs, thinking, profile, ... }
 */
export function makeCitizen(i, seed = 20261110, real = null) {
  const R = real || samplePerson(i, seed);
  const rand = mulberry32(seed + i * 7919);
  const B = bandOf(behaviorBandOf(R.age));
  const age = R.age;
  const ageKey = B.group;

  // 经验：年龄段给基线，但同段内拉得很开 ——「有的人经验好，有的人不足」。
  const experience = clamp(B.expBase + (rand() - 0.5) * 0.55, 0.02, 0.99);
  const veteran = experience >= 0.62;
  const rookie = experience < 0.40;

  // ---- 步速（m/s 绝对值，直接给 ped.js）
  // 20 岁及以上用实测年龄 × 性别舒适步速；20 岁以下该研究没有数据，
  // 退回项目自设倍率，并在 speedSource 里显式标出来，不混进实测里报。
  const measuredWalk = measuredComfortableSpeedMs(age, R.sex === '2');
  const baseWalk = measuredWalk !== null ? measuredWalk : WALK.BASE * B.walk;
  const gait = baseWalk * (0.88 + experience * 0.22);
  const speedAbs = +clamp(gait, WALK.MIN, WALK.MAX).toFixed(3);
  const runAbs = +clamp(gait * (1.9 + experience * 0.15) * B.run / B.walk,
    WALK.MIN * 1.7, WALK.ROUTE_MAX).toFixed(3);
  const speedSource = measuredWalk !== null
    ? 'Bohannon & Andrews 2011, Physiotherapy 97:182–189, Table 2（实测）'
    : '目前自己定的（20 岁以下无实测步速）';

  const sightM = Math.round(24 + experience * 30 + B.sight);
  const profile = {
    key: `citizen_${B.id}_${i}`,
    label: '', role: '', trait: '',
    dutyWeight: +(0.72 + B.duty * 0.36 + experience * 0.14).toFixed(3),
    riskAversion: +(0.44 + (1 - experience) * 0.56 + B.risk).toFixed(3),
    wadeLimit: +clamp(0.19 + experience * 0.20 + B.wade, 0.06, 0.46).toFixed(3),
    carWade: 0.35,
    sightM,
    driveSightM: Math.round(sightM * 1.6),
    patience: +clamp(0.36 + experience * 0.26 + B.patience, 0.05, 0.96).toFixed(3),
    noise: +(0.018 + (1 - experience) * 0.125 + (B.group === 'child' ? 0.035 : 0)).toFixed(3),
  };

  const thinking = (B.id === 'preschool' ? '幼儿·必须跟着大人·几乎不独立判断'
    : B.id === 'child' ? '小学生·找大人·容易受惊'
      : B.id === 'teen' ? '青少年·敢自己试·愿意绕'
        : B.id === 'oldest' ? '高龄·走得慢·绝不涉险/绕远'
          : B.group === 'elderly' ? '年长·求稳·不愿意绕远'
            : veteran ? '经验老到·看得远·决策稳'
              : rookie ? '经验不足·易慌·倾向随大流'
                : '一般经验·按习惯走')
    + (veteran && B.group === 'adult' ? '·会主动绕行' : '');

  return {
    i, ageGroup: ageKey, ageBand: B.id, ageBandLabel: B.label,
    age, experience: +experience.toFixed(3),
    veteran, rookie, speedAbs, runAbs, speedSource,
    stressGain: B.stressGain,
    moodBias: B.mood,
    effortBias: B.effort,
    staminaBase: B.stamina,
    sightM, thinking, profile,
    // 真实身份随人走：职业、家庭、通勤、车全部由下游从这里读，
    // 不再各自按自设权重抽一次。
    real: R,
  };
}

/**
 * 按「这个人是谁」造决策候选。
 *
 * 【2026-11-10 闭环改造】每个候选带一个 `goal` —— 地图上的**真实目标类型**：
 *   high 真实高地/屋顶 · near 最近门牌 · shortcut/steady/slow 当前时段门牌
 *   scout 前方路网站点 · follow 身边某个具体的人 · wait 原地不动
 * crowd-life.decide() 会用 route-brain 的 A* 为每个 goal 生成真实 walknet 折线，
 * 覆盖这里的 path / distance / speed，然后才交给 Brain 打分。选中的那条折线
 * 会被行人真的走完 —— 所以「想法」不再只是记录，而是地图上的一条路。
 *
 * 这里保留的 trace 只在 planner 没装配时降级使用（避免 unknownRatio 全 1）。
 */
export function candidatesFor(q, pos, storm = false) {
  const c = q.citizen || { experience: 0.5, ageGroup: 'adult', veteran: false,
    rookie: false, speedAbs: 1.2, effortBias: 0 };
  const v = q.speedAbs || c.speedAbs || 1.2;
  const exp = c.experience;
  const age = c.ageGroup;
  const band = c.ageBand || (age === 'child' ? 'child' : age === 'elderly' ? 'old' : 'prime');
  const tiny = band === 'preschool';
  const oldSlow = band === 'old' || band === 'oldest';
  const trace = (n, dx, dz) => Array.from({ length: n }, (_, k) => ({
    p: { x: pos.x + dx * (k + 1) / n, z: pos.z + dz * (k + 1) / n },
  }));

  if (storm) {
    const out = [
      {
        label: '就近进楼避雨', reason: '雨太大先进去等', goal: 'near',
        distance: 22, speed: Math.max(0.5, v * 0.8), duty: 0.25,
        waitWeight: 0.78, effortWeight: 0.12, path: [],
      },
    ];
    if (c.veteran) {
      out.push({
        label: '沿熟路绕到高处', reason: '我知道哪几条街不积水', goal: 'high',
        distance: 132, speed: Math.max(0.6, v * 1.02), duty: 0.58,
        effortWeight: 0.14, timeWeight: 0.16,
        path: trace(5, -14, 22),
      });
      out.push({
        label: '看清水情再走', reason: '先确认前面多深，别乱猜', goal: 'scout',
        distance: 46, speed: Math.max(0.5, v * 0.7), duty: 0.44,
        waitWeight: 0.30, path: trace(3, -6, 9),
      });
    } else if (c.rookie || age === 'child' || tiny) {
      out.push({
        label: (age === 'child' || tiny) ? '找大人 / 跟着大人' : '跟着人群往那边走', goal: 'follow',
        reason: (age === 'child' || tiny) ? '不知道该往哪走' : '别人走我也走',
        distance: 88, speed: Math.max(0.5, v * 1.12), duty: 0.30,
        waitWeight: 0.52, effortWeight: 0.30, path: [],
      });
      out.push({
        label: '先站着看别人怎么做', reason: '没经验，不敢乱动', goal: 'wait',
        distance: 0, speed: 0.5, duty: 0.18, kind: 'wait', waitWeight: 0.90, path: [],
      });
    } else {
      out.push({
        label: '沿原路快走', reason: '路熟、能早点到', goal: 'shortcut',
        distance: 76, speed: Math.max(0.6, v * 1.08), duty: 0.55,
        effortWeight: 0.30, path: trace(3, 9, 9),
      });
    }
    if (age === 'elderly' || band === 'senior') {
      out.push({
        label: '在屋檐下等雨小', reason: '路滑，先不急', goal: 'wait',
        distance: 8, speed: 0.35, duty: 0.70,
        kind: 'wait', waitWeight: 1.05, effortWeight: 0.42, path: [],
      });
      out.push({
        label: '慢慢沿熟路走', reason: '走熟的、不抄近道', goal: 'slow',
        distance: 104, speed: Math.max(0.45, v * 0.72), duty: 0.62,
        effortWeight: 0.48, timeWeight: 0.46, path: trace(4, -8, 14),
      });
    }
    return out;
  }

  // ---- 日常：每 25 分钟权衡一次「按计划 / 抄近道 / 缓一缓」
  const steady = q.indoor ? 26 : 58;
  const out = [
    {
      label: q.indoor ? '按计划继续' : '照原路走', goal: 'steady',
      reason: q.indoor ? '手上的事还没做完' : '这条路熟',
      distance: steady, speed: Math.max(0.5, v * 0.92), duty: 0.85,
      effortWeight: 0.20 + (c.effortBias || 0) * 0.4,
      timeWeight: 0.20 + (age === 'elderly' ? 0.16 : 0),
      path: trace(3, 7, 8),
    },
  ];
  if (c.veteran) {
    out.push({
      label: '抄近道', reason: '知道哪条巷子好走', goal: 'shortcut',
      distance: steady * 0.70, speed: Math.max(0.5, v * 1.12), duty: 0.62,
      effortWeight: 0.20, timeWeight: 0.12, path: trace(4, -6, 10),
    });
  } else if (c.rookie) {
    out.push({
      label: '跟着前面的人走', reason: '不认路，跟着走稳妥', goal: 'follow',
      distance: steady * 0.92, speed: Math.max(0.5, v * 0.96), duty: 0.40,
      effortWeight: 0.34, waitWeight: 0.35, path: [],
    });
  } else {
    out.push({
      label: '抄近道', reason: '想早点到', goal: 'shortcut',
      distance: steady * 0.76, speed: Math.max(0.5, v * 1.08), duty: 0.55,
      effortWeight: 0.32, timeWeight: 0.14, path: [],
    });
  }
  out.push({
    label: oldSlow ? '坐下来歇一会儿' : (tiny ? '被大人牵着停下'
      : (age === 'child' ? '停下来看热闹' : '先停一下')),
    reason: oldSlow ? '腿脚慢，歇口气' : (tiny ? '要跟着大人' : '时间还宽裕'), goal: 'wait',
    distance: 0, speed: 0.5, duty: 0.28, kind: 'wait', waitWeight: 0.70,
    path: [],
  });
  return out;
}
