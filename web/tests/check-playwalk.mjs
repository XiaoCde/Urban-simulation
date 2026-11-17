/** 播放态验收（直接推 PED.update，不渲染）：谁在真走、谁在原地跑、谁撞实体。 */
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
  const C = window.__clock, PED = window.__ped, PE = window.__people, MK = window.__mark;
  const COLL = window.__collide, CROWD = window.__crowdLife;
  C.setPlaying(false);
  const cam = window.__camera, flood = window.__flood, ctl = window.__controls;
  const out = [];
  // 把镜头放到「默认镜头街区」里：全城 240 人铺开后，随便挑一个人当机位
  // 会落在空街上，测出来「0 人在动」是裁剪造成的假象。
  let nearP = PED.peds[1], bd = Infinity;
  for (let i = 1; i < PED.peds.length; i++) {
    const h = PED.peds[i].homeXZ; if (!h) continue;
    const d = Math.hypot(h.x - 2501, h.z - 355);
    if (d < bd) { bd = d; nearP = PED.peds[i]; }
  }
  const near = nearP.homeXZ || nearP.obj.position;
  cam.position.set(near.x + 16, 11, near.z + 16);
  if (ctl) { ctl.target.set(near.x, 1, near.z); ctl.update(); }
  for (const m of [20, 500, 760, 900, 1080, 1100, 1120, 1320]) {
    C.seek(m); window.__frame(0, 2);
    const ps = PED.peds.slice(1);   // 全城市民，不再只测前 24 个
    const before = ps.map((p) => ({ x: p.obj.position.x, z: p.obj.position.z }));
    // 手动推进 30 帧，绕开渲染：CLOCK.minute 连续前进，PED.update 真跑
    for (let f = 0; f < 30; f++) {
      C.minute += (1 / 30) / 60;
      PED.update(1 / 30, cam, flood);
    }
    const rows = ps.map((p, i) => {
      const q = p.obj.position;
      const d = Math.hypot(q.x - before[i].x, q.z - before[i].z);
      const clip = p.cur ? String(p.cur.getClip().name) : '';
      const soc = CROWD.at(i + 1, C.minute);
      return { i: i + 1, d: +d.toFixed(2), clip, visible: !!p.obj.visible,
        indoor: !!(soc && soc.indoor), mode: p.mode,
        // 距离裁剪外的人本来就不可见，clip 停在旧值不算「用户看到的原地跑」
        stillRun: !!p.obj.visible && /walk|run/.test(clip) && d < 0.05 };
    });
    // 具名角色：是否落在实体里（排除楼体/树）
    const cast = [];
    for (const a of PE.actors) {
      const q = a.root.position;
      const h = COLL.blockedCircle(q.x, q.z, 0.32, q.y + 0.1, q.y + 1.7,
        { ignoreTags: new Set(['building', 'tree']) });
      if (h) cast.push({ k: a.def.key, tag: h.tag });
    }
    out.push({ m, total: ps.length, stillRun: rows.filter((r) => r.stillRun).map((r) => `${r.i}:${r.clip}/${r.mode}`),
      moving: rows.filter((r) => r.d > 0.05).length,
      clips: [...new Set(rows.map((r) => r.clip))].join(','),
      indoorWalk: rows.filter((r) => r.indoor && /walk|run/.test(r.clip)).length,
      castHits: cast });
  }
  return out;
});
for (const r of R) {
  const hh = `${String(Math.floor(r.m / 60)).padStart(2, '0')}:${String(r.m % 60).padStart(2, '0')}`;
  console.log(hh, `真在移动 ${r.moving}/${r.total} 人`,
    `| 原地跑 ${r.stillRun.length}: ${r.stillRun.slice(0, 8).join(' ')}`,
    `| 室内却播走跑 ${r.indoorWalk}`,
    `| 具名撞实体 ${JSON.stringify(r.castHits)}`,
    `| clips=${r.clips}`);
}
console.log('页面错误:', errs.length, errs.slice(0, 3).join(' | '));
console.log('结论:', R.every((r) => r.stillRun.length === 0 && r.indoorWalk === 0) && !errs.length
  ? 'PASS 无原地跑 / 无室内走跑' : '仍有异常');
await b.close();
