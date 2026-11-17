/** 实测「说在走动、人却原地跑」：逐帧量真实位移 vs 正在播的 clip。 */
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
  const C = window.__clock, PE = window.__people, PED = window.__ped, MK = window.__mark;
  const COLL = window.__collide;
  // 【必须真的播放】CLOCK.advance() 在暂停时返回 0，MARK/PEOPLE/PED 全都不推进，
  // 上一版探测把「暂停态」误当成「原地跑步」。设 playing=true + 1 倍速，
  // 24 帧 = 0.8 仿真秒，真在走的人应该移动 ~1 m。
  C.setPlaying(true); C.setSpeed(1);
  const times = [20, 500, 760, 900, 1080, 1100, 1320];
  const out = [];
  const frames = 24;
  const targets = () => {
    const list = [];
    if (PED && PED.peds && PED.peds[0])
      list.push({ k: 'mark', pos: () => PED.peds[0].obj.position,
        clip: () => PED.peds[0].cur ? String(PED.peds[0].cur.getClip().name) : '' });
    for (const a of (PE ? PE.actors : []))
      list.push({ k: a.def.key, pos: () => a.root.position,
        clip: () => a.cur ? String(a.cur.getClip().name) : '' });
    for (let i = 1; i < Math.min(25, PED ? PED.peds.length : 1); i++) {
      const q = PED.peds[i];
      list.push({ k: `路人${i}`, pos: () => q.obj.position,
        clip: () => q.cur ? String(q.cur.getClip().name) : '' });
    }
    return list;
  };
  for (const m of times) {
    C.seek(m); window.__frame(0, 3);
    const ts = targets();
    let last = ts.map((t) => ({ x: t.pos().x, z: t.pos().z }));
    const acc = ts.map(() => ({ walk: 0, still: 0, dist: 0, maxStep: 0, teleport: 0, hit: 0, hitTag: '' }));
    for (let f = 0; f < frames; f++) {
      window.__frame(1 / 30, 1);
      ts.forEach((t, i) => {
        const q = t.pos(), pv = last[i];
        const d = Math.hypot(q.x - pv.x, q.z - pv.z);
        const a = acc[i], c = t.clip();
        a.dist += d;
        a.maxStep = Math.max(a.maxStep, d);
        if (d > 3) a.teleport++;
        if (/walk|run|stairs/i.test(c)) { a.walk++; if (d < 0.008) a.still++; }
        if (COLL && f === frames - 1) {
          const h = COLL.blockedCircle(q.x, q.z, 0.32, q.y, q.y + 1.7,
            { ignoreTags: new Set(['building', 'tree']) });
          if (h) { a.hit++; a.hitTag = h.tag || ''; }
        }
        last[i] = { x: q.x, z: q.z };
      });
    }
    // 只报「播了走跑但几乎不动」或「撞实体」的角色
    const bad = ts.map((t, i) => ({ k: t.k, ...acc[i], clip: t.clip(),
      dist: +acc[i].dist.toFixed(2), maxStep: +acc[i].maxStep.toFixed(3) }))
      .filter((r) => (r.walk > 0 && r.still / r.walk > 0.5) || r.teleport > 0 || r.hit > 0);
    const hud = (PE ? PE.hud() : []).map((h) => `${h.key}:${h.clip}`);
    out.push({ m, checked: ts.length, frames, bad: bad.slice(0, 40),
      badN: bad.length, hud: hud.slice(0, 8) });
  }
  return out;
});

for (const r of R) {
  const hh = `${String(Math.floor(r.m / 60)).padStart(2, '0')}:${String(r.m % 60).padStart(2, '0')}`;
  console.log(`\n=== ${hh}  ${r.checked} 人 × ${r.frames} 帧，异常 ${r.badN} 人 ===`);
  console.log('  HUD:', r.hud.join(' '));
  for (const x of r.bad.slice(0, 14)) console.log(`  ${x.k.padEnd(7)} clip=${String(x.clip).padEnd(8)}`,
    `走跑帧 ${x.walk}/${r.frames} 其中原地 ${x.still} (${Math.round(100 * x.still / Math.max(1, x.walk))}%)`,
    `总位移 ${x.dist}m 单帧最大 ${x.maxStep}m`,
    x.teleport ? `瞬移 ${x.teleport}` : '', x.hit ? `撞实体 ${x.hit}` : '');
}
console.log('\n页面错误:', errs.length, errs.slice(0, 3).join(' | '));
await b.close();
