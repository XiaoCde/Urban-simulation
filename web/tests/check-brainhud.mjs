/** 演示验收：三个关键时刻的 HUD 是否如实显示 Brain 决策与人数。 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await b.newPage();
await p.setViewport({ width: 1200, height: 760 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });
const R = await p.evaluate(async () => {
  const C = window.__clock; C.setPlaying(false);
  const out = [];
  for (const m of [20, 455, 1075, 1090, 1100, 1110, 1320]) {
    C.seek(m); window.__frame(0, 3);
    await new Promise((r) => setTimeout(r, 280));
    window.__frame(0, 3);
    const g = (id) => (document.getElementById(id) || {}).textContent || '';
    const ph = window.__people ? window.__people.hud() : [];
    const walking = ph.filter((h) => /walk|run|stairs/i.test(String(h.clip || ''))).length;
    out.push({ m, at: g('storyAt'), env: g('storyEnv'),
      walking, markClip: window.__mark ? window.__mark.hud().clip : '' });
  }
  return out;
});
for (const r of R) console.log(`${String(Math.floor(r.m / 60)).padStart(2, '0')}:${String(r.m % 60).padStart(2, '0')}`,
  `| ${r.at}\n    env: ${r.env}\n    6人中走动 ${r.walking} / 马克 ${r.markClip}`);
console.log('页面错误:', errs.length, errs.slice(0, 2).join(' | '));
await b.close();
