/**
 * probe-speed.mjs — 验证「流速帧真的被前端读到」的最小探针。
 *
 * 只做一件事：切到指定工况的降雨峰值帧，在栅格上均匀撒点，比较
 * 「水深 >1 m」的格子里 speedAt 是不是非零，并打印流速/危险度分布。
 * 不推人工时钟、不跑行人，属于数据接通验证，不出任何结果数字。
 *
 * 用法：cd web && node devtools/probes/probe-speed.mjs [case] [tMin]
 * 需要 8140 已经有静态服务（probe 不自己起服务）。
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
if (!CHROME) throw new Error('找不到 Chrome / Edge');

const CASE = process.argv[2] || 'u_p80_s0';
const TMIN = Number(process.argv[3] || 1125);
const URL = 'http://127.0.0.1:8140/index.html?capture=1&ped=40&seed=20261117';

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e && e.message));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 300 });

// 页面默认装的是 u_p8_s0；先切到目标档，再等水帧与流速帧落地。
await page.evaluate(async (cs, t) => {
  const F = window.__flood;
  if (!F) throw new Error('window.__flood 不存在');
  const cur = ((F.manifest && F.manifest.source) || '').split('/').filter(Boolean).pop();
  if (cur !== cs) await F.load(cs);
  // 反复 showMinute 触发该时间点邻近帧的下载；sampleFlow 返回 0 可能只是还没到。
  for (let i = 0; i < 8; i++) {
    F.showMinute(t);
    await new Promise((r) => setTimeout(r, 500));
  }
}, CASE, TMIN);

const out = await page.evaluate(async (t) => {
  const F = window.__flood;
  // 先空采一次把该时刻的 vel/dir 帧踢进去，再等它们落地 —— 这些 fetch 是异步的，
  // 在一个同步循环里连着采只会全部读到「还没下载完」。
  const px0 = -1277.0 + 300 * 8 + 4, pz0 = -4189.0 + 300 * 8 + 4;
  F.speedAt(px0, pz0, t);
  await new Promise((r) => setTimeout(r, 2500));
  const rows = [];
  let wet = 0, wetWithSpeed = 0, deep = 0, deepWithSpeed = 0;
  let sumSp = 0, maxSp = 0, maxHr = 0, sumHr = 0, nHr = 0, seen = 0;
  // 8 m 栅格、全城 747×640：按 12 格步长撒点（约 3.3k 点，够判接通）
  for (let c = 0; c < 747; c += 12) {
    for (let r = 0; r < 640; r += 12) {
      const x = -1277.0 + c * 8 + 4;
      const z = -4189.0 + r * 8 + 4;
      const d = F.depthAt(x, z, t);
      if (d >= 0.05) {
        wet++;
        const sp = F.speedAt(x, z, t);
        if (sp > 0.01) { wetWithSpeed++; sumSp += sp; if (sp > maxSp) maxSp = sp; }
        if (d >= 1.0) {
          deep++;
          if (sp > 0.01) deepWithSpeed++;
          const hr = d * (sp + 0.5) + (d >= 0.75 ? 1 : (d >= 0.25 ? 0.5 : 0));
          sumHr += hr; nHr++;
          if (hr > maxHr) maxHr = hr;
          if (rows.length < 8 && sp > 0.3) rows.push({ d: +d.toFixed(2), sp: +sp.toFixed(2), hr: +hr.toFixed(2) });
        }
      }
      if (++seen % 900 === 0) await new Promise((r2) => setTimeout(r2, 30));  // 让 fetch 有机会回调
    }
  }
  return { t, wet, wetWithSpeed, deep, deepWithSpeed,
    meanSpWet: wetWithSpeed ? +(sumSp / wetWithSpeed).toFixed(3) : 0, maxSp: +maxSp.toFixed(2),
    meanHrDeep: nHr ? +(sumHr / nHr).toFixed(2) : 0, maxHr: +maxHr.toFixed(2), samples: rows };
}, TMIN);

console.log(JSON.stringify(out, null, 2));
console.log(out.wetWithSpeed > 0 ? '[ok] 流速帧已接通' : '[bad] 湿格流速全为 0 —— 检查 manifest/vel 文件');
await browser.close();