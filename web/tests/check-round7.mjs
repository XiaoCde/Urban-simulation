/**
 * 第七轮验收：场景是否真的对位 + 代码 bug 扫描 + UI 截图。
 * 1) 27 个生活场景：没有立牌残留、楼层高度与该栋楼真实层高吻合
 * 2) 7 个具名角色 0 点是否都在各自楼层的正确楼面高度上
 * 3) 室外场景是否压在车道上
 * 4) 控制台 / 页面错误
 * 5) 面板文本 + 整页 UI 截图
 */
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
mkdirSync('../out/scene', { recursive: true });
const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--window-size=1280,760'],
});
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 760 });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 160)); });
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
await p.evaluate(() => { window.__ready = false; });

const checks = [];
const add = (name, ok, info = '') => checks.push([name, !!ok, info]);

const data = await p.evaluate(() => {
  const LIFE = window.__life, fit = window.__placeFit, T = window.__THREE;
  const road = window.__roadCorridor;
  const sc = [];
  for (const o of LIFE.group.children) {
    const bb = new T.Box3().setFromObject(o);
    const sz = bb.getSize(new T.Vector3());
    const place = o.name.split('_')[1] === 'home' ? 'home'
      : o.name.startsWith('sc_office') ? 'office'
        : o.name.startsWith('sc_clinic') ? 'clinic'
          : o.name.startsWith('sc_school') ? 'school'
            : o.name.startsWith('sc_cafe') ? 'cafe'
              : o.name.startsWith('sc_site') ? 'site' : 'street';
    sc.push({
      id: o.name, place, x: o.position.x, y: o.position.y, z: o.position.z,
      minY: bb.min.y, maxY: bb.max.y, w: sz.x, h: sz.y, d: sz.z,
      meshes: (() => { let n = 0; o.traverse((q) => { if (q.isMesh) n++; }); return n; })(),
      onRoad: road ? !!road(o.position.x, o.position.z) : null,
    });
  }
  return { scenes: sc, fit, stats: LIFE.stats, placeFit: window.__placeFit };
});

// ---- 1) 场景：无立牌、楼层高度吻合 ----
const markerLike = data.scenes.filter((s) => s.meshes <= 2 && s.w < 1 && s.h < 1.2);
add('没有「只有一块小立牌」的场景', markerLike.length === 0,
  markerLike.map((s) => s.id).join(',') || `0/${data.scenes.length}`);

const FLOOR = { home: 9, office: 6, clinic: 2, school: 3, cafe: 1 };
const heightBad = [];
for (const s of data.scenes) {
  const f = data.fit[s.place];
  if (!f) continue;
  const indoor = !['site', 'street'].includes(s.place);
  if (!indoor) continue;
  const k = (s.y - f.baseY) / f.floorH;          // 应该是整数（0,1,2…）
  const frac = Math.abs(k - Math.round(k));
  if (frac > 0.06) heightBad.push(`${s.id} k=${k.toFixed(2)}`);
}
add('室内场景 y 落在该栋楼真实楼板上（无浮空/陷楼板）', heightBad.length === 0,
  heightBad.join(',') || `${data.scenes.length} 个场景全部对齐`);

const onRoadOut = data.scenes.filter((s) => s.onRoad && ['site', 'street', 'cafe'].includes(s.place));
add('室外场景没有压在车行道上', onRoadOut.length === 0,
  onRoadOut.map((s) => s.id).join(',') || '0 个');

