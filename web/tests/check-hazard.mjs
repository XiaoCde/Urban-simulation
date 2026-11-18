/**
 * _check_hazard.mjs — 灾害履历 / 避险选址 / 预警距离 专项实测。
 *
 * 口径：从 17:45 的按时刻快照起，用 ×24 **连续推帧** 90 分钟覆盖整个暴雨
 * 窗口（17:52–18:35）。这是专项分组对比，不是正式 24h 验收；静态的灾害
 * 履历不随 seek 清零，所以两组差异仍来自真实判断，不由快照伪造。
 *
 * 用法：node _check_hazard.mjs [人数=400] [帧数=4500]
 */
import puppeteer from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';

const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const N = Number(process.argv[2] || 400);
const FRAMES = Number(process.argv[3] || 4500);
if (!CHROME) throw new Error('找不到 Chrome / Edge');

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  protocolTimeout: 900000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 1000, height: 620 });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1');
u.searchParams.set('ped', String(N));
u.searchParams.set('v', String(Date.now()));
u.searchParams.set('seed', '20261117');
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
await p.evaluate(() => { window.__manualDrive = true; });

const init = await p.evaluate(() => {
  const PED = window.__ped, C = window.__clock;
  C.setPlaying(true); C.setSpeed(24);
  C.seek(1065);                       // 17:45，紧接着连续推帧
  return {
    people: PED.peds.length, minute: C.minute,
    hazard: PED.crowdLife.stats().hazard,
    speedAudit: PED.speedAudit,
    kernelSample: [0, 1, 2].map((i) => {
      const a = PED.live.agent(i);
      return { i, sightM: a.kernel.sightM, hazard: a.kernel.hazard,
        tier: a.kernel.hazardTier, wade: +a.kernel.wade.toFixed(3),
        temp: +a.kernel.temp.toFixed(3) };
    }),
  };
});

const BATCH = 500;
for (let done = 0; done < FRAMES; done += BATCH) {
  const n = Math.min(BATCH, FRAMES - done);
  await p.evaluate((k) => window.__frame(0.05, k, true), n);
  if ((done / BATCH) % 2 === 0) console.log(`[hazard] ${Math.min(100, Math.round(100 * (done + n) / FRAMES))}%`);
}

