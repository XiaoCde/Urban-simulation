/**
 * cases.mjs —— 把一次运行里「出过事的人」的完整过程摊成人能读的时间线。
 *
 * 数据来源：结果 JSON 的 `final.cases[]`（`incidents.exportCases()`），
 * 每项 = 摘要 + 完整事件链 + 出事前后逐帧状态与判断理由。
 * 这是「个体行为追溯」的批量版：跑一次，所有死者/被困者都能单独打开看。
 *
 * 用法：
 *   node tools/trace/cases.mjs web/out/_sens/base.json
 *   node tools/trace/cases.mjs web/out/v6/u_p24_s0.json --only dead
 * 输出：
 *   web/out/_cases/<run>__case<i>.md   每人一份
 *   web/out/_cases/<run>__all.md       索引 + 全表
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error('用法：node tools/trace/cases.mjs <结果.json> [--only dead|stranded|injured]');
  process.exit(2);
}
const only = (() => {
  const k = process.argv.indexOf('--only');
  return k > 0 ? String(process.argv[k + 1] || '').toLowerCase() : '';
})();

const J = JSON.parse(readFileSync(file, 'utf8'));
const cases = (J.final && J.final.cases) || [];
if (!cases.length) {
  console.error('这份结果里没有 cases（跑的时候至少要有一个人出事；或换更大的工况）');
  process.exit(1);
}

const mm = (t) => {
  const h = Math.floor(t / 60), m = Math.floor(t % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
const cm = (d) => `${Math.round((d || 0) * 100)}cm`;

/** 抽稀：水深变 5cm 以上、位移 40m 以上、状态/动作/理由变了才留。 */
function thin(frames) {
  const out = [];
  let prev = null;
  for (const f of frames) {
    const keep = !prev
      || Math.abs((f.d || 0) - (prev.d || 0)) >= 0.05
      || Math.abs((f.x || 0) - (prev.x || 0)) + Math.abs((f.z || 0) - (prev.z || 0)) >= 40
      || f.st !== prev.st || f.act !== prev.act || f.why !== prev.why
      || f.car !== prev.car || f.indoor !== prev.indoor;
    if (keep) out.push(f);
    prev = f;
  }
  const last = frames[frames.length - 1];
  if (last && out[out.length - 1] !== last) out.push(last);
  return out;
}

const dir = 'web/out/_cases';
mkdirSync(dir, { recursive: true });
const stem = basename(file, '.json');

const rows = [];
const docs = [];
for (const c of cases) {
  const s = c.summary || {};
  const r = c.replay || {};
  if (only && String(s.status).toLowerCase() !== only) continue;
  const frames = thin(r.trace || []);
  const evs = (r.events || []).slice();
  const deadAt = s.status === 'dead' ? s.minute : Infinity;

  const md = [];
  md.push(`# 案 ${s.i} · ${s.status}${s.cause ? ' · ' + s.cause : ''}\n`);
  md.push(`- 年龄 ${s.age}（${s.band}）· ${s.district || '未知片区'} · ${s.circleLabel || ''}`);
  md.push(`- 结局：${s.status}${s.cause ? '（' + s.cause + '）' : ''} @ ${mm(s.minute)}，脚下 ${cm(s.depth)}，全程最深 ${cm(s.maxDepth)}`);
  md.push(`- 轨迹：${s.firstMinute}→${s.minute} 分，${s.frames} 帧，事件 ${s.events} 条`);
  md.push(`- 涉水 ${r.everWaded ? '是' : '否'} · 被困 ${r.everStranded ? '是' : '否'} · 受伤 ${r.everInjured ? '是' : '否'} · 避险 ${r.everEvacuated ? '是' : '否'}\n`);

  if (evs.length) {
    md.push('## 事件链\n');
    md.push('| 时刻 | 类型 | 什么发生了 | 水深 |');
    md.push('| --- | --- | --- | --- |');
    for (const e of evs) {
      const late = Number(e.minute) > deadAt + 0.01 ? ' ⚠（死在它之前，顺序异常）' : '';
      md.push(`| ${mm(e.minute)} | ${e.type} | ${String(e.reason || '').replace(/\|/g, '/')}${late} | ${cm(e.depth)} |`);
    }
    md.push('');
  }

  md.push('## 过程（抽稀后的帧）\n');
  md.push('| 时刻 | 位置 | 水深 | 速度 | 状态 | 动作 | 为什么 | 在哪 |');
  md.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const f of frames) {
    const where = f.car ? '车里' : f.indoor ? `室内${f.fl ? ' ' + f.fl + 'F' : ''}` : '室外';
    md.push(`| ${mm(f.t)} | ${Math.round(f.x)},${Math.round(f.z)} | ${cm(f.d)} | ${(f.v || 0).toFixed(1)} | ${f.st} | ${f.act || '—'} | ${String(f.why || '').replace(/\|/g, '/')} | ${where} |`);
  }
  md.push('');
  md.push('> 帧里的「为什么」是那一刻决策层返回的理由原文，不是事后补的。');

  const text = md.join('\n');
  writeFileSync(join(dir, `${stem}__case${s.i}.md`), text);
  docs.push(text);
  rows.push([s.i, s.status, s.cause || '', mm(s.minute), cm(s.maxDepth), s.district || '', `${stem}__case${s.i}.md`]);
}

const idx = [];
idx.push(`# 出过事的人（${stem}）\n`);
idx.push(`共 ${rows.length} 人。每人一份时间线，文件名见最后一列。\n`);
idx.push('| 编号 | 结局 | 死因/原因 | 时刻 | 全程最深 | 片区 | 文件 |');
idx.push('| --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) idx.push(`| ${r.join(' | ')} |`);
idx.push('\n---\n');
idx.push(docs.join('\n\n---\n\n'));
writeFileSync(join(dir, `${stem}__all.md`), idx.join('\n'));

console.log(`写出 ${rows.length} 份个案 + 1 份索引，目录 ${dir}`);
for (const r of rows) console.log(` ${r[1].padEnd(9)} 案${String(r[0]).padStart(4)}  ${r[3]}  ${r[2] || ''}`);