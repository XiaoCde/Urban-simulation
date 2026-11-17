/**
 * _sim_sweep.mjs — 多个降雨工况并行跑（工况级并行，不改内核）。
 *
 * 【用户 2026-11-17】「现在是多核在跑计算吗」→ 不是；「先做小的吧」。
 * 单个 24h 仿真是一整条串行链（页面里一个 for 循环遍历所有人），
 * 不改内核就没法把一次仿真拆到多核。但工况之间完全独立——u_p8_s0 和
 * u_p24_s0 互不读对方任何状态——所以可以每个工况开一个浏览器实例，
 * 同时推进。这是最省事、且不动内核一行代码的并行方式。
 *
 * 每个工况仍然是自己那份完整的 24h 连续仿真（同一套代码、同一个起点、
 * 同一批人），跑出来的数字与单跑完全一致，可以直接横向比。
 *
 * 用法:
 *   node _sim_sweep.mjs all                   # 8 个降雨档，并发 3
 *   node _sim_sweep.mjs all 4                 # 并发 4
 *   node _sim_sweep.mjs u_p8_s0,u_p32_s0 2    # 指定工况
 *   node _sim_sweep.mjs all 3 1000 1440 out/sweep
 *
 * 参数顺序：工况 / 并发数 / 人数 / 分钟 / 输出目录
 *
 * 为什么并发默认 3：一个无头 Chrome 跑这套城市模型约占 1.2–1.6 GB，
 * 本机可用物理内存只有 4 GB 左右，开多了会开始换页，反而更慢。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, normalize, sep } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');   // 脚本已移到 web/sim/，web/ 根目录在上一级
const ARG_CASES = (process.argv[2] || 'all').trim();
const CONCURRENCY = Math.max(1, Number(process.argv[3] || 3));
const PEOPLE = Number(process.argv[4] || 1000);
const MINUTES = Number(process.argv[5] || 1440);
const OUTDIR = resolve(WEB, process.argv[6] || 'out/sweep');
const PORT = 8140;
// 人群种子：所有工况用同一批人，只有水在变。改这个号就是换一批人。
const SEED = Number(process.env.SIM_SEED || 20261117) >>> 0;

// 无增水（s0）的 8 个降雨档。全天连绵雨：8/16/24/32 mm/h；傍晚 17–19 点
// 两小时暴雨：20/40/80/120 mm/h。两族不能直接横向比，报告里要分开写。
const ALL_CASES = [
  'u_p8_s0', 'u_p16_s0', 'u_p24_s0', 'u_p32_s0',
  'u_p20_s0', 'u_p40_s0', 'u_p80_s0', 'u_p120_s0',
];
const CASES = ARG_CASES === 'all' ? ALL_CASES : ARG_CASES.split(',').map((s) => s.trim()).filter(Boolean);
for (const c of CASES) {
  if (!existsSync(join(WEB, 'assets/flood', c, 'manifest.json'))) {
    throw new Error('没有这个工况：' + c);
  }
}
mkdirSync(OUTDIR, { recursive: true });

// ---------------------------------------------------------------- 静态服务
// 只在没起过的时候起一个，跑完关掉；不常驻（用户要求 8140 不留后台）。
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.u8': 'application/octet-stream', '.ktx2': 'image/ktx2', '.wasm': 'application/wasm',
};
const ROOT = WEB;
function serve() {
  const s = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const full = normalize(join(ROOT, p));
      if (!full.startsWith(ROOT + sep) && full !== ROOT) { res.writeHead(403).end('no'); return; }
      const st = await stat(full);
      if (st.isDirectory()) { res.writeHead(404).end('no'); return; }
      const buf = await readFile(full);
      res.writeHead(200, { 'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache' });
      res.end(buf);
    } catch { res.writeHead(404).end('no'); }
  });
  return new Promise((ok) => s.listen(PORT, '127.0.0.1', () => ok(s)));
}
let server = null;
try {
  const probe = await fetch(`http://127.0.0.1:${PORT}/index.html`, { method: 'HEAD' });
  if (!probe.ok) throw new Error('bad');
  console.log(`[sweep] 8140 已有服务，直接复用`);
} catch {
  server = await serve();
  console.log(`[sweep] 起了临时静态服务 127.0.0.1:${PORT}`);
}

// ---------------------------------------------------------------- 任务池
console.log(`[sweep] 工况 ${CASES.length} 个 · 并发 ${CONCURRENCY} · ${PEOPLE} 人 · ${MINUTES} 分`);
console.log(`[sweep] 输出 ${OUTDIR}`);

const results = [];
const t0 = Date.now();

function runOne(c, label = c) {
  return new Promise((ok) => {
    const out = join(OUTDIR, label + '.json');
    const logPath = join(OUTDIR, label + '.log');
    const log = createWriteStream(logPath);
    const t = Date.now();
    const cp = spawn(process.execPath, [
      join(WEB, 'sim/sim-day.mjs'), String(MINUTES), '24', String(PEOPLE), out, '0', c, String(SEED),
    ], { cwd: WEB, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    cp.stdout.on('data', (d) => { const s = d.toString(); log.write(s); tail = (tail + s).slice(-4000); });
    cp.stderr.on('data', (d) => { const s = d.toString(); log.write('[err] ' + s); tail = (tail + s).slice(-4000); });
    cp.on('close', (code) => {
      log.end();
      const sec = (Date.now() - t) / 1000;
      let sum = null;
      try {
        const j = JSON.parse(readFileSync(out, 'utf8'));
        const I = (j.final && j.final.sim && j.final.sim.incidents) || {};
        const D = (j.final && j.final.sim && j.final.sim.driving) || {};
        sum = { dead: I.dead, stranded: I.everStranded, injured: I.everInjured,
          evacuated: I.evacuated, driveChosen: D.driveChosen, arrivals: D.arrivals,
          carKm: D.carKm, redLightWaits: I.redLightWaits, yields: I.yields,
          maxDepthCm: Math.round((I.maxDepth || 0) * 100),
          deathsByCause: I.deathsByCause, wallSec: j.wallSec };
      } catch (e) { sum = { error: 'parse: ' + e.message }; }
      console.log(`[sweep] ${c} 完成 · ${sec.toFixed(0)}s · 退出码 ${code}`
        + (sum && sum.dead != null ? ` · 死 ${sum.dead} 困 ${sum.stranded} 避险 ${sum.evacuated}` : ''));
      results.push({ case: c, code, sec: +sec.toFixed(1), sum });
      ok();
    });
  });
}

// 同一个工况出现多次（用来验证确定性）时，输出文件不能互相覆盖
const seenCase = new Map();
function uniqueLabel(c) {
  const k = (seenCase.get(c) || 0) + 1;
  seenCase.set(c, k);
  return k === 1 ? c : `${c}__${k}`;
}

let cursor = 0;
async function worker(id) {
  while (cursor < CASES.length) {
    const c = CASES[cursor++];
    const label = uniqueLabel(c);
    console.log(`[sweep] 工人 ${id} 接 ${c}${label === c ? '' : ' → ' + label}`);
    await runOne(c, label);
  }
}
const n = Math.min(CONCURRENCY, CASES.length);
await Promise.all(Array.from({ length: n }, (_, i) => worker(i + 1)));

// ---------------------------------------------------------------- 汇总
const wallSec = +((Date.now() - t0) / 1000).toFixed(1);
// 串行耗时 = 各工况耗时之和；并行提速按墙钟算
const serialSec = +results.reduce((s, r) => s + r.sec, 0).toFixed(1);
const summary = { wallSec, serialSec, speedup: +(serialSec / wallSec).toFixed(2),
  concurrency: CONCURRENCY, people: PEOPLE, minutes: MINUTES, results };
const sumPath = join(OUTDIR, '_sweep.json');
const { writeFileSync } = await import('node:fs');
writeFileSync(sumPath, JSON.stringify(summary, null, 2));
console.log(`\n[sweep] 全部完成 · 墙钟 ${wallSec}s · 串行本应 ${serialSec}s · 提速 ${summary.speedup}×`);
console.log(`[sweep] 汇总 ${sumPath}`);
if (server) { server.close(); console.log('[sweep] 已关闭临时静态服务'); }
