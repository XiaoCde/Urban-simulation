#!/usr/bin/env node
/** 单人场景截图与状态探针：node office-shot.js <png> [tMin] [view] [W] [H] */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const candidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) throw new Error('找不到 Chrome/Edge');
const out = process.argv[2] || '_office.png';
const t = Number(process.argv[3] || 49);
const view = process.argv[4] || 'follow';
const W = Number(process.argv[5] || 1400), H = Number(process.argv[6] || 900);
const browser = await puppeteer.launch({
  executablePath, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', `--window-size=${W},${H}`],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));
await page.goto(`http://127.0.0.1:8123/office.html?play=0&t=${t}&view=${view}${process.env.OFFICE_PROFILE ? `&profile=${process.env.OFFICE_PROFILE}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__ready === true || window.__officeError, { timeout: 240000, polling: 300 });
let error = null;
try { error = await page.evaluate(() => window.__officeError || null); }
catch (e) { for (const l of logs) console.log(l); throw e; }
if (error) {
  console.error(error);
  for (const l of logs) console.log(l);
  await browser.close();
  process.exit(2);
}
await new Promise((r) => setTimeout(r, 2500));
const bubbleClick = await page.evaluate(() => {
  const bubble = document.getElementById('agentBubble');
  const card = document.getElementById('agentCard');
  if (!bubble) return 'missing';
  bubble.click();
  return card?.classList.contains('open') ? 'opened' : 'closed';
});
const snapshot = await page.evaluate(() => {
  const s = window.__officeSnapshot();
  return {
    tMin: s.tMin, state: s.state, stateText: s.stateText, reason: s.reason, floor: s.floor,
    position: [s.position.x, s.position.y, s.position.z], depth: s.depth,
    health: s.health, stamina: s.stamina, travelled: s.travelled,
    pathName: s.pathName, pathProgress: s.pathProgress, remaining: s.remaining?.length,
    info: s.info, events: s.events, traceCount: s.trace.length,
    reroutes: s.reroutes, finished: s.finished, decisions: s.decisions || [],
    exitGround: window.__officeStory?.groundAt?.(2544.37, 369.79),
    debug: window.__officeDebug?.(),
    traceSignature: `${s.trace.length}|${s.trace.slice(-3).map((p) => `${p.t.toFixed(2)},${p.x.toFixed(2)},${p.z.toFixed(2)},${p.state}`).join(';')}`,
  };
});
await page.screenshot({ path: out, type: 'png' });
console.log(`[office-shot] ${out} ${W}x${H}`);
console.log(`[office-shot] bubbleClick=${bubbleClick}`);
console.log(JSON.stringify(snapshot, null, 2));
const bad = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]') || l.startsWith('[reqfail]'));
console.log(`[office-shot] console=${logs.length} errors=${bad.length}`);
for (const l of [...bad, ...logs].slice(0, 50)) console.log(l);
await browser.close();
