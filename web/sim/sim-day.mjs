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
 *
 * 【2026-11-20 卡点诊断】u_p20_s0 两次跑到 440 / 840 分就无声停住，日志最后一行
 * 之后既没有报错也没有收尾——说明是**页面里某一帧卡死**（p.evaluate 永不返回），
 * 不是内核抛异常。原来整批 100 帧一次 evaluate，卡在哪一帧、哪一分钟外面看不见。
 * 现在拆成：
 *   1) 一帧一次 __frame(dt,1,true)（与 __frame(dt,n,true) 逐帧等价，见 main.js:2274），
 *      在页面里量每帧墙钟，>SLOW_MS 立刻 console 上报；
 *   2) 每 50 帧上报一条 PROG（帧号/分钟/在场人数）。控制台消息由 CDP 立刻送出，
 *      不等页面线程空闲，所以真卡死时最后一条 PROG 就是卡住的位置；
 *   3) Node 侧每批套 SIM_BATCH_TIMEOUT 毫秒的硬超时；超时就打印
 *      「第几分钟 / 第几批 / 当时在场人数」并退出，不再无声消失。
 * 可用环境变量：SIM_BATCH（每批帧数，默认 100）、SIM_BATCH_TIMEOUT（默认 180000）、
 * SIM_SLOW_MS（单帧慢阈值，默认 4000）。
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
const BATCH = Math.max(1, Number(process.env.SIM_BATCH || 100));
const DT = 0.1;                  // 真实秒/帧（CLOCK 会钳到 0.1）
// 单批硬超时：正常一批（100 帧 = 4 仿真分钟）实测 5–30 s，暴雨段最慢约 28 s，
// 180 s 已是 6 倍余量；超过它就不是「慢」而是卡死。
const BATCH_TIMEOUT = Math.max(10000, Number(process.env.SIM_BATCH_TIMEOUT || 180000));
// 单帧慢阈值：一帧正常 0.05–0.3 s，>4 s 说明这一帧里有人卡在寻路/碰撞里。
const SLOW_MS = Math.max(500, Number(process.env.SIM_SLOW_MS || 4000));
// 【相机解耦验收 2026-11-20】表现层机位不许影响行为。SIM_VIEW 把机位切到
// __setView 的预设（city / mall / street …），用来对同一段仿真做 A/B：
// 若两台的「判断数 / 涉水 / 避险 / 困死」不同，说明行为还挂在相机上。
// 空 = 页面默认机位（web/src/main.js:153 的街面近景）。
const VIEW = (process.env.SIM_VIEW || '').trim();

if (!CHROME) throw new Error('找不到 Chrome / Edge 可执行文件');
mkdirSync(dirname(OUT), { recursive: true });

const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 3600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=6144'],
});
const p = await b.newPage();
// 泄漏判定要用「强制 GC 后的存活堆」，不能看 usedJSHeapSize（它含尚未回收的垃圾，
// 随 GC 时机上下跳，2026-11-20 两次 80 分钟短跑分别读到 1938→1688 和 640→1404）。
const cdp = await p.createCDPSession();
async function heapAfterGC() {
  try { await cdp.send('HeapProfiler.collectGarbage'); } catch { /* 忽略 */ }
  try { return await p.metrics(); } catch { return null; }
}
await p.setViewport({ width: 900, height: 560 });
const pageErrors = [];
// 卡点：页面每 50 帧上报一条 PROG，这里保留最后一条。真卡死时它是唯一线索。
let lastProg = null;
p.on('pageerror', (e) => pageErrors.push(e.message));
p.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('PROG ')) {
    try { lastProg = JSON.parse(t.slice(5)); } catch { /* 半截消息忽略 */ }
    return;
  }
  if (m.type() === 'error') pageErrors.push('console: ' + t);
});

