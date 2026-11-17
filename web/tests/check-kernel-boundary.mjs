/**
 * 内核边界检查（纯 Node，不需要浏览器）。
 *
 * 验三件事：
 *   1. kernel/ 目录里的文件不许引用页面对象或 three；
 *   2. params.js 每个参数项都写明了值和出处，性质分类只用中文；
 *   3. 真实数据能读出来，加权总量和联合分布格子数对得上。
 *
 * 运行：node _check_kernel_boundary.mjs
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');   // 脚本已移到 web/tests/
const kernelDir = join(webRoot, 'src', 'kernel');

const FORBIDDEN = [
  { name: 'window', re: /\bwindow\s*\./ },
  { name: 'document', re: /\bdocument\s*\./ },
  { name: 'location', re: /\blocation\s*\./ },
  { name: 'navigator', re: /\bnavigator\s*\./ },
  { name: 'three 模块', re: /from\s+['"]three['"]/ },
  { name: 'THREE 命名空间', re: /\bTHREE\s*\./ },
  { name: '3D 对象构造', re: /new\s+(Vector3|Mesh|Scene|Group|Box3|Sprite|CanvasTexture)\s*\(/ },
];

const ALLOWED_KINDS = new Set(['真实数据集', '文献里的实测值', '模型跑出来的数（不是实测）', '目前自己定的']);

let failed = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failed += 1; };
const ok = (msg) => console.log('  ✓ ' + msg);

const files = (await readdir(kernelDir)).filter((f) => f.endsWith('.js')).sort();
console.log(`内核目录 ${files.length} 个文件：${files.join(', ')}`);

for (const f of files) {
  const text = await readFile(join(kernelDir, f), 'utf8');
  const hits = FORBIDDEN.filter((x) => x.re.test(text)).map((x) => x.name);
  // 注释里提到这些词是允许的，只检查代码行。
  const codeLines = text.split('\n').filter((l) => {
    const t = l.trim();
    return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  });
  const codeHits = FORBIDDEN.filter((x) => codeLines.some((l) => x.re.test(l))).map((x) => x.name);
  if (codeHits.length) fail(`${f} 代码里出现禁止依赖：${codeHits.join('、')}`);
  else ok(`${f} 没有页面对象或 3D 依赖${hits.length ? '（注释里提到的词不算）' : ''}`);
}

const mod = await import('../src/kernel/params.js');
const expected = ['POPULATION', 'DAY_BASELINE', 'HAZARD_THRESHOLDS', 'SELF_SET', 'KERNEL_META', 'paramsSummary'];
for (const name of expected) {
  if (mod[name] === undefined) fail(`params.js 缺导出 ${name}`);
}
ok(`params.js 导出齐全：${expected.join(', ')}`);

const groups = ['POPULATION', 'DAY_BASELINE', 'HAZARD_THRESHOLDS', 'SELF_SET'];
for (const g of groups) {
  for (const [key, item] of Object.entries(mod[g])) {
    if (g === 'DAY_BASELINE' && key === 'usageLimit') continue;
    if (!item || typeof item !== 'object') { fail(`${g}.${key} 不是参数项`); continue; }
    if (!('value' in item)) fail(`${g}.${key} 缺 value`);
    if (!('source' in item)) fail(`${g}.${key} 缺 source`);
    if (!ALLOWED_KINDS.has(item.kind)) fail(`${g}.${key} 的性质分类不是中文写明：${item.kind}`);
    if (item.kind !== '目前自己定的' && !item.source) fail(`${g}.${key} 标了真实来源却没写 source`);
    if (item.kind === '目前自己定的' && !item.note) fail(`${g}.${key} 标了「目前自己定的」却没写待补依据`);
  }
}
ok('每个参数项都有值、出处、中文性质；「目前自己定的」都写了待补依据');

const s = mod.paramsSummary();
console.log('  参数摘要：', JSON.stringify(s));
if (s.acsWeightSum !== 681294) fail(`ACS 加权合计 ${s.acsWeightSum}，预期 681294`);
if (s.acsJointCells !== 2970) fail(`ACS 联合分布格子数 ${s.acsJointCells}，预期 2970`);
if (s.nhtsJointCells !== 946) fail(`NHTS 交叉表格子数 ${s.nhtsJointCells}，预期 946`);
if (Math.abs(s.nhtsWeightSum - 253754536507) > 1) fail(`NHTS 加权合计 ${s.nhtsWeightSum} 对不上`);
ok('两份真实数据的加权总量与联合分布规模对得上');

if (mod.DAY_BASELINE.usageLimit.includes('灾害')) ok('日常出行基线的用途限制已写明');
else fail('DAY_BASELINE 缺「不能证明灾害行为」的限制说明');

console.log(failed ? `\n边界检查失败 ${failed} 项` : '\n边界检查全部通过');
process.exit(failed ? 1 : 0);
