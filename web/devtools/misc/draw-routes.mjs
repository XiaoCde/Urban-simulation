/** 把马克 4 条路线和路网画出来，俯瞰截图，直观找穿楼/穿草地。 */
import puppeteer from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const [, , out = 'out/routes.png', cx = '2500', cz = '0', h = '620', dist = '300'] = process.argv;
const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await b.newPage();
await p.setViewport({ width: 1200, height: 820 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html?ped=1');
u.searchParams.set('capture', '1');
u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });
await p.evaluate(async (x, z, hh, dd) => {
  const THREE = await import('three');
  const sc = window.__scene;
  const M = window.__mark;
  const RN = window.__roadnet();
  const g = new THREE.Group();
  g.name = 'DEBUG_ROUTES';

  // 路网：细灰线（参照）
  {
    const pts = [];
    for (const e of RN.edges) {
      pts.push(new THREE.Vector3(e.a.x, 1.0, e.a.z), new THREE.Vector3(e.b.x, 1.0, e.b.z));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x9aa4ad, transparent: true, opacity: 0.55, depthTest: false })));
  }
  // 4 条路线
  const colors = { route_home: 0x22dd66, route_detour: 0x22ddaa, route_drive: 0xff3333, route_drive_detour: 0xff9922 };
  for (const [k, col] of Object.entries(colors)) {
    const raw = M.story.routes[k];
    if (!Array.isArray(raw)) continue;
    const pts = raw.map(([a, b, c]) => new THREE.Vector3(a, (b || 0) + 3.2, c));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: col, linewidth: 3, depthTest: false }));
    line.renderOrder = 999;
    g.add(line);
    // 端点球
    for (const q of [pts[0], pts[pts.length - 1]]) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(4, 8, 6),
        new THREE.MeshBasicMaterial({ color: col, depthTest: false }));
      s.position.copy(q); s.renderOrder = 1000; g.add(s);
    }
  }
  // 未被剔除的楼：只画路线附近的，红框
  {
    const BX = window.__bIdx, EX = window.__exclude || new Set();
    const all = M.story.routes.route_home || [];
    const near = (x0, z0) => all.some(([a, , c]) => Math.hypot(a - x0, c - z0) < 220);
    const pts = [];
    for (const r of BX.rects) {
      if (EX.has(r.id) || r.h <= 3) continue;
      if (!near((r.minx + r.maxx) / 2, (r.minz + r.maxz) / 2)) continue;
      const y = 2;
      const c = [[r.minx, r.minz], [r.maxx, r.minz], [r.maxx, r.maxz], [r.minx, r.maxz], [r.minx, r.minz]];
      for (let i = 1; i < c.length; i++) {
        pts.push(new THREE.Vector3(c[i - 1][0], y, c[i - 1][1]), new THREE.Vector3(c[i][0], y, c[i][1]));
      }
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const ls = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xff00aa, transparent: true, opacity: 0.75, depthTest: false }));
    ls.renderOrder = 998;
    g.add(ls);
    window.__debugRects = pts.length / 2;
  }
  sc.add(g);

  const C = window.__clock;
  C.setPlaying(false); C.seek(1080);
  const cam = window.__camera, ctl = window.__controls;
  cam.position.set(Number(x) + Number(dd) * 0.35, Number(hh), Number(z) + Number(dd) * 0.65);
  if (ctl) { ctl.target.set(Number(x), 0, Number(z)); ctl.update(); }
}, cx, cz, h, dist);
await new Promise((r) => setTimeout(r, 600));
await p.evaluate(() => window.__frame(1 / 30, 4));
const data = await p.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'));
console.log('[draw]', out, 'rects', await p.evaluate(() => window.__debugRects));
await b.close();
