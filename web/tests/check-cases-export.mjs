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
  const start = src.indexOf('p.evaluate((casesMax) => {');
  ok('收尾快照闭包以形参接收 casesMax', start >= 0);
  if (start >= 0) {
    // 闭包从 p.evaluate( 到它的结束 "}, CASES_MAX)"
    const end = src.indexOf('}, CASES_MAX)', start);
    ok('闭包有明确的结束标记 }, CASES_MAX)', end > start);
    const block = src.slice(start, end > start ? end : src.length);
    ok('闭包里没有 process（浏览器里没有这个全局）', !/\bprocess\b/.test(block),
      '发现 process，会让每次收尾抛错 → final.sim=null');
    ok('闭包里用 casesMax 调 exportCases', /exportCases\(casesMax\)/.test(block));
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

console.log(`\n个案导出与坏结果防呆：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);