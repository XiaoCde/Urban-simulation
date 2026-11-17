/**
 * cohort.js — 判断内核的接口层。
 *
 * 【2026-11-15 整套换掉】旧版这里是手写线性打分：
 *   继续 = 1.55 + 进度×0.35 − 前方水深×0.8 …
 * 七个动作各有一条自设公式，再加「威胁超过 0.12 才放开绕路池」的二元门控，
 * 最后 softmax 抽样。导师在录音 14:39 逐条念了这些系数并问「为什么是 1.55」，
 * 15:22 明确否掉「把这些系数换成实测数」这个方向 —— 问题不是数字准不准，
 * 是人不按这种精确打分做决定。01:41 还点名了二元触发式建模。
 * 现在整套弃用，旧实现只归档，运行时不留双实现。
 *
 * 【现在的形式】离散选择，见 kernel/choice-model.js：
 *   认知层  Thieken 2023 补充材料 Table S2 有序 logit（情境知识）
 *   行动层  Thieken 2023 补充材料 Table S3 有序 logit（保护行为，含水深 −0.28）
 *   选择层  Borowski & Stathopoulos 2023 Table 4 二元随机参数 logit
 *            （继续日常 / 启动保护行动；同伴效应随危险等级衰减）
 *   时间层  Silva 2025 补充材料 Table S2（预警扩散与动员，跨灾种）
 * 输出是「要不要启动保护性行动」的概率，抽样决定，没有阈值门控。
 *
 * 【细动作降级为路径执行】决定启动保护之后，具体是等一下、换条街、掉头
 * 还是放弃今天这件事，由当时的真实几何与状态决定（前方水深、是否被挡、
 * 卡住多久、迟到多久），不再是一个行为决策模型。这一层是工程规则，
 * 在 docs/依据台账.md 标为「目前自己定的」，不当行为结论报出去。
 *
 * makeKernel 保留旧的字段名只为不破坏 live-agent / ped 的读取，
 * 其中 wade / detour / urgency / temp / wait 已不参与决策概率，
 * 只作执行层兼容参数，全部数值仍是「目前自己定的」。
 */
import { STATUS_BASE, statusOf } from './roles.js';
import { bandOf } from './citizen.js';
import { WALK } from './motion-units.js';
import { mulberry32 } from './decision.js';
import { buildHazardInput } from './kernel/hazard-input.js';
import { decideProtectiveAction, waterDepthOrdinalOf } from './kernel/choice-model.js';
import { attributesFromSim } from './kernel/attributes.js';
import { BOROWSKI_DESIGN } from './kernel/evidence-tables.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const ACTIONS = ['continue', 'slow', 'hurry', 'wait', 'detour', 'turnback', 'abandon'];

/**
 * 造一个人的执行层参数。确定性：同一 seed+i 永远得到同一组值。
 * 【注意】这里不再产生任何行为决策系数；下列数值只用于步速、视野、
 * 思考间隔等执行层量，官方依据见各字段注释，均在台账登记为「目前自己定的」。
 */
export function makeKernel(i, person, rnd = mulberry32(20261111 + i * 7919), circle = null) {
  const c = person && person.citizen ? person.citizen : null;
  const real = (person && person.real) || (c && c.real) || null;
  const role = (person && person.role) || '服务业';
  const status = statusOf(role);
  const b = STATUS_BASE[status] || STATUS_BASE['服务业'];
  const band = c ? (c.ageBand || (c.ageGroup === 'child' ? 'child'
    : c.ageGroup === 'elderly' ? 'old' : 'prime')) : 'prime';
  const B = bandOf(band);
  const exp = c ? c.experience : 0.5;
  const hz = (c && c.hazard) ? c.hazard : null;

  const k = {
    id: `${status}/${band}`, status, band, role,
    age: real ? real.age : (c ? c.age : 48),
    female: real ? real.sex === '2' : false,
    socCode: real ? real.socCode : 'NA',
    householdHasMinor: real ? real.hasMinor : false,
    householdVehicles: real ? real.householdVehicles : 0,
    // 灾害履历：既往洪水次数是离散选择模型的先验，来自 hazard.js。
    priorFloods: hz ? clamp(Math.round((hz.runs || 0) + (hz.score || 0)), 0, 4) : 0,
    trained: !!(hz && hz.trained),
    hazard: hz ? hz.score : 0,
    hazardTier: hz ? hz.tier : 'naive',
    // 以下 5 个字段只作兼容读取，不进决策概率。
    wade: b.wade, detour: b.detour, wait: b.wait,
    urgency: b.urgency, temp: b.temp,
    oldSlow: band === 'old' || band === 'oldest' || band === 'senior',
    tiny: band === 'preschool',
    hasCar: circle ? !!circle.hasCar : rnd() < b.car,
    think: clamp(b.think + (1 - B.walk) * 0.30 + (rnd() - 0.5) * 0.2, 0.5, 1.05),
    speed: clamp(b.speed * B.walk * (0.95 + rnd() * 0.1), WALK.MIN, WALK.KERNEL_MAX),
    sightM: clamp((c ? c.sightM : 40) + (hz ? (hz.sightBonus || 0) : 0), 18, 76),
  };
  if (circle) {
    k.circleId = circle.id;
    k.circleLabel = circle.label;
    k.circleDistrict = circle.district;
    k.info = circle.info;
    k.conformity = circle.conformity;
    k.hasCar = !!circle.hasCar;
  }
  return k;
}

