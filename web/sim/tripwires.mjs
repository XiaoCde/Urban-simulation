/**
 * tripwires.mjs — 批量工况跑批的四条「绊线」（A5）。
 *
 * 【为什么要有这个】2026-11-20 夜里 v4 那批 sweeps 的死法，三种都有：
 *   ① 23:17 之后 11 小时没有任何新文件，第二天早上才发现 —— 进程要么死了要么卡死，
 *      没人知道。这就是「断流」。
 *   ② p24 用 420 s 只跑到 320 分（其余工况 420 s 能跑完 1440 分），ETA 早就不对，
 *      但没人算过进度该花多久。
 *   ③ v4 死了 97 人（基线 21），结果照样被当成「跑完了」收进表里。
 *   ④ 任何一个 NaN 混进汇总指标，JSON.stringify 会把它写成 null，读的人只会看到
 *      「dead: null」，然后以为是解析问题 —— 静默失败。
 *
 * 所以这里只做四件事，全部是**判据 + 报警**，不碰模型、不改结果：
 *   绊线1 断流：日志 N 分钟不增长 → 报警 + 由调用方终止该子进程（不再干等 11 小时）。
 *   绊线2 ETA 偏离：按已完成段的实测速率外推，实际墙钟超出预期 slack 倍 → 报警。
 *   绊线3 结果合理性：死亡数 / 死因分解 / 最大水深 与人数、基线对不上 → 报警。
 *   绊线4 NaN：结果 JSON 里出现 NaN / Infinity → 报警（不是等它变 null）。
 *
 * 这个模块是纯函数 + 一个可注入时钟的看门狗，方便测试（tests/check-tripwires.mjs
 * 用假时钟模拟「8 分钟没动静」和「ETA 翻倍」，不需要真的等）。
 */

/** 默认阈值。都能用环境变量覆盖，跑批时不用改代码。 */
export const WATCH = Object.freeze({
  // 绊线1：日志连续多久不增长算断流。sim-day 每批都会打一行 [sim] 进度（一批
  // 通常几十秒到两分钟），所以 8 分钟没有新字节已经是异常。夜里那种 11 小时
  // 属于极端案例；把默认设成 8 分钟是为了「十几分钟后就知道」，不是等天亮。
  stallMin: Number(process.env.SIM_STALL_MIN || 8),
  // 绊线1 的轮询间隔：30 s 足够灵敏，也不会把 CPU 从仿真那边抢走。
  pollMs: Number(process.env.SIM_WATCH_POLL_MS || 30000),
  // 绊线2：实际墙钟 / 按速率外推的剩余时间，超过这个倍数算偏离。
  etaSlack: Number(process.env.SIM_ETA_SLACK || 1.35),
  // 绊线3：死亡数相对基线的允许倍数（上下各一条）。
  // 基线来自同批中位数（sim-sweep 里算）；3 倍已经不像「同一套模型同一个水」，
  // v4 那种 97 对 21（4.6×）就是被这条拦下来的。掉到基线 20% 以下同样报警——
  // 门 5 / 接触判定漏接的表现是「更安全」，别把漏接当好消息。
  deadUp: Number(process.env.SIM_DEAD_UP || 3),
  deadDown: Number(process.env.SIM_DEAD_DOWN || 0.2),
});

// ------------------------------------------------------------------ 绊线1 断流

/**
 * 断流看门狗。不自己读文件，由调用方给 `probe()`（返回 {size, mtimeMs}），
 * 时间和定时器也都能注入 —— 测试里就不用真等 8 分钟。
 *
 * 语义：只要 size 或 mtime 有任何变化就算「有心跳」；连续 silentMs 没心跳 →
 * 触发一次 onSilent（同一段断流只报一次，恢复心跳后再断会重新报）。
 */
