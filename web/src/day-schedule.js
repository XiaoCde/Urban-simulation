/**
 * day-schedule.js — 24 小时人的全程状态（唯一日程真值表）
 *
 * 现有剧情只覆盖 17:52→18:35（一天分钟 1072–1115）那 43 分钟。
 * 用户要「监测他 24 小时的全程状态」，所以需要一层覆盖全天的日程：
 *
 *   00:00–06:00 在家睡  / 06:00–08:00 通勤 / 08:00–12:00 上班上课
 *   12:00–13:00 午餐    / 13:00–17:00 上班
 *   17:00–19:00 【暴雨窗口】→ 交给 story + Brain 的实时决策（不归日程管）
 *   19:00–21:00 避难 / 返家（水还没退干净，紧张度随脚下水深缓慢回落）
 *   21:00–24:00 在家休息
 *
 * 日程给的是**位置锚点 + 真实动作 clip + 心理基线**，不是文字标签：
 * 渲染层会把人物 group 真挪到锚点、真播对应动作；HUD 任意时刻可查。
 * 暴雨窗口内本模块返回 null，让 story 接管，绝不吃掉 Brain 的决策结果。
 */
import { STORY_OFFSET } from './clock.js';
export { STORY_OFFSET };   // people.js / mark.js 也用它做相对↔绝对换算

/** 剧情窗口（一天分钟）。窗口内返回 null = 交给 story / Brain。 */
export const STORY_DAY_START = STORY_OFFSET + 52;   // 1072 = 17:52
export const STORY_DAY_END = STORY_OFFSET + 95;    // 1115 = 18:35

/**
 * 建筑锚点（与 office-building / home-building / district-buildings 常量一致）。
 * 第 4、5 项是建筑占地宽深，用来把人**摆到楼外的人行道上**，而不是全部
 * 塞进同一个中心点（旧版六个人 home 全在 (2642.79,-331.65)，完全重叠）。
 */
export const PLACES = {
  office: [2501.37, 354.69, 'FAA 办公楼 6F', 131.86, 30.10],
  home: [2642.79, -331.65, '565 Penn 公寓 9F', 81.96, 27.50],
  cafe: [2273.38, -102.32, 'Pavilion 咖啡馆', 12.87, 38.04],
  clinic: [2481.50, -380.63, '社区诊所', 33.68, 23.65],
  school: [2298.20, -517.94, 'Hospitality 学校', 20.41, 30.73],
  site: [2350.00, -360.00, '10th St 在建工地', 26.00, 16.00],
  street: [2410.00, 300.00, 'Constitution Ave 街面', 16.00, 16.00],
};

/**
 * 某人在某地点该站的位置：从楼心沿一个**各自不同的角度**射出，
 * 落在建筑轮廓外 6 m 的人行道上。六个人均分六个方向，绝不重叠、也不穿楼。
 */
export function placeSpot(key, placeKey, pad = 6) {
  const i = Math.max(0, CAST_KEYS.indexOf(key));
  // 每人再按序号往外错开几米：六个人同半径一圈，看着像「摆出来的」
  pad += i * 3.5;
  const n = Math.max(1, CAST_KEYS.length);
  const P = PLACES[placeKey] || PLACES.home;
  // 每个人固定一个角度（golden-angle 错开，避免六人等距排成一条线）
  const ang = (i * 2.399963) % (Math.PI * 2);
  const hw = (P[3] || 20) / 2 + pad, hd = (P[4] || 20) / 2 + pad;
  const c = Math.cos(ang), s = Math.sin(ang);
  const tx = Math.abs(c) < 1e-6 ? Infinity : hw / Math.abs(c);
  const tz = Math.abs(s) < 1e-6 ? Infinity : hd / Math.abs(s);
  const t = Math.min(tx, tz);
  return { x: P[0] + c * t, z: P[1] + s * t, name: P[2], place: placeKey };
}

/** 7 个具名角色的家 / 岗位 / 性格带来的基础情绪。 */
const CAST = {
  mark:   { name: '马克·陈',     work: 'office', home: 'home',   base: 0.08, car: true },
  // 老板 58 岁、住得远，通勤开车（「车里跟车外状态不一样」就是从他身上体现）
  boss:   { name: '罗伯特·帕克', work: 'office', home: 'home',   base: 0.10, car: true },
  doctor: { name: '大卫·帕特尔', work: 'clinic', home: 'home',   base: 0.06 },
  worker: { name: '路易斯·戈麦斯', work: 'site', home: 'home',  base: 0.12 },
  woman:  { name: '艾米·吴',     work: 'cafe',  home: 'home',   base: 0.09 },
  rider:  { name: '泰瑞尔·杰克逊', work: 'street', home: 'home', base: 0.14 },
  girl:   { name: '索菲亚·马丁内斯', work: 'school', home: 'home', base: 0.16 },
};
export const CAST_KEYS = Object.keys(CAST);