/**
 * 【路径执行层，目前自己定的】决定启动保护行动之后，按真实几何与状态
 * 选一个具体动作。这里没有打分、没有效用、没有系数，只有工程判断：
 * 走不通就换街或掉头，被挡就等，严重迟到且走不下去才放弃。
 */
function executionAction(k, s, pool) {
  const allowed = new Set(pool || ACTIONS);
  const depthAhead = s.depthAhead || 0;
  // 0.30 m 是路径执行层的可通行门槛。第六轮回件 条8 给了实测来源：
  //  · 国土交通省「地下空間における浸水対策ガイドライン」§1.5 把浸水走廊/居室的
  //    行动限界水深定为 30 cm（依据步行困难水深 + 水压致门无法打开的水深）；
  //  · 石垣ほか 2005（土木学会第60回年次学術講演会 CS7-010，实物大楼梯实验，
  //    n=49）问卷中，判断「越流水深 30 cm 为实际避难限界」的人最多。
  // 【限制】这两项都是楼梯／地下空间实验，开阔街道可以绕、可以扶，通常更宽松；
  // 用 30 cm 在街道上是偏保守的一侧。这是「愿不愿意走」的工程门槛，
  // 不是「站不站得住」——后者在 kernel/hazard-input.js 按失稳分级算。
  const over = Math.max(0, depthAhead - 0.30);
  const blocked = !!s.blocked;
  const stuck = s.stuck || 0;
  const overdue = s.overdue || 0;
  const want = [];

  if (blocked || (depthAhead > 0.04 && over > 0)) {
    if (allowed.has('detour') && !s.detourCd) want.push('detour');
    if (allowed.has('turnback') && !s.detourCd && stuck > 6) want.push('turnback');
    if (allowed.has('wait') && !s.waitCd) want.push('wait');
  }
  if (overdue > 0.35 && (blocked || stuck > 8) && allowed.has('abandon') && !s.abandonCd) {
    want.push('abandon');
  }
  if (allowed.has('wait') && !s.waitCd && (s.rain > 15 || depthAhead > 0.02)) want.push('wait');
  for (const a of want) if (allowed.has(a)) return a;
  if (allowed.has('wait')) return 'wait';
  if (allowed.has('detour')) return 'detour';
  return allowed.values().next().value || 'continue';
}

/** 未启动保护行动时的执行层动作：继续、放慢、加快，由真实状态决定。 */
function routineAction(k, s, pool) {
  const allowed = new Set(pool || ACTIONS);
  if (s.late && allowed.has('hurry') && s.depthAhead < 0.05) return 'hurry';
  const wading = s.depthAhead > 0.01;
  if ((wading || s.rain > 6 || s.fatigue > 0.75) && allowed.has('slow')) return 'slow';
  if (allowed.has('continue')) return 'continue';
  if (allowed.has('slow')) return 'slow';
  return allowed.values().next().value || 'continue';
}

/**
 * 一次判断：把当前状态收成灾害输入，交给离散选择模型，
 * 抽样决定「继续日常 / 启动保护行动」，再落到具体执行动作。
 *
 * 返回结构保持旧版一致：{ action, score, reason }；
 * score 不再是自设分数，而是这次概率的分解，供验收与 HUD 追溯。
 */
