/**
 * _sim_day.mjs — 连续 24 小时仿真验收（2026-11-13 正式启用）。
 *
 * 【用户 2026-11-11】「验收的话单独写一个程序，我们后面等你把这个搭完之后，
 *  我们后期找空闲时间跑一遍」；【2026-11-13】「所有做完之后，你再开始跑这个
 *  24 小时验证，开一个快一点的倍速，24 倍速吧…跑出一个数据给我」。
 *
 * 这个程序**绝不 seek 起点之后**：从 00:00 连续播放到 24:00，按倍率把仿真秒
 * 推进完。每一帧走的是和实时播放完全相同的子步循环：时钟 → 交通（含等灯、
 * 让行、限速、涉水）→ 行人判断与真实位移 → 驾驶层 → 伤亡台账 → 积水回写。
 * 拖动时间轴看的是快照，这里看的是过程与分布。
 *
 * 用法:
 *   node _sim_day.mjs [minutes=1440] [speed=24] [people=1000] [out=out/sim_day.json] [startMinute=0]
 *   node _sim_day.mjs 1440 24 1000                 # 完整一天，×24
 *   node _sim_day.mjs 120 24 240                    # 先拿两小时试水
 *   node _sim_day.mjs 120 24 300 out/case.json 1140  # 从 19:00 起跑两小时，导出事故个案
 *
 * 【起点参数只用于短片验证】正式 24h 验收一律从 00:00 开始；从别处起跑会
 * 清空起点之前的经历，不能用来反推全天数字，也不能写成「全天结果」。
 *
 * 产出：JSON 全量数据 + 同名 .md 可读报告。
 */
import puppeteer from 'puppeteer-core';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const MINUTES = Number(process.argv[2] || 1440);
const SPEED = Number(process.argv[3] || 24);
const PEOPLE = Number(process.argv[4] || 1000);
const OUT = resolve(process.argv[5] || 'out/sim_day.json');
const START_MINUTE = Math.max(0, Math.min(1439, Number(process.argv[6] || 0)));
// 降雨工况（assets/flood 下的目录名）。默认 u_p8_s0 = 全天 8 mm/h 无增水。
// 传别的档位时，页面加载完再切过去；切换必须在 seek 之前，因为 load() 会按
// 新 manifest 重配 0–1440 的量程。
const CASE = (process.argv[7] || 'u_p8_s0').trim();
// 【人群种子，2026-11-17】页面默认 seed = Date.now() ^ Math.random()，每次加载
// 换一批人（当初是为了让实时预览不总是同一批人）。但这样两个工况跑出来的差异
// 里就混进了「人不一样」，横向比降雨强度会被污染。所以验收一律固定 seed：
// 同 seed + 同人数 = 同一批人，只有水在变。要换一批人就传第 9 个参数。
const SEED = Number(process.argv[8] || 20261117) >>> 0;
const REPORT = OUT.replace(/\.json$/i, '') + '.md';
const BATCH = 100;
const DT = 0.1;                  // 真实秒/帧（CLOCK 会钳到 0.1）

if (!CHROME) throw new Error('找不到 Chrome / Edge 可执行文件');
mkdirSync(dirname(OUT), { recursive: true });

const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 3600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await b.newPage();
await p.setViewport({ width: 900, height: 560 });
const pageErrors = [];
p.on('pageerror', (e) => pageErrors.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1');
u.searchParams.set('ped', String(PEOPLE));
u.searchParams.set('v', String(Date.now()));
u.searchParams.set('seed', String(SEED));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });

