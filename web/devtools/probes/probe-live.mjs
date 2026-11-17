/**
 * 实时耦合探针：让时钟真的走起来，看行人有没有把「涉水」写回流场。
 * 用法: node _probe_live.mjs [query] [minute] [frames] [speed]
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);

const q = process.argv[2] || '?ped=3000';
const minute = Number(process.argv[3] ?? 1080);
const frames = Number(process.argv[4] ?? 300);
const speed = Number(process.argv[5] ?? 60);

const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage();
await p.setViewport({ width: 900, height: 560 });
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push('ERR ' + m.text()); });
const u = new URL('http://127.0.0.1:8140/index.html' + (q.startsWith('?') || q.startsWith('&') ? q : '?' + q));
u.searchParams.set('capture', '1'); u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 240000, polling: 300 });

const out = await p.evaluate(async (mm, n, sp) => {
  const C = window.__clock, F = window.__flood, fb = window.__fb;
  C.setSpeed(sp);
  C.setPlaying(false); C.seek(mm);
  const t0 = performance.now();
  while (performance.now() - t0 < 20000 && F.frameIndex !== 4) await new Promise((r) => setTimeout(r, 150));
  const rows = [];
  C.setPlaying(true);
  for (let k = 0; k < n; k += 50) {
    window.__frame(1 / 30, 50);
    const s = fb.stats();
    const st = window.__ped && window.__ped.fleeStats ? window.__ped.fleeStats() : {};
    rows.push({
      min: +C.minute.toFixed(0),
      waders: s.waders, stalled: s.stalled, cells: s.cells,
      maxDelay: +s.maxDelay.toFixed(2), maxDisp: +(s.maxDisp * 100).toFixed(2),
      flee: st.flee ?? '-', wade: st.wadeNow ?? '-',
    });
  }
  C.setPlaying(false);
  return { rows, painted: F.repaint(true) };
}, minute, frames, speed);

console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log(errs.join('\n'));
await b.close();
