/** 暴雨决策窗口 17:52–18:35 的专项核对：7 人是否真的有位置 / 动作 / 楼层。 */
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
const R = await p.evaluate(async () => {
  const C = window.__clock, P = window.__people, MK = window.__mark, PED = window.__ped;
  const out = [];
  C.setPlaying(false);
  for (const m of [1072, 1080, 1090, 1100, 1110, 1115]) {
    C.seek(m); window.__frame(0, 2);
    const ph = P ? P.hud() : [];
    const mh = MK ? MK.hud() : null;
    out.push({
      m, clock: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`,
      mark: mh ? { state: mh.state, clip: mh.clip, floor: mh.floor,
        x: +mh.x.toFixed(0), z: +mh.z.toFixed(0) } : null,
      heroClip: PED && PED.peds[0] && PED.peds[0].cur ? PED.peds[0].cur.getClip().name : null,
      cast: ph.map((h) => ({ k: h.key, st: h.state, clip: h.clip, f: h.floor,
        x: +h.x.toFixed(0), z: +h.z.toFixed(0) })),
    });
  }
  // 面板文案有 240 ms 节流，等一拍再读，确认暴雨窗口的统计不再显示 0/0
  C.seek(1110); window.__frame(0, 2);
  await new Promise((r) => setTimeout(r, 320));
  window.__frame(0, 2);
  const dom = {
    storyAt: (document.getElementById('storyAt') || {}).textContent || '',
    rows: [...document.querySelectorAll('#mkOthers .prow')].map((el) => el.textContent.trim()),
  };
  return { out, dom };
});
for (const r of R.out) {
  console.log(`\n${r.clock}  马克 ${JSON.stringify(r.mark)}  heroClip=${r.heroClip}`);
  console.log('  ' + r.cast.map((h) => `${h.k}:${h.st}/${h.clip}@${h.f}F(${h.x},${h.z})`).join('  '));
}
const bad = R.out.filter((r) => !r.mark || r.mark.clip === '—'
  || r.cast.some((h) => !h.clip || h.clip === '—' || !Number.isFinite(h.x)));
console.log('\n18:30 面板:', R.dom.storyAt);
console.log('人物行:', R.dom.rows.join(' | '));
console.log('异常时刻:', bad.length, '页面错误:', errs.length, errs.slice(0, 2).join('|'));
await b.close();
