/**
 * _probe_final.mjs — 3000 人最终验收探针（只读）
 * 用法: node _probe_final.mjs [人数=3000]
 * A 决策覆盖 + 逐帧动作一致性 + 倍率同步（连续播放，不拖时间轴）
 * B 今日经历累积 + 经历影响走势（暴雨窗口连续跑）
 */
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME = [
  'C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(fs.existsSync);
const N = Number(process.argv[2] || 3000);
const B_FRAMES = Number(process.argv[3] || 7000);

const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 1200000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await b.newPage();
await page.setViewport({ width: 800, height: 500 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1');
u.searchParams.set('ped', String(N));
u.searchParams.set('v', String(Date.now()));
await page.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready === true, { timeout: 900000, polling: 300 });

// ---------------- A：白天连续播放，逐帧核对动作与决策 ----------------
const A = await page.evaluate(() => {
  const C = window.__clock, PED = window.__ped, CL = window.__crowdLife;
  C.setPlaying(false); C.seek(420); window.__frame(0, 2);
  C.setSpeed(12); C.setPlaying(true);
  const peds = PED.peds;
  const tally = {};            // lastAction | clip -> n
  const outdoorSeen = new Set();
  let outdoorEver = 0, frames = 0, zeroMoveWithWalk = 0;
  const prev = new Float64Array(peds.length * 2);
  for (let f = 0; f < 150; f++) {
    for (let i = 0; i < peds.length; i++) {
      prev[i * 2] = peds[i].obj.position.x;
      prev[i * 2 + 1] = peds[i].obj.position.z;
    }
    window.__frame(0.05, 1, true);
    frames++;
    for (let i = 0; i < peds.length; i++) {
      const q = CL.at(i), a = PED.live.agent(i), pp = peds[i];
      if (!a) continue;
      if (!q.indoor) { outdoorEver++; outdoorSeen.add(i); }
      const clip = pp.cur ? String(pp.cur.getClip().name) : 'none';
      const key = a.lastAction + '|' + clip;
      tally[key] = (tally[key] || 0) + 1;
      const moved = Math.hypot(pp.obj.position.x - prev[i * 2],
        pp.obj.position.z - prev[i * 2 + 1]);
      if (moved < 0.001 && /walk|run/.test(clip) && !q.indoor) zeroMoveWithWalk++;
    }
  }
  // 室外的人是否 100% 自己判断过
  let outdoorJudged = 0, outdoorTotal = 0;
  for (const i of outdoorSeen) {
    outdoorTotal++;
    const a = PED.live.agent(i);
    if (a && a.recent && a.recent.length > 0) outdoorJudged++;
  }
  const st = PED.live.stats();
  C.setPlaying(false);
  return {
    frames, minute: +C.minute.toFixed(2), outdoorTotal, outdoorJudged,
    zeroMoveWithWalk, actKeys: Object.keys(peds[10].acts || {}),
    judged: st.judged, budgetBlocked: st.budgetBlocked,
    byAction: st.byAction,
    tally: Object.fromEntries(Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 18)),
    hurryRun: (tally['hurry|run'] || 0), hurryWalk: (tally['hurry|walk'] || 0),
    waitIdle: (tally['wait|idle'] || 0), waitWalk: (tally['wait|walk'] || 0),
  };
});

// ---------------- A2：倍率同步（×1 对 ×12，同一段、同一初值） ----------------
const A2 = await page.evaluate(() => {
  const C = window.__clock, PED = window.__ped;
  const run = (sp, frames) => {
    C.setPlaying(false); C.seek(500); window.__frame(0, 2);
    const st0 = PED.live.stats();
    C.setSpeed(sp); C.setPlaying(true);
    for (let f = 0; f < frames; f++) window.__frame(0.05, 1, true);
    const st1 = PED.live.stats();
    C.setPlaying(false);
    const dSim = st1.simSec - st0.simSec;
    return { dMin: +(C.minute - 500).toFixed(4), dSimSec: +dSim.toFixed(2),
      dJudged: st1.judged - st0.judged,
      judgedPerSimSec: +((st1.judged - st0.judged) / Math.max(0.01, dSim)).toFixed(2) };
  };
  const a = run(1, 300), c = run(12, 300);
  return { x1: a, x12: c,
    ratioMinute: +(c.dMin / Math.max(1e-6, a.dMin)).toFixed(2),
    ratioSimSec: +(c.dSimSec / Math.max(1e-6, a.dSimSec)).toFixed(2),
    ratioJudgeRate: +(c.judgedPerSimSec / Math.max(0.01, a.judgedPerSimSec)).toFixed(2) };
});

// ---------------- B：暴雨窗口连续跑，看经历累积与走势差异 ----------------
const B = await page.evaluate((bFrames) => {
  const C = window.__clock, PED = window.__ped, CL = window.__crowdLife, F = window.__flood;
  C.setPlaying(false); C.seek(1000); window.__frame(0, 2);
  C.setSpeed(48); C.setPlaying(true);
  const startMin = C.minute;
  let frames = 0;
  // 跑到 20:00（约 200 仿真分钟），跳过渲染，只推进仿真
  while (C.minute < 1200 && frames < bFrames) { window.__frame(0.05, 1, true); frames++; }
  C.setPlaying(false);
  const EXP = PED.experience;
  const es = EXP.stats();
  // 经历分组：蹚过 >22cm 深水 vs 没有，统计后续换街/放弃率
  const groups = { deep: { n: 0, detour: 0, abandon: 0, wait: 0 },
    shallow: { n: 0, detour: 0, abandon: 0, wait: 0 } };
  const wetGroups = { wet: { n: 0, abandon: 0, wait: 0 },
    dry: { n: 0, abandon: 0, wait: 0 } };
  const umb = { withU: { n: 0, wet: 0, shelter: 0 }, noU: { n: 0, wet: 0, shelter: 0 } };
  let maxWalk = 0, maxHomeBias = 0, diversity = new Set();
  for (let i = 0; i < PED.peds.length; i++) {
    const s = EXP.snapshot(i);
    if (!s) continue;
    const a = PED.live.agent(i);
    const det = a ? (a.detours || 0) : 0;
    const g = s.maxDepthCm > 22 ? groups.deep : groups.shallow;
    g.n++; g.detour += s.detours; g.abandon += s.abandons; g.wait += s.waits;
    const w = s.wetnessPct > 45 ? wetGroups.wet : wetGroups.dry;
    w.n++; w.abandon += s.abandons; w.wait += s.waits;
    const u = s.hasUmbrella ? umb.withU : umb.noU;
    u.n++; u.wet += s.wetnessPct; u.shelter += s.shelterSec;
    if (s.walkedM > maxWalk) maxWalk = s.walkedM;
    if (s.homeBias > maxHomeBias) maxHomeBias = s.homeBias;
    diversity.add(s.lastAction);
  }
  const avg = (o, k, d) => o.n ? +(o[k] / o.n).toFixed(3) : 0;
  const samples = [3, 51, 211, 777].filter((i) => i < PED.peds.length)
    .map((i) => ({ i, ...EXP.snapshot(i) }));
  return {
    frames, from: +startMin.toFixed(1), to: +C.minute.toFixed(1),
    rainNow: F.rainRate ? +F.rainRate().toFixed(1) : -1,
    expStats: es,
    deepVsShallow: {
      deep: { n: groups.deep.n, detourPer: avg(groups.deep, 'detour'),
        abandonPer: avg(groups.deep, 'abandon') },
      shallow: { n: groups.shallow.n, detourPer: avg(groups.shallow, 'detour'),
        abandonPer: avg(groups.shallow, 'abandon') },
    },
    wetVsDry: {
      wet: { n: wetGroups.wet.n, abandonPer: avg(wetGroups.wet, 'abandon'),
        waitPer: avg(wetGroups.wet, 'wait') },
      dry: { n: wetGroups.dry.n, abandonPer: avg(wetGroups.dry, 'abandon'),
        waitPer: avg(wetGroups.dry, 'wait') },
    },
    umbrella: {
      withU: { n: umb.withU.n, avgWetPct: avg(umb.withU, 'wet'), avgShelterSec: avg(umb.withU, 'shelter') },
      noU: { n: umb.noU.n, avgWetPct: avg(umb.noU, 'wet'), avgShelterSec: avg(umb.noU, 'shelter') },
    },
    maxWalkM: maxWalk, maxHomeBias: +maxHomeBias.toFixed(2),
    lastActionKinds: diversity.size,
    samples,
    liveStats: PED.live.stats(),
  };
}, B_FRAMES);

console.log(JSON.stringify({ A, A2, B, errs }, null, 1));
await b.close();