export function judge(k, s, rnd, restrict = null, forceProtect = null) {
  const pool = restrict || ACTIONS;
  // 同伴比例是 Borowski 2023 实测系数的输入。第四轮 QA9 拿到了公开定义：
  // 论文里的比例是受访者「自我中心社会网络中最多 5 人」的选择比例，
  // 不是空间半径里的人数。仿真目前还没把这个网络统计接进来，
  // 所以从 s 读，读不到就显式给 0，绝不编一个比例。
  // 输入通道已经打开，个案回放阶段接上统计后直接传 s.peersStay / s.peersRide 即可。
  // 上限按 Borowski 2023 Table 3 实验设计范围截断（同伴留下 0–0.8、搭车 0–1），
  // 不按 0–1 外推。仿真目前还没有把社会网络统计接进来，所以实际取到的是 0。
  const peersStay = clamp(Number(s.peersStay) || 0,
    BOROWSKI_DESIGN.peerFractionStay.min, BOROWSKI_DESIGN.peerFractionStay.max);
  const peersRide = clamp(Number(s.peersRide) || 0,
    BOROWSKI_DESIGN.peerFractionRide.min, BOROWSKI_DESIGN.peerFractionRide.max);
  const hazard = buildHazardInput({
    depthM: Math.max(s.depthAhead || 0, s.depthHere || 0),
    velocityMs: 0,
    // 碎屑因子不显式给 0：由 hazard-input 按 FD2321 Table 3.1 城市列取。
    officialWarning: !!s.officialWarning,
    warningInformation: s.warningInformation || 0,
    surprise: clamp(s.surprise ?? (s.farDepth > s.depthAhead + 0.08 ? 0.6 : 0.1), 0, 1),
    floodImpact: clamp(s.floodImpact ?? (s.depthAhead || 0), 0, 1),
    peersStay,
    peersRide,
    priorFloods: k.priorFloods,
    age: k.age,
    female: k.female,
    minutesSinceWarning: s.minutesSinceWarning || 0,
  });

  // 路径属性：米→英里、秒→分钟、绕路→美元（按实测 32.78 美元/英里），
  // 再按 Borowski 2023 Table 3 的实验设计范围归一化。
  // 旧的 0.001 / 0.01 自设缩放已删除，换算与出处在 kernel/attributes.js。
  const attrs = attributesFromSim(s);
  const input = {
    ...hazard,
    cost: attrs.cost,
    travelTime: attrs.travelTime,
    waitTime: attrs.waitTime,
    walkDistance: attrs.walkDistance,
    waterDepthM: hazard.waterDepthM,
    hazardRatingValue: hazard.hazardRatingValue,
    hazardRatingExtremeBound: hazard.hazardRatingExtremeBound,
    // 敏感性分析用：允许注入缩放后的实测动员点，正常运行时不传。
    mobilisationPoints: s.mobilisationPoints,
  };
  const choice = decideProtectiveAction(input, rnd);
  // 【2026-11-16 决策分层】离散选择模型本身不变（实测系数、抽样方式原样跑）。
  // 这里只加一个可选的「沿用上次保护决定」覆盖：情境签名没变时，live-agent
  // 把上一次的 protect 传进来，不重新抽——这才是文献里「一次决定后锁定，
  // 出新情况才重估」的做法。forceProtect=null 时完全等同旧行为，验收不变。
  const protect = (forceProtect === true || forceProtect === false)
    ? forceProtect : choice.protect;
  const action = protect
    ? executionAction(k, s, pool)
    : routineAction(k, s, pool);

  const score = {
    protectiveActionProbability: +choice.probability.toFixed(4),
    logitUtility: +choice.utility.toFixed(4),
    knowledgeLinearPredictor: +choice.knowledge.toFixed(4),
    actionLinearPredictor: +choice.actionScore.toFixed(4),
    waterDepthOrdinal: waterDepthOrdinalOf(hazard.waterDepthM),
    threat: choice.components.threat,
    priorFloods: choice.components.priorFloods,
    peersStay: +choice.components.peersStay.toFixed(3),
  };

  return {
    action,
    score,
    choice,
    // 实际生效的保护决定（可能被 forceProtect 覆盖），供决策层锁定保存。
    protectHeld: protect,
    reason: explain(action, k, s, choice),
  };
}

/** 把结果翻译成一句人话：说的是这一刻真正起作用的那个因素。 */
function explain(action, k, s, choice) {
  const cm = (v) => `${Math.round(v * 100)}cm`;
  const p = Math.round(choice.probability * 100);
  const base = `保护行动概率 ${p}%（水深编码 ${choice.components.waterDepthOrdinal} 级`
    + `、危险 ${choice.components.threat}、既往洪水 ${choice.components.priorFloods} 次）`;
  switch (action) {
    case 'continue': return `${base}，继续按原计划走`;
    case 'slow': return `${base}，脚下 ${cm(s.depthHere)} 有水，放慢脚步`;
    case 'hurry': return `${base}，快到点了，加快脚步`;
    case 'wait': return `${base}，${s.blocked ? '前面被挡住了' : '先等一下水情'}，等 ${s.waitSec.toFixed(1)} 秒`;
    case 'detour': return `${base}，前方 ${cm(s.depthAhead)} 水走不过去，换一条街`;
    case 'turnback': return `${base}，这条路卡住了，掉头绕开`;
    case 'abandon': return `${base}，${s.goalLabel || '这件事'}今天算了`;
    default: return base;
  }
}
