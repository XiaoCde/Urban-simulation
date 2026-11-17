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
    try {
      const g = await loader.loadAsync(url);
      g.scene.updateMatrixWorld(true);
      const all = new THREE.Box3();
      const optics = new THREE.Box3();
      const glass = new THREE.Box3();
      let nOpt = 0, nGlass = 0;
      g.scene.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        const geo = o.geometry.clone();
        geo.applyMatrix4(o.matrixWorld);
        if (!geo.boundingBox) geo.computeBoundingBox();
        all.union(geo.boundingBox);
        const nm = String((o.material && o.material.name) || '').toLowerCase();
        if (nm.includes('optic') || nm.includes('light') || nm.includes('lamp')) {
          optics.union(geo.boundingBox); nOpt++;
        }
        if (nm.includes('glass') || nm.includes('window')) { glass.union(geo.boundingBox); nGlass++; }
      });
      const c = all.getCenter(new THREE.Vector3());
      const size = all.getSize(new THREE.Vector3());
      const oc = nOpt ? optics.getCenter(new THREE.Vector3()) : null;
      const gc = nGlass ? glass.getCenter(new THREE.Vector3()) : null;
      const ang = (v) => +(Math.atan2(v.x - c.x, v.z - c.z) * 180 / Math.PI).toFixed(1);
      res[url] = {
        size: [+size.x.toFixed(2), +size.y.toFixed(2), +size.z.toFixed(2)],
        center: [+c.x.toFixed(2), +c.y.toFixed(2), +c.z.toFixed(2)],
        opticsDeg: oc ? ang(oc) : null, glassDeg: gc ? ang(gc) : null,
        opticsN: nOpt, glassN: nGlass,
      };
    } catch (e) { res[url] = { error: String(e && e.message) }; }
  }
  return res;
});
console.log(JSON.stringify(out, null, 2));
await b.close();
