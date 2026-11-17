/** 决策→真实路网闭环的冒烟探针：折线是否贴在 walknet 上、是否真被执行。 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await b.newPage();
await p.setViewport({ width: 960, height: 600 });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 180)); });
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });

const R = await p.evaluate(() => {
  const C = window.__crowdLife, PED = window.__ped, PL = PED.planner;
  const out = { hasPlanner: !!PL, decisions: [], planner: PL ? PL.stats() : null };
  for (const m of [400, 760, 1100]) {
    for (let i = 1; i < 16; i++) {
      const pos = PED.peds[i].obj.position;
      const rec = C.decide(i, m + i, { x: pos.x, y: pos.y, z: pos.z });
      if (!rec) continue;
      const rt = rec.route;
      // 末段（最后 2 点）是「人行道投影点 → 真实门牌/高地」，允许脱离网；
      // 折线主体必须严格贴在 walknet 上。
      const net = rt && rt.pts && rt.pts.length > 2
        ? PL.onNet(rt.pts.slice(0, -2), 2.5) : null;
      out.decisions.push({
        i, m, chosen: rec.chosen, kind: rec.goalKind,
        pts: rt ? rt.pts.length : 0, dist: rt ? +rt.dist.toFixed(1) : 0,
        maxDepth: rt ? +rt.maxDepth.toFixed(3) : 0,
        goal: rt && rt.goal ? rt.goal.id : null,
        arrive: rt ? rt.onArrive : null, ok: !!(rt && rt.ok),
        net, offNet: net ? net.off : -1,
      });
    }
  }
  return out;
});
console.log('planner:', R.hasPlanner, JSON.stringify(R.planner && {
  planned: R.planner.planned, failed: R.planner.failed, chains: R.planner.chains,
}));
const bad = R.decisions.filter((d) => d.pts > 1 && d.offNet > 0);
console.log('决策数:', R.decisions.length, '有真实折线:', R.decisions.filter((d) => d.pts > 1).length,
  '折线脱离路网点数:', bad.reduce((n, d) => n + d.offNet, 0));
console.log('样例:');
for (const d of R.decisions.slice(0, 14)) console.log(' ', JSON.stringify(d));
console.log('按目标类型:', JSON.stringify(R.decisions.reduce((m, d) => {
  m[d.kind] = (m[d.kind] || 0) + 1; return m;
}, {})));

// 真实播放 90 帧，看路线有没有被行人执行
const PLAY = await p.evaluate(() => {
  const C = window.__clock, PED = window.__ped;
  C.setPlaying(true); C.seek(760);
  const before = PED.routeStats();
  for (let k = 0; k < 90; k++) window.__frame(1 / 30, 1);
  const after = PED.routeStats();
  const samples = PED.peds.slice(1, 40).map((q) => ({
    i: q.i, mode: q.mode, speed: q.route ? +q.route.speed.toFixed(2) : 0,
    idx: q.route ? q.route.i : 0, n: q.route ? q.route.pts.length : 0,
    stuck: q.route ? q.route.stuck : 0,
    walked: q.route ? +q.route.walked.toFixed(2) : 0,
    dist: q.route ? +q.route.dist.toFixed(1) : 0,
    info: q.routeInfo ? { kind: q.routeInfo.kind, done: q.routeInfo.done,
      walked: +(q.routeInfo.walked || 0).toFixed(1) } : null,
  })).filter((q) => q.mode === 'route' || (q.info && q.info.kind !== 'wait'));
  return { before, after, planner: PED.planner.stats(), samples: samples.slice(0, 10) };
});
console.log('\n播放前:', JSON.stringify(PLAY.before));
console.log('播放后:', JSON.stringify(PLAY.after));
console.log('寻路器:', JSON.stringify({ planned: PLAY.planner.planned, failed: PLAY.planner.failed }));
console.log('路线样例:', JSON.stringify(PLAY.samples));
console.log('\n页面错误:', errs.length, errs.slice(0, 5).join(' | '));
await b.close();
