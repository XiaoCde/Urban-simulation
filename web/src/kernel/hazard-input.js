/**
 * hazard-input.js — 灾害只作为「输入」。
 *
 * 录音里导师 16:29–18:28 那条：现在这套规则是纯为内涝写的，换成爆炸、
 * 地震又得另写一套；人是一样的，只是事件输入不同。这个文件就是把
 * 「事件」收成一组字段，人的画像、认知、决策流程一行都不改。
 *
 * 换灾种 = 换一组输入值，不换决策规则。当前实现的是内涝输入，
 * 字段里留了通用位（危险等级、预警、可通行性、同伴状态），
 * 别的灾种只要按同样的字段给数就能跑同一套 choice-model。
 *
 * 危险等级不用「前方水深几厘米」直接打分，改用有出处的工程分级：
 *   HR = d × (v + 0.5) + DF      DEFRA / Environment Agency (2006) FD2321/TR2
 *   D·V 失稳阈值                 Australian Rainfall & Runoff Project 10 Stage 1 (Cox et al. 2010)
 * 这些是**失稳／危险分级，不是死亡判定**。「失稳 → 伤亡」的定量函数
 * 三轮检索都没有找到，仍然标「目前自己定的」，见 docs/依据台账.md。
 */
import { HAZARD_THRESHOLDS } from './params.js';
import { warningReachedBy, mobilisedBy } from './choice-model.js';
import { FD2321_DEBRIS_FACTOR } from './evidence-tables.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * 碎屑因子 DF：DEFRA / Environment Agency (2008) 补充说明，
 * FD2321/TR1 Table 3.1 的「Urban（城市地表）」列。
 * 之前一律取 0 是项目自己定的；现在按实测工程表取：
 *   水深 ≤0.25 m → 0；0.25–0.75 m → 1；>0.75 m 或流速 >2 m/s → 1。
 * 注意 FD2320/TR2 的取法不同（≤0.25 m 取 0.5、>0.25 m 取 1.0），两套别混。
 */
export function debrisFactorOf(depthM, velocityMs = 0) {
  const d = Math.max(0, Number(depthM) || 0);
  const v = Math.max(0, Number(velocityMs) || 0);
  if (d > 0.75 || v > 2) return 1;
  for (const step of FD2321_DEBRIS_FACTOR.urban) {
    if (d <= step.maxDepthM) return step.df;
  }
  return 1;
}

/**
 * 由水深和流速算 HR 连续值：HR = d × (v + 0.5) + DF，
 * DEFRA / Environment Agency (2006) FD2321/TR2（规划口径 FD2320）。
 * 速度没有实测流场时用 0（静水保守下限），这个「取 0」是目前自己定的近似。
 */
export function hazardRatingValue(depthM, velocityMs = 0, debrisFactor = 0) {
  const d = Number(depthM), v = Number(velocityMs), df = Number(debrisFactor);
  // 非有限输入不能进比较链：NaN 参与 >= 会全为 false，把危险静默判成安全。
  // 这里显式退回 0（无危险）而不是让 NaN 继续传播，调用方仍可从返回值看出是 0。
  if (!Number.isFinite(d) || !Number.isFinite(v) || !Number.isFinite(df)) return 0;
  return clamp(d * (v + 0.5) + df, 0, 20);
}

/**
 * HR 分级。第四轮 QB2 把界值归属查清了：
 *   FD2321 Table 3.2：0.75 Low / 1.25 Moderate / 2.5 Significant / >2.5 Extreme；
 *   FD2320 出于预防把「danger for all」从 2.5 下调到 2.0。
 * 本项目用的是 0.75 / 1.25 / **2.0**，所以属于 FD2320 规划口径，
 * 不是 FD2321 原文值。两套不能混着引用。
 */
export function hazardRating(depthM, velocityMs = 0, debrisFactor = 0) {
  const hr = hazardRatingValue(depthM, velocityMs, debrisFactor);
  const t = HAZARD_THRESHOLDS.hazardRating.value;
  if (hr >= t.extreme) return 'extreme';
  if (hr >= t.significant) return 'moderate';
  if (hr >= t.moderate) return 'low';
  return 'none';
}

