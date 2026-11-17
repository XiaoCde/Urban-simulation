/** 纯函数诊断：HUD 说「走动」时，人在一分钟里到底挪了多少米。 */
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
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
const R = await p.evaluate(() => {
  const D = window.__dayMotion, CROWD = window.__crowdLife;
  const out = { cast: {}, crowd: [], crisisFrames: 0 };
  const hh = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  for (const key of D.keys) {
    let movingMin = 0, stillRun = 0, sum = 0, maxD = 0;
    const samples = [];
    for (let m = 0; m < 1439; m += 1) {
      const a = D.at(key, m), c = D.at(key, m + 1);
      if (!a || !c || a.crisis || c.crisis) continue;
      const d = Math.hypot(c.x - a.x, c.z - a.z);
      if (a.moving) {
        movingMin++; sum += d; maxD = Math.max(maxD, d);
        // 1.25 m/s 的真实步速 = 75 m/min；剧本把路程摊到整段，
        // 这里用 0.8 m/min 作「几乎没动」的判据
        if (d < 0.8) {
          stillRun++;
          if (samples.length < 6) samples.push({ at: hh(m), d: +d.toFixed(3),
            clip: a.clip, kind: a.kind, seg: `${a.a}-${a.b}`, spot: (a.spot || '').slice(0, 16) });
        }
      }
    }
    out.cast[key] = { movingMin, stillRun, pct: Math.round(100 * stillRun / Math.max(1, movingMin)),
      avgMperMin: +(sum / Math.max(1, movingMin)).toFixed(2), maxD: +maxD.toFixed(1), samples };
  }
  // 24 路人：社会层的位置是不是随时间在变
  for (let i = 0; i < 24; i++) {
    let walkMin = 0, frozen = 0;
    let ex = null;
    for (let m = 0; m < 1439; m += 5) {
      const a = CROWD.at(i, m), c = CROWD.at(i, m + 5);
      if (!a || !c) continue;
      if (!/walk|run/.test(a.clip)) continue;
      walkMin++;
      const d = Math.hypot(c.x - a.x, c.z - a.z);
      if (d < 0.01) { frozen++; if (!ex) ex = { at: hh(m), clip: a.clip, seg: a.segment }; }
    }
    out.crowd.push({ i, name: CROWD.at(i, 0).name, walkMin, frozen,
      pct: Math.round(100 * frozen / Math.max(1, walkMin)), ex });
  }
  return out;
});
console.log('=== 7 具名角色：q.moving=true 时「每分钟位移 <0.8m」的比例 ===');
for (const [k, v] of Object.entries(R.cast)) {
  console.log(`  ${k.padEnd(7)} 走动 ${String(v.movingMin).padStart(4)} 分钟 / 原地 ${String(v.stillRun).padStart(4)} (${v.pct}%)`,
    `平均 ${v.avgMperMin} m/min  最大 ${v.maxD} m/min`);
  for (const s of v.samples) console.log(`      ${s.at} 位移 ${s.d}m clip=${s.clip} kind=${s.kind} 段${s.seg} ${s.spot}`);
}
console.log('\n=== 24 路人：社会层说 walk/run 但锚点 5 分钟纹丝不动 ===');
const frozen = R.crowd.filter((c) => c.pct > 50);
console.log('  受影响人数:', frozen.length, '/ 24',
  ' 例:', JSON.stringify(frozen.slice(0, 4)));
console.log('  全部:', R.crowd.map((c) => `${c.i}:${c.pct}%`).join(' '));
await b.close();
