import puppeteer from 'puppeteer-core';
import { existsSync, writeFileSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 1400, height: 620 });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });
await p.evaluate(async () => {
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const scene = window.__scene;
  for (const c of scene.children) if (!c.isLight) c.visible = false;
  const sun = new THREE.DirectionalLight(0xffffff, 3.0);
  sun.position.set(10, 30, 20); scene.add(sun);
  scene.add(new THREE.AmbientLight(0xffffff, 1.4));
  scene.background = new THREE.Color(0x303840);
  const loader = new GLTFLoader();
  const urls = [
    '/assets/street/car_sedan.glb', '/assets/street/car_suv.glb',
    '/assets/street/car_compact.glb', '/assets/props/car_sedan.glb',
    '/assets/props/car_suv.glb',
  ];
  const g = new THREE.Group();
  for (let i = 0; i < urls.length; i++) {
    const gl = await loader.loadAsync(urls[i]);
    const obj = gl.scene;
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const sz = box.getSize(new THREE.Vector3());
    const s = 4.5 / Math.max(sz.x, sz.z, 0.01);
    obj.scale.setScalar(s);
    // 把脚底贴到 y=0
    const c = box.getCenter(new THREE.Vector3());
    obj.position.set(0, -box.min.y * s, -c.z * s);
    const wrap = new THREE.Group();
    wrap.add(obj);
    wrap.position.x = (i - 2) * 11;
    g.add(wrap);
    // 红色箭头指向 +Z（画面下方）：车头朝箭头 = CAR_YAW 0
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.6, 10),
      new THREE.MeshBasicMaterial({ color: 0xff4444 }));
    cone.rotation.x = Math.PI / 2;
    cone.position.set(0, 0.9, 6.2);
    wrap.add(cone);
    const label = new THREE.Mesh(new THREE.BoxGeometry(7, 0.04, 0.5),
      new THREE.MeshBasicMaterial({ color: i < 3 ? 0x66aaff : 0xffcc66 }));
    label.position.set(0, 0.05, -5.5);
    wrap.add(label);
  }
  scene.add(g);
  const cam = window.__camera, ctl = window.__controls;
  cam.position.set(0, 34, 0.01);
  if (ctl) { ctl.target.set(0, 0, 0); ctl.update(); }
  cam.lookAt(0, 0, 0);
  window.__frame(0, 2);
});
const data = await p.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
writeFileSync('../out/motion/car_heads.png', Buffer.from(data.split(',')[1], 'base64'));
console.log('[shot] ../out/motion/car_heads.png  蓝标=street 三辆 / 黄标=props 两辆 / 红箭头=+Z');
await b.close();
