/**
 * experience.js — 「今天干了什么、经历了什么」的可累积状态。
 *
 * 【2026-11-12 用户要求】「把人的状态值也加进去，今天干了什么和经历了什么
 *  必然会影响走势，把这个考虑进去」。
 *
 * 这里不写故事、不写台词，只累积**真实世界量出来的数**：
 *   ped.js 每子步回填真实位移 / 脚下水深 / 模式 / 生理值 / 伞状态；
 *   live-agent.js 每次判断、每次目标事件回填动作名。
 * 这些数再由 state(i) 交回 cohort.judge()，直接改变每个动作的分数：
 *   蹚过深水的人更早绕行、淋透又没伞的人更想躲、放弃过的人更容易再放弃、
 *   走累的人步速下降、办成过事的人更有惯性、绕烦了的人懒得再绕。
 *
 * 同一场雨里，经历不同的人会走出不同路线 —— 这就是「走势被经历改变」。
 */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function createExperience(peds, crowd) {
  const rows = [];
  for (const p of peds) rows[p.i] = blank(p.i);

  function blank(i) {
    return {
      i, walkedM: 0, maxDepth: 0, wadeSec: 0, shelterSec: 0, waitSec: 0,
      judgedN: 0, blockedN: 0, waitedN: 0, detoursN: 0, turnbacksN: 0,
      abandonsN: 0, doneN: 0, timeoutN: 0, sheltersN: 0, hurriedN: 0, slowedN: 0,
      depth: 0, speed: 0, mode: 'net', indoor: true, raining: false,
      wetness: 0, hunger: 0, stamina: 90, umbrella: 'none', hasUmbrella: false,
      lastAction: 'continue', lastReason: '', minute: 0,
    };
  }

  /** ped.js 每子步调一次：只吃这一子步真实测得的值。 */
  function tick(i, dt, env) {
    const r = rows[i];
    if (!r) return;
    const h = Math.max(0, Math.min(1, dt || 0));   // 单子步 ≤0.2 仿真秒
    const depth = Number(env.depth) || 0;
    const speed = Number(env.speed) || 0;
    r.depth = depth;
    r.speed = speed;
    r.mode = env.mode || r.mode;
    r.indoor = !!env.indoor;
    r.raining = !!env.raining;
    r.minute = env.minute ?? r.minute;
    if (env.phys) {
      r.wetness = clamp((Number(env.phys.wetness) || 0) / 100, 0, 1);
      r.hunger = Number(env.phys.hunger) || 0;
      r.stamina = Number(env.phys.stamina) || 90;
      r.umbrella = env.phys.umbrella || 'none';
      r.hasUmbrella = !!env.phys.hasUmbrella;
    }
    if (h > 0) {
      r.walkedM += speed * h;
      if (depth > r.maxDepth) r.maxDepth = depth;
      if (depth > 0.08) r.wadeSec += h;
      if (r.mode === 'shelter' || r.mode === 'flee') r.shelterSec += h;
      if (speed < 0.02 && !r.indoor) r.waitSec += h;
    }
  }

  /** live-agent.js 每次判断 / 目标事件调一次。 */
  function note(i, type, reason) {
    const r = rows[i];
    if (!r) return;
    switch (type) {
      case 'continue': r.judgedN++; break;
      case 'slow': r.judgedN++; r.slowedN++; break;
      case 'hurry': r.judgedN++; r.hurriedN++; break;
      case 'wait': r.judgedN++; r.waitedN++; break;
      case 'detour': r.judgedN++; r.detoursN++; break;
      case 'turnback': r.judgedN++; r.turnbacksN++; break;
      case 'abandon': r.judgedN++; r.abandonsN++; break;
      case 'blocked': r.blockedN++; break;
      case 'done': r.doneN++; break;
      case 'timeout': r.timeoutN++; break;
      case 'shelter': r.sheltersN++; break;
      default: break;
    }
    r.lastAction = type;
    if (reason) r.lastReason = reason;
  }

  /** 交给 judge() 的状态向量。全部来自上面累积的真实量。 */
  function state(i) {
    const r = rows[i];
    if (!r) return null;
    const walkFatigue = clamp(r.walkedM / 4200, 0, 1);
    const bodyFatigue = clamp(1 - r.stamina / 100, 0, 1);
    const fatigue = clamp(bodyFatigue * 0.55 + walkFatigue * 0.45, 0, 1);
    const failures = r.abandonsN + r.timeoutN;
    const confidence = clamp((r.doneN + 0.5) / (r.doneN + failures + 1), 0, 1);
    // 淋透 / 累 / 今天已经放弃过 / 在檐下待久了 → 更想回家、更容易收工
    // 淋湿 / 累 / 放弃过会让人更想收工回家，但不能形成「淋透→无限放弃」
    // 的正反馈。限幅 0.65，且放弃次数只计前 3 次。
    const homeBias = clamp(r.wetness * 0.34 + fatigue * 0.24
      + Math.min(r.abandonsN, 3) * 0.06 + clamp(r.shelterSec / 360, 0, 0.14), 0, 0.65);
    return {
      expDepth: r.maxDepth, detoursToday: r.detoursN + r.turnbacksN,
      abandonToday: r.abandonsN, doneToday: r.doneN, timeoutToday: r.timeoutN,
      blockedToday: r.blockedN, waitedToday: r.waitedN, shelteredSec: r.shelterSec,
      walkedTodayM: r.walkedM, wadeSec: r.wadeSec,
      wetness: r.wetness, hunger: r.hunger, fatigue,
      stamina: r.stamina, umbrella: r.umbrella, hasUmbrella: r.hasUmbrella,
      confidence, homeBias,
    };
  }

  /** 步速乘子：累 / 湿 / 饿 / 撑伞 都会真的让人走慢，改的是位移不是文案。 */
  function speedFactor(i) {
    const r = rows[i];
    if (!r) return 1;
    const f = state(i);
    let m = 1 - f.fatigue * 0.32 - f.wetness * 0.16;
    if (f.hunger > 82) m *= 0.92;
    if (f.umbrella === 'open') m *= 0.94;      // 撑伞步子略慢
    return clamp(m, 0.55, 1.05);
  }

  /** HUD / 验收用的逐人摘要。 */
  function snapshot(i) {
    const r = rows[i];
    if (!r) return null;
    const f = state(i);
    return {
      walkedM: Math.round(r.walkedM), maxDepthCm: Math.round(r.maxDepth * 100),
      wadeSec: Math.round(r.wadeSec), shelterSec: Math.round(r.shelterSec),
      judged: r.judgedN, detours: r.detoursN + r.turnbacksN,
      waits: r.waitedN, abandons: r.abandonsN, done: r.doneN,
      timeouts: r.timeoutN, blocked: r.blockedN,
      wetnessPct: Math.round(f.wetness * 100), hunger: Math.round(f.hunger),
      stamina: Math.round(f.stamina), fatigue: +f.fatigue.toFixed(2),
      homeBias: +f.homeBias.toFixed(2), confidence: +f.confidence.toFixed(2),
      umbrella: f.umbrella, hasUmbrella: f.hasUmbrella,
      lastAction: r.lastAction, lastReason: r.lastReason,
      summary: `今日走 ${Math.round(r.walkedM)} m · 最深水 ${Math.round(r.maxDepth * 100)} cm`
        + ` · 绕行 ${r.detoursN + r.turnbacksN} 次 · 放弃 ${r.abandonsN} 次`
        + ` · 完成 ${r.doneN} 件 · 淋湿 ${Math.round(f.wetness * 100)}%`
        + ` · 体力 ${Math.round(f.stamina)} · ${f.hasUmbrella ? (f.umbrella === 'open' ? '撑着伞' : '带着伞') : '没带伞'}`,
    };
  }

  /** 拖时间轴 = 查这一刻的城市快照，没有历史可回放：经历归零重来。 */
  function reset() {
    for (let i = 0; i < rows.length; i++) if (rows[i]) rows[i] = blank(i);
  }

  function stats() {
    let walked = 0, deep = 0, detours = 0, abandons = 0, done = 0, wet = 0, judged = 0;
    let withUmb = 0, maxDepth = 0;
    for (const r of rows) {
      if (!r) continue;
      walked += r.walkedM; judged += r.judgedN;
      detours += r.detoursN + r.turnbacksN; abandons += r.abandonsN; done += r.doneN;
      wet += r.wetness; if (r.hasUmbrella) withUmb++;
      if (r.maxDepth > 0.22) deep++;
      if (r.maxDepth > maxDepth) maxDepth = r.maxDepth;
    }
    const n = Math.max(1, rows.length);
    return { people: rows.length, walkedM: Math.round(walked), judged,
      avgWalkedM: Math.round(walked / n), avgWetPct: Math.round(wet * 100 / n),
      detours, abandons, done, deepWaders: deep, maxDepthCm: Math.round(maxDepth * 100),
      withUmbrella: withUmb };
  }

  return { tick, note, state, speedFactor, snapshot, reset, stats,
    row: (i) => rows[i] };
}