export function createWatchdog({
  probe, silentMs = WATCH.stallMin * 60000, intervalMs = WATCH.pollMs,
  now = () => Date.now(), setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (h) => clearInterval(h), onSilent = () => {},
} = {}) {
  let last = null;          // {size, mtimeMs, at}
  let silentReported = false;
  let silentSince = null;
  let timer = null;
  let stopped = false;

  const state = { beats: 0, silentReports: 0, lastSilentSec: 0 };

  function tick() {
    if (stopped) return;
    const t = now();
    let cur = null;
    try { cur = probe(); } catch { cur = null; }
    if (!cur) return;                       // 文件还没建出来，不算断流
    if (!last) { last = { ...cur, at: t }; silentSince = t; return; }
    const moved = cur.size !== last.size || cur.mtimeMs !== last.mtimeMs;
    if (moved) {
      last = { ...cur, at: t };
      state.beats++;
      if (silentReported) { silentReported = false; silentSince = null; }
      return;
    }
    const silentSec = (t - last.at) / 1000;
    if (!silentReported && silentSec >= silentMs / 1000) {
      silentReported = true;
      silentSince = last.at;
      state.silentReports++;
      state.lastSilentSec = Math.round(silentSec);
      onSilent({ silentSec: Math.round(silentSec), size: cur.size, lastBeatMs: last.at });
    }
  }

  return {
    start() { if (!timer && !stopped) timer = setTimer(tick, intervalMs); return this; },
    stop() { stopped = true; if (timer) { clearTimer(timer); timer = null; } },
    tick,
    state,
    get stalled() { return silentReported; },
    get silentForSec() {
      if (!silentReported || silentSince == null) return 0;
      return Math.round((now() - silentSince) / 1000);
    },
  };
}

// ------------------------------------------------------------------ 绊线2 ETA

/**
 * 从 sim-day 的进度行里取最新一条：
 *   [sim] 43% · 620.5 分 · 判断 12000 条 · 本批 61.2s · 540s
 * 返回 {pct, minute, wallSec} 或 null。取**最后一条**匹配，容忍中途重跑。
 */
export function parseProgress(text) {
  if (!text) return null;
  const re = /\[sim\]\s*(\d+(?:\.\d+)?)%\s*·\s*([\d.]+)\s*分\s*·[^\n]*?·\s*([\d.]+)s/gu;
  let m, best = null;
  while ((m = re.exec(text)) !== null) {
    best = { pct: Number(m[1]), minute: Number(m[2]), wallSec: Number(m[3]) };
  }
  return best;
}

/**
 * 按实测速率外推：已跑到 minute、已花 wallSec 秒，总时长 minutesTotal。
 * 返回 {rate, remainingSec, etaWallSec, done}。
 * 速率分段取「最近窗口」会在早期抖动很大，所以用全程平均（收敛、可解释）；
 * 偏离判定交给 etaVerdict 的 slack。
 */
export function etaOf({ minute, wallSec, minutesTotal }) {
  const min = Math.max(0, Number(minute) || 0);
  const wall = Math.max(0, Number(wallSec) || 0);
  const total = Math.max(0, Number(minutesTotal) || 0);
  if (!(min > 0) || !(wall > 0) || !(total > 0)) {
    return { rate: 0, remainingSec: null, etaWallSec: null, done: min >= total };
  }
  const rate = min / wall;                    // 仿真分钟 / 墙钟秒
  const remainingMin = Math.max(0, total - min);
  const remainingSec = rate > 0 ? remainingMin / rate : null;
  return {
    rate: +rate.toFixed(4),
    remainingSec: remainingSec == null ? null : +remainingSec.toFixed(0),
    etaWallSec: remainingSec == null ? null : +(wall + remainingSec).toFixed(0),
    done: min >= total,
  };
}

/**
 * 偏离判定：实际墙钟 / 当初外推的总墙钟 > slack → 报警。
 * `expectedWallSec` 是**起点之后第一次**算出来的 etaWallSec（外推一次就固定下来，
 * 否则随速率变化会自我修正，永远不偏离 —— 那就成了永远不报警的指标）。
 */
