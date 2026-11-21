/**
 * 个体行为追溯（具体某人逐分钟的「感知 → 判断 → 动作 → 状态」）。
 *
 * 为什么有这个文件：导师点评要求「定位某个受困/溺亡者，复现其完整过程，
 * 而不是只能看随机个体」。之前的输出都是聚合数（多少死、多少困），
 * 一旦数字和直觉不符，没有任何人能指出是哪一步判错了。
 *
 * 用法：
 *   ?trace=<人序号>        —— 页面上只追这一个人
 *   SIM_TRACE=<人序号>     —— sim-day.mjs 跑完后把 trace 写成 JSON
 *
 * 设计约束（三条，都是为了"别拖慢仿真"）：
 *   1. 只有被追的那一个人写记录，其他人零开销（traceWanted 退化成一次比较）。
 *   2. 逐分钟去重：同一分钟只留第一条 tick，避免 60 fps 刷爆内存。
 *   3. 硬上限 MAX_RECORDS，到顶就停写并置 truncated 标记 —— 宁可数据不全，
 *      也不要因为追溯把整轮仿真拖崩（11-20 那次"无声停住"就是这么来的）。
 */

const QS = (typeof location !== 'undefined' && location.search)
  ? new URLSearchParams(location.search) : new URLSearchParams();

const raw = QS.get('trace');
const TARGET = (raw === null || raw === '' || raw === 'off') ? -1 : Number(raw);
const MAX_RECORDS = 40000;

const buf = [];
let identity = null;
let truncated = false;
let lastTickMinute = null;
let lastJudgeT = null;
let lastJudgeKey = '';

export const TRACE_ON = Number.isFinite(TARGET) && TARGET >= 0;
export const TRACE_ID = TARGET;

export function traceWanted(i) {
  return TRACE_ON && Number(i) === TARGET;
}
export function traceHasIdentity() { return identity !== null; }
export function traceTruncated() { return truncated; }

function push(kind, o) {
  if (buf.length >= MAX_RECORDS) { truncated = true; return; }
  buf.push({ t: o.t ?? null, k: kind, ...o });
}

/** 被追的人是谁：ACS 属性 + 行为原型。只在第一帧写一次。 */
export function traceIdentity(o) {
  if (!TRACE_ON || identity) return;
  identity = { ...o };
  push('identity', { t: o.t ?? null, ...o });
}

/** 逐分钟位置/水深/所在（帧级调用，内部按分钟去重）。 */
export function traceTick(o) {
  if (!TRACE_ON) return;
  const t = Number(o.t);
  if (!Number.isFinite(t)) return;
  // 注意：NOW_MIN() 返回的是**小数分钟**（帧间隔 1/60 分），直接比较等于每帧都不同，
  // 一天下来几万条 tick 会把 buffer 挤满、把真正要紧的 judge/死亡事件挤出去。
  // 这里按整分钟去重（同一分钟只留第一帧），实跑验证：240 分钟 → 240 条。
  const m = Math.floor(t);
  if (lastTickMinute === m) return;
  lastTickMinute = m;
  push('tick', o);
}

/** 一次决策：五道门读了什么、乘出多少概率、最后走了哪个动作。
 *
 * 判断是每秒级别的（微行为状态机在跑），一天下来一个人上万条，
 * 全记 4 万条上限两下就满了 —— 满了以后真正要紧的死亡事件反而写不进去。
 * 所以只在「结论变了」或「满 5 分钟」时留一条：结论变 = 有信息的事件，
 * 满 5 分钟 = 抽样背景，两者合起来足够复现，又不至于把 buffer 挤爆。
 */
export function traceJudge(o) {
  if (!TRACE_ON) return;
  const t = Number(o.t);
  const key = `${o.protect}|${o.action}|${Math.round(Number(o.probability || 0) * 20)}`;
  const dueForSample = !Number.isFinite(t) || lastJudgeT === null || (t - lastJudgeT) >= 5;
  if (!dueForSample && key === lastJudgeKey) return;
  lastJudgeT = Number.isFinite(t) ? t : lastJudgeT;
  lastJudgeKey = key;
  push('judge', o);
}

/** 状态跃迁：见水 / 被困 / 受伤 / 死亡 / 上车 / 进屋。 */
export function traceEvent(kind, o) {
  if (!TRACE_ON) return;
  push(kind, o);
}

export function traceDump() {
  return {
    ok: TRACE_ON,
    target: TARGET,
    identity,
    records: buf.length,
    truncated,
    events: buf.slice(),
  };
}

export function traceReset() {
  buf.length = 0;
  identity = null;
  truncated = false;
  lastTickMinute = null;
}