// ---------------------------------------------------------------- 起点对齐
const start = await p.evaluate(async (sp, m, cs) => {
  const C = window.__clock, PED = window.__ped, F = window.__flood;
  // 关掉 capture=1 的自动推帧：整段 24h 只由 __frame 驱动，时间轴不插帧。
  window.__manualDrive = true;
  C.setPlaying(false);
  // 换工况：页面默认装的是 u_p8_s0。其它档位先切过去，等纹理落地再对齐起点。
  if (cs && F && F.load) {
    const cur = ((F.manifest && F.manifest.source) || '').split('/').filter(Boolean).pop();
    if (cur !== cs) {
      await F.load(cs);
      // showFrame 是异步取帧；给一拍再读 manifest，避免读到上一档的元数据
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  C.setSpeed(sp);
  C.seek(m);                       // 只在起点对齐一次，之后绝不 seek
  if (PED.live) PED.live.reset(m, PED.peds);
  if (F && F.fb) F.fb.reset();
  C.setPlaying(true);
  const cohort = {}, circles = {};
  for (let i = 1; i < PED.peds.length; i++) {
    const d = PED.live && PED.live.debug(i);
    if (d) { cohort[i] = d.cohort; circles[i] = d.circleId || d.cohort; }
  }
  const f = window.__sim ? window.__sim() : null;
  const man = (F && F.manifest) || null;
  let peakWet = 0;
  if (man && man.frames) for (const fr of man.frames) peakWet = Math.max(peakWet, fr.wet_ha || 0);
  return { people: PED.peds.length, minute: C.minute, tMin: F ? F.tMin : null,
    cohort, circles, speedTruth: f ? f.speed : null,
    circleStats: f ? f.circles : null,
    caseMeta: man ? { name: (man.source || '').split('/').filter(Boolean).pop(),
      pMmH: man.p_mm_h ?? null, surgeM: man.surge_m ?? null,
      hyeto: man.hyetograph || '', rainStart: man.rain_start_min ?? null,
      rainEnd: man.rain_end_min ?? null, frames: (man.frames || []).length,
      peakWetHa: +peakWet.toFixed(1) } : null };
}, SPEED, START_MINUTE, CASE);

// ---------------------------------------------------------------- 流式聚合
const agg = {
  minutes: MINUTES, speed: SPEED, people: start.people,
  case: CASE, caseMeta: start.caseMeta, seed: SEED,
  startMinute: start.minute, simSec: 0, frames: 0, batches: 0,
  byAction: {}, byCohortAction: {}, byCircleAction: {}, byGoal: {}, goals: {},
  unjustified: 0, unjustifiedSamples: [], events: 0, overflow: 0,
  maxDepthSeen: 0, rainWindowEvents: 0, shelterAtEnd: 0,
  hourly: [], pageErrors,
  speedTruth: start.speedTruth, circleStats: start.circleStats,
};
const simPerFrame = Math.min(0.1, DT) * SPEED;
const totalFrames = Math.ceil(MINUTES * 60 / simPerFrame);
let aborted = false;
process.on('SIGINT', () => { aborted = true; });

const t0 = Date.now();
let lastHour = -1;
for (let f = 0; f < totalFrames && !aborted; f += BATCH) {
  const n = Math.min(BATCH, totalFrames - f);
  const batch = await p.evaluate((frames, dt) => {
    window.__frame(dt, frames, true);   // 只跑仿真，不渲染
    const PED = window.__ped;
    const ev = PED.live ? PED.live.events.splice(0) : [];
    const st = PED.live ? PED.live.stats() : null;
    return {
      ev, st,
      minute: window.__clock.minute,
      tMin: window.__flood ? window.__flood.tMin : null,
      route: PED.routeStats ? PED.routeStats() : null,
      flee: PED.fleeStats ? PED.fleeStats() : null,
      drive: PED.drive ? PED.drive.stats() : null,
    };
  }, n, DT);
  agg.frames += n;
  agg.batches++;
  agg.simSec = batch.st ? batch.st.simSec : agg.simSec;
  agg.overflow = batch.st ? batch.st.overflow : agg.overflow;
  agg.shelterAtEnd = batch.flee ? batch.flee.shelter : 0;

  for (const e of batch.ev) {
    agg.events++;
    agg.byAction[e.action] = (agg.byAction[e.action] || 0) + 1;
    const c = start.cohort[e.i] || '未知';
    agg.byCohortAction[c + '|' + e.action] = (agg.byCohortAction[c + '|' + e.action] || 0) + 1;
    const cc = start.circles[e.i] || '未知';
    agg.byCircleAction[cc + '|' + e.action] = (agg.byCircleAction[cc + '|' + e.action] || 0) + 1;
    if (e.goal) agg.byGoal[e.goal] = (agg.byGoal[e.goal] || 0) + 1;
    if (e.depth > agg.maxDepthSeen) agg.maxDepthSeen = e.depth;
    if (e.rain >= 10) agg.rainWindowEvents++;
    // 「无依据改道」：没水没雨，也没有被挡住 / 路线卡住 / 目标迟到，
    // 却换街 / 掉头 / 放弃。前三种都是正当理由，事件里带真实依据字段。
    if (['detour', 'turnback', 'abandon'].includes(e.action)
      && (e.depth || 0) < 0.01 && (e.rain || 0) < 8
      && !e.blocked && (e.stuck || 0) <= 3 && (e.overdue || 0) < 0.02
      && !e.late) {
      agg.unjustified++;
      if (agg.unjustifiedSamples.length < 12) agg.unjustifiedSamples.push(e);
    }
  }
  if (batch.st) {
    agg.totalByAction = { ...(batch.st.byAction || {}) };
    agg.goals = { ...(batch.st.goals || {}) };
  }
  // 每跨过一个整点，取一次全量快照（24 次，不做逐批全表扫描）
  const hour = Math.floor(batch.minute / 60);
  if (hour !== lastHour && hour >= 0 && hour < 24) {
    lastHour = hour;
    const snap = await p.evaluate(() => window.__sim ? window.__sim() : null);
    if (snap) {
      const I = snap.incidents, D = snap.driving;
      agg.hourly.push({
        hour, minute: +batch.minute.toFixed(1),
        judged: snap.live ? snap.live.judged : 0,
        routing: batch.route ? batch.route.active : 0,
        shelter: batch.flee ? batch.flee.shelter : 0,
        driving: D.active, driveRequests: D.requests,
        driveArrivals: D.arrivals, carKm: D.carKm,
        redLightWaits: I.redLightWaits, yields: I.yields,
        stalled: I.stalled, abandonedCar: I.abandonedCar,
        wading: I.wading, stranded: I.stranded, injured: I.injured,
        dead: I.dead, evacuated: I.evacuated,
        everInjured: I.everInjured, everStranded: I.everStranded,
        maxDepthCm: Math.round((I.maxDepth || 0) * 100),
        // deathsByCause：地点×动作二维键（2026-11-19 起）
        deathsByCause: { ...(I.deathsByCause || {}) },
        // 致死机制分区（室外涉水/室外被困/车内/室内被淹/地下室进水）
        deathsByZone: { ...(I.deathsByZone || {}) },
        // 旧口径（涉水溺亡/深水被困致死/车内溺亡…），只给旧报告对照
        deathsByLegacyCause: { ...(I.deathsByLegacyCause || {}) },
      });
    }
  }
  agg.last = { minute: +batch.minute.toFixed(2),
    tMinSync: Math.abs(batch.minute - batch.tMin) < 1e-6,
    routing: batch.route ? batch.route.active : 0,
    walked: batch.route ? +batch.route.walked.toFixed(0) : 0 };
  if (agg.batches % 10 === 0) {
    const pct = (100 * agg.frames / totalFrames).toFixed(1);
    const sec = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`[sim] ${pct}% · ${agg.last.minute} 分 · 判断 ${agg.events} 条 · ${sec}s`);
  }
  // 每 50 批落一次盘：24h 跑得久，中途被中断也能拿到已采集的逐时数据。
  if (agg.batches % 50 === 0) {
    writeFileSync(OUT.replace(/\.json$/i, '') + '.partial.json',
      JSON.stringify({ ...agg, final: null }, null, 2));
  }
}

// ---------------------------------------------------------------- 收尾
agg.endMinute = agg.last ? agg.last.minute : start.minute;
agg.wallSec = +((Date.now() - t0) / 1000).toFixed(1);
agg.aborted = aborted;
agg.final = await p.evaluate(() => {
  const PED = window.__ped, C = window.__clock;
  return {
    minute: +C.minute.toFixed(2),
    sim: window.__sim ? window.__sim() : null,
    route: PED.routeStats ? PED.routeStats() : null,
    flee: PED.fleeStats ? PED.fleeStats() : null,
    // 连续运行记下的真实个案：完整事件链 + 每 2 仿真秒一帧的状态与判断。
    // 只导出出过事的人，未出事的人不写盘。
    cases: (PED.incidents && PED.incidents.exportCases)
      ? PED.incidents.exportCases(12) : [],
  };
});
writeFileSync(OUT, JSON.stringify(agg, null, 2));

// ---------------------------------------------------------------- 可读报告
const F = agg.final.sim || {};
const L = F.live || {}, D = F.driving || {}, I = F.incidents || {}, C = F.circles || {};
const n = (v) => Number(v || 0).toLocaleString('zh-CN');
const rows = agg.hourly.map((h) => `| ${String(h.hour).padStart(2, '0')}:00 | ${n(h.judged)} | ${n(h.driving)} | ${n(h.redLightWaits)} | ${n(h.yields)} | ${n(h.wading)} | ${n(h.stranded)} | ${n(h.injured)} | ${n(h.dead)} | ${n(h.evacuated)} | ${n(h.maxDepthCm)} |`).join('\n');
const causes = Object.entries(I.deathsByCause || {}).map(([k, v]) => `${k} ${v} 人`).join(' / ') || '无';
const md = `# 连续 24 小时实时决策仿真报告

- 降雨工况：**${CASE}**${agg.caseMeta ? `（${agg.caseMeta.pMmH} mm/h · ${agg.caseMeta.hyeto === 'day' ? '全天连绵雨' : '短时脉冲雨'} · 降雨 ${agg.caseMeta.rainStart}–${agg.caseMeta.rainEnd} 分 · 增水 ${agg.caseMeta.surgeM} m · 峰值湿区 ${agg.caseMeta.peakWetHa} ha）` : ''}
- 时段：${agg.startMinute} → ${agg.endMinute} 分钟（${((agg.endMinute - agg.startMinute) / 60).toFixed(1)} 小时，全程连续推进，无 seek）
- 人数：${n(agg.people)} 人 · 倍率 ×${agg.speed} · ${n(agg.frames)} 帧 · 墙钟 ${agg.wallSec} 秒
- 人群种子：${agg.seed}（固定种子，各工况用的是同一批人）
- 仿真秒：${n(agg.simSec)} · 页面脚本错误：${pageErrors.length}
- 积水与时钟同层：${agg.last ? agg.last.tMinSync : '—'} · 事件 ${n(agg.events)} 条 · 溢出 ${n(agg.overflow)}

## 一、速度一致性

| 项 | 值 |
| --- | --- |
| 自检 | ${F.speed && F.speed.ok ? '通过' : '未通过'} ${F.speed && F.speed.errors ? F.speed.errors.join('; ') : ''} |
| 步行基准 | ${F.speed ? F.speed.truth.walkBase : '—'} m/s |
| 城市限速 | ${F.speed ? F.speed.truth.carLimit : '—'} m/s（${F.speed ? Math.round(F.speed.truth.carLimit * 3.6) : '—'} km/h） |
| 1 分钟 | ${F.speed ? F.speed.truth.minuteSec : '—'} 仿真秒 |
| 信号周期 | ${F.speed ? F.speed.truth.redCycle : '—'} 仿真秒 |
| 实测超速次数 | ${n(D.speedViolations)} |
| 实测平均车速 | ${n(D.avgSpeedKmh)} km/h |

## 二、人群圈层（不是大类）

${n(C.people)} 人分出 **${n(C.distinctCircles)} 种圈层**，最大一种 ${n(C.largestCircle)} 人
（占比 ${C.largestShare || 0}）；有车 ${n(C.withCar)} 人，有照护责任 ${n(C.careDuty)} 人，
有接送孩子节点 ${n(C.withPickups)} 人，自驾/拼车通勤 ${n(C.driveCommute)} 人。

## 三、分层决策

- 快层判断总数：**${n(L.judged)}** 次（每 0.5~1 仿真秒一次「现在该干什么」）
- 动作分布：${Object.entries(L.byAction || {}).map(([k, v]) => `${k} ${n(v)}`).join(' · ')}
- 目标结果：${Object.entries(agg.goals || {}).map(([k, v]) => `${k} ${n(v)}`).join(' · ')}
- 无依据改道（没水没雨、没被挡没卡住没迟到，却绕路/掉头/放弃）：${n(agg.unjustified)} 次，应接近 0
- 绕开积水的路线：${n(agg.final.route ? agg.final.route.active : 0)} 人在按自己规划的路走

## 四、开车 / 交规 / 避让

| 项 | 值 |
| --- | --- |
| 出行方式请求 | ${n(D.requests)} 次 |
| 决定开车 / 步行 | ${n(D.driveChosen)} / ${n(D.walkChosen)} |
| 车池满改步行 | ${n(D.poolFull)} 次 |
| 接送孩子节点 | ${n(D.pickups)} 次 |
| 到达下车 | ${n(D.arrivals)} 次 |
| 累计行驶 | ${n(D.carKm)} km · ${n(D.drivingSec)} 仿真秒 |
| 等红灯 | ${n(I.redLightWaits)} 次 |
| 礼让行人 | ${n(I.yields)} 次 |
| 跟车 / 涉水慢行 | ${n((D.byAction || {}).follow)} / ${n((D.byAction || {}).wadeSlow)} 次 |
| 熄火 / 弃车 | ${n(I.stalled)} / ${n(I.abandonedCar)} |
| 超速违规 | ${n(D.speedViolations)} 次 |

驾驶快层动作：${Object.entries(D.byAction || {}).map(([k, v]) => `${k} ${n(v)}`).join(' · ')}

## 五、伤亡与被困（全部由真实状态逐子步判定，无预写数字）

| 项 | 人数 |
| --- | --- |
| 困死 / 溺亡 | **${n(I.dead)}** |
| 被困（累计发生 / 当前仍被困） | **${n(I.everStranded)}** / ${n(I.stranded)} |
| 受伤（累计发生 / 当前仍受伤） | **${n(I.everInjured)}** / ${n(I.injured)} |
| 涉水暴露过 | ${n(I.exposed)} |
| 避险成功 | ${n(I.evacuated)} |
| 水位退下脱困 | ${n(I.rescued)} |
| 车辆熄火 | ${n(I.stalled)} |
| 弃车逃生 | ${n(I.abandonedCar)} |

> 「累计发生」不会因后来脱困或进屋避险而被抹掉；「当前」是这一刻的状态快照。

- 死因分布：${causes}
- 事件最深水：${n(Math.round((I.maxDepth || 0) * 100))} cm
- 按片区：${JSON.stringify(I.byCircle || {})}
- 按年龄带：${JSON.stringify(I.byBand || {})}

死亡判定链：水深 ≥ ARR 危险分级限值静水深（儿童 0.5 m = H2、成人 1.2 m = H3，
**这是分级限值，不是实测个体失稳深度**）→ 连续浸泡超过耐受时间（体力、雨强
修正）→ 判定；在室内 / 避难 / 车内按各自阈值单独判（车内另有熄火 → 水位
上涨 → 未及时弃车 → 车内溺亡）。逐人可在
\`window.__ped.incidents.snapshot(i)\` 回查 minute / 坐标 / 水深 / 原因。

> **重要**：「失稳 → 伤亡」的定量函数四轮检索都没有找到；本判定链里的
> 暴露时长、滑倒概率、被困时长是**目前自己定的**，由此算出的伤亡／被困
> 是**模型输出，不是实测**，不能当研究结论报出去，交付时必须附敏感性分析。

## 六、逐时曲线

| 时刻 | 累计判断 | 在开车 | 等红灯 | 礼让 | 涉水 | 被困 | 受伤 | 死亡 | 避险 | 最深水 cm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

## 七、说明

- 本报告只反映**连续运行**的结果：拖动时间轴看的是按时刻重建的快照，
  经历会归零，不能用来反推本文任何数字。
- 倍率只改变每帧的仿真秒数；实时播放单子步 ≤0.2 仿真秒，本次离线验收
  （skipRender）为把 43 万子步减到 21 万，单子步放宽到 ≤0.4 仿真秒。
  人、车、水、判断、动作、伤亡计时全程共用同一个子步 h，不存在哪一层漏乘倍率。
- 原始全量数据：\`${OUT}\`
`;
writeFileSync(REPORT, md);

console.log('\n===== 连续仿真验收摘要 =====');
console.log(`工况 ${CASE} · 时段 ${agg.startMinute} → ${agg.endMinute} 分 · ${agg.people} 人 · ×${agg.speed} · ${agg.wallSec}s`);
console.log(`判断总数 ${n(L.judged)} · 事件 ${n(agg.events)} · 溢出 ${n(agg.overflow)}`);
console.log('动作分布', JSON.stringify(L.byAction || {}));
console.log('目标结果', JSON.stringify(agg.goals));
console.log('开车/到达', n(D.driveChosen), '/', n(D.arrivals), '· 等灯', n(I.redLightWaits), '礼让', n(I.yields));
console.log('伤亡 困死', n(I.dead), '累计被困', n(I.everStranded), '累计受伤', n(I.everInjured), '避险', n(I.evacuated));
console.log('圈层', n(C.distinctCircles), '种 · 开车', n(D.driveChosen), '次 · 超速', n(D.speedViolations));
console.log('无依据改道', agg.unjustified, '（应接近 0）');
console.log('积水与时钟同层', agg.last ? agg.last.tMinSync : '—', '· 脚本错误', pageErrors.length);
console.log('完整报表', OUT, '/', REPORT);
await b.close();