/**
 * 降雨族：全天连绵雨（8/16/24/32 mm/h）与傍晚两小时暴雨（20/40/80/120 mm/h）
 * 每帧成本不同（文档 §15：跨族不能横向比），所以 ETA 的参照也必须分族。
 */
export function rainFamily(caseName) {
  const m = /^u_p(\d+)_s/.exec(String(caseName || ''));
  const p = m ? Number(m[1]) : NaN;
  return (p === 8 || p === 16 || p === 24 || p === 32) ? 'uniform' : 'evening';
}

/**
 * 同族已完成工况的墙钟中位数。没有参照就返回 0 —— 调用方据此**不报** ETA 偏离。
 * 为什么不用「本工况早期线性外推」：早期全是干地帧，便宜；17 点以后下雨帧贵得多，
 * 拿前 24 分钟推整场，几乎每个雨季工况都会被判「偏离」——假警报比没有警报更糟
 * （2026-11-21 实跑 u_p120_s0 就因此误报 1.57×）。
 */
export function familyRefSec(caseName, results, opts = {}) {
  const fam = rainFamily(caseName);
  const secs = (Array.isArray(results) ? results : [])
    .filter((r) => r && !(r.trip && r.trip.stalled) && r.sum && !r.sum.error
      && rainFamily(r.case) === fam)
    .map((r) => Number(r.sec))
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (!secs.length) return 0;
  return opts.upperHalf ? secs[Math.floor(secs.length * 0.75)] : secs[Math.floor(secs.length / 2)];
}

export function etaVerdict({ wallSec, expectedWallSec, slack = WATCH.etaSlack }) {
  const w = Number(wallSec), e = Number(expectedWallSec);
  if (!(w > 0) || !(e > 0)) return { over: false, ratio: null };
  const ratio = w / e;
  return { over: ratio > slack, ratio: +ratio.toFixed(2) };
}

// ------------------------------------------------------------------ 绊线4 NaN

/** 递归找 NaN / Infinity / -Infinity 的字段路径（有上限，避免大对象炸内存）。 */
export function scanNaN(obj, { limit = 40, path = '$', out = [] } = {}) {
  if (out.length >= limit) return out;
  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) out.push({ path, value: String(obj) });
    return out;
  }
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length && out.length < limit; i++) scanNaN(obj[i], { limit, path: `${path}[${i}]`, out });
    return out;
  }
  for (const k of Object.keys(obj)) {
    if (out.length >= limit) break;
    scanNaN(obj[k], { limit, path: `${path}.${k}`, out });
  }
  return out;
}

// ------------------------------------------------------------------ 绊线3 合理性

/**
 * 结果合理性。不是「模型对不对」，是「这份结果能不能当成跑完了」：
 *   · 关键指标必须是有限数字（null 就是 JSON.stringify(NaN) 留下的尸体）；
 *   · 死亡数不能超过人数；
 *   · 死因分解之和要等于死亡总数（两套口径打架 = 有一边没接上）；
 *   · 有基线时，死亡数相对基线偏离过大要报警（v4 死 97 对基线 21 就是这种）。
 */
