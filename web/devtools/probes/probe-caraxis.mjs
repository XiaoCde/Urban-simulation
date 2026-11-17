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
console.log(JSON.stringify(await p.evaluate(() => {
  const out = [];
  window.__scene.traverse((o) => {
    if (!o.isInstancedMesh) return;
    if (!/^car_/.test(o.name)) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    out.push({
      name: o.name,
      dx: +(bb.max.x - bb.min.x).toFixed(2),
      dy: +(bb.max.y - bb.min.y).toFixed(2),
      dz: +(bb.max.z - bb.min.z).toFixed(2),
    });
  });
  return out;
}), null, 1));
await b.close();
