/** 逐场景近景拍摄：相机进到锚点旁边看实际建出来的东西。 */
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
mkdirSync('../out/scene', { recursive: true });
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

const list = process.argv[2] ? process.argv[2].split(',') : [
  'sc_home_bedroom', 'sc_home_kitchen', 'sc_home_living', 'sc_office_6f',
  'sc_cafe_counter', 'sc_school_class3f', 'sc_clinic_or2f', 'sc_site_pit',
  'sc_street_shelter', 'sc_office_meeting3f',
];

for (const id of list) {
  const ok = await p.evaluate((sid, minute) => {
    const LIFE = window.__life;
    const sc = LIFE && LIFE.group && LIFE.group.children.find((c) => c.name === sid);
    if (!sc) return false;
    const C = window.__clock, cam = window.__camera, ctl = window.__controls;
    C.setPlaying(false); C.seek(minute); window.__frame(0, 1);
    const x = sc.position.x, y = sc.position.y, z = sc.position.z;
    // 斜 45° 俯视、距 9 m，看得清家具轮廓
    cam.position.set(x + 6.2, y + 6.4, z + 6.6);
    if (ctl) { ctl.target.set(x, y + 0.9, z); ctl.update(); }
    window.__frame(0, 1);
    return true;
  }, id, Number(process.env.MIN || 120));
  if (!ok) { console.log('[miss]', id); continue; }
  const data = await p.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
  writeFileSync(`../out/scene/${id}.png`, Buffer.from(data.split(',')[1], 'base64'));
  console.log('[shot]', id);
}
await b.close();
