/**
 * incidents.js — 真实状态驱动的伤亡 / 被困 / 事故台账。
 *
 * 【2026-11-13 用户要求】「今天把那个呃就是多少人困死了，多少人这个多少人
 *  这个发生事情了，这些都给写好」。
 *
 * 这里**没有任何预写数字**。每一个「被困 / 受伤 / 困死 / 避险成功 / 车辆熄火」
 * 都是逐子步读真实状态判出来的：当前位置的水深、实际位移速度、是否在室内、
 * 是否在车里、体力、年龄带、雨强、有没有伞、熄火后熬了多久。
 * 每条都留 minute / 坐标 / 水深 / 原因，可逐人回查，不靠事后编故事。
 *
 * 状态机（不可逆，除非 reset 拖时间轴）：
 *   safe → wading → stranded → injured → dead
 *   safe → evacuated（进避难所 / 到家且水退）
 *   车内：driving → stalled → abandonedCar（弃车转步行） / dead（困死车内）
 */
import { RISK, CAR } from './motion-units.js';
import { MEASURED, SELF_SET, instabilityDepthFor, exposureSecFor } from './kernel/thresholds.js';
// 【2026-11-16 阶段3】楼层淹没判据：室内人按所在楼层是否被淹决定安危。
import { floodFloor, floorElevationM, submergenceThresholdM, limitedMobilityByAge, BASEMENT }
  from './kernel/floors.js';
// 【2026-11-16 第六轮】室内顶层被淹的致死概率改用 Jonkman 实测函数
// （博士论文 §7.4 Eq.7-6 / 7-7），不再用自设耐受时长。见 kernel/fatality.js。
import { jonkmanFatality, fatalRiskPerSecond, personalThreshold } from './kernel/fatality.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * 【2026-11-15 已换掉 9 档自设致死水深】
 * 旧版按 9 个年龄带各写一个 lethal（62 / 66 / 115 cm）和耐受秒数，
 * 三轮检索明确答复没有一手依据。现在：
 *   · 暴露起点用 ARR Project 10 的失稳最大深度：成人 1.2 m / 儿童 0.5 m
 *     （这是「失稳」分级，不是死亡判定）；
 *   · 「失稳 → 伤亡」的定量函数文献没有，暴露时长仍是【目前自己定的】，
 *     集中在 SELF_SET.casualty，必须做敏感性分析；
 *   · 由这里算出的伤亡数是**模型输出，不是实测**，不许当结论报出去。
 * 年龄由真实 ACS 记录给出，不再按 9 档标签猜。
 */
function vulnerabilityOf(age, band) {
  const a = Number.isFinite(age) ? age : (band === 'preschool' || band === 'child' ? 8 : 40);
  return {
    instabilityDepth: instabilityDepthFor(a),   // 实测（ARR）
    exposureSec: exposureSecFor(a),             // 目前自己定的
    slip: SELF_SET.slipProbability,             // 目前自己定的
    isChild: a < 13,
  };
}

const blank = (i) => ({
  i, status: 'safe', cause: '', minute: 0, x: 0, z: 0, depth: 0,
  deepSec: 0, stillSec: 0, wadeSec: 0, shelterSec: 0, stalledSec: 0,
  inCar: false, everWaded: false, everStranded: false, everEvacuated: false,
  everInjured: false, slipRolled: false, events: [],
  // 【阶段3】室内楼层：effFloor 是当前实际所在层（水位上涨时会往上转移），
  // floorMoveT 记上次转移时刻，避免每子步重复记事件。
  effFloor: 0, floorMoveT: -1e9,
  // 【第六轮】室内顶层被淹时的死亡风险累积（Jonkman 2007 Eq.7-7 / 7-6）。
  // floodRisk 是累计风险，personalThreshold 是这人的固定耐受阈值；
  // lastDepth / riseRate 用来算涨水率（m/hr），判断落在哪个区。
  floodRisk: 0, lastDepth: null, riseRate: 0, floorFd: 0, floorFdZone: '',
  // 【2026-11-17】地下室：在地下时不受楼层保护，按涉水暴露判，死因单列。
  inBasement: false, everWentBasement: false,
  // 弃车时刻：下车后头两分钟按"站不住"处理（见 tick 的 C 段）。
  carExitMin: null,
  // 个案回放：每人只留最近 60 秒的短轨迹；出事后才升级成完整链。
  // 未出事的人不占全天逐帧内存。
  trace: null, recent: [], traceSec: 0,
});