const R = await p.evaluate(() => {
  const PED = window.__ped, C = window.__clock, LIVE = PED.live;
  const tiers = PED.crowdLife.persons.map((q) => (q.hazard ? q.hazard.tier : 'naive'));
  const blank = () => ({ n: 0, detours: 0, waits: 0, judged: 0, earlyWarn: 0,
    maxDepthSum: 0, refuge: 0, high: 0, highPool: 0, riseSum: 0, distSum: 0,
    sightMSum: 0, wadeSum: 0, tempSum: 0 });
  const g = { naive: blank(), aware: blank(), veteran: blank() };
  // 【控制职业】wade 基线由 roles.js 的 8 类身份决定，直接比分组均值会被
  // 「有经验组里蓝领多」混淆。这里按 status 分层，只在同一身份内部比。
  const wadeByStatus = {};
  for (let i = 0; i < PED.peds.length; i++) {
    const t = tiers[i] || 'naive', o = g[t];
    const e = PED.experience.snapshot(i);
    const a = LIVE.agent(i);
    const k = a.kernel;
    o.n++;
    o.detours += e.detours; o.waits += e.waits; o.judged += e.judged;
    o.earlyWarn += a.earlyWarn || 0;
    o.maxDepthSum += e.maxDepthCm;
    o.sightMSum += k.sightM || 40;
    o.wadeSum += k.wade || 0.25;
    o.tempSum += k.temp || 0.8;
    const st = k.status || '?';
    const w = wadeByStatus[st] || (wadeByStatus[st] = {
      naive: { n: 0, s: 0 }, aware: { n: 0, s: 0 }, veteran: { n: 0, s: 0 },
    });
    w[t].n++; w[t].s += (k.wade || 0.25);
  }
  let sameStatusWin = 0, sameStatusTotal = 0;
  const wadeControlled = {};
  for (const [st, w] of Object.entries(wadeByStatus)) {
    const na = w.naive.n ? w.naive.s / w.naive.n : null;
    const ve = w.veteran.n ? w.veteran.s / w.veteran.n : null;
    wadeControlled[st] = { naive: na === null ? null : +na.toFixed(3),
      veteran: ve === null ? null : +ve.toFixed(3), nNaive: w.naive.n, nVeteran: w.veteran.n };
    if (na !== null && ve !== null) { sameStatusTotal++; if (ve < na) sameStatusWin++; }
  }
  for (const r of PED.refugePicks()) {
    const t = tiers[r.i] || 'naive', o = g[t];
    o.refuge++; o.riseSum += r.rise; o.distSum += r.dist;
    if (r.rise > 1.0 || r.kind === 1) o.high++;
    if (r.highPool) o.highPool++;
  }
  const rate = (o, k) => +(o[k] / Math.max(1, o.n)).toFixed(3);
  const groups = {};
  for (const [t, o] of Object.entries(g)) groups[t] = {
    n: o.n,
    detoursPerPerson: rate(o, 'detours'), waitsPerPerson: rate(o, 'waits'),
    judgedPerPerson: rate(o, 'judged'), earlyWarnPerPerson: rate(o, 'earlyWarn'),
    detourPer1kJudged: +(1000 * o.detours / Math.max(1, o.judged)).toFixed(2),
    avgMaxDepthCm: rate(o, 'maxDepthSum'),
    avgSightM: rate(o, 'sightMSum'), avgWade: +rate(o, 'wadeSum').toFixed(3),
    avgTemp: +rate(o, 'tempSum').toFixed(3),
    refugePicks: o.refuge,
    highRate: +(o.high / Math.max(1, o.refuge)).toFixed(3),
    highPoolRate: +(o.highPool / Math.max(1, o.refuge)).toFixed(3),
    avgRiseM: +(o.riseSum / Math.max(1, o.refuge)).toFixed(2),
    avgRefugeDistM: +(o.distSum / Math.max(1, o.refuge)).toFixed(1),
  };
  // 【反事实对照】同一批真实街道位置、同一时刻、同一份避难所占用情况，
  // 只把灾害经验从 0.02 换成 0.90，看选出来的地点是否真的不同。
  // 用 pedI=-1 使人序偏置固定为 0，两组完全可比，也不污染真实选址台账。
  const starts = [];
  const stride = Math.max(1, Math.floor(PED.peds.length / 60));
  for (let i = 0; i < PED.peds.length; i += stride) {
    const q = PED.peds[i];
    starts.push([q.obj.position.x, q.obj.position.z]);
  }
  let cfN = 0, cfHigher = 0, cfDifferent = 0;
  let rise0 = 0, rise1 = 0, dist0 = 0, dist1 = 0;
  for (const [x, z] of starts) {
    const a = PED.probeRefuge(x, z, 0.02);
    const b = PED.probeRefuge(x, z, 0.90);
    if (!a || !b) continue;
    cfN++; rise0 += a.rise; rise1 += b.rise;
    dist0 += a.dist; dist1 += b.dist;
    if (b.rise > a.rise + 0.05) cfHigher++;
    if (Math.hypot(a.x - b.x, a.z - b.z) > 1) cfDifferent++;
  }
  const counterfactual = {
    starts: cfN, higher: cfHigher, different: cfDifferent,
    higherRate: +(cfHigher / Math.max(1, cfN)).toFixed(3),
    differentRate: +(cfDifferent / Math.max(1, cfN)).toFixed(3),
    avgRiseNaive: +(rise0 / Math.max(1, cfN)).toFixed(2),
    avgRiseVeteran: +(rise1 / Math.max(1, cfN)).toFixed(2),
    avgDistNaive: +(dist0 / Math.max(1, cfN)).toFixed(1),
    avgDistVeteran: +(dist1 / Math.max(1, cfN)).toFixed(1),
  };
  const ev = LIVE.events || [];
  let unjustified = 0;
  for (const e of ev) {
    if (!['detour', 'turnback', 'abandon'].includes(e.action)) continue;
    if ((e.depth || 0) < 0.01 && (e.rain || 0) < 8 && !e.blocked
      && (e.stuck || 0) <= 3 && (e.overdue || 0) <= 0.05 && !e.late) unjustified++;
  }
  return {
    minute: C.minute, live: LIVE.stats(), groups, wadeControlled,
    counterfactual, sameStatusWin, sameStatusTotal,
    unjustifiedSample: unjustified, eventSample: ev.length,
    incidents: PED.incidents.stats(),
    speedAudit: PED.speedAudit,
  };
});

