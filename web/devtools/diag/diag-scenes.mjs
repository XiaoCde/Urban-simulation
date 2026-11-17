/**
 * 诊断 27 个 life-scenes 锚点的世界坐标：是否浮空 / 沉地 / 落在楼外 / 压在车道上 /
 * 同楼层多组道具互相重叠。只读数据，不改任何东西。
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);

const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 300000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await b.newPage();
await p.setViewport({ width: 1000, height: 640 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });
await p.evaluate(() => { window.__ready = false; });

const out = await p.evaluate(() => {
  const LIFE = window.__life, STORY = window.__story;
  const T = window.__THREE;
  const BIDX = window.__bIdx || null;
  const rows = [];
  const g = LIFE && LIFE.group;
  if (!g) return { err: 'no life group' };
  const places = (STORY && STORY.places) || {};
  for (const sc of g.children) {
    const bb = new T.Box3().setFromObject(sc);
    const size = bb.getSize(new T.Vector3());
    rows.push({
      id: sc.name,
      x: +sc.position.x.toFixed(1), y: +sc.position.y.toFixed(2), z: +sc.position.z.toFixed(1),
      minY: +bb.min.y.toFixed(2), maxY: +bb.max.y.toFixed(2),
      w: +size.x.toFixed(1), h: +size.y.toFixed(1), d: +size.z.toFixed(1),
      meshes: sc.children.length,
      visible: sc.visible,
    });
  }
  return {
    rows,
    places: Object.fromEntries(Object.entries(places).map(([k, v]) => [k, {
      x: +(+v.x).toFixed(1), z: +(+v.z).toFixed(1), w: v.w, d: v.d, name: v.name,
    }])),
    floodY: typeof window.__groundAt === 'function' ? 0 : 0,
  };
});

console.log('=== SCENES ===');
console.log('id'.padEnd(24), 'x'.padStart(8), 'y'.padStart(7), 'z'.padStart(8),
  'minY'.padStart(7), 'size(w/h/d)'.padStart(16), 'meshes');
for (const r of out.rows) {
  console.log(String(r.id).padEnd(24), String(r.x).padStart(8), String(r.y).padStart(7),
    String(r.z).padStart(8), String(r.minY).padStart(7),
    `${r.w}/${r.h}/${r.d}`.padStart(16), String(r.meshes).padStart(4));
}
console.log('\n=== PLACES ===');
for (const [k, v] of Object.entries(out.places)) {
  console.log(k.padEnd(14), `(${v.x}, ${v.z})`, `${v.w}x${v.d}`, v.name);
}

// 地面高程 + 楼体占用 + 车道
const chk = await p.evaluate(() => {
  const g = window.__life.group;
  const G = window.__ped && window.__ped.graph;
  const gAt = (x, z) => (G && G.groundAt) ? G.groundAt(x, z) : 0;
  const BIDX = window.__bIdx;
  const road = window.__roadCorridor;
  const res = [];
  for (const sc of g.children) {
    const x = sc.position.x, y = sc.position.y, z = sc.position.z;
    const gy = gAt(x, z);
    res.push({
      id: sc.name, dy: +(y - gy).toFixed(2),
      inBldg: BIDX && BIDX.blocked ? !!BIDX.blocked(x, y + 1.2, z) : null,
      onRoad: road ? !!road(x, z) : null,
    });
  }
  return res;
});
console.log('\n=== 与地面/楼体/车道的关系 ===');
const gyMap = Object.fromEntries(out.rows.map((r) => [r.id, r.y]));
for (const r of chk) {
  const gy = gyMap[r.id] - r.dy;
  console.log(String(r.id).padEnd(24), `dy=${String(r.dy).padStart(7)}`,
    `ground=${gy.toFixed(2)}`, `inBldg=${r.inBldg}`, `onRoad=${r.onRoad}`);
}
await b.close();
