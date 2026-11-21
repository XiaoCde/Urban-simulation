/**
 * check-dead-wiring.mjs — 纯 Node，防止「看着接了、其实死的」两根线回来（A6）。
 *
 * 这两处都不是算错，是**声明与实现脱钩**：参数/常量在，代码不读它。
 * 答辩现场只要有人顺手试一下命令行就会露馅，所以钉成回归：
 *   ① tools/flood/shallow2d.py 不再接受 --sewer-m3s（二维内核真正的排水
 *      能力是 --drain-m3s + --drain-fail-after-mm 的满管桶）；
 *   ② tools/flood/build_unified.py 拼给内核的每个 flag，内核 argparse 都认识
 *      （2026-11-21 删参数时如果只删一边，重跑 8 工况会直接 argparse 报错）；
 *   ③ web/src/kernel/crowd-threshold.js 不再导出 RUFAT_CUE_LADDER（未接入的
 *      候选证据，留在注释里，不做成可 import 的死常量）。
 *
 * 需要 python 在 PATH 上（与 tools/flood 其它脚本一致）。
 * 用法：cd web && node tests/check-dead-wiring.mjs
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const FLOOD = join(ROOT, 'tools', 'flood');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? `  ← ${detail}` : ''}`); }
};

const py = spawnSync('python', ['shallow2d.py', '--help'], { cwd: FLOOD, encoding: 'utf8' });
const help = (py.stdout || '') + (py.stderr || '');
const flags = new Set((help.match(/--[a-z0-9][a-z0-9-]*/g) || []));

ok(py.status === 0 && flags.size > 20, 'shallow2d.py --help 正常跑出参数表', `退出码=${py.status}`);
ok(!flags.has('--sewer-m3s'), 'shallow2d 不再接受 --sewer-m3s（旧参数从没被读过）');
ok(flags.has('--drain-m3s') && flags.has('--drain-fail-after-mm'),
  '真正的排水旋钮还在：--drain-m3s + --drain-fail-after-mm');

// build_unified 的 COMMON 里每个 flag 内核都认识（注释行不计）
{
  const src = readFileSync(join(FLOOD, 'build_unified.py'), 'utf8');
  const block = src.split('COMMON = [')[1].split(']')[0]
    .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  const asked = (block.match(/--[a-z0-9][a-z0-9-]*/g) || []);
  const missing = asked.filter((f) => !flags.has(f));
  ok(asked.length >= 10 && missing.length === 0,
    `build_unified 拼给内核的 ${asked.length} 个 flag 全部被认可`, missing.join(' '));
}

// build_velocity 不再透传 sewer_m3s（旧 stats.json 里还有这个键）
{
  const src = readFileSync(join(FLOOD, 'build_velocity.py'), 'utf8');
  ok(!/"sewer_m3s"/.test(src), 'build_velocity 不再把 sewer_m3s 透传进命令行');
}

// simple_drainage.py 的 --sewer-m3s 是**真在用**的，别顺手一起删了
{
  const src = readFileSync(join(FLOOD, 'simple_drainage.py'), 'utf8');
  const uses = (src.match(/args\.sewer_m3s/g) || []).length;
  ok(uses >= 1, 'simple_drainage.py 仍在使用 args.sewer_m3s（fill-and-spill 内核那条真账）',
    `引用 ${uses} 处`);
}

// RUFAT 阶梯：不做成可 import 的死常量
{
  const src = readFileSync(join(ROOT, 'web', 'src', 'kernel', 'crowd-threshold.js'), 'utf8');
  ok(!/^export const RUFAT_CUE_LADDER/m.test(src), 'RUFAT_CUE_LADDER 已不再导出');
  ok(/A6/.test(src) && /没有接进代码/.test(src), '删除原因写在原处，不是无声消失');
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);