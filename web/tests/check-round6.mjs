import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
mkdirSync('../out/motion', { recursive: true });
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', protocolTimeout: 300000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 1360, height: 800 });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
p.on('console', (m) => {
  if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push('CONSOLE ' + m.text().slice(0, 180));
});
const u = new URL('http://127.0.0.1:8140/index.html');   // 默认 24 个随机行人
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });

const checks = [];
const res = await p.evaluate(() => {
  // 停掉 capture=1 的自动帧循环，全部改手动推帧，避免软件渲染下主线程堆积
  window.__ready = false;
  const C = window.__clock;
  const out = {};
  // ---- 1) 面板：7 行、点击切换跟随 / 自由 ----
  const rows = [...document.querySelectorAll('#mkOthers .prow')];
  out.panel = {
    rows: rows.length,
    keys: rows.map((r) => r.dataset.k),
    stTexts: rows.map((r) => r.querySelector('.st').textContent),
    storyCollapsed: document.getElementById('storyPanel').classList.contains('collapsed'),
    decideHidden: getComputedStyle(document.getElementById('decide')).display === 'none',
  };
  // ---- 2) 社会层 ----
  const CL = window.__crowdLife;
  out.crowd = CL ? CL.stats() : null;
  if (CL) {
    const d0 = CL.debug(20), d600 = CL.debug(600), d1090 = CL.debug(1090);
    out.crowd.nightIndoor = d0.filter((q) => q.indoor).length;
    out.crowd.noonOutdoor = d600.filter((q) => !q.indoor).length;
    out.crowd.sample = [d0[0], d600[0], d1090[0]];
  }
  // ---- 3) 车头：推进后 yaw 应收敛到「路段方向 + 车型补偿」 ----
  C.setPlaying(true); C.setSpeed(6);
  window.__frame(1 / 30, 30);
  const T = window.__traffic();
  const CAR_YAW = { sedan: 0, suv: (-108) * Math.PI / 180, compact: (36.8) * Math.PI / 180 };
  let bad = 0, maxErr = 0, sum = 0;
  const perKind = {};
  for (const c of T.cars) {
    const a = c.dir > 0 ? c.e.a : c.e.b, bb = c.dir > 0 ? c.e.b : c.e.a;
    const want = Math.atan2(bb.x - a.x, bb.z - a.z) + (CAR_YAW[c.kind] || 0);
    let d = Math.abs((c.yaw || 0) - want);
    while (d > Math.PI) d = Math.abs(d - 2 * Math.PI);
    if (d > 0.35) bad++;
    maxErr = Math.max(maxErr, d); sum += d;
    const k = c.kind;
    perKind[k] = perKind[k] || { n: 0, bad: 0 };
    perKind[k].n++; if (d > 0.35) perKind[k].bad++;
  }
  out.cars = { n: T.cars.length, bad, maxErr: +maxErr.toFixed(3), avgErr: +(sum / T.cars.length).toFixed(3), perKind };
  // ---- 4) 随机行人动作：全天采样，禁止怪动作 ----
  const BANNED = new Set(['turn180', 'side_l', 'side_r', 'back', 'look', 'idle2', 'crawl']);
  let bannedHits = 0; const clipSeen = {};
  for (const m of [20, 300, 460, 600, 760, 900, 1090, 1180, 1320]) {
    C.setPlaying(false); C.seek(m); window.__frame(0, 2);
    for (const ped of window.__ped.peds) {
      if (ped.hero) continue;
      const n = ped.cur ? String(ped.cur.getClip().name) : 'none';
      clipSeen[n] = (clipSeen[n] || 0) + 1;
      if (BANNED.has(n)) bannedHits++;
    }
  }
  out.pedClips = { bannedHits, clipSeen };
  // ---- 5) 暴雨窗口跑一段，看 Brain 决策是否真的产生 ----
  C.seek(1075); C.setPlaying(true); C.setSpeed(12);
  window.__frame(1 / 30, 40);
  const decided = window.__ped.peds.filter((x) => !x.hero && (x.decisions || []).length > 0).length;
  out.brain = { pedestriansWithDecisions: decided,
    crowdDecisions: CL ? CL.stats().decisions : 0 };
  // ---- 6) 夜景亮度 ----
  C.setPlaying(false); C.seek(20); window.__frame(0, 3);
  const lights = [];
  window.__scene.traverse((o) => {
    if (o.isHemisphereLight) lights.push(['hemi', +o.intensity.toFixed(2)]);
    if (o.isDirectionalLight) lights.push(['sun', +o.intensity.toFixed(2)]);
    if (o.isPointLight) lights.push(['point', +o.intensity.toFixed(0), o.visible]);
  });
  out.lights = lights;
  out.lampPositions = (window.__lampPositions || []).length;
  return out;
});

