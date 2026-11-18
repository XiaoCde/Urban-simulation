/** 全天验收：马克的车绝不能穿楼、不能在半空、不能钻进不可见实体。 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await b.newPage();
await p.setViewport({ width: 900, height: 560 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
u.searchParams.set('seed', '20261117');
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });

const R = await p.evaluate(() => {
  const D = window.__dayMotion, S = window.__solids, C = window.__clock;
  const gy = window.__terrY;
  const onRoad = window.__roadCorridor;
  const out = {
    solids: S ? S.stats() : null, roadKill: window.__roadKill,
    bad: [], high: [], offRoad: [], samples: [], carModel: [],
    totalMin: 0, maxAbove: 0,
  };
  if (!D || !S || !D.carAt) return { error: '缺少 dayMotion.carAt / solids' };
  for (let m = 0; m < 1440; m++) {
    const q = D.carAt(m);
    if (!q) { out.bad.push({ m, why: 'no car' }); continue; }
    out.totalMin++;
    const g = gy ? gy(q.x, q.z) : q.y;
    const above = q.y - (g || 0);
    out.maxAbove = Math.max(out.maxAbove, above);
    // 车宽余量 1.6 m：车身任何部分都不能在楼里
    const hit = S.hit(q.x, q.z, 1.6);
    const hitAny = S.hit(q.x, q.z, 0);
    if (hit || hitAny) out.bad.push({ m, x: +q.x.toFixed(1), z: +q.z.toFixed(1),
      id: (hit || hitAny).id, pad: hit ? 1.6 : 0, parked: !!q.parked });
    if (above > 2.2) out.high.push({ m, above: +above.toFixed(1) });
    if (q.moving && onRoad && !onRoad(q.x, q.z))
      out.offRoad.push({ m, x: +q.x.toFixed(1), z: +q.z.toFixed(1) });
    if ([0, 440, 450, 455, 460, 465, 470, 475, 479, 480, 500, 1080, 1100, 1110, 1200].includes(m))
      out.samples.push({ m, x: +q.x.toFixed(1), y: +q.y.toFixed(1), z: +q.z.toFixed(1),
        moving: q.moving, parked: !!q.parked, above: +above.toFixed(1),
        hit: hitAny ? hitAny.id : null });
  }
  // 实际渲染的车模型（含暴雨窗口 story 接管）
  const MK = window.__mark;
  C.setPlaying(false);
  for (const m of [0, 450, 455, 460, 465, 470, 475, 479, 480,
    1072, 1082, 1092, 1102, 1112, 1130]) {
    C.seek(m); window.__frame(0, 3);
    const c = MK && MK.car;
    if (!c) { out.carModel.push({ m, missing: true }); continue; }
    const h = S.hit(c.position.x, c.position.z, 1.6);
    out.carModel.push({ m, x: +c.position.x.toFixed(1), y: +c.position.y.toFixed(1),
      z: +c.position.z.toFixed(1), hit: h ? h.id : null });
  }
  // BIDX 与 COLLIDE 是否还有幽灵（用一栋已知被删的楼验证）
  const ghost = (window.__roadKill.ghostIds || [])[0];
  out.ghostCheck = ghost ? {
    id: ghost,
    bIdxAlive: (window.__bIdx.rects.find((r) => r.id === ghost) || {}).alive,
    collideDead: (() => {
      const rr = window.__bIdx.rects.find((r) => r.id === ghost);
      return rr && rr.collideId != null ? !!window.__collide.items[rr.collideId].dead : null;
    })(),
  } : null;
  return out;
});

const hh = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
console.log('可见实体:', JSON.stringify(R.solids),
  ' 压路统计:', JSON.stringify({ leftPts: R.roadKill && R.roadKill.leftPts,
    total: R.roadKill && R.roadKill.totalPts, leftBuildings: R.roadKill && R.roadKill.leftBuildings }));
console.log('幽灵注销:', JSON.stringify(R.ghostCheck));
console.log('\n全天车位置采样:');
for (const s of R.samples) console.log(`  ${hh(s.m)} (${s.x}, ${s.y}, ${s.z})`,
  s.parked ? '停放' : (s.moving ? '行驶' : '待发'), `离地 ${s.above}m`, s.hit ? `穿楼 ${s.hit}` : 'OK');
console.log('\n穿楼帧:', R.bad.length, R.bad.slice(0, 12).map((x) => `${hh(x.m)}@${x.id}`).join(' '));
console.log('半空帧(>2.2m):', R.high.length, ' 最高离地:', R.maxAbove.toFixed(2), 'm');
console.log('行驶时离开路面:', R.offRoad.length, '/', R.totalMin,
  R.offRoad.slice(0, 8).map((x) => hh(x.m)).join(' '));
console.log('\n实际车模型:');
for (const c of R.carModel) console.log(`  ${hh(c.m)} (${c.x}, ${c.y}, ${c.z})`, c.hit ? `穿楼 ${c.hit}` : 'OK');
console.log('\n页面错误:', errs.length, errs.slice(0, 3).join(' | '));
const pass = !R.error && R.bad.length === 0 && R.high.length === 0
  && R.carModel.every((c) => !c.hit && !c.missing) && errs.length === 0;
console.log('\n结论:', pass ? 'PASS 车全天不穿楼' : 'FAIL');
await b.close();
