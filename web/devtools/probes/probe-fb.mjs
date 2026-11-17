/**
 * 时间维 + 回写场探针。
 * 用法: node _probe_fb.mjs [query] [minute]
 * 输出: 控制台全部消息、depthAt(t) 的时间曲线、回写场读数、单帧耗时。
 *
 * 【注意】无头 + SwiftShader 下渲染泵每 33 ms 抢一次主线程，网络回调会被饿到
 * 好几秒，所以这里必须「等帧真的落地」再采样，不能 sleep 固定时长。
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);

const q = process.argv[2] || '';
const minute = Number(process.argv[3] ?? 1100);
const b = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 760 });
const logs = [];
p.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
p.on('pageerror', (e) => logs.push(`[PAGEERROR] ${e.message}`));
p.on('requestfailed', (r) => logs.push(`[REQFAIL] ${r.url()} ${r.failure()?.errorText}`));

const u = new URL('http://127.0.0.1:8140/index.html' + q);
u.searchParams.set('capture', '1');
u.searchParams.set('v', String(Date.now()));
await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__ready === true, { timeout: 180000, polling: 300 });

const out = await p.evaluate(async (mm) => {
  const C = window.__clock, F = window.__flood, fb = window.__fb;
  C.setPlaying(false);
  C.seek(mm);
  // 等目标帧真的进到纹理里（无头环境可能要几秒）
  const t0 = performance.now();
  while (performance.now() - t0 < 20000) {
    if (F.frameIndex === 5 && (F.manifest.frames[5].t_min === mm || true)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 400));

  const g = F.depthGrid;
  let mx = 0, ami = -1;
  if (g) for (let i = 0; i < g.data.length; i++) if (g.data[i] > mx) { mx = g.data[i]; ami = i; }
  const man = F.manifest;
  const c = ami % man.cols, r = (ami / man.cols) | 0;
  const best = { x: man.x0 + (c + 0.5) * man.step_m, z: man.z0 + (r + 0.5) * man.step_m, d: 0 };
  best.d = +F.depthAt(best.x, best.z, mm).toFixed(3);

  const res = { frameIndex: F.frameIndex, maxU8: mx, best: { x: +best.x.toFixed(0), z: +best.z.toFixed(0), d: best.d } };
  res.series = [1020, 1060, 1080, 1100, 1140, 1180, 1260, 1440]
    .map((t) => [t, +F.depthAt(best.x, best.z, t).toFixed(3)]);
  // 空间插值：横穿水面 8 m 走一步，看是不是台阶
  res.across = [];
  for (let k = 0; k < 6; k++) res.across.push(+F.depthAt(best.x + k * 2, best.z, mm).toFixed(3));

  // 回写：模拟 40 人在这一格踩 2 分钟
  res.fb0 = { ...fb.stats() };
  for (let k = 0; k < 600; k++) {
    for (let i = 0; i < 40; i++) fb.wade(best.x + (i % 8) * 1.2, best.z + ((i / 8) | 0) * 1.2, 0.4, 0.2);
    fb.step(0.2);
  }
  res.fb1 = { ...fb.stats() };
  res.depthAfter = +F.depthAt(best.x, best.z, mm).toFixed(3);

  const t1 = performance.now();
  for (let k = 0; k < 2000; k++) F.depthAt(best.x + k * 0.01, best.z, mm);
  res.depthAt_us = +((performance.now() - t1) / 2000 * 1000).toFixed(2);
  const t2 = performance.now();
  for (let k = 0; k < 10; k++) F.repaint(true);
  res.repaint_ms = +((performance.now() - t2) / 10).toFixed(2);
  res.painted = F.repaint(true);
  return res;
}, minute);

console.log('--- console ---');
for (const l of logs) console.log(l);
console.log('--- probe ---');
console.log(JSON.stringify(out, null, 1));
await b.close();
