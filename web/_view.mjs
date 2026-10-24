// node _view.mjs out.png tx ty tz px py pz [fov]
import puppeteer from 'puppeteer-core';
const [out, tx, ty, tz, px, py, pz, fov] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'shell', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage();
await p.setViewport({ width: 1400, height: 800, deviceScaleFactor: 1 });
await p.goto('http://127.0.0.1:8123/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction('window.__ready === true', { timeout: 240000 });
await p.evaluate((tx, ty, tz, px, py, pz, fov) => {
  const T = window.__THREE;
  window.__camera.position.set(+px, +py, +pz);
  window.__camera.fov = +(fov || 50); window.__camera.updateProjectionMatrix();
  window.__controls.target.set(+tx, +ty, +tz);
  window.__controls.update();
  const hud = document.getElementById('hud'); if (hud) hud.style.display = 'none';
  const vs = document.getElementById('views'); if (vs) vs.style.display = 'none';
}, tx, ty, tz, px, py, pz, fov);
await new Promise(r => setTimeout(r, 2500));
await p.screenshot({ path: out });
await b.close();
console.log('saved ' + out);