/**
 * 把水深映射成 Borowski 2023 Table 4 的 low / moderate / extreme 三档。
 *
 * 【为什么不用 HR 分级】DEFRA 的 HR = d×(v+0.5)+DF 需要流速 v，
 * 本项目离线烘焙的帧序列只存了水深，没有流速场；取 v=0 时 34 cm 水
 * 只算到 HR=0.17，连 moderate 都不到，明显低估。与其拿一个假流速去算，
 * 不如用 Thieken 2023 Table S1 印刷的 1–7 水深有序编码（实测问卷分级）。
 *
 * 【目前自己定的】「编码几级 → 论文哪一档威胁」的对应，原文没有给，
 * 这是工程映射，写进 docs/依据台账.md 并做敏感性分析。
 * HR 值仍按公式算出来供参考，但不用来定威胁档。
 */
export function threatLevelOf(depthM, velocityMs = 0, debrisFactor = 0) {
  void velocityMs; void debrisFactor;
  const grade = waterDepthOrdinal(depthM);
  if (grade >= 5) return 'extreme';   // >1 m
  if (grade >= 3) return 'moderate';  // 有可见积水到 1 m
  return 'low';
}

/** Thieken 2023 Table S1 印刷的水深有序编码，1 无水 / 3 ≤0.5m / 4 >0.5–1m / 5 >1–2m / 6 >2–4m / 7 >4m。 */
function waterDepthOrdinal(depthM) {
  const d = Math.max(0, Number(depthM) || 0);
  if (d === 0) return 1;
  if (d <= 0.5) return 3;
  if (d <= 1.0) return 4;
  if (d <= 2.0) return 5;
  if (d <= 4.0) return 6;
  return 7;
}

/** 行人是否失稳：ARR Project 10 的 D·V 分级，不是死亡判定。 */
export function instability(depthM, velocityMs = 0, isChild = false) {
  const t = HAZARD_THRESHOLDS.humanInstabilityDV.value;
  const d = Number(depthM), v = Number(velocityMs);
  const dv = (Number.isFinite(d) && Number.isFinite(v)) ? d * v : 0;
  const limit = isChild ? t.childLow : t.adultLow;
  const maxDepth = isChild ? t.childMaxDepthM : t.adultMaxDepthM;
  return {
    dv,
    limit,
    unstable: Number.isFinite(d) && (dv > limit || d > maxDepth),
    kind: '失稳（不是伤亡判定）',
    source: HAZARD_THRESHOLDS.humanInstabilityDV.source.report,
  };
}

/**
 * 涉水步速，来自中科大静水受控实验（不是真实街头内涝）。
 * 水深 0 / 0.35 / 0.60 / 0.90 m 的自由流速度，中间线性插值。
 */
export function wadingSpeed(depthM) {
  const table = HAZARD_THRESHOLDS.wadingFreeSpeed.value;
  const keys = [0, 0.35, 0.60, 0.90];
  // 【修 2026-11-17】表键印的是 '0.60'/'0.90'，而 String(0.60) 是 '0.6'、
  // String(0.90) 是 '0.9'。原先直接拿 String(keys[i]) 取键，水深一过 0.35 m
  // 就取到 undefined，插值变 NaN。这里显式写键名，不再靠浮点转字符串。
  const labels = ['0', '0.35', '0.60', '0.90'];
  const raw = Number(depthM);
  const d = clamp(Number.isFinite(raw) ? raw : 0, 0, 0.90);
  for (let i = 0; i < keys.length - 1; i++) {
    if (d <= keys[i + 1]) {
      const f = (d - keys[i]) / (keys[i + 1] - keys[i]);
      const v0 = Number(table[labels[i]]), v1 = Number(table[labels[i + 1]]);
      if (!Number.isFinite(v0) || !Number.isFinite(v1)) return 0;
      return v0 * (1 - f) + v1 * f;
    }
  }
  const last = Number(table[labels[labels.length - 1]]);
  return Number.isFinite(last) ? last : 0;
}