/** 露天工种：上班时段不进楼（工地、跑单）。 */
const OUTDOOR_JOBS = new Set(['worker', 'rider']);

/** 时段表：minute 是 0–1440 的一天分钟。
 *  travel=true 表示这是一个**在路上**的时段：从 from 走到 to，由渲染层沿街网
 *  真的走过去（旧版直接把人 set 到目标点，所以看起来是凭空平移）。 */
const SEGMENTS = [
  // 【夜里在家 = 屋里，不是坐在人行道上】用户 2026-11-06：0 点六个人全堆在
  // 同一栋楼下、还坐在地上。夜里本来就应该在室内，模型收起来（HUD 仍显示）。
  { a: 0,    b: 360,  id: 'night',   label: '深夜 · 在家休息', clip: 'sit',   mood: '放松',   stress: 0.02, act: '睡觉 / 休息',       at: 'home', inBuilding: true },
  { a: 360,  b: 480,  id: 'morning', label: '清晨 · 通勤',     clip: 'walk',  mood: '平静',   stress: 0.06, act: '起床、早餐、出门',  at: 'work', travel: ['home', 'work'] },
  // 【indoor】上班时段人在楼里。旧版让六个人 08:00–17:00 一直站在人行道上
  // 播 idle（用户 2026-11-06「好多人都在原地不动，不知道在干什么」）——
  // 位置四个小时一格不动，动作是待机，最像卡死。进了楼模型收起，
  // HUD 仍然显示「在 XX 楼内 · 上班」，信息不少。
  { a: 480,  b: 720,  id: 'am',      label: '上午 · 工作',     clip: 'idle',  mood: '专注',   stress: 0.10, act: '上班 / 上课',      at: 'work', indoor: true },
  { a: 720,  b: 780,  id: 'lunch',   label: '午间 · 午餐',     clip: 'idle',  mood: '放松',   stress: 0.05, act: '出去吃饭、走一走',  at: 'work' },
  { a: 780,  b: 1020, id: 'pm',      label: '下午 · 工作',     clip: 'idle', mood: '专注',   stress: 0.09, act: '上班 / 上课',       at: 'work', indoor: true },
  // 【窗口必须和 inCrisis() 对齐】Brain 只接管 17:52–18:35（1072–1115）。
  { a: 1020, b: 1072, id: 'preRain', label: '傍晚 · 起雨',    clip: 'idle', mood: '警觉',   stress: 0.22, act: '收拾东西、准备下班',   at: 'work' },
  { a: 1072, b: 1115, id: 'crisis',  label: '暴雨 · 实时决策', clip: null,    mood: null,     stress: null, act: 'Brain 实时判断',     at: null },
  { a: 1115, b: 1140, id: 'postRain',label: '雨中 · 继续避险', clip: 'walk',  mood: '焦虑',   stress: 0.58, act: '雨还在下，找地方避',    at: 'work', travel: ['here', 'work'] },
  { a: 1140, b: 1260, id: 'return',  label: '傍晚 · 返家',    clip: 'walk',  mood: '紧张',   stress: 0.52, act: '绕开积水、往家走',   at: 'home', travel: ['work', 'home'] },
  { a: 1260, b: 1440, id: 'evening', label: '夜间 · 在家',     clip: 'sit',   mood: '疲惫',   stress: 0.24, act: '换衣服、看新闻',    at: 'home', inBuilding: true },
];

export function daySegment(minute) {
  const m = ((Number(minute) || 0) % 1440 + 1440) % 1440;
  return SEGMENTS.find((s) => m >= s.a && m < s.b) || SEGMENTS[SEGMENTS.length - 1];
}

/**
 * 查某个角色在一天分钟 minute 的全程状态。
 * @param {string} key  CAST_KEYS 之一
 * @param {number} minute 一天分钟
 * @param {number} depth 脚下水深（米），用于返家段的紧张度
 * @returns {object|null} 暴雨窗口内返回 null（交给 Brain）
 */