/**
 * 逐帧记录当时的真实状态，不是事后补的剧情：位置、水深、速度、状态、
 * 室内外、是否在车里、体力、雨强，以及这一刻快层判断给出的动作与理由。
 * 采样间隔 2 仿真秒（人、水、判断共用同一子步，不额外造时间层）。
 */
const TRACE_STEP_SEC = 2;
const RECENT_MAX = 30;           // 60 秒短轨迹
const TRACE_MAX_FRAMES = 3600;   // 过程最多 2 小时（24h × 2s 采样足够覆盖涉水全过程）
/**
 * 这些事件一出现，这个人就进入「可回放个案」，短轨迹升级为完整链。
 * wading（第一次踩进水）也算：导师要的是「从哪一步走到出事」，
 * 不是只看出事那一分钟。避险 / 脱困同样是过程的终点。
 */
const CASE_TYPES = new Set([
  'wading', 'stranded', 'injured', 'dead', 'rescued', 'evacuated',
  'stalled', 'abandonedCar', 'collision', 'slip',
]);

/**
 * @param {object} o
 *  peds      行人数组
 *  depthAt   (x,z,minute)=>水深 m
 *  clock     CLOCK
 *  circles   圈层数组（分组统计用）
 *  crowd     crowd-life（取年龄带）
 */
