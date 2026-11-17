/** 探测：0 点「睡觉」时模型实际播的是哪一段 clip，sit 是否真的存在。 */
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
  const PED = window.__ped, MK = window.__mark, P = window.__people, D = window.__dayMotion;
  const out = {
    moment: D ? D.at('mark', 30) : null,
    heroActs: PED && PED.peds[0] ? Object.keys(PED.peds[0].acts || {}) : null,
    heroCur: PED && PED.peds[0] && PED.peds[0].cur ? PED.peds[0].cur.getClip().name : null,
    peopleActs: P && P.actors && P.actors[0] ? Object.keys(P.actors[0].acts || {}) : null,
    peopleCur: P && P.actors && P.actors[0] && P.actors[0].cur ? P.actors[0].cur.getClip().name : null,
    markHud: MK ? MK.hud() : null,
  };
  window.__clock.setPlaying(false); window.__clock.seek(30); window.__frame(0, 3);
  out.afterSeek = {
    heroCur: PED && PED.peds[0] && PED.peds[0].cur ? PED.peds[0].cur.getClip().name : null,
    peopleCur: P && P.actors && P.actors[0] && P.actors[0].cur ? P.actors[0].cur.getClip().name : null,
    q: D ? { clip: D.at('mark', 30).clip, kind: D.at('mark', 30).kind, moving: D.at('mark', 30).moving } : null,
  };
  return out;
});
console.log(JSON.stringify(R, null, 1));
await b.close();