export function sanityOf(sum, { people = null, baselineDead = null } = {}) {
  const issues = [];
  if (!sum || typeof sum !== 'object') return { ok: false, issues: ['没有汇总（结果文件缺失或解析失败）'] };
  if (sum.error) issues.push('解析失败：' + sum.error);

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const dead = num(sum.dead);
  if (sum.dead === undefined || sum.dead === null) issues.push('死亡数缺失');
  else if (dead === null) issues.push('死亡数不是有限数字（NaN/Infinity）');

  if (dead != null && people != null && dead > people) {
    issues.push(`死亡数 ${dead} 超过总人数 ${people}`);
  }

  // 死因分解求和：三个口径只要在场，就必须与 dead 一致。
  for (const key of ['deathsByCause', 'deathsByZone', 'deathsByLegacyCause']) {
    const m = sum[key];
    if (!m || typeof m !== 'object') continue;
    const parts = Object.values(m).map((v) => num(v) ?? NaN);
    if (parts.some((v) => Number.isNaN(v))) { issues.push(`${key} 里有非数字`); continue; }
    const total = parts.reduce((a, b) => a + b, 0);
    if (dead != null && total !== dead) {
      issues.push(`${key} 求和 ${total} ≠ 死亡数 ${dead}（两套口径没对齐）`);
    }
  }

  if (sum.maxDepthCm != null && num(sum.maxDepthCm) === null) issues.push('最大水深不是有限数字');

  if (dead != null && baselineDead != null && baselineDead > 0) {
    const ratio = dead / baselineDead;
    if (ratio > WATCH.deadUp) issues.push(`死亡 ${dead} 是基线 ${baselineDead} 的 ${ratio.toFixed(1)} 倍（>${WATCH.deadUp}×）`);
    else if (ratio < WATCH.deadDown) issues.push(`死亡 ${dead} 只有基线 ${baselineDead} 的 ${(ratio * 100).toFixed(0)}%（<${WATCH.deadDown * 100}%）`);
  }
  return { ok: issues.length === 0, issues };
}

/**
 * 同族「雨强更高、死亡反而不到一半」的结构性逆转判据。
 *
 * 【2026-11-22 改法的原因】上一版把「同批所有工况的死亡中位数」当基线，
 * 于是一次干净的 8 工况跑批（0 断流 / 0 NaN / 0 退出码异常）报出 3 条告警：
 * u_p8_s0 死 3、u_p20_s0 死 0、u_p40_s0 死 2 都「低于中位数 26」。
 * 这不是异常，这是**雨强梯度**：8 mm/h 下满一天当然比 120 mm/h 两小时灌死得少。
 * 用跨雨强的中位数当基线，等于要求「小雨和大暴雨死一样多」——判据本身错了。
 *
 * 现在只保留一种有意义的相对判据：**同族内雨强升高、死亡却掉到不足一半**。
 * 出现这种情况要么是分母变了（先死的那批人已不在被困池里），要么是真出事了，
 * 无论哪种都值得复核，但它只作为「提示」，不阻断结果入表。
 *
 * @param {Array<{case:string, family:string, intensity:number, dead:number}>} rows
 * @param {{minDead?:number, ratio?:number}} opts 低雨强档死亡数 ≥ minDead 才比（小样本不比）
 */
export function familyInversions(rows, { minDead = 5, ratio = 0.5 } = {}) {
  const issues = [];
  const byFam = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.family) continue;
    if (!byFam.has(r.family)) byFam.set(r.family, []);
    byFam.get(r.family).push(r);
  }
  for (const [family, arr] of byFam) {
    arr.sort((a, b) => (a.intensity || 0) - (b.intensity || 0));
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i - 1]; const cur = arr[i];
      const a = prev.dead; const b = cur.dead;
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (a < minDead) continue;          // 低基数档不比，避免拿 0 比 0
      if (b < a * ratio) {
        issues.push({
          family, from: prev.case, to: cur.case, fromDead: a, toDead: b,
          note: `${cur.case} 雨强更高（${cur.intensity} mm/h）却只死 ${b}，不到 ${prev.case}（${prev.intensity} mm/h）的 ${a} 的一半`,
        });
      }
    }
  }
  return issues;
}

/** 把一次跑批的四类绊线结果压成一行结论（给 _sweep.json 与控制台用）。 */
export function tripwireSummary({ stalled = false, eta = null, nan = [], sanity = null } = {}) {
  const bad = [];
  if (stalled) bad.push('断流');
  if (eta && eta.over) bad.push(`ETA ${eta.ratio}×`);
  if (nan.length) bad.push(`NaN ${nan.length} 处`);
  if (sanity && !sanity.ok) bad.push(...sanity.issues);
  return { ok: bad.length === 0, bad };
}