const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1');
u.searchParams.set('ped', String(PEOPLE));
u.searchParams.set('v', String(Date.now()));
u.searchParams.set('seed', String(SEED));
// 【单变量 A/B 2026-11-20】SIM_FOUND=off → 关掉逐栋首层高（全城 0.457 m），
// 或填 A_全国河岸 / C_商业为主 换占比假设。不设时用页面默认（B_老城排屋）。
const FOUND = (process.env.SIM_FOUND || '').trim();
if (FOUND) u.searchParams.set('found', FOUND);
// 【§5 时间层 2026-11-20】SIM_TL=1 → 打开「发布/收到/动身」三钟（默认关闭）。
const TL = (process.env.SIM_TL || '').trim();
if (TL === '1' || TL === 'on') u.searchParams.set('timelayer', '1');
// 【2026-11-21 冲走判据】SIM_SWEPT=unstable → 打开「D·V 达失稳上限即判被冲走」。
// 默认关闭；主结果两版都跑，差值就是这条判据的贡献（docs/冲走判据改法_2026-11-21.md）。
const SW = (process.env.SIM_SWEPT || '').trim().toLowerCase();
if (SW === 'unstable' || SW === 'on') u.searchParams.set('swept', 'unstable');
// 【2026-11-21 经验修正】SIM_EXP=off → 关闭「经验 → 多快动员」，回到经验不进概率的旧口径。
const EX = (process.env.SIM_EXP || '').trim().toLowerCase();
if (EX === 'off' || EX === '0') u.searchParams.set('exp', 'off');
// 【2026-11-21 门1】SIM_RECV=off 关闭接收渠道重分配；SIM_RECV_RATIO=0.5/2 做敏感性。
{
  const RV = (process.env.SIM_RECV || '').trim().toLowerCase();
  if (RV === 'off' || RV === '0') u.searchParams.set('recv', 'off');
  if (process.env.SIM_RECV_RATIO) u.searchParams.set('recvratio', String(process.env.SIM_RECV_RATIO));
}
// 【2026-11-21 敏感性】四条单变量开关，一次只开一条：
//   SIM_KAPPA=0.5|2       经验→门3 尺度比
//   SIM_CROWD=coefficient|off  从众渠道（默认 threshold）
//   SIM_SLIP=off          关掉 D·V 受伤判据
//   SIM_SLIP_LO=0.35|1.4  受伤判据成人下界；SIM_SLIP_HI=1.4 改上界
{
  const K = (process.env.SIM_KAPPA || '').trim(); if (K) u.searchParams.set('kappa', K);
  const CM = (process.env.SIM_CROWD || '').trim(); if (CM) u.searchParams.set('crowd', CM);
  const SP = (process.env.SIM_SLIP || '').trim(); if (SP) u.searchParams.set('slip', SP);
  const SL = (process.env.SIM_SLIP_LO || '').trim(); if (SL) u.searchParams.set('sliplo', SL);
  const SH = (process.env.SIM_SLIP_HI || '').trim(); if (SH) u.searchParams.set('sliphi', SH);
  // 暴露时长整体倍数：0.5 / 2 两档是「说得通」的最低要求（见参数依据表 casualty 段）
  const CS = (process.env.SIM_CAS_SCALE || '').trim(); if (CS) u.searchParams.set('casscale', CS);
  // 参照群体生成器（2026-11-22）：SIM_PEER=synthetic|neighbour|household 切换模式，
  // SIM_PEER_R / SIM_PEER_Q 改短程半径与长程边数（扫稳健性用，见 kernel/peer-network.js）。
  const PN = (process.env.SIM_PEER || '').trim(); if (PN) u.searchParams.set('peer', PN);
  const PNR = (process.env.SIM_PEER_R || '').trim(); if (PNR) u.searchParams.set('peerR', PNR);
  const PNQ = (process.env.SIM_PEER_Q || '').trim(); if (PNQ) u.searchParams.set('peerQ', PNQ);
  // 【2026-11-22 消融】决策结构：SIM_DECIDE=single 走单式效用基线，
  // SIM_SINGLE=merge|raw 选合并方式（默认 gate = 五道门，见 kernel/choice-model.js）。
  const DM = (process.env.SIM_DECIDE || '').trim(); if (DM) u.searchParams.set('decide', DM);
  const SV = (process.env.SIM_SINGLE || '').trim(); if (SV) u.searchParams.set('single', SV);
}
// 【2026-11-22 个案导出上限】必须由 Node 读环境变量、再通过 URL 传进页面：
// 收尾快照是在 page.evaluate() 里跑的（浏览器上下文），那里**没有 process**。
// 我第一版直接在闭包写 process.env.SIM_CASES_MAX → 每次收尾都抛 "process is not defined"，
// final.sim 变成 null、死亡数全读成 0，而且不报错——整批 8 个工况白跑。
const CASES_MAX = Math.max(1, Number(process.env.SIM_CASES_MAX || 12));
u.searchParams.set('casesmax', String(CASES_MAX));
// 【2026-11-21 个体追溯】SIM_TRACE=<人序号> → 追这一个人，跑完写 trace JSON。
// 用途：导师要的「定位某个受困/溺亡者，复现其完整过程」。traceTarget 记在 agg 里，
// 结果文件和 trace 文件用同一个 case 名，回放/写报告时不会拿错人。
const TRACE_RAW = (process.env.SIM_TRACE || '').trim();
const traceTarget = (TRACE_RAW === '' || TRACE_RAW.toLowerCase() === 'off')
  ? -1 : Number(TRACE_RAW);
