// 回归测试：结果 JSON 必须「自证没坏」，且个案导出上限必须真的生效。
//
// 背景（2026-11-22 事故）：为了导出全部死者，我在 sim/sim-day.mjs 的
// page.evaluate 闭包里写了 `Number(process.env.SIM_CASES_MAX || 12)`。
// page.evaluate 的代码是在**浏览器**里执行的，那里没有 `process` ——
// 于是每个工况收尾都抛 "process is not defined"，`final.sim` 变成 null，
// 所有指标读成 0（死亡 0、被困 0），而**跑批脚本照旧 exit 0**。
// 表现是「clean」、实质是「整批作废」，白跑约 1.5 小时、8+3 个工况。
//
// 这个测试盯三件事：
//   1. 页面内代码不许出现 process（Node 变量不能漏进浏览器）；
//   2. SIM_CASES_MAX 必须走 URL 参数 casesmax，并在闭包里以形参接收；
//   3. 下游读结果的地方必须拒绝 final.error / final.sim=null 的结果
//      （否则「0 死亡」会被当成结论）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 注意别用 new URL(...).pathname：中文路径会被百分号编码（%E9%A1%B9%E7%9B%AE），
// 直接拼路径会 ENOENT。fileURLToPath 才做正确的解码。
const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
};

function read(rel) { return fs.readFileSync(path.join(WEB, rel), 'utf8'); }

// ---------- 1. sim-day：页面闭包里不能有 process ----------
{
  const src = read('sim/sim-day.mjs');
  // 闭包形参在 2026-11-22 晚从 casesMax（数字）改成 RUN（配置对象）：
  // 结果需要自带 decide/single/peer/seed 这些配置，一个数字不够传。
  const start = src.indexOf('p.evaluate((RUN) => {');
  ok('收尾快照闭包以形参接收配置对象 RUN', start >= 0);
  if (start >= 0) {
    const end = src.indexOf('}, RUN_META)', start);
    ok('闭包有明确的结束标记 }, RUN_META)', end > start);
    const block = src.slice(start, end > start ? end : src.length);
    ok('闭包里没有 process（浏览器里没有这个全局）', !/\bprocess\b/.test(block),
      '发现 process，会让每次收尾抛错 → final.sim=null');
    ok('闭包里用 RUN.casesMax 调 exportCases', /exportCases\(RUN\.casesMax\)/.test(block));
  }
  ok('SIM_CASES_MAX 从 Node 侧读', /process\.env\.SIM_CASES_MAX/.test(src));
  ok('上限经 URL 参数 casesmax 传入页面', /searchParams\.set\('casesmax'/.test(src));
  ok('CASES_MAX 有下限保护（≥1）', /Math\.max\(1, Number\(process\.env\.SIM_CASES_MAX/.test(src));
}

// ---------- 2. sim-sweep：必须显式拒绝坏结果 ----------
{
  const src = read('sim/sim-sweep.mjs');
  ok('sim-sweep 检查 final.error', /final\.error/.test(src));
  ok('sim-sweep 检查 final.sim 为 null', /final\.sim 为 null|!j\.final\.sim/.test(src));
}

// ---------- 3. 下游比较器：不许拿坏结果比 ----------
{
  const ab = read('tools/check/decide-ab.mjs');
  ok('decide-ab 拒绝 final.error', /\[refuse\]/.test(ab) && /final\.error/.test(ab));
  const td = read('tools/check/trace-deep.mjs');
  ok('trace-deep 记录并排除坏结果', /broken\.push/.test(td));
}

// ---------- 4. 批跑脚本：必须把上限传下去 ----------
{
  for (const f of ['sim/run_ablate_v1.sh', 'sim/run_surge_v1.sh']) {
    const src = read(f);
    ok(`${f} 设了 SIM_CASES_MAX=999`, /SIM_CASES_MAX=999/.test(src));
  }
}

// ---------- 5. 收尾快照必须有独立的、更宽的超时 ----------
// 2026-11-22 19:05 抓到：p16 两条跑到 100% 后 `收尾快照 超时 180000ms`，
// final.sim=null。个案上限开到 999 之后，序列化上百条 replay 要几分钟，
// 180 s 是「一批帧」的预算，不是「整场个案」的预算。
{
  const src = read('sim/sim-day.mjs');
  ok('收尾快照有独立 FINAL_TIMEOUT（默认 900000）',
    /const FINAL_TIMEOUT = Math\.max\(60000, Number\(process\.env\.SIM_FINAL_TIMEOUT \|\| 900000\)\)/.test(src));
  ok('收尾快照用 FINAL_TIMEOUT 而不是 BATCH_TIMEOUT',
    /\}, RUN_META\), FINAL_TIMEOUT, '收尾快照'\)/.test(src));
  ok('批次超时仍是 180000（卡帧检测不能被顺手放大）',
    /SIM_BATCH_TIMEOUT \|\| 180000/.test(src));
  ok('SIM_FINAL_TIMEOUT 写进文件头环境变量说明', /SIM_FINAL_TIMEOUT（收尾快照超时/.test(src));
}

