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
 * 为什么并发默认 3：一个无头 Chrome 跑这套模型实测常驻 2.0–2.5 GB（2026-11-19 采样，
 * 上下浮动、不单调增长），本机总内存 15.4 GB、提交内存余量约 11 GB，四并发时余量会被吃掉大半，
 * 开始换页反而更慢，也有渲染进程被干掉的风险。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, readFileSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, normalize, sep } from 'node:path';
import {
  WATCH, createWatchdog, parseProgress, etaOf, etaVerdict, scanNaN, sanityOf, tripwireSummary,
  rainFamily, familyRefSec, familyInversions,
} from './tripwires.mjs';

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
    // 四条绊线的判定结果，跟着这次工况一起进 _sweep.json。
    const trip = { stalled: false, silentSec: 0, etaOver: false, etaRatio: null,
      expectedWallSec: 0, nan: [], sanity: null, killedByWatchdog: false };
    const cp = spawn(process.execPath, [
      join(WEB, 'sim/sim-day.mjs'), String(MINUTES), '24', String(PEOPLE), out, '0', c, String(SEED),
    ], { cwd: WEB, stdio: ['ignore', 'pipe', 'pipe'] });

    let tail = '';
    // 绊线2 的基准：同族（全天雨/傍晚暴雨）已完成工况的墙钟中位数。
    // 没有同族参照（例如只跑一个工况）时**不报 ETA 偏离**，只报进度 ——
    // 宁可少一条指标，也不发一条每次都会响的假警报。
    let expectedWallSec = familyRefSec(c, results);
    trip.expectedWallSec = expectedWallSec;
    trip.refFamily = rainFamily(c);
    if (!expectedWallSec) trip.etaRefMissing = true;
    let lastMinute = -1;

    // ---- 绊线1 断流看门狗：日志长时间不涨 → 报警 + 终止子进程。
    // 夜里「23:17 之后 11 小时没人知道」就是死在这条上。
    const wd = createWatchdog({
      probe: () => { const st = statSync(logPath); return { size: st.size, mtimeMs: st.mtimeMs }; },
      onSilent: ({ silentSec }) => {
        trip.stalled = true;
        trip.silentSec = silentSec;
        trip.killedByWatchdog = true;
        console.error(`[sweep][绊线1] ${c} 日志 ${silentSec}s 没有新内容（阈值 ${WATCH.stallMin} 分钟）→ 判定断流，终止该子进程`);
        try { cp.kill('SIGKILL'); } catch { /* 进程可能已经没了 */ }
      },
    }).start();

    const onChunk = (s) => {
      log.write(s);
      tail = (tail + s).slice(-4000);
      // ---- 绊线2 ETA 偏离
      const p = parseProgress(s) || parseProgress(tail);
      if (p && p.minute !== lastMinute) {
        lastMinute = p.minute;
        trip.lastMinute = p.minute;
        if (expectedWallSec) {
          const v = etaVerdict({ wallSec: p.wallSec, expectedWallSec });
          if (v.over && !trip.etaOver) {
            trip.etaOver = true;
            trip.etaRatio = v.ratio;
            console.error(`[sweep][绊线2] ${c} 进度偏离：到 ${p.minute} 分已花 ${p.wallSec}s，`
              + `同族参照 ${expectedWallSec}s（${v.ratio}×，阈值 ${WATCH.etaSlack}×）`);
          }
        } else if (p.minute >= MINUTES / 2 && !trip.etaInfo) {
          // 没有同族参照时只报「按本工况当前速度大概还要多久」，明说是参考、不作告警。
          const e = etaOf({ minute: p.minute, wallSec: p.wallSec, minutesTotal: MINUTES });
          if (e.etaWallSec && e.etaWallSec > 0) {
            trip.etaInfo = true;
            console.log(`[sweep] ${c} 没有同族参照：按本工况当前速度估计总墙钟 ≈ ${e.etaWallSec}s`
              + `（仅参考，不作告警）`);
          }
        }
      }
    };
    cp.stdout.on('data', (d) => onChunk(d.toString()));
    cp.stderr.on('data', (d) => onChunk('[err] ' + d.toString()));

    cp.on('close', (code) => {
      wd.stop();
      log.end();
      const sec = (Date.now() - t) / 1000;
      // 绊线2 的收尾复核：进度行不一定跑到最后（一个 120 人的 60 分工况只打了两行），
      // 光靠「跑到 X 分花了多久」会漏掉「整场就是比别人慢一倍」这种。
      // 这里用最终墙钟对比同族参照，迟到但一定不会漏。
      if (expectedWallSec && !trip.etaOver && sec > expectedWallSec * WATCH.etaSlack) {
        trip.etaOver = true;
        trip.etaRatio = +(sec / expectedWallSec).toFixed(2);
        console.error(`[sweep][绊线2] ${c} 整场超时：实测 ${sec.toFixed(0)}s，同族参照 ${expectedWallSec}s`
          + `（${trip.etaRatio}×，阈值 ${WATCH.etaSlack}×）`);
      }
      let sum = null;
      try {
        const j = JSON.parse(readFileSync(out, 'utf8'));
        // ---- 绊线4 NaN：只扫汇总层，不扫逐帧轨迹（那会把内存和 CPU 拖垮）。
        trip.nan = scanNaN({ final: j.final, metrics: j.metrics, summary: j.summary });
        const I = (j.final && j.final.sim && j.final.sim.incidents) || {};
        const D = (j.final && j.final.sim && j.final.sim.driving) || {};
        sum = { dead: I.dead, stranded: I.everStranded, injured: I.everInjured,
          evacuated: I.evacuated, driveChosen: D.driveChosen, arrivals: D.arrivals,
          carKm: D.carKm, redLightWaits: I.redLightWaits, yields: I.yields,
          maxDepthCm: Math.round((I.maxDepth || 0) * 100),
          deathsByCause: I.deathsByCause, deathsByZone: I.deathsByZone,
          deathsByLegacyCause: I.deathsByLegacyCause, wallSec: j.wallSec };
      } catch (e) { sum = { error: 'parse: ' + e.message }; }

      // ---- 绊线3 合理性（这里只做绝对判据：缺数/超人数/死因对不上；
      //      相对基线的判据要等同批都跑完，在下面的汇总段里算）。
      // 被看门狗终止的工况没有结果文件，「解析失败 / 死亡数缺失」只是断流的后果，
      // 不再重复计三条 —— 结论写清「断流终止，没有产出」就够了。
      trip.sanity = trip.killedByWatchdog
        ? { ok: true, issues: [], skipped: '断流终止，合理性无从判定（无产出）' }
        : sanityOf(sum, { people: PEOPLE });
      const tw = tripwireSummary({ stalled: trip.stalled, eta: { over: trip.etaOver, ratio: trip.etaRatio },
        nan: trip.nan, sanity: trip.sanity });
      trip.ok = tw.ok;
      trip.bad = tw.bad;

      if (!tw.ok) {
        console.error(`[sweep][绊线] ${c} 有 ${tw.bad.length} 条告警：${tw.bad.join('；')}`);
      }
      if (trip.killedByWatchdog) {
        console.error(`[sweep] ${c} 被看门狗终止（${trip.silentSec}s 无输出）· 没有产出，不进结果表`);
      } else {
        console.log(`[sweep] ${c} 完成 · ${sec.toFixed(0)}s · 退出码 ${code}`
          + (sum && sum.dead != null ? ` · 死 ${sum.dead} 困 ${sum.stranded} 避险 ${sum.evacuated}` : '')
          + (tw.ok ? '' : ` ⚠ ${tw.bad.join(' / ')}`));
      }
      results.push({ case: c, code, sec: +sec.toFixed(1), sum, trip });
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

// ---- 绊线3 的相对判据：只用「同族内雨强升高却掉一半」这种结构性逆转。
// 【2026-11-22 改法的原因】上一版拿「同批死亡中位数」当基线，一次干净的 8 工况跑批
// 就误报 3 条（u_p8_s0 死 3、u_p20_s0 死 0、u_p40_s0 死 2 都「低于中位数 26」）——
// 那不是异常，那是雨强梯度：8 mm/h 下满一天本来就不该和 120 mm/h 两小时灌一样多。
// 跨雨强的死亡数没有可比性（文档 §15 与 sweep-report 都写明两族不能横比）。
// 现在改为同族、按雨强排序、只看「更高雨强反而不到低雨强的一半」，且只作复核提示，不阻断入表。
const intensityOf = (caseName) => {
  const m = /^u_p(\d+)_s/.exec(String(caseName || ''));
  return m ? Number(m[1]) : null;
};
const familyRows = results
  .map((r) => {
    const p = intensityOf(r.case);
    return p == null ? null : {
      case: r.case, family: rainFamily(r.case), intensity: p,
      dead: r.sum && typeof r.sum.dead === 'number' ? r.sum.dead : NaN,
    };
  })
  .filter(Boolean);
const inversions = familyInversions(familyRows);
const baselineDead = null;   // 保留字段以兼容旧 _sweep.json 读取方；不再用于判据

const bad = results.filter((r) => !r.trip.ok);
const tripCount = {
  stalled: results.filter((r) => r.trip.stalled).length,
  etaOver: results.filter((r) => r.trip.etaOver).length,
  nan: results.filter((r) => r.trip.nan.length > 0).length,
  sanity: results.filter((r) => r.trip.sanity && !r.trip.sanity.ok).length,
  inversions: inversions.length,
};
const summary = { wallSec, serialSec, speedup: +(serialSec / wallSec).toFixed(2),
  concurrency: CONCURRENCY, people: PEOPLE, minutes: MINUTES,
  baselineDead, tripwires: { thresholds: WATCH, counts: tripCount, inversions,
    clean: bad.length === 0, cases: bad.map((r) => ({ case: r.case, bad: r.trip.bad })) },
  results };
const sumPath = join(OUTDIR, '_sweep.json');
const { writeFileSync } = await import('node:fs');
writeFileSync(sumPath, JSON.stringify(summary, null, 2));
console.log(`\n[sweep] 全部完成 · 墙钟 ${wallSec}s · 串行本应 ${serialSec}s · 提速 ${summary.speedup}×`);
console.log(`[sweep] 绊线 · 断流 ${tripCount.stalled} · ETA 偏离 ${tripCount.etaOver} · NaN ${tripCount.nan}`
  + ` · 合理性 ${tripCount.sanity} · 雨强逆转 ${tripCount.inversions}`
  + `（ETA 参照 = 同族已完成工况墙钟中位数；死亡数不做跨雨强比较）`);
if (bad.length) {
  console.log('[sweep] ⚠ 以下工况有告警，不能当成「跑完了」直接进表：');
  for (const r of bad) console.log(`[sweep]   ${r.case}：${r.trip.bad.join('；')}`);
} else {
  console.log('[sweep] 四条绊线全清（断流 / ETA / NaN / 合理性）');
}
if (inversions.length) {
  console.log('[sweep] 复核提示（不阻断入表）：同族内雨强升高但死亡掉一半以上');
  for (const v of inversions) console.log(`[sweep]   ${v.note}`);
}
console.log(`[sweep] 汇总 ${sumPath}`);
if (server) { server.close(); console.log('[sweep] 已关闭临时静态服务'); }
