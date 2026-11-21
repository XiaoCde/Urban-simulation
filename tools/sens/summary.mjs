/**
 * summary.mjs —— 把 V6 敏感性矩阵的几份结果文件压成一张增量表。
 *
 * 规则（口径表 §六）：基线单独跑，每个变体只改一个开关，报「相对基线的增量」，
 * 不报"跑完是多少" —— 后者会让人误把绝对数当结论。
 *
 * 用法：node tools/sens/summary.mjs web/out/_sens
 * 输出：终端表格 + 同目录 summary.md
 */

import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || 'web/out/_sens';
const basePath = join(dir, 'base.json');
if (!existsSync(basePath)) {
  console.error('缺少基线 ' + basePath + '（先跑 tools/sens/run_v6_sens.sh）');
  process.exit(2);
}

const pick = (f) => {
  const j = JSON.parse(readFileSync(f, 'utf8'));
  const s = (j.final && j.final.sim) || {};
  const inc = s.incidents || {};
  return {
    dead: inc.dead || 0,
    stranded: inc.everStranded || 0,
    injured: inc.everInjured || 0,
    evacuated: inc.everEvacuated || 0,
    waded: inc.everWaded || 0,
    maxDepthCm: Math.round((inc.maxDepth || 0) * 100),
    judged: (s.live && s.live.judged) || 0,
    causes: inc.deathsByCause || {},
  };
};

const base = pick(basePath);
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'base.json' && f !== 'summary.json').sort();

const cols = ['dead', 'stranded', 'injured', 'evacuated', 'waded'];
const fmt = (v) => (v > 0 ? `+${v}` : String(v));
const sign = (v) => (v > 0 ? `+${v}` : v < 0 ? String(v) : '0');

const rows = files.map((f) => {
  const name = f.replace(/\.json$/, '');
  const v = pick(join(dir, f));
  const d = {};
  for (const c of cols) d[c] = v[c] - base[c];
  return { name, v, d };
});

const md = [];
md.push('# V6 敏感性矩阵（单变量，相对基线）\n');
md.push(`- 基线：u_p80_s0 · 1020→1200 分 · 400 人 · 种子 20261117 · 时间层开`);
md.push(`- 基线绝对值：死 ${base.dead} / 困 ${base.stranded} / 伤 ${base.injured} / 避险 ${base.evacuated} / 涉水 ${base.waded} / 最深 ${base.maxDepthCm} cm / 判断 ${base.judged.toLocaleString('zh-CN')}\n`);
md.push(`| 变体 | Δ死 | Δ困 | Δ伤 | Δ避险 | Δ涉水 | Δ判断数 | 该变体的死/困/伤 |`);
md.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  const dj = r.v.judged - base.judged;
  md.push(`| ${r.name} | ${fmt(r.d.dead)} | ${fmt(r.d.stranded)} | ${fmt(r.d.injured)} | ${fmt(r.d.evacuated)} | ${fmt(r.d.waded)} | ${sign(dj)} | ${r.v.dead}/${r.v.stranded}/${r.v.injured} |`);
}
md.push('\n> 400 人 3 小时的样本里，死亡个位数、±1 人没有信息量；要看方向与量级，不要看小数点。');
md.push('> 「Δ判断数」是这行是否真的生效的证据：判断数不变说明这条开关没接上或没被触发，不能当作「该参数不敏感」。');
md.push('> 「受伤」一项对 `slip_off` 最敏感 —— 它只影响 D·V 受伤判据，这正是单变量分解要的结果。\n');

const outMd = join(dir, 'summary.md');
writeFileSync(outMd, md.join('\n'));
console.log(md.join('\n'));
console.log('写出 ' + outMd);