/**
 * 组装一次判断的输入。字段与灾种无关，决策模型只读这些字段。
 * @param {object} raw 场景给出的原始观测量
 */
export function buildHazardInput(raw = {}) {
  // 【修 2026-11-17】默认参数不覆盖显式传入的 null；且 clamp 不拦 NaN，
  // 一个 NaN 水深会顺着 threat / HR / 步速 / 失稳一路污染整包输入。
  const q = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d) => {
    if (v === null || v === undefined) return d;
    const x = Number(v);
    return Number.isFinite(x) ? x : d;
  };
  const depthM = clamp(num(q.depthM, 0), 0, 10);
  const velocityMs = clamp(num(q.velocityMs, 0), 0, 10);
  // 没显式给 DF 时按 FD2321/TR1 Table 3.1 城市地表列取，不再一律取 0。
  const debrisFactor = clamp(num(q.debrisFactor, debrisFactorOf(depthM, velocityMs)), 0, 3);
  const minutesSinceWarning = Math.max(0, num(q.minutesSinceWarning, 0));
  const warningReached = q.officialWarning ?? warningReachedBy(minutesSinceWarning);
  return {
    // ---- 通用字段（换灾种不改）----
    threat: threatLevelOf(depthM, velocityMs, debrisFactor),
    hazardRating: hazardRating(depthM, velocityMs, debrisFactor),
    // HR 连续值，供选择层做「危险暴露」的连续权重，不是阈值开关。
    hazardRatingValue: hazardRatingValue(depthM, velocityMs, debrisFactor),
    hazardRatingExtremeBound: HAZARD_THRESHOLDS.hazardRating.value.extreme,
    officialWarning: !!warningReached,
    warningInformation: clamp(num(q.warningInformation, 0), 0, 4),
    surprise: clamp(num(q.surprise, 0), 0, 1),
    floodImpact: clamp(num(q.floodImpact, 0), 0, 1),
    peersStay: clamp(num(q.peersStay, 0), 0, 1),
    peersRide: clamp(num(q.peersRide, 0), 0, 1),
    priorFloods: clamp(num(q.priorFloods, 0), 0, 4),
    age: num(q.age, 48),
    female: !!q.female,
    // ---- 内涝专属输入（换灾种时由别的输入层提供同名位）----
    waterDepthM: depthM,
    velocityMs,
    debrisFactor,
    minutesSinceWarning,
    // ---- 给路径执行层的量，有实测出处 ----
    walkSpeedMs: wadingSpeed(depthM),
    instability: instability(depthM, velocityMs, q.age != null && Number(q.age) < 13),
    // ---- 动员时间曲线（Silva 2025）----
    warningReachedProbability: warningReachedBy(minutesSinceWarning),
    mobilisedProbability: mobilisedBy(minutesSinceWarning),
  };
}

export const HAZARD_INPUT_META = {
  layers: '输入层只提供观测量，人的画像／认知／决策在 kernel/choice-model.js 与 population.js，换灾种不改',
  sources: [
    HAZARD_THRESHOLDS.hazardRating.source.report,
    HAZARD_THRESHOLDS.humanInstabilityDV.source.report,
    HAZARD_THRESHOLDS.wadingFreeSpeed.source.article,
    FD2321_DEBRIS_FACTOR.source,
  ],
  selfSet: [
    '没有实测流场时流速取 0（静水保守下限）',
    '预警到达时间用 Silva 2025 的 Rayleigh 结构，(S1) 中 Ct 项位置原文 PDF 残损未核实',
    'Thieken Table S1 水深等级 → Borowski 威胁档的对应，原文没有给（QA2 确认威胁等级从未对应水深）',
  ],
  measuredNow: ['碎屑因子 DF 改按 FD2321/TR1 Table 3.1 城市列取，不再取 0'],
};