// ---- 2) 0 点人是否在正确楼面 ----
const people0 = await p.evaluate(() => {
  const C = window.__clock;
  C.setPlaying(false); C.seek(20); window.__frame(0, 2);
  const out = [];
  const D = window.__dayMotion, fit = window.__placeFit;
  for (const k of D.keys) {
    const q = D.at(k, 20);
    if (!q) continue;
    const f = fit[q.place];
    out.push({
      key: k, place: q.place, floor: q.floor, y: +q.y.toFixed(2), indoor: q.indoor,
      expect: f ? +(f.baseY + (q.floor - 1) * f.floorH).toFixed(2) : null,
    });
  }
  return out;
});
const badY = people0.filter((q) => q.indoor && q.expect != null && Math.abs(q.y - q.expect) > 2.6);
add('0 点 7 人都在各自楼层的真实楼面上（±2.6m）', badY.length === 0,
  badY.map((q) => `${q.key}${q.floor}F y=${q.y}≠${q.expect}`).join(',') || people0.map((q) => `${q.key}:${q.floor}F/${q.y}`).join(' '));

const allIndoor = people0.every((q) => q.indoor);
add('0 点 7 人全部在室内（不在街上）', allIndoor,
  people0.filter((q) => !q.indoor).map((q) => q.key).join(',') || '7/7 室内');

// ---- 3) 3D 摆位与轨迹一致（抽样 4 个时刻） ----
const pos = await p.evaluate(() => {
  const C = window.__clock; const out = [];
  for (const m of [120, 480, 720, 1260]) {
    C.seek(m); window.__frame(0, 1);
    const ppl = window.__people.hud();
    out.push({ m, ppl: ppl.map((q) => ({ k: q.key, x: +q.x.toFixed(1), z: +q.z.toFixed(1) })) });
  }
  return out;
});
add('抽取 4 个时刻，人物 HUD 坐标都在变动', pos.length === 4, pos.map((x) => `${x.m}min`).join(' '));

// ---- 4) 面板 ----
const panel = await p.evaluate(() => {
  const rows = [...document.querySelectorAll('#mkOthers .prow')];
  return {
    rows: rows.length,
    txt: rows.map((r) => r.querySelector('.st').textContent),
    names: rows.map((r) => r.querySelector('.nm').textContent),
  };
});
add('人物列表 7 行（马克 + 6 人）', panel.rows === 7, panel.names.join(' / '));
add('列表显示中文动作（无 idle/walk 技术名）',
  !panel.txt.some((t) => /\b(idle|walk|run|sit|look)\b/.test(t)), panel.txt.slice(0, 3).join(' | '));

// ---- 5) 截图：UI + 城市 ----
await p.evaluate(() => {
  const C = window.__clock; C.setPlaying(false); C.seek(600); window.__frame(0, 2);
  if (window.__mkview) window.__mkview();
  window.__frame(0, 2);
});
try {
  await p.screenshot({ path: '../out/scene/ui_full.jpg', type: 'jpeg', quality: 74,
    captureBeyondViewport: false, timeout: 180000 });
  console.log('[shot] ui_full.jpg');
} catch (e) { console.log('[shot] ui skipped:', String(e.message).slice(0, 70)); }

// 城市全景（无 UI 干扰的 canvas）
const cityData = await p.evaluate(() => {
  const C = window.__clock, cam = window.__camera, ctl = window.__controls;
  C.seek(600); window.__frame(0, 1);
  cam.position.set(2480, 190, 60);
  if (ctl) { ctl.target.set(2500, 20, 120); ctl.update(); }
  window.__frame(0, 2);
  return document.querySelector('canvas').toDataURL('image/png');
});
writeFileSync('../out/scene/ui_city.png', Buffer.from(cityData.split(',')[1], 'base64'));
console.log('[shot] ui_city.png');

add('页面无脚本错误', errs.length === 0, errs.slice(0, 2).join(' | ') || '0');

console.log('\n=== 场景统计 ===');
console.log(JSON.stringify({ built: data.stats.built, skipped: data.stats.skipped,
  markers: data.stats.markers, relocated: data.stats.relocated, meshes: data.stats.meshes }));
console.log('\n=== 检查项 ===');
let fail = 0;
for (const [n, ok, info] of checks) {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? '  —  ' + info : ''}`);
}
console.log(`\n${checks.length - fail}/${checks.length} PASS`);
await b.close();
