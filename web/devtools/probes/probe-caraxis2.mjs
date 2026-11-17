import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });
const out = await p.evaluate(async () => {
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  const urls = [
    '/assets/street/car_sedan.glb', '/assets/street/car_suv.glb',
    '/assets/street/car_compact.glb', '/assets/props/car_sedan.glb',
    '/assets/props/car_suv.glb',
  ];
  const res = {};
  for (const url of urls) {
    const g = await loader.loadAsync(url);
    g.scene.updateMatrixWorld(true);
    // 只取车身（排除轮子）：轮子分布接近正方形，会污染主轴
    let sx = 0, sz = 0, sxx = 0, szz = 0, sxz = 0, n = 0;
    const bulbs = [];
    g.scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const nm = String((o.name || '') + ' ' + (o.material && o.material.name || '')).toLowerCase();
      const isWheel = nm.includes('wheel') || nm.includes('tire');
      const isOptic = nm.includes('optic') || nm.includes('light');
      const geo = o.geometry.clone();
      geo.applyMatrix4(o.matrixWorld);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), z = pos.getZ(i);
        if (isOptic) bulbs.push([x, z]);
        if (isWheel) continue;
        sx += x; sz += z; sxx += x * x; szz += z * z; sxz += x * z; n++;
      }
    });
    if (!n) { res[url] = { error: 'no body verts' }; continue; }
    const cx = sx / n, cz = sz / n;
    const Cxx = sxx / n - cx * cx, Czz = szz / n - cz * cz, Cxz = sxz / n - cx * cz;
    const tr = Cxx + Czz, det = Cxx * Czz - Cxz * Cxz;
    const lam = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
    let ux = Cxz, uz = lam - Cxx;
    const L = Math.hypot(ux, uz) || 1; ux /= L; uz /= L;
    const axisDeg = +(Math.atan2(ux, uz) * 180 / Math.PI).toFixed(1);
    // 车灯质心沿主轴的投影符号：+ 说明车头在 +主轴方向
    let bproj = null;
    if (bulbs.length) {
      const bx = bulbs.reduce((a, v) => a + v[0], 0) / bulbs.length;
      const bz = bulbs.reduce((a, v) => a + v[1], 0) / bulbs.length;
      bproj = +((bx - cx) * ux + (bz - cz) * uz).toFixed(3);
    }
    res[url] = { axisDeg, fixDeg: +(-axisDeg).toFixed(1), plus180: bproj !== null && bproj < 0,
      bulbProj: bproj, bodyVerts: n, bulbVerts: bulbs.length };
  }
  return res;
});
console.log(JSON.stringify(out, null, 2));
await b.close();