if (Number.isFinite(traceTarget) && traceTarget >= 0) {
  u.searchParams.set('trace', String(traceTarget));
}
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });

// ---------------------------------------------------------------- 起点对齐
const start = await p.evaluate(async (sp, m, cs, view) => {
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
  // 【相机 A/B】只切机位，不 seek、不动时间。空字符串保持页面默认。
  // 特殊值 'crowd'：把相机**放进人群里**（质心、眼睛高度 2 m）。
  // 为什么不是高空俯视：运行时可见性用的是 3D 距离（web/src/ped.js:54
  // VIS_DIST=360），相机抬到 260 m 时 3D 距离已经吃掉 260 m，质心又在
  // 城市中间、人群铺开上千米，实测 visAtStart 只有 17 人，和默认机位的
  // 15 人几乎一样，A/B 测不出差别。站到人群里才能让几百人真的可见。
  if (view === 'crowd') {
    const cam = window.__camera;
    let sx = 0, sz = 0, nn = 0;
    for (const pd of PED.peds) { sx += pd.obj.position.x; sz += pd.obj.position.z; nn++; }
    if (cam && nn) {
      const cx = sx / nn, cz = sz / nn;
      cam.position.set(cx, 2.0, cz);
      cam.lookAt(cx, 2.0, cz - 100);
    }
  } else if (view && window.__setView) window.__setView(view);
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
  // 起点时相机 VIS_DIST 内有多少人——用途只有一个：证明 A/B 两台的人确实
  // 处在不同可见性下（否则「两台结果相同」可能是因为相机根本没起作用）。
  // 按 3D 距离算（与运行时 p.dist 同口径，web/src/ped.js:54 VIS_DIST = 360），
  // 不引用运行时的 p.visible（它要到第一帧 update 才会被写）。
  const cam = window.__camera;
  let visN = 0;
  if (cam) {
    for (const pd of PED.peds) {
      const dx = pd.obj.position.x - cam.position.x;
      const dy = pd.obj.position.y - cam.position.y;
      const dz = pd.obj.position.z - cam.position.z;
      if (Math.hypot(dx, dy, dz) < 360) visN++;
    }
  }
  let peakWet = 0;
  if (man && man.frames) for (const fr of man.frames) peakWet = Math.max(peakWet, fr.wet_ha || 0);
  // 【逐栋首层高诊断】确认运行时真的拿到了逐栋表，并看它落到人身上是什么分布。
  // 只读：不改任何人，只统计家里那栋楼的首层高。
  const found = (() => {
    try {
      const meta = window.__foundation || null;
      const CL = window.__crowdLife;
      if (!meta || !CL || !CL.persons) return { ready: false };
      const hist = {};
      let n = 0;
      for (const q of CL.persons) {
        if (!q) continue;
        const v = Number(q.homeFoundationM);
        const k = Number.isFinite(v) && v > 0 ? v.toFixed(2) : 'none';
        hist[k] = (hist[k] || 0) + 1; n++;
      }
      return { ready: true, scenario: meta.scenario, buildings: meta.count,
        coverage: meta.coverage, persons: n, hist };
    } catch (e) { return { ready: false, error: String(e && e.message) }; }
  })();
  return { people: PED.peds.length, minute: C.minute, tMin: F ? F.tMin : null,
    // 机位诊断：这一帧有多少人在 VIS_DIST 内（web/src/ped.js:54）。相机解耦后
    // 这个数只该影响渲染，不该影响任何行为计数。
    view: view || '(default)', visAtStart: visN, foundation: found,
    cohort, circles, speedTruth: f ? f.speed : null,
    circleStats: f ? f.circles : null,
    caseMeta: man ? { name: (man.source || '').split('/').filter(Boolean).pop(),
      pMmH: man.p_mm_h ?? null, surgeM: man.surge_m ?? null,
      hyeto: man.hyetograph || '', rainStart: man.rain_start_min ?? null,
      rainEnd: man.rain_end_min ?? null, frames: (man.frames || []).length,
      peakWetHa: +peakWet.toFixed(1) } : null };
}, SPEED, START_MINUTE, CASE, VIEW);