console.log('=== PANEL ===', JSON.stringify(res.panel));
checks.push(['统一列表 7 人（马克也在内）', res.panel.rows === 7 && res.panel.keys.includes('mark')]);
checks.push(['故事面板默认折叠 / 决策面板隐藏', res.panel.storyCollapsed && res.panel.decideHidden]);
checks.push(['列表全部显示中文动作（无 idle/walk 技术名）',
  !res.panel.stTexts.some((t) => /\b(idle|walk|run|sit|look)\b/.test(t))]);
console.log('=== CROWD ===', JSON.stringify(res.crowd));
checks.push(['社会层人数 = 24 且场景锚点已注入', !!res.crowd && res.crowd.count === 24 && res.crowd.anchors >= 20]);
checks.push(['0 点多数人在室内', !!res.crowd && res.crowd.nightIndoor >= 14]);
console.log('=== CARS ===', JSON.stringify(res.cars));
checks.push(['车头朝向收敛（偏差 >0.35 rad 的车 < 8%）',
  res.cars.bad / Math.max(1, res.cars.n) < 0.08]);
console.log('=== PED CLIPS ===', JSON.stringify(res.pedClips));
checks.push(['随机行人无转圈/倒退/侧移/挥手动作', res.pedClips.bannedHits === 0]);
console.log('=== BRAIN ===', JSON.stringify(res.brain));
checks.push(['暴雨窗口路人产生 Brain 决策', res.brain.pedestriansWithDecisions > 0]);
console.log('=== LIGHTS ===', JSON.stringify(res.lights), 'lampPositions=', res.lampPositions);
checks.push(['夜间天光 >= 0.55', res.lights.some((l) => l[0] === 'hemi' && l[1] >= 0.55)]);
checks.push(['路灯位置与夜间点光源已接入', res.lampPositions > 100 && res.lights.some((l) => l[0] === 'point' && l[2] === true)]);

// 面板点击：跟随 → 再点一次自由
await p.evaluate(() => {
  const C = window.__clock; C.setPlaying(false); C.seek(600); window.__frame(0, 1);
  // 用 DOM 原生 click 走事件委托，避开 CDP 元素交互在软件渲染下的长时间等待
  document.querySelector('#mkOthers .prow[data-k="mark"]').click();
});
const after1 = await p.evaluate(() => ({
  sel: document.querySelectorAll('#mkOthers .prow.sel').length,
  label: document.querySelector('#mkOthers .prow[data-k="mark"] .go').textContent,
}));
await p.evaluate(() => {
  document.querySelector('#mkOthers .prow[data-k="mark"]').click();
});
const after2 = await p.evaluate(() => ({
  sel: document.querySelectorAll('#mkOthers .prow.sel').length,
  label: document.querySelector('#mkOthers .prow[data-k="mark"] .go').textContent,
}));
console.log('=== CLICK ===', JSON.stringify({ after1, after2 }));
checks.push(['点名字 = 跟随，再点 = 自由', after1.sel === 1 && after1.label === '自由'
  && after2.sel === 0 && after2.label === '跟随']);

console.log('=== CHECKS ===');
for (const [n, ok] of checks) console.log(ok ? 'PASS ' : 'FAIL ', n);
console.log('=== ERRORS ===', errs.length ? errs.slice(0, 12).join('\n') : 'none');

// DOM 截图（含面板）+ 0 点街景
try { await p.screenshot({ path: '../out/motion/round6_panel.png', timeout: 60000 }); } catch (e) { console.log('[shot] panel skipped'); }
await p.evaluate(() => {
  const C = window.__clock, cam = window.__camera, ctl = window.__controls;
  C.setPlaying(false); C.seek(20); window.__frame(0, 2);
  cam.position.set(2470 + 70, 46, -200 + 90);
  if (ctl) { ctl.target.set(2470, 4, -200); ctl.update(); }
  window.__frame(0, 3);
});
const data = await p.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
writeFileSync('../out/motion/round6_night.png', Buffer.from(data.split(',')[1], 'base64'));
console.log('[shot] round6_panel.png / round6_night.png');
await b.close();
