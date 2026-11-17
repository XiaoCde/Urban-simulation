/** 灯网改造前的结构探测：建筑清单、灯杆、材质、场景规模。 */
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
  const B = window.__buildings;
  const out = {
    buildingsType: Object.prototype.toString.call(B),
    buildingsKeys: B ? Object.keys(B).slice(0, 12) : null,
    buildingsLen: B ? (B.length || Object.keys(B).length) : 0,
    buildingsSample: [],
    lamps: window.__lampPositions ? window.__lampPositions.length : 0,
    lampSample: (window.__lampPositions || []).slice(0, 3),
    sceneChildren: window.__scene ? window.__scene.children.length : 0,
    worldChildren: window.__world ? window.__world.children.length : 0,
    names: [],
    matNames: {},
    instanced: [],
  };
  if (Array.isArray(B)) out.buildingsSample = B.slice(0, 3).map((x) => JSON.parse(JSON.stringify(x)));
  else if (B && typeof B === 'object') {
    const arr = B.blocks || B.list || B.items || null;
    if (Array.isArray(arr)) out.buildingsSample = arr.slice(0, 3).map((x) => JSON.parse(JSON.stringify(x)));
    else for (const k of Object.keys(B).slice(0, 3)) {
      try { out.buildingsSample.push({ key: k, val: JSON.parse(JSON.stringify(B[k])).toString().slice(0, 200) }); } catch (e) { /* */ }
    }
  }
  const seen = new Set();
  window.__scene.traverse((o) => {
    if (!o.name || seen.has(o.name)) return;
    if (o.isGroup || o.isInstancedMesh || o.isMesh) out.names.push(o.name);
    seen.add(o.name);
    if (o.isInstancedMesh && out.instanced.length < 22) {
      out.instanced.push({ name: o.name, count: o.count, mat: (o.material && o.material.name) || '',
        type: o.material && o.material.type });
    }
    if (o.isMesh && o.material && out.names.length < 4000) {
      const n = o.material.name || o.material.type;
      out.matNames[n] = (out.matNames[n] || 0) + 1;
    }
  });
  out.names = out.names.slice(0, 90);
  out.matNames = Object.entries(out.matNames).sort((a, b2) => b2[1] - a[1]).slice(0, 30);
  const mk = window.__megakit;
  out.megakit = mk ? JSON.parse(JSON.stringify(mk)) : null;
  const arrB = B && B.buildings;
  out.buildingsArray = Array.isArray(arrB) ? {
    len: arrB.length,
    sample: arrB.slice(0, 4).map((x) => JSON.parse(JSON.stringify(x))),
  } : { len: 0, keys: arrB ? Object.keys(arrB).slice(0, 12) : null };
  const blocks = window.__buildingMesh;
  out.buildingMesh = blocks ? { type: Object.prototype.toString.call(blocks),
    len: blocks.length || Object.keys(blocks).length,
    sample: JSON.stringify(Array.isArray(blocks) ? blocks[0] : Object.values(blocks)[0]).slice(0, 400) } : null;
  return out;
});
console.log(JSON.stringify(R, null, 1));
await b.close();