export function createIncidents(o = {}) {
  const { peds = [], depthAt = null, clock = null, circles = [], crowd = null } = o;
  const rows = peds.map((_, i) => blank(i));
  let log = [];
  const stat = {
    safe: 0, wading: 0, stranded: 0, injured: 0, dead: 0, evacuated: 0,
    stalled: 0, abandonedCar: 0, slip: 0, collision: 0, redLightWaits: 0,
    yields: 0, rescued: 0,
    deathsByCause: {}, incidentsByType: {}, exposed: 0, maxDepth: 0,
  };
  const hourly = Array.from({ length: 24 }, (_, h) => ({
    hour: h, wading: 0, stranded: 0, injured: 0, dead: 0, evacuated: 0,
    stalled: 0, maxDepth: 0,
  }));

  const minute = () => {
    // 【修 2026-11-17】坏 manifest / 拖时间轴 / 跨天会让 clock.minute 变成
    // NaN 或 Infinity，下面 hourly[clamp(NaN,0,23)] 会取到 undefined 而抛错。
    const m = clock ? Number(clock.minute) : 0;
    return Number.isFinite(m) ? m : 0;
  };
  const bandOf = (i) => {
    try {
      const q = crowd && crowd.at ? crowd.at(i, minute()) : null;
      const c = peds[i] && peds[i].citizen;
      return (c && c.ageBand) || (q && q.ageBand) || 'prime';
    } catch (e) { return 'prime'; }
  };
  /** 真实年龄：从 ACS 记录取；取不到时不猜一个具体岁数，返回 null 走保守成人档。 */
  const ageOf = (i) => {
    try {
      const q = crowd && crowd.at ? crowd.at(i, minute()) : null;
      const c = peds[i] && peds[i].citizen;
      const a = (q && q.age) ?? (c && c.age) ?? (c && c.real && c.real.age);
      return Number.isFinite(Number(a)) ? Number(a) : null;
    } catch (e) { return null; }
  };

  function push(i, type, reason, ctx = {}) {
    const m = minute(), r = rows[i];
    if (!r) return;
    const e = { i, minute: +m.toFixed(2), type, reason,
      depth: +(ctx.depth || 0).toFixed(3), x: +(ctx.x || 0).toFixed(1),
      z: +(ctx.z || 0).toFixed(1),
      band: ctx.band || bandOf(i), circle: (circles[i] && circles[i].id) || null,
      label: (circles[i] && circles[i].label) || null };
    // 完整事件链：不再截断。一整天一个人的事件数最多几十条，
    // 截断会让「从涉水到被困到溺亡」的中间过程凭空消失。
    r.events.push(e);
    log.push(e);
    if (log.length > 200000) log.splice(0, 50000);
    // 出事即把最近 60 秒的短轨迹升级成完整链，之后逐帧续记。
    // 这样回放能看到「出事前 1 分钟他在哪、水多深、在干什么」，不是从出事那一刻才开始。
    if (CASE_TYPES.has(type) && !r.trace) {
      r.trace = r.recent.slice();
      r.recent = [];
    }
    stat.incidentsByType[type] = (stat.incidentsByType[type] || 0) + 1;
    const H = hourly[clamp(Math.floor(m / 60), 0, 23)];
    if (H[type] !== undefined) H[type]++;
    if (ctx.depth > H.maxDepth) H.maxDepth = ctx.depth;
    if (ctx.depth > stat.maxDepth) stat.maxDepth = ctx.depth;
  }

  /**
   * 死因的统计归类键。【修 2026-11-17】顶层被淹那支的 cause 里嵌了水深、
   * 判据、死亡概率和分区，几乎每个死者字符串都不同，直接拿它当
   * deathsByCause 的键会把统计碎成几十个「各计 1」的项，没法按类汇总。
   * 这里只归一统计键；r.cause 与事件 reason 仍保留完整描述，回放不丢细节。
   */
  function causeKeyOf(cause) {
    const s = String(cause == null ? '' : cause);
    if (s.startsWith('顶层被淹')) return '顶层被淹没路可退';
    if (s.includes('车内')) return '车内溺亡';
    if (s.includes('地下室')) return '地下室进水溺亡';
    if (s.includes('深水')) return '深水被困致死';
    if (s.includes('涉水')) return '涉水溺亡';
    return s || '未分类死亡';
  }

  function die(i, cause, ctx) {
    const r = rows[i];
    if (!r || r.status === 'dead') return false;
    r.status = 'dead'; r.cause = cause; r.minute = minute();
    r.x = ctx.x; r.z = ctx.z; r.depth = ctx.depth;
    const key = causeKeyOf(cause);
    stat.deathsByCause[key] = (stat.deathsByCause[key] || 0) + 1;
    push(i, 'dead', cause, ctx);
    // 终点帧：回放最后一格必须停在他实际出事的位置与水深。
    if (r.trace) r.trace.push(frameOf(i, ctx, 'dead'));
    return true;
  }

  /**
   * 取一帧真实状态。动作与理由来自这一刻快层判断的返回值，由 ped.js
   * 在调用 tick 时把 LIVE.agent(i).lastAction / lastReason 放进 ctx；
   * 拿不到就留空，不编一个动作。
   */
  function frameOf(i, ctx, statusOverride) {
    const r = rows[i];
    return {
      t: +minute().toFixed(2),
      x: +(ctx.x || 0).toFixed(1), z: +(ctx.z || 0).toFixed(1),
      // 【阶段3】室内帧记下真实楼层与脚底高程（来自建筑高度派生），
      // 回放人偶据此把人摆在对应楼层，而不是贴地显示在楼外。
      fl: Math.max(0, Math.floor(Number(ctx.floor) || 0)),
      y: Number.isFinite(ctx.floorY) ? +ctx.floorY.toFixed(2) : null,
      d: +Math.max(0, Number(ctx.depth) || 0).toFixed(3),
      v: +Math.max(0, Number(ctx.speed) || 0).toFixed(2),
      st: statusOverride || r.status,
      act: ctx.action || '', why: ctx.reason || '',
      goal: ctx.goalLabel || '',
      mode: ctx.mode || '',
      indoor: !!ctx.indoor, shelter: !!ctx.sheltered,
      car: !!ctx.inVehicle,
      sta: +Math.max(0, Number(ctx.stamina) || 0).toFixed(0),
      rain: +Math.max(0, Number(ctx.rainMMH) || 0).toFixed(1),
    };
  }

  /** 每 2 仿真秒采一帧；出事者续记完整链，其余人只留最近 30 帧。 */
  function sampleTrace(i, h, ctx) {
    const r = rows[i];
    r.traceSec = (r.traceSec || 0) + h;
    if (r.traceSec < TRACE_STEP_SEC) return;
    r.traceSec = 0;
    const f = frameOf(i, ctx);
    if (r.trace) {
      r.trace.push(f);
      if (r.trace.length > TRACE_MAX_FRAMES) r.trace.splice(0, 500);
    } else {
      r.recent.push(f);
      if (r.recent.length > RECENT_MAX) r.recent.shift();
    }
  }

  /**
   * 每个仿真子步对第 i 个人判一次。h = 仿真秒（≤0.2）。
   * ctx: { x, z, depth, speed, indoor, sheltered, inVehicle, carStalled,
   *        stamina, rainMMH, umbrella, mode }
   */
  function tick(i, h, ctx = {}) {
    const r = rows[i];
    if (!r || r.status === 'dead') return r ? r.status : 'safe';
    if (!(h > 0)) return r.status;
    sampleTrace(i, h, ctx);
    const band = ctx.band || bandOf(i);
    const V = vulnerabilityOf(ageOf(i), band);
    const depth = Math.max(0, Number(ctx.depth) || 0);
    const speed = Math.max(0, Number(ctx.speed) || 0);
    const indoor = !!ctx.indoor, sheltered = !!ctx.sheltered;
    const inVehicle = !!ctx.inVehicle;
    // 【2026-11-16 修 bug】旧写法 `Number(ctx.stamina) ?? 70`：ctx.stamina 未传时
    // Number(undefined)=NaN，`??` 只拦 null/undefined 不拦 NaN，于是 stamina=NaN、
    // endurance=NaN、`deepSec > NaN` 永远 false —— 溺亡判定整条失效。
    // 正确写法：先对原值做 ??，再转数字。
    const stamina = clamp(Number(ctx.stamina ?? 70) / 100, 0, 1);
    const rain = Math.max(0, Number(ctx.rainMMH) || 0);
    // 【目前自己定的】体力 / 雨强 / 伞对耐受时间的修正，没有一手依据，
    // 只保留一个统一的折减，不再按 9 档各写一套。
    const endurance = V.exposureSec * (0.72 + stamina * 0.42)
      * (rain > 25 ? 0.82 : 1) * (ctx.umbrella === 'open' ? 1.06 : 1);
    // 暴露起点是 ARR 的失稳深度（实测），不是「致死水深」。
    const instabilityDepth = V.instabilityDepth;

    r.inCar = inVehicle;
    if (depth > stat.maxDepth) stat.maxDepth = depth;

    // 涨水率（米/小时），供 Jonkman 的分区判据用：≥0.5 m/hr 且水深 ≥2.1 m
    // 走快速涨水区，否则走其余区。水情是离线帧序列插值出来的，瞬时差分噪声大，
    // 用 60 秒时间常数的指数平滑；第一步没有历史值时记 0，不凭一帧乱判。
    const instRate = h > 0 && r.lastDepth != null
      ? Math.max(0, (depth - r.lastDepth) / h * 3600) : 0;
    const rateAlpha = Math.min(1, h / 60);
    if (r.lastDepth != null) {
      r.riseRate = r.riseRate * (1 - rateAlpha) + instRate * rateAlpha;
    }
    r.lastDepth = depth;

    // ---- 室内 / 高处避难 ----
    // 【阶段3 楼层淹没】室内人按所在楼层判，这就是「1/2/3/4 层接受不一样」：
    //  · 所在层没被淹 → 安全（受楼层保护，跳过暴露）；
    //  · 所在层被淹、且还有更高未被淹的层 → 往上转移，活着；
    //  · 已在顶层且顶层也被淹 → 楼内无处可退，按 Jonkman 2007 的实测死亡率
    //    算死亡概率（见下）。第六轮之前这里转去走室外涉水判定，用的是自设
    //    耐受时长；现在换成有出处的函数，不再借用涉水那条链。
    // 判据形式见 kernel/floors.js（FLOODrisk 2016 / USACE LifeSim），
    // 致死概率见 kernel/fatality.js（Jonkman 2007 §7.4）。
    // 【2026-11-17 B 地下室】人在底下时不受楼层保护：水从窗井、门洞、下水
    // 倒灌进来，人就在水里，楼梯还在身后但要走上去。所以这里把 basement 的
    // 人直接放行到下面的涉水暴露段（dExp 用室外地面的水深——地下室水位与
    // 室外基本齐平），不走"楼层保护"那条 return。
    // 依据：Thieken 2026（Earth's Future 14(9):e2026EF008695）室内 131 名
    // 死者里 29 人（22.1%）死在地下室，多为抢救财物、查水泵时被淹。
    r.inBasement = !!ctx.basement;
    if (r.inBasement && !r.everWentBasement) {
      r.everWentBasement = true;
      push(i, 'basement', '下到地下室抢救财物 / 查看水泵', { ...ctx, band });
    }
    // 【修 2026-11-17】檐下只挡雨，不挡积水的重量与浮力。
    // 原实现把 sheltered 和 indoor 一并放行到「受保护」分支直接 return，
    // 于是站在檐下、脚边 2 m 深水的人被当成完全不暴露——这是错的。
    // 现在：室内仍按楼层判定；檐下只有在水深低于成人失稳下界（ARR 1.2 m）
    // 且没到深水阈值时才算受保护；超过就落到下面的涉水暴露段。
    // 1.2 m 是「危险分级」不是死亡阈值，用在这里是保守地取消保护，不是判死。
    const shelterProtects = sheltered && depth < Math.min(instabilityDepth, RISK.DEEP);
    if ((indoor && !r.inBasement) || shelterProtects || depth < RISK.WADING) {
      // 【修 2026-11-17】totalFloors 从 JSON 传来可能是字符串（"3"），
      // Number.isFinite("3") 为 false，会导致整段楼层淹没判定被静默跳过。
      // 这里显式转成数字再判，行数与类型都固定。
      const tf = Number(ctx.totalFloors);
      if (indoor && Number.isFinite(tf) && tf > 0 && depth > 0.05) {
        if (!(r.effFloor > 0)) r.effFloor = Math.max(1, Math.floor(Number(ctx.floor) || 1));
        const fr = floodFloor({ waterDepthM: depth, currentFloor: r.effFloor,
          totalFloors: tf, floorHeightM: ctx.floorHeightM });
        if (fr.status === 'moveUp' && fr.targetFloor > r.effFloor) {
          r.effFloor = fr.targetFloor;      // 往更高的干层转移
          if (minute() - (r.floorMoveT || -1e9) > 30) {
            r.floorMoveT = minute();
            if (!r.everEvacuated) { r.everEvacuated = true; }
            if (r.status !== 'dead' && r.status !== 'injured') r.status = 'evacuated';
            push(i, 'evacuated', `第 ${fr.targetFloor} 层还没被淹，往上转移`, { ...ctx, band });
          }
        } else if (fr.status === 'drowning') {
          // 顶层也被淹：楼内无处可退。但不是「水一过地板就危险」——
          // 按 LifeSim CPD-97a Table 4-3 的淹没判据，要积到一定深度才算高危险：
          // 行动不便者从地板起算 5 ft（1.52 m），能行动者要接近天花板
          // （层高 − 1 ft）。水到脚踝、到膝盖，人仍站在房间里。
          const localDepth = Math.max(0, depth
            - floorElevationM(r.effFloor, undefined, ctx.floorHeightM));
          r.floorLocalDepth = localDepth;
          const limited = limitedMobilityByAge(ageOf(i));
          const thr = submergenceThresholdM({ limitedMobility: limited,
            floorHeightM: ctx.floorHeightM });
          // 楼内进水就算受困，不管到没到高危险深度——状态与致死风险分开记。
          if (localDepth > 0.02 && r.status !== 'dead' && r.status !== 'injured'
            && r.status !== 'stranded') {
            r.status = 'stranded';
            r.everStranded = true;
            push(i, 'stranded', `楼内进水 ${localDepth.toFixed(2)} m，`
              + `${localDepth >= thr ? '已达高危险深度' : '未到高危险深度，暂能站住'}`,
            { ...ctx, band });
          }
          if (localDepth >= thr) {
            const jk = jonkmanFatality({
              depthM: localDepth,
              riseRateMhr: r.riseRate,     // 由水深时间序列平滑得到
              improvedBuilding: true,       // DC 建筑按现行防洪标准（一阶修正）
              velocityMs: 0,                // 没有流速场，因此不判溃决区
            });
            r.floorFd = jk.fd;
            r.floorFdZone = jk.zone;
            if (jk.fd > 0) {
              // 把「事件级死亡概率」换成按时间累积的风险，超过个人固定阈值就死。
              r.floodRisk += fatalRiskPerSecond(jk.fd) * h;
              if (r.floodRisk >= personalThreshold(i)) {
                die(i, `顶层被淹、楼内无路可退，该层积水 ${localDepth.toFixed(2)} m`
                  + `（判据 ${thr.toFixed(2)} m），死亡概率 ${(jk.fd * 100).toFixed(1)}%`
                  + `（${jk.zone === 'rapid' ? '快速涨水区' : '其余区'}）`,
                { ...ctx, band });
                return r.status;
              }
            }
          }
        }
      }
      // 受楼层保护（没被淹，或已经被淹但还没到顶层）：不暴露，累计避险时长。
      {
        r.deepSec = Math.max(0, r.deepSec - h * 1.6);
        r.stillSec = 0;
        if (sheltered) r.shelterSec += h;
        if (!r.everEvacuated && (sheltered || indoor) && depth < 0.08
          && r.everWaded && r.shelterSec > 3) {
          r.everEvacuated = true;
          r.status = 'evacuated';
          push(i, 'evacuated', '从积水路段撤到安全处', { ...ctx, band });
        }
        if (r.status === 'stranded' && depth < 0.25) {
          r.status = 'safe';
          push(i, 'rescued', '水位退下，脱离被困', { ...ctx, band });
          stat.rescued++;
        }
        if (r.status === 'wading' && depth < 0.12) r.status = 'safe';
        r.stalledSec = 0;
        return r.status;
      }
    }

    // ---- 涉水暴露（只有不在任何遮蔽下的人走到这里）----
    // 室内的人在上一段已经 return；这里踏的是室外地面水深。
    // 【修 2026-11-17】地下室是例外：地下室地板在室外地坪以下 2.2 m，
    // 水从窗井／门洞／下水灌进去后，室内水深 ≈ 室外水深 + 2.2 m（扣排水能力）。
    // 原实现把地下室人当成站在室外地面，只用室外深度，系统性低估危险：
    // 室外 0.8 m 时地下室已约 3.0 m，远超成人失稳的 1.2 m。
    // 只在室外水深已过进水阈值（0.05 m）时才加埋深；室外没水时不凭空制造水深。
    // 依据：kernel/floors.js 的 BASEMENT.depthM（目前自己定的埋深），
    // 连通器原理是物理常识；日本国土交通省地下空间指南 G-11～G-14 的行动限界 30 cm
    // 说明地下室进水极浅即不可通行。埋深本身仍属「目前自己定的」，见待补清单。
    const basementFlooded = r.inBasement && depth >= BASEMENT.entryDepthM;
    const dExp = basementFlooded
      ? depth + BASEMENT.depthM
      : depth;
    // 风险等级的可见水深用当地实际值，事件文字才能说清是地下室内部积水。
    r.localExposureDepth = dExp;
    if (!r.everWaded) r.everWaded = true;
    r.wadeSec += h;
    if (r.status === 'safe' || r.status === 'evacuated') {
      r.status = 'wading';
      push(i, 'wading', `脚下 ${Math.round(dExp * 100)} cm 积水，进入涉水`, { ...ctx, band });
    }
    // 【2026-11-17 C 弃车不等于安全】Thieken 2026（Earth's Future 14(9)）第 7 页
    // 记了 13 例车中/车旁死亡（瓦隆 2、北威 9）：多数是在积水区失去对车的控制、
    // 被困车内，**或者更常见的是——离开车之后被冲走、受重伤而死**。
    // 本项目没有流速场，编不出"被冲走"；能做的是这条物理事实：水已经到失稳
    // 深度（ARR 的成年人 1.2 m）还开门下车，人是站不住的，走不动。
    // 所以弃车后头 2 分钟按"挪不动"处理（步速记 0），接上同一条被困→溺亡判定。
    // 2 分钟是【目前自己定的】——原文没给"下车后多久被冲走"的时间。
    const justExited = Number.isFinite(r.carExitMin) && (minute() - r.carExitMin) < 2;
    const effSpeed = (justExited && dExp >= instabilityDepth) ? 0 : speed;
    if (dExp >= RISK.DEEP) {
      // 深水里几乎走不动 = 被困；不是「水深到了就死」
      r.deepSec += h * (dExp / instabilityDepth);
      if (effSpeed < 0.09) r.stillSec += h;
      else r.stillSec = Math.max(0, r.stillSec - h * 0.7);
      if (r.stillSec > RISK.STRANDED_SEC && r.status !== 'stranded' && r.status !== 'injured') {
        r.status = 'stranded'; r.everStranded = true;
        push(i, 'stranded', `${Math.round(dExp * 100)} cm 深水里 ${Math.round(r.stillSec)} 秒没能挪动`, { ...ctx, band });
      }
    } else {
      r.deepSec = Math.max(0, r.deepSec - h * 0.8);
      r.stillSec = Math.max(0, r.stillSec - h);
    }

    // ---- 涉水滑倒受伤：深水 + 走太快 + 年龄脆弱，一次行程只判一次 ----
    // 【修 2026-11-17】用当地实际水深 dExp，不再用室外 depth：
    // 地下室人的当地水深是室外深度 + 埋深，按室外值会漏掉滑倒判定。
    if (!r.slipRolled && dExp > 0.45 && effSpeed > 2.1) {
      r.slipRolled = true;
      const p = V.slip * clamp((dExp - 0.45) * 2.2, 0.25, 1);
      const roll = ((i * 2654435761) % 1000) / 1000;
      if (roll < p) {
        // 状态可能随后变成「已避险」，但「今天受过伤」这件事不能被抹掉。
        r.everInjured = true;
        if (r.status !== 'dead') r.status = 'injured';
        stat.slip++;
        push(i, 'injured', `${Math.round(depth * 100)} cm 积水里快走失足（${band}）`, { ...ctx, band });
      }
    }

    // ---- 车内：熄火 → 弃车 or 困死车内 ----
    if (inVehicle && depth > CAR.STALL_DEPTH) {
      r.stalledSec += h;
      if (r.stalledSec > RISK.CAR_ABANDON_SEC && depth > RISK.CAR_TRAP_DEPTH) {
        if (depth >= RISK.CAR_LETHAL_DEPTH && r.stalledSec > endurance * 0.8) {
          die(i, '车内溺亡', { ...ctx, band });
          return r.status;
        }
      }
    } else if (inVehicle) {
      r.stalledSec = Math.max(0, r.stalledSec - h);
    }

    // ---- 困死：达到 ARR 失稳深度 + 熬过（自设的）耐受时间 ----
    // 【重要】「失稳 → 伤亡」没有实测函数，这一整条判定是目前自己定的，
    // 算出来的死亡数是模型输出不是实测，交付时必须附敏感性分析。
    if (dExp >= instabilityDepth && r.deepSec > endurance) {
      const cause = inVehicle ? '车内溺亡'
        : (r.inBasement ? '地下室进水溺亡'
          : (r.status === 'stranded' ? '深水被困致死' : '涉水溺亡'));
      die(i, cause, { ...ctx, band });
    }
    return r.status;
  }

  /** 车/交通层抛进来的事件（熄火、弃车、碰撞、等灯、让行）——同样不预写。 */
  function mark(i, type, reason, ctx = {}) {
    if (type === 'dead') return die(i, reason, ctx);
    if (type === 'injured' && rows[i] && rows[i].status !== 'dead') {
      rows[i].status = 'injured'; rows[i].everInjured = true;
    }
    if (type === 'stranded' && rows[i]) rows[i].everStranded = true;
    if (type === 'stalled') stat.stalled++;
    if (type === 'abandonedCar') {
      stat.abandonedCar++;
      // 记下弃车时刻：之后 2 分钟按"下车后站不住"处理（见 tick 里的 C 段）。
      if (rows[i]) rows[i].carExitMin = minute();
    }
    if (type === 'collision') stat.collision++;
    if (type === 'redLightWait') stat.redLightWaits++;
    if (type === 'yield') stat.yields++;
    push(i, type, reason, ctx);
  }

  function recount() {
    for (const k of ['safe', 'wading', 'stranded', 'injured', 'dead', 'evacuated']) stat[k] = 0;
    let exposed = 0, everInjured = 0, everStranded = 0, everEvacuated = 0;
    for (const r of rows) {
      if (!r) continue;
      stat[r.status] = (stat[r.status] || 0) + 1;
      if (r.everWaded) exposed++;
      if (r.everInjured) everInjured++;
      if (r.everStranded) everStranded++;
      if (r.everEvacuated) everEvacuated++;
    }
    stat.exposed = exposed;
    stat.everInjured = everInjured;
    stat.everStranded = everStranded;
    stat.everEvacuated = everEvacuated;
  }

  function stats() {
    recount();
    const byCircle = {}, byBand = {}, byCause = stat.deathsByCause;
    for (const r of rows) {
      // 只对出事的人取年龄带/圈层：bandOf 要查社会层，全城 3000 人每批
      // 都查一遍会把 24h 验收拖慢一个数量级。
      if (r.status !== 'dead' && r.status !== 'stranded' && r.status !== 'injured') continue;
      const c = circles[r.i];
      const b = bandOf(r.i);
      const key = c ? c.districtLabel : '未知片区';
      byCircle[key] = byCircle[key] || { dead: 0, stranded: 0, injured: 0 };
      byCircle[key][r.status]++;
      byBand[b] = byBand[b] || { dead: 0, stranded: 0, injured: 0 };
      byBand[b][r.status]++;
    }
    return { ...stat, people: rows.length, byCause, byCircle, byBand,
      logSize: log.length, timeline: hourly };
  }

  /**
   * 逐人回查：完整事件链 + 逐帧轨迹。拖动时间轴会 reset，所以这里的
   * 链只对「连续运行」成立；文档里已写明不能用重建快照反推任何数字。
   */
  function snapshot(i) {
    const r = rows[i];
    if (!r) return null;
    const c = circles[i];
    return {
      i, status: r.status, cause: r.cause, minute: r.minute,
      x: r.x, z: r.z, depth: r.depth,
      age: ageOf(i), band: bandOf(i),
      circle: (c && c.id) || null, circleLabel: (c && c.label) || null,
      district: (c && c.districtLabel) || null,
      everWaded: r.everWaded, everStranded: r.everStranded,
      everInjured: r.everInjured, everEvacuated: r.everEvacuated,
      events: r.events.slice(),
      trace: r.trace ? r.trace.slice() : [],
    };
  }

  /** 有完整轨迹的个案清单，供页面下拉和离线验收导出。按严重程度排。 */
  function cases(limit = 200) {
    const rank = { dead: 0, stranded: 1, injured: 2, stalled: 3,
      abandonedCar: 4, evacuated: 5, rescued: 6 };
    const out = [];
    for (const r of rows) {
      if (!r || !r.trace || !r.trace.length) continue;
      const c = circles[r.i];
      const last = r.events[r.events.length - 1];
      out.push({
        i: r.i, status: r.status, cause: r.cause || (last && last.reason) || '',
        minute: last ? last.minute : r.minute,
        x: r.x, z: r.z, depth: r.depth,
        age: ageOf(r.i), band: bandOf(r.i),
        circleLabel: (c && c.label) || null,
        district: (c && c.districtLabel) || null,
        events: r.events.length, frames: r.trace.length,
        firstMinute: r.trace.length ? r.trace[0].t : 0,
        maxDepth: r.trace.reduce((m, f) => Math.max(m, f.d || 0), 0),
      });
    }
    out.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
      || b.maxDepth - a.maxDepth || a.i - b.i);
    return out.slice(0, limit);
  }

  /** 离线验收导出：把个案的完整链取走（不含未出事的人）。 */
  function exportCases(limit = 60) {
    return cases(limit).map((c) => ({ summary: c, replay: snapshot(c.i) }));
  }

  function reset() {
    for (let i = 0; i < rows.length; i++) rows[i] = blank(i);
    log = [];
    for (const k of Object.keys(stat)) {
      if (typeof stat[k] === 'number') stat[k] = 0;
      else if (k !== 'deathsByCause' && k !== 'incidentsByType') stat[k] = {};
    }
    stat.deathsByCause = {}; stat.incidentsByType = {};
    for (const H of hourly) for (const k of Object.keys(H)) if (k !== 'hour') H[k] = 0;
  }

  return {
    tick, mark, stats, snapshot, reset, push, die, cases, exportCases,
    isDead: (i) => !!(rows[i] && rows[i].status === 'dead'),
    // 【2026-11-16 阶段2A】被困状态要对运动层可见：过去 stranded 只是台账标签，
    // 从不反馈到 live-agent，于是被困的人仍每 0.5~1 秒重抽保护行动、反复
    // detour/turnback，在两个水坑之间来回跑。现在把这个状态暴露出去，
    // 让决策层能锁死这类人，不再触发绕路。
    isStranded: (i) => !!(rows[i] && rows[i].status === 'stranded'),
    isInjured: (i) => !!(rows[i] && rows[i].status === 'injured'),
    statusOf: (i) => (rows[i] ? rows[i].status : 'safe'),
    log: () => log,
    row: (i) => rows[i],
  };
}
