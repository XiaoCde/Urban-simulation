import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', protocolTimeout: 300000,
  args: ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 800, height: 500 });
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture','1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });
await p.evaluate(() => { window.__ready = false; });
for (const id of ['sc_school_class3f','sc_home_bedroom','sc_cafe_counter']) {
  const r = await p.evaluate((sid) => {
    const sc = window.__life.group.children.find((c) => c.name === sid);
    const C = window.__clock, cam = window.__camera, ctl = window.__controls;
    C.setPlaying(false); C.seek(600); window.__frame(0, 1);
    cam.position.set(sc.position.x + 6.2, sc.position.y + 6.4, sc.position.z + 6.6);
    if (ctl) { ctl.target.set(sc.position.x, sc.position.y + 0.9, sc.position.z); ctl.update(); }
    window.__frame(0, 1);
    return { camPlace: window.__camPlace,
      lights: window.__indoorLights.map((L) => ({ pl: L.userData.place, v: L.visible,
        i: +L.intensity.toFixed(1), y: +L.position.y.toFixed(1), d: +L.distance.toFixed(0) })),
      anchorY: +sc.position.y.toFixed(1) };
  }, id);
  console.log(id, JSON.stringify(r));
}
await b.close();
