/** 全天核对小女孩：有没有瞬移、来回横跳、贴在实体里。 */
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
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
const R = await p.evaluate(() => {
  const D = window.__dayMotion, C = window.__clock, PE = window.__people;
  const COLL = window.__collide;
  const hh = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const pts = [];
  for (let m = 0; m <= 1440; m += 2) {
    const q = D.at('girl', m);
    if (!q || q.crisis) continue;
    const h = COLL.blockedCircle(q.x, q.z, 0.32, q.y + 0.1, q.y + 1.7,
      { ignoreTags: new Set(['building', 'tree']) });
    pts.push({ m, x: q.x, y: q.y, z: q.z, clip: q.clip, moving: q.moving,
      place: q.place, hit: h ? h.tag : null });
  }
  // 暴雨窗口由 story 驱动，用真实渲染层补采
  const crisisPts = [];
  for (let m = 1072; m <= 1116; m += 2) {
    C.setPlaying(false); C.seek(m); window.__frame(0, 2);
    const a = PE.actors.find((x) => x.def.key === 'girl');
    if (!a) continue;
    const q = a.root.position;
    const h = COLL.blockedCircle(q.x, q.z, 0.32, q.y + 0.1, q.y + 1.7,
      { ignoreTags: new Set(['building', 'tree']) });
    crisisPts.push({ m, x: q.x, y: q.y, z: q.z, clip: a.cur ? String(a.cur.getClip().name) : '',
      hit: h ? h.tag : null });
  }
  const analyse = (arr, tag) => {
    const jumps = [], flips = [], hits = [];
    let prev = null;
    for (let i = 0; i < arr.length; i++) {
      const q = arr[i];
      if (q.hit) hits.push({ at: hh(q.m), tag: q.hit });
      if (!prev) { prev = q; continue; }
      const dx = q.x - prev.x, dz = q.z - prev.z;
      const d = Math.hypot(dx, dz);
      if (d > 25) jumps.push({ at: hh(q.m), d: +d.toFixed(1), from: prev.place, to: q.place });
      if (q.m - prev.m <= 4 && d > 0.4 && flips.length < 40) {
        // 方向反转：和上一段位移点积为负
        const pdx = prev.x - (arr[i - 2] ? arr[i - 2].x : prev.x);
        const pdz = prev.z - (arr[i - 2] ? arr[i - 2].z : prev.z);
        if (dx * pdx + dz * pdz < -0.05) flips.push({ at: hh(q.m), d: +d.toFixed(1) });
      }
      prev = q;
    }
    return { tag, n: arr.length, jumps: jumps.slice(0, 8), jumpN: jumps.length,
      flips: flips.slice(0, 10), flipN: flips.length, hits: hits.slice(0, 10), hitN: hits.length };
  };
  return { day: analyse(pts, '非暴雨'), crisis: analyse(crisisPts, '暴雨窗口') };
});
for (const r of [R.day, R.crisis]) {
  console.log(`\n=== ${r.tag} ${r.n} 个采样点 ===`);
  console.log('  落在实体里:', r.hitN, JSON.stringify(r.hits));
  console.log('  >25m 跳变:', r.jumpN, JSON.stringify(r.jumps));
  console.log('  方向反复反转:', r.flipN, JSON.stringify(r.flips));
}
console.log('\n页面错误:', errs.length, errs.slice(0, 2).join(' | '));
await b.close();
