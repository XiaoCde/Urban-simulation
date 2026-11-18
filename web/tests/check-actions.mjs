import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
mkdirSync('../out/motion', { recursive: true });
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 760 });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
const u = new URL('http://127.0.0.1:8140/index.html?ped=1000');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
u.searchParams.set('seed', '20261117');
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });

const res = await p.evaluate(() => {
  const D = window.__dayMotion, C = window.__clock;
  const byKind = {};
  const bad = { look: 0, staticDrift: 0, walkStill: 0, sleepMove: 0 };
  const staticKinds = new Set(['sleep', 'drive', 'ride', 'meal', 'desk',
    'medical', 'teach', 'serve', 'talk']);
  for (let m = 0; m < 1440; m += 1) {
    for (const k of D.keys) {
      const q = D.at(k, m);
      if (!q || q.crisis) continue;
      const cell = byKind[q.kind] || (byKind[q.kind] = {});
      cell[q.clip] = (cell[q.clip] || 0) + 1;
      if (q.clip === 'look') bad.look++;
      if (staticKinds.has(q.kind) && q.drifting) bad.staticDrift++;
      if (!q.moving && (q.clip === 'walk' || q.clip === 'run')) bad.walkStill++;
      if (q.kind === 'sleep' && q.moving) bad.sleepMove++;
    }
  }
  const checks = [];
  // 【2026-11-11 同源检查】具名角色不再跑旧 DAYMOTION，而是第 0~6 个实时
  // 居民的“外观”。这里不只比文案，直接比模型与对应居民的位置、clip、场景，
  // 任何一项不一致都说明又分叉成两套系统。
  const CL = window.__crowdLife;
  for (const m of [20, 500, 600, 760, 900, 1320]) {
    C.setPlaying(false); C.seek(m); window.__frame(0, 2);
    window.__ped.update(0, window.__camera, window.__flood);
    const mk = window.__ped.peds[0];
    const q0 = CL.at(0), h0 = window.__mark.hud();
    const got = mk.cur ? String(mk.cur.getClip().name) : null;
    checks.push([`${m} 马克模型与实时居民同源`,
      h0.indoor === q0.indoor && h0.sceneId === q0.sceneId
      && Math.hypot(h0.x - mk.obj.position.x, h0.z - mk.obj.position.z) < 1.5
      && got === (mk.cur ? String(mk.cur.getClip().name) : null)]);
    const P = window.__people;
    let mismatch = 0;
    P.actors.forEach((a, k) => {
      const src = window.__ped.peds[k + 1];
      const g = a.cur ? String(a.cur.getClip().name) : null;
      const sg = src.cur ? String(src.cur.getClip().name) : null;
      const d = Math.hypot(a.root.position.x - src.obj.position.x,
        a.root.position.z - src.obj.position.z);
      if (g !== sg || d > 1.5) mismatch++;
    });
    checks.push([`${m} 6 个具名模型与实时居民同源（不符 ${mismatch} 个）`, mismatch === 0]);
  }
  // 楼材质：确认不再整栋半透明
  const mat = {};
  for (const [label, obj] of Object.entries({
    office: window.__officeBuilding, home: window.__homeBuilding,
  })) {
    if (!obj || !obj.group) { mat[label] = 'missing'; continue; }
    let n = 0, ghost = 0, order3 = 0;
    obj.group.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      n++;
      if (o.material.transparent && (o.material.opacity ?? 1) < 0.5) ghost++;
      if (o.renderOrder === 3) order3++;
    });
    mat[label] = { meshes: n, ghost, renderOrder3: order3 };
  }
  return { byKind, bad, checks, mat, keys: D.keys };
});

console.log('=== 全天动作分布（kind → clip: 分钟数）===');
for (const [k, v] of Object.entries(res.byKind)) console.log(k.padEnd(9), JSON.stringify(v));
console.log('=== 动作断言 ===');
console.log('look 出现次数', res.bad.look, res.bad.look === 0 ? 'PASS' : 'FAIL');
console.log('静态场景踱步次数', res.bad.staticDrift, res.bad.staticDrift === 0 ? 'PASS' : 'FAIL');
console.log('静止却播走跑', res.bad.walkStill, res.bad.walkStill === 0 ? 'PASS' : 'FAIL');
console.log('睡觉却在动', res.bad.sleepMove, res.bad.sleepMove === 0 ? 'PASS' : 'FAIL');
for (const [n, ok] of res.checks) console.log(ok ? 'PASS ' : 'FAIL ', n);
console.log('=== 楼材质（应 ghost=0 / renderOrder3=0）===');
console.log(JSON.stringify(res.mat));
console.log('=== 页面错误 ===', errs.length ? errs.join('\n') : 'none');

const shots = process.env.QUICK ? [] : [
  { m: 600, name: 'fixed_office', x: 2501.37, z: 354.69, d: 150, h: 95 },
  { m: 600, name: 'fixed_office_near', x: 2501.37, z: 354.69, d: 80, h: 55 },
  { m: 20, name: 'fixed_home', x: 2642.79, z: -331.65, d: 130, h: 85 },
  { m: 755, name: 'fixed_cafe', x: 2273.38, z: -102.32, d: 70, h: 46 },
  // 实心楼状态下，跟拍 / 点人把相机送进 9F 房间，验证人还看得见
  { m: 20, name: 'fixed_home_near', x: 2637.7, z: -332.6, d: 13, h: 41, ty: 38 },
];
for (const o of shots) {
  await p.evaluate((a) => {
    const C = window.__clock;
    C.setPlaying(false); C.seek(a.m); window.__frame(0, 2);
    const cam = window.__camera, ctl = window.__controls;
    cam.position.set(a.x + a.d * 0.7, a.h, a.z + a.d * 0.9);
    if (ctl) { ctl.target.set(a.x, a.ty === undefined ? 12 : a.ty, a.z); ctl.update(); }
    window.__frame(0, 2);
  }, o);
  const data = await p.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
  writeFileSync(`../out/motion/${o.name}.png`, Buffer.from(data.split(',')[1], 'base64'));
  console.log('[shot]', o.name);
}
await b.close();
