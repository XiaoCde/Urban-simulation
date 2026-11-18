/** 核对：马克的车与社会车辆不再叠在一起（交通层把它当外部前车跟车）。 */
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
  const T = window.__traffic(), net = window.__roadnet(), C = window.__clock;
  const THREE = window.__THREE, P = new THREE.Vector3();
  const S = window.__solids;
  const out = [];
  for (const m of [455, 465, 475]) {
    C.setPlaying(false); C.seek(m); window.__frame(0, 3);
    const mk = window.__mark.car.position;
    let minGap = Infinity, under3 = 0, under5 = 0, trafficInBuilding = 0;
    for (let step = 0; step < 90; step++) {
      T.advance(0.25);
      for (const c of T.cars) {
        net.lanePoint(c.e, Math.min(1, Math.max(0, c.t)), c.dir, 0, P);
        const d = Math.hypot(P.x - mk.x, P.z - mk.z);
        if (d < minGap) minGap = d;
        if (d < 3) under3++;
        if (d < 5) under5++;
        if (S.hit(P.x, P.z, 1.6)) trafficInBuilding++;
      }
    }
    out.push({ m, minGap: +minGap.toFixed(2), under3, under5, trafficInBuilding });
  }
  return { out, solids: S.stats(), ext: !!(T.setExternalCar) };
});
console.log('外部前车避让已接入:', R.ext, ' 实体:', JSON.stringify(R.solids));
for (const r of R.out) console.log(`  ${String(Math.floor(r.m / 60)).padStart(2, '0')}:${String(r.m % 60).padStart(2, '0')}`,
  `最近车距 ${r.minGap} m / <3m 帧 ${r.under3} / <5m 帧 ${r.under5} / 社会车穿楼 ${r.trafficInBuilding}`);
console.log('页面错误:', errs.length, errs.slice(0, 3).join(' | '));
console.log('结论:', R.out.every((r) => r.trafficInBuilding === 0 && r.under3 === 0) && !errs.length
  ? 'PASS' : '需复核');
await b.close();