await b.close();
const H = init.hazard;
const G = R.groups;
const out = { people: init.people, fromMinute: init.minute, toMinute: R.minute,
  frames: FRAMES, hazard: H, kernelSample: init.kernelSample,
  groups: G, wadeControlled: R.wadeControlled,
  counterfactual: R.counterfactual,
  sameStatusWin: R.sameStatusWin, sameStatusTotal: R.sameStatusTotal,
  earlyWarnings: R.live.earlyWarnings,
  unjustifiedSample: R.unjustifiedSample, eventSample: R.eventSample,
  incidents: { dead: R.incidents.dead, injured: R.incidents.injured,
    evacuated: R.incidents.evacuated, stranded: R.incidents.stranded },
  speedOk: R.speedAudit.ok, errs };
writeFileSync('out/_check_hazard.json', JSON.stringify(out, null, 2));

const n0 = G.naive, a0 = G.aware, v0 = G.veteran;
const checks = [
  ['灾害履历与年龄解耦（青年老手>0 且 高龄新手>0）', H.decoupled],
  ['三档都有足够样本（veteran≥20 人）', v0.n >= 20],
  ['经验足者视野更远', v0.avgSightM > n0.avgSightM],
  ['经验足者判断噪声更低', v0.avgTemp < n0.avgTemp],
  // 不同页面加载的片区抽样会有波动；同职业的严格对照由纯 Node 单元测试给出。
  ['控制职业后，多数身份里经验足者涉水阈值更保守',
    R.sameStatusTotal >= 3 && R.sameStatusWin / R.sameStatusTotal >= 0.5],
  ['同一位置只换经验：足够起点选了不同避难所',
    R.counterfactual.starts >= 30 && R.counterfactual.differentRate >= 0.15],
  ['同一位置只换经验：经验足者平均选得更高 / 愿意多走',
    R.counterfactual.avgRiseVeteran > R.counterfactual.avgRiseNaive
    || R.counterfactual.avgDistVeteran > R.counterfactual.avgDistNaive],
  ['经验足者当日最深涉水更浅（提前避开）', v0.avgMaxDepthCm <= n0.avgMaxDepthCm],
  ['有真实远景预警事件', R.live.earlyWarnings > 0],
  ['有真实避险选址样本', G.naive.refugePicks + G.aware.refugePicks + G.veteran.refugePicks >= 10],
  ['采样窗口无依据改道为 0', R.unjustifiedSample === 0],
  ['速度自检通过', R.speedAudit.ok],
  ['0 脚本错误', errs.length === 0],
];
console.log('\n===== 灾害履历专项 =====');
console.log('人数', init.people, '时段', init.minute, '→', R.minute, '帧', FRAMES);
console.log('履历分布', JSON.stringify(H.byTier), 'avg', H.avgScore,
  '亲历', H.experienced, '受训', H.trained, '演练', H.drill,
  '青年老手', H.youngVeteran, '高龄新手', H.oldNaive);
for (const [t, o] of Object.entries(G)) console.log(t.padEnd(8), JSON.stringify(o));
console.log('预警总数', R.live.earlyWarnings, '无依据改道样本', R.unjustifiedSample,
  '伤亡', JSON.stringify(out.incidents));
console.log('内核样本', JSON.stringify(init.kernelSample));
console.log('控制职业后的涉水阈值', JSON.stringify(R.wadeControlled),
  `同身份内 veteran 更保守 ${R.sameStatusWin}/${R.sameStatusTotal}`);
console.log('反事实对照（同一位置只换经验）', JSON.stringify(R.counterfactual));
let pass = 0;
for (const [name, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (ok) pass++; }
console.log(`\n${pass}/${checks.length} 通过`, errs.length ? '错误: ' + errs.slice(0, 5).join(' | ') : '');
if (pass < checks.length) process.exitCode = 1;