// ---------------------------------------------------------------- 流式聚合
const agg = {
  minutes: MINUTES, speed: SPEED, people: start.people,
  case: CASE, caseMeta: start.caseMeta, seed: SEED,
  view: start.view, visAtStart: start.visAtStart, foundation: start.foundation,
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

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(label + ' 超时 ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** 卡死时的统一出口：打印分钟/批号/在场人数，落快照，然后硬退出。 */
function dieStuck(reason, batchNo, fFrom, fTo) {
  const where = lastProg
    ? `第 ${lastProg.minute} 分钟（帧 ${lastProg.f}）· 在场 ${lastProg.people} 人（PED.peds 总数，含具名 1 人）`
    : '页面没有回报过任何 PROG（卡在第一帧就死了）';
  console.error('\n[stuck] ' + reason);
  console.error(`[stuck] 第 ${batchNo} 批（帧 ${fFrom}–${fTo}）· ${where}`);
  console.error(`[stuck] 已完成 ${agg.frames}/${totalFrames} 帧 · 事件 ${agg.events} 条 · 墙钟 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (lastProg && lastProg.ms > SLOW_MS) console.error(`[stuck] 最后成功帧耗时 ${lastProg.ms} ms（>${SLOW_MS} ms）`);
  try {
    writeFileSync(OUT.replace(/\.json$/i, '') + '.stuck.json',
      JSON.stringify({ ...agg, batchNo, fFrom, fTo, lastProg, final: null }, null, 2));
    console.error('[stuck] 卡点快照 ' + OUT.replace(/\.json$/i, '') + '.stuck.json');
  } catch (e) { console.error('[stuck] 快照写盘失败 ' + e.message); }
  // 页面线程已死，b.close() 会一起挂住；直接退，让 sweep 的 close 事件拿到非零码。
  process.exit(2);
}

let lastHour = -1;
for (let f = 0; f < totalFrames && !aborted; f += BATCH) {
  const n = Math.min(BATCH, totalFrames - f);
  const batchNo = agg.batches + 1;
  const tb = Date.now();
  let batch;
  try {
    batch = await withTimeout(p.evaluate((frames, dt, f0, slowMs) => {
      const C = window.__clock, PD = window.__ped;
      const slow = [];
      // 一帧一次：与 __frame(dt, frames, true) 逐帧等价（main.js:2274 就是 for 循环），
      // 但这样每一帧都能量墙钟，并能把卡点精确到帧。
      for (let k = 0; k < frames; k++) {
        const tf = performance.now();
        window.__frame(dt, 1, true);   // 只跑仿真，不渲染
        const ms = performance.now() - tf;
        const bad = ms > slowMs;
        if (bad) slow.push({ f: f0 + k, minute: +C.minute.toFixed(2), ms: Math.round(ms) });
        if (bad || k % 50 === 0) {
          console.log('PROG ' + JSON.stringify({ f: f0 + k + 1, minute: +C.minute.toFixed(2),
            people: PD.peds.length, ms: Math.round(ms) }));
        }
        if (bad) console.log('SLOWFRAME ' + JSON.stringify({ f: f0 + k, minute: +C.minute.toFixed(2),
          ms: Math.round(ms), peds: PD.peds.length, judged: PD.live ? PD.live.judged : null }));
      }
      const ev = PD.live ? PD.live.events.splice(0) : [];
      const st = PD.live ? PD.live.stats() : null;
      // 泄漏体检：three 的纹理/几何计数、场景子节点、积涝缓存项数。
      // 堆一直涨时，看是这三项之一在涨（GPU/DOM 泄漏），还是都平（纯 JS 对象留住了）。
      const R = window.__renderer;
      const gm = R && R.info && R.info.memory;
      const mem = {
        tex: gm ? gm.textures : null,
        geo: gm ? gm.geometries : null,
        scene: window.__scene ? window.__scene.children.length : null,
        u8: window.__flood && window.__flood.u8Cache ? window.__flood.u8Cache.size : null,
        heapMB: Math.round((performance.memory ? performance.memory.usedJSHeapSize : 0) / 1048576),
      };
      return {
        ev, st, slow, mem,
        minute: C.minute,
        tMin: window.__flood ? window.__flood.tMin : null,
        route: PD.routeStats ? PD.routeStats() : null,
        flee: PD.fleeStats ? PD.fleeStats() : null,
        drive: PD.drive ? PD.drive.stats() : null,
      };
    }, n, DT, f, SLOW_MS), BATCH_TIMEOUT, '第 ' + batchNo + ' 批');
  } catch (e) {
    dieStuck(e && e.message ? e.message : String(e), batchNo, f, f + n - 1);
  }
  const batchMs = Date.now() - tb;
  if (batch.slow && batch.slow.length) {
    console.log(`[sim] 慢帧 ${batch.slow.length} 个（>${SLOW_MS}ms）· 最慢 ${Math.max(...batch.slow.map((s) => s.ms))}ms`);
    for (const s of batch.slow.slice(0, 5)) {
      console.log(`[sim]   帧 ${s.f} @ ${s.minute} 分 耗时 ${s.ms}ms`);
    }
  }
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
    const mb = (v) => (v / 1048576).toFixed(0);
    console.log(`[sim] ${pct}% · ${agg.last.minute} 分 · 判断 ${agg.events} 条 · 本批 ${(batchMs / 1000).toFixed(1)}s · ${sec}s`);
    // 存活堆（强制 GC 后）：如果 p20 是内存耗死，这两列会一直往上爬；如果是卡在某一帧，它们是平的。
    try {
      const mt = await heapAfterGC();
      if (!mt) throw new Error('metrics 不可用');
      const k = batch.mem || {};
      console.log(`[sim]   存活堆 ${mb(mt.JSHeapUsedSize)}MB · 节点 ${mt.Nodes} · 监听 ${mt.JSEventListeners}`
        + ` · 纹理 ${k.tex} 几何 ${k.geo} 场景子 ${k.scene}`);
    } catch (e) { console.log(`[sim]   取不到页面指标: ${e.message}`); }
  }
  // 每 50 批落一次盘：24h 跑得久，中途被中断也能拿到已采集的逐时数据。
  if (agg.batches % 50 === 0) {
    writeFileSync(OUT.replace(/\.json$/i, '') + '.partial.json',
      JSON.stringify({ ...agg, lastProg, final: null }, null, 2));
  }
}

// ---------------------------------------------------------------- 收尾
agg.endMinute = agg.last ? agg.last.minute : start.minute;
agg.wallSec = +((Date.now() - t0) / 1000).toFixed(1);
agg.aborted = aborted;
// 收尾快照也套超时：页面要是正好在最后一帧卡住，不能连已跑完的 hourly 一起丢掉。
try {
  agg.final = await withTimeout(p.evaluate((casesMax) => {
    const PED = window.__ped, C = window.__clock;
    return {
      minute: +C.minute.toFixed(2),
      sim: window.__sim ? window.__sim() : null,
      route: PED.routeStats ? PED.routeStats() : null,
      flee: PED.fleeStats ? PED.fleeStats() : null,
      // 连续运行记下的真实个案：完整事件链 + 每 2 仿真秒一帧的状态与判断。
      // 只导出出过事的人，未出事的人不写盘。
      // 【2026-11-22 创新点 #3】个案导出上限从固定 12 改成 SIM_CASES_MAX（默认仍 12）。
      // 为什么必须能放开：cases() 先按「status 严重度 → maxDepth」排序再截断，所以
      // 12 条上限取到的是「最深的 12 个死者」，不是「全部死者」——拿它统计死因构成
      // 会系统性偏向深水（实测 u_p16_s0 30 个死者只导出 12 个）。导出多少不影响仿真
      // 本身（只是写盘），所以批跑中途改这个上限不会让同一批的计数不可比。
      cases: (PED.incidents && PED.incidents.exportCases)
        ? PED.incidents.exportCases(casesMax) : [],
      // 【§5 时间层】三个时刻的分布（发布/收到/动身）；默认关闭时 enabled=false。
      timeLayer: PED.timeLayerSummary ? PED.timeLayerSummary() : null,
    };
  }, CASES_MAX), BATCH_TIMEOUT, '收尾快照');
} catch (e) {
  // 注意：这里出错会让 final.sim 变成 null，随后任何人算指标都会得到 0。
  // 所以「0 死亡」必须先看 final.error 在不在（decide-ab / trace-deep 已加拒绝）。
  console.error('[stuck] 收尾快照失败：' + (e && e.message ? e.message : e));
  agg.final = { minute: agg.endMinute, sim: null, route: null, flee: null, cases: [], error: String(e && e.message || e) };
}
// 【2026-11-21 个体追溯】跑完把被追那人的记录取出来单独存一份（与结果同名 .trace.json）。
// 导师要的是「定位某个受困/溺亡者，复现其完整过程」，所以 trace 必须能单独打开、
// 不依赖重跑；结果 JSON 里只留一句摘要，避免「有 trace 文件但没人知道追的是谁」。
if (Number.isFinite(traceTarget) && traceTarget >= 0) {
  try {
    const tr = await p.evaluate(() => (window.__trace ? window.__trace() : null));
    if (tr && Array.isArray(tr.events)) {
      const tf = OUT.replace(/\.json$/i, '') + '.trace.json';
      writeFileSync(tf, JSON.stringify(tr, null, 2));
      const id = tr.identity || {};
      agg.trace = {
        target: traceTarget,
        file: tf,
        records: tr.records,
        truncated: !!tr.truncated,
        identity: { age: id.age ?? null, sex: id.sex ?? null, socCode: id.socCode ?? null,
          role: id.role ?? null, hasCar: id.hasCar ?? null, workPlace: id.workPlace ?? null },
      };
      console.log('TRACE ' + JSON.stringify(agg.trace));
    } else {
      console.error('[trace] 页面没有返回记录（?trace 是否真的传进去了）');
    }
  } catch (e) {
    console.error('[trace] 导出失败：' + (e && e.message ? e.message : e));
  }
}
writeFileSync(OUT, JSON.stringify(agg, null, 2));

// ---------------------------------------------------------------- 可读报告
const F = (agg.final && agg.final.sim) || {};
const L = F.live || {}, D = F.driving || {}, I = F.incidents || {}, C = F.circles || {};
const n = (v) => Number(v || 0).toLocaleString('zh-CN');
const rows = agg.hourly.map((h) => `| ${String(h.hour).padStart(2, '0')}:00 | ${n(h.judged)} | ${n(h.driving)} | ${n(h.redLightWaits)} | ${n(h.yields)} | ${n(h.wading)} | ${n(h.stranded)} | ${n(h.injured)} | ${n(h.dead)} | ${n(h.evacuated)} | ${n(h.maxDepthCm)} |`).join('\n');
const causes = Object.entries(I.deathsByCause || {}).map(([k, v]) => `${k} ${v} 人`).join(' / ') || '无';
const md = `# 连续 24 小时实时决策仿真报告

- 降雨工况：**${CASE}**${agg.caseMeta ? `（${agg.caseMeta.pMmH} mm/h · ${agg.caseMeta.hyeto === 'day' ? '全天连绵雨' : '短时脉冲雨'} · 降雨 ${agg.caseMeta.rainStart}–${agg.caseMeta.rainEnd} 分 · 增水 ${agg.caseMeta.surgeM} m · 峰值湿区 ${agg.caseMeta.peakWetHa} ha）` : ''}
- 时段：${agg.startMinute} → ${agg.endMinute} 分钟（${((agg.endMinute - agg.startMinute) / 60).toFixed(1)} 小时，全程连续推进，无 seek）
- 人数：${n(agg.people)} 人 · 倍率 ×${agg.speed} · ${n(agg.frames)} 帧 · 墙钟 ${agg.wallSec} 秒
- 人群种子：${agg.seed}（固定种子，各工况用的是同一批人）
- 机位：${agg.view === '(default)' ? '页面默认（街面近景）' : agg.view}；起点时相机 360 m 内 ${agg.visAtStart} 人${agg.view === '(default)' ? '' : '（仅用于相机解耦 A/B，不作为结果口径）'}
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
- 绕开积水的路线：${n(agg.final && agg.final.route ? agg.final.route.active : 0)} 人在按自己规划的路走

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
