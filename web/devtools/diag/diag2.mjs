import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const mm = Number(process.argv[2] ?? 0);
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const u = new URL('http://127.0.0.1:8140/index.html');
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });
console.log(JSON.stringify(await p.evaluate(async (t) => {
  const C = window.__clock; C.setPlaying(false); C.seek(t);
  await new Promise((r) => setTimeout(r, 900));
  window.__frame(1/30, 4);
  const out = {};
  const PE = window.__people;
  out.castClips = Object.keys(PE.actors[0].acts || {});
  out.cast = PE.actors.map((a) => ({
    key: a.key, daySeg: a.daySeg, dayClip: a.day && a.day.clip,
    cur: a.cur ? a.cur.getClip().name : null,
    visible: a.model.visible,
    pos: [Math.round(a.root.position.x), Math.round(a.root.position.z)],
    state: a.story.state,
  }));
  const PED = window.__ped;
  const p0 = PED.peds[0];
  out.pedClips = p0 ? Object.keys(p0.acts || p0.clips || {}) : [];
  out.ped = { total: PED.peds.length, sample: PED.peds.slice(0, 6).map((q) => ({
    mode: q.mode, clip: q.cur ? q.cur.getClip().name : (q.cur || null),
    pos: [Math.round(q.obj.position.x), Math.round(q.obj.position.z)], sp: q.s,
  })) };
  // 所有人位置去重（不裁剪）
  const seen = {}; let dup = 0;
  for (const q of PED.peds) { const k = Math.round(q.obj.position.x / 0.5) + ',' + Math.round(q.obj.position.z / 0.5); seen[k] = (seen[k] || 0) + 1; }
  for (const k in seen) if (seen[k] > 1) dup += seen[k] - 1;
  out.pedDup = dup;
  return out;
}, mm), null, 1));
await b.close();