// ---------- 5b. 个案导出失败时，不能让整场作废 ----------
// 2026-11-22 20:10：一次把「汇总 + 个案」都取回来是脆的。个案序列化慢、汇总很快，
// 所以失败后要立刻降级再取一次**不要个案**的快照。降级结果必须有 casesWithheld，
// 下游（decide-ab / trace-deep）按「指标可信、个案缺」处理，而不是当坏结果丢掉。
{
  const src = read('sim/sim-day.mjs');
  ok('失败后降级重取（casesWithheld + 120000 超时）',
    /casesWithheld: true/.test(src) && /120000, '收尾快照（降级）'/.test(src));
  ok('降级结果仍带 meta 与 sim', /meta: RUN,\n        error: null/.test(src));
  const ab = read('tools/check/decide-ab.mjs');
  ok('decide-ab：sim 在的降级结果照常比，只 warn',
    /\[warn\]/.test(ab) && /j\.final\.error && j\.final\.sim/.test(ab));
  ok('decide-ab：只有 sim 为 null 才 refuse', /j\.final\.error && !j\.final\.sim/.test(ab));
  const td = read('tools/check/trace-deep.mjs');
  ok('trace-deep：降级结果进 withheld 不进 broken',
    /withheld\.push/.test(td) && /j\.final\.error && !j\.final\.sim/.test(td));
}

// ---------- 5c. 个案轨迹要抽稀（否则 999 个个案序列化要十几分钟） ----------
{
  const src = read('src/incidents.js');
  ok('exportCases 对轨迹抽稀（slimTrace + REPLAY_MAX_FRAMES）',
    /function slimTrace/.test(src) && /REPLAY_MAX_FRAMES = \d+/.test(src) && /function exportCases/.test(src));
  ok('抽稀后写明原始密度（traceFull / traceStride）',
    /rep\.traceFull = full/.test(src) && /rep\.traceStride/.test(src));
  ok('抽稀保留首末帧（等距步长）', /const step = \(trace\.length - 1\) \/ \(max - 1\)/.test(src));
}

// ---------- 6. 结果必须自带配置元数据 ----------
// 起因：结果 JSON 只有 caseMeta（水情），"这份结果是 gate 还是 single" 只能靠
// 文件名和日志猜。审稿人/后来的 AI 复现时一定拿错。final.meta 必须自带。
{
  const src = read('sim/sim-day.mjs');
  ok('结果带 final.meta（RUN_META 传进闭包）', /meta: RUN,/.test(src) && /}, RUN_META\), FINAL_TIMEOUT/.test(src));
  ok('meta 含 decide/single/peer/casesMax/seed', /decide: \(process\.env\.SIM_DECIDE/.test(src)
    && /single: \(process\.env\.SIM_SINGLE/.test(src)
    && /peer: \(process\.env\.SIM_PEER/.test(src)
    && /casesMax: CASES_MAX/.test(src) && /seed: SEED/.test(src));
  ok('个案上限从 meta 读（不再单独传 casesMax）', /exportCases\(RUN\.casesMax\)/.test(src));
}

console.log(`\n个案导出与坏结果防呆：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);