export function scheduleFor(key, minute, depth = 0) {
  // 只有 Brain 真正接管的那 43 分钟让位；其余时段（含起雨/雨未停）都有日程。
  if (inCrisis(minute)) return null;
  const seg = daySegment(minute);
  if (seg.id === 'crisis') return null;   // 兜底，正常不会到
  const who = CAST[key] || CAST.mark;
  const workKey = who.work;
  const placeKey = seg.at === 'work' ? workKey : who.home;
  const spot = placeSpot(key, placeKey);
  const P = PLACES[placeKey] || PLACES.home;

  // 返家段：脚下还有水就继续紧张，水退了慢慢松下来；
  // 且这一段的进度越靠后越放松（不是一过 19:00 就瞬间平静）。
  let stress = seg.stress + who.base * (seg.id === 'night' ? 0.2 : 1);
  let mood = seg.mood;
  if (seg.id === 'return') {
    const k = (minute - seg.a) / (seg.b - seg.a);
    stress = Math.max(0.08, 0.62 - 0.42 * k + Math.min(0.30, depth * 0.7));
    mood = stress > 0.45 ? '焦虑' : (stress > 0.25 ? '紧张' : '松了口气');
  } else if (seg.id === 'evening') {
    stress = Math.max(0.05, 0.30 - 0.18 * ((minute - seg.a) / (seg.b - seg.a)));
    mood = stress > 0.20 ? '疲惫' : '平静';
  }
  stress = Math.min(1, Math.max(0, stress));

  // 在路上：给的是「从哪到哪」，位置由渲染层沿街网推进，不是直接落点
  const travel = seg.travel || null;
  const fromKey = travel ? (travel[0] === 'work' ? workKey : who.home) : placeKey;
  const fromSpot = travel ? placeSpot(key, fromKey) : spot;

  // 【巡游】露天工种在上班时段不能站成一根柱子：工地工人要在场地里走动，
  // 骑手要一直在街上跑单。范围按工种给，速度也按工种（骑手骑车 4.5 m/s）。
  const wander = (seg.id === 'am' || seg.id === 'pm') && OUTDOOR_JOBS.has(key);

  return {
    key, name: who.name, segment: seg.id, label: seg.label,
    wander,
    // 工地锚点在街区内部，半径给 26 m 时附近一个路网节点都挑不到（实测原地不动），
    // 放到 70 m 才能走到工地外围那圈街
    wanderR: key === 'rider' ? 300 : 70,
    wanderSpeed: key === 'rider' ? 4.5 : 1.15,
    activity: seg.act, clip: seg.clip, mood, stress,
    place: placeKey, placeName: P[2],
    // stay 用 spot；travel 用 from（起点），渲染层自己算中间位置
    x: travel ? fromSpot.x : spot.x, z: travel ? fromSpot.z : spot.z,
    mode: travel ? 'travel' : 'stay',
    fromPlace: fromKey, toPlace: placeKey,
    segStart: seg.a, segEnd: seg.b,
    // 有车的人通勤/返家开车：速度快、淋不到雨、不能打伞、水深处会弃车
    travelByCar: !!who.car && !!travel,
    // 室内判据：夜里在家、上班在楼里都收起模型；但**室外工种不进屋** ——
    // 工地工人和骑手 08:00–17:00 本来就在露天，把他们收进楼反而假。
    inBuilding: (!!seg.inBuilding || (!!seg.indoor && !OUTDOOR_JOBS.has(key))),
    reason: travel
      ? (seg.id === 'return'
        ? (depth > 0.15 ? '路上还有积水，挑高处走，边走边看水位' : '水退了，绕远路回家，情绪慢慢平复')
        : '按日常路线上班，还不知道傍晚会下暴雨')
      : seg.id === 'night' ? '夜里没有预警，正常休息'
        : seg.id === 'preRain' ? '外面开始下雨了，收东西准备走'
          : '日常作息，没有异常',
  };
}

/** 暴雨窗口？窗口内 story / Brain 接管，日程层让位。 */
export function inCrisis(minute) {
  return minute >= STORY_DAY_START && minute <= STORY_DAY_END;
}

/**
 * 24 个随机行人的全天状态：夜间街上几乎没人、白天满员、暴雨时全员上街避险、
 * 退水后逐渐回家。给 HUD 显示「人群此刻在做什么」。
 */
export function crowdState(minute) {
  const seg = daySegment(minute);
  const table = {
    night:   { count: 4,  label: '大多在家休息，街上只有夜班行人', mood: '平静', clip: 'walk' },
    morning: { count: 18, label: '早高峰通勤',                    mood: '平静', clip: 'walk' },
    am:      { count: 24, label: '街上正常人流',                  mood: '平静', clip: 'walk' },
    lunch:   { count: 24, label: '午间人流',                      mood: '放松', clip: 'walk' },
    pm:      { count: 24, label: '下午人流',                      mood: '平静', clip: 'walk' },
    preRain: { count: 24, label: '起雨：有人开始找地方避',          mood: '警觉', clip: 'walk' },
    crisis:  { count: 24, label: '暴雨：遇水避险、找高处避雨',      mood: '紧张', clip: 'run' },
    postRain:{ count: 24, label: '雨未停：继续避险 / 涉水',         mood: '焦虑', clip: 'run' },
    return:  { count: 16, label: '水未退净，陆续绕路回家',          mood: '焦虑', clip: 'walk' },
    evening: { count: 8,  label: '街上人渐渐少了',                  mood: '疲惫', clip: 'walk' },
  };
  return { ...(table[seg.id] || table.am), segment: seg.id, dayLabel: seg.label };
}
