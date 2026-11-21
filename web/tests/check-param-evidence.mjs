#!/usr/bin/env node
/**
 * check-param-evidence.mjs — 参数依据的机检
 *
 * 它回答的不是「数值准不准」，而是「每个在跑的常数是不是都说得清来路」。
 * 四类断言：
 *   ① 性质合法：kind ∈ KINDS；实测/真实数据集必须能指到出处（含年份或数据集名）；
 *      自设必须写 why（≥30 字）与 sens；工程参数必须写明「不进结论」。
 *   ② 不漂移：有 get() 的条目，运行时真值必须等于表里登记的值。
 *   ③ 不空挂：probe 指的文件必须存在，且里面真的还有这个字面量。
 *   ④ 覆盖：MONITORED 里每个模块至少一条登记；id 唯一；链条合法。
 * 另查 UNWIRED_INPUTS 每条都写了「为什么是 0」「上界影响」「要什么才能接」。
 *
 * 用法：cd web && node tests/check-param-evidence.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENTRIES, KINDS, CHAINS, UNWIRED_INPUTS, MONITORED, REGISTRY_META,
} from '../src/kernel/param-registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const bad = [];
function ok(cond, name, extra) {
  if (cond) { pass++; return; }
  fail++; bad.push(name + (extra ? ` → ${extra}` : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ① 结构
ok(Object.keys(KINDS).length === 6, 'KINDS 六类齐全', Object.keys(KINDS).join(','));
const ids = new Set();
for (const e of ENTRIES) {
  const tag = e.id || '(缺 id)';
  ok(typeof e.id === 'string' && e.id.length > 2, `[${tag}] 有 id`);
  ok(!ids.has(e.id), `[${tag}] id 唯一`);
  ids.add(e.id);
  ok(CHAINS.includes(e.chain), `[${tag}] chain 合法`, e.chain);
  ok(Object.prototype.hasOwnProperty.call(KINDS, e.kind), `[${tag}] kind 合法`, e.kind);
  ok(typeof e.label === 'string' && e.label.length >= 2, `[${tag}] 有 label`);
  ok(e.source && String(e.source).length >= 8, `[${tag}] 有出处`);
  if (e.kind === 'selfSet' || e.kind === 'engineering') {
    ok(typeof e.why === 'string' && e.why.length >= 30, `[${tag}] 自设/工程项写了 why`, `${(e.why || '').length} 字`);
    ok(typeof e.sens === 'string' && e.sens.length >= 2, `[${tag}] 写了敏感性`);
  }
  if (e.kind === 'measured' || e.kind === 'real') {
    ok(/(19|20)\d{2}|Table|表|NHESS|PUMS|ACS|NHTS|FD23|ARR|WRL|NHANES|DOI/.test(String(e.source)),
      `[${tag}] 实测/数据集出处可指认`, e.source);
  }
  if (e.kind === 'derived') {
    ok(typeof e.formula === 'string' && e.formula.length >= 8, `[${tag}] 推导项写了公式`);
  }
  if (e.kind === 'engineering') {
    ok(/不(进|影响|进入)|只影响|表现|交互|动画/.test(e.why || ''), `[${tag}] 工程参数写明不进结论`);
  }
  // ③ probe 指的文件存在且字面量还在
  if (e.probe) {
    const abs = path.resolve(ROOT, '..', e.probe.file);
    ok(fs.existsSync(abs), `[${tag}] probe 文件存在`, e.probe.file);
    if (fs.existsSync(abs)) {
      const text = fs.readFileSync(abs, 'utf8');
      ok(e.probe.re.test(text), `[${tag}] 字面量仍在源文件里`, `${e.probe.file} / ${e.probe.re}`);
    }
  }
  // ② 不漂移
  if (typeof e.get === 'function') {
    let got;
    try { got = e.get(); } catch (err) { got = `ERR ${err.message}`; }
    const expectedComparable = e.expect !== null && typeof e.expect !== 'string';
    if (expectedComparable) {
      ok(eq(got, e.expect), `[${tag}] 运行时值与登记值一致`, `登记 ${JSON.stringify(e.expect)} / 实得 ${JSON.stringify(got)}`);
    }
  }
}

// ④ 覆盖：每个受监控模块至少一条
const files = new Set(ENTRIES.filter((e) => e.probe).map((e) => e.probe.file));
for (const m of MONITORED) {
  ok(files.has(m), `覆盖：${m} 至少一条登记`);
}

// 未接线输入
ok(Array.isArray(UNWIRED_INPUTS) && UNWIRED_INPUTS.length >= 1, 'UNWIRED_INPUTS 非空');
for (const u of UNWIRED_INPUTS) {
  const t = u.id || '(缺 id)';
  ok(typeof u.where === 'string' && u.where.length > 10, `[unwired:${t}] 写了位置`);
  ok(typeof u.whyZero === 'string' && u.whyZero.length >= 20, `[unwired:${t}] 写了为什么是 0`);
  ok(typeof u.effectBound === 'string' && u.effectBound.length >= 10, `[unwired:${t}] 写了上界影响`);
  ok(typeof u.liftRequires === 'string' && u.liftRequires.length >= 10, `[unwired:${t}] 写了要什么才能接`);
  ok(typeof u.status === 'string' && u.status.length >= 2, `[unwired:${t}] 写了状态`);
}

// 反向防呆：源码里真的有「未接线」这回事（防止表格比代码新）
{
  const cohort = fs.readFileSync(path.resolve(ROOT, 'src/cohort.js'), 'utf8');
  ok(/warningInformation: s\.warningInformation \|\| 0/.test(cohort),
    'cohort.js 里 warningInformation 确实还是恒 0 的写法');
  const cm = fs.readFileSync(path.resolve(ROOT, 'src/kernel/choice-model.js'), 'utf8');
  ok(/warningInformation/.test(cm), 'choice-model.js 里认知层系数仍在');
}

// 元信息
ok(REGISTRY_META.version.includes('V7'), 'REGISTRY_META 标了版本');

console.log(`\n参数依据机检：${pass}/${pass + fail} 通过`);
if (fail) {
  console.log('未通过：');
  for (const b of bad) console.log('  ✗ ' + b);
  console.log(`\n共 ${ENTRIES.length} 条登记，${UNWIRED_INPUTS.length} 条未接线输入。`);
  process.exit(1);
}
const byKind = {};
for (const e of ENTRIES) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
console.log(`登记 ${ENTRIES.length} 条：` + Object.entries(byKind).map(([k, v]) => `${KINDS[k]} ${v}`).join(' / '));
console.log(`未接线输入 ${UNWIRED_INPUTS.length} 条；覆盖模块 ${files.size} 个。`);