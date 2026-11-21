/**
 * acs-fidelity.mjs —— 仿真人口 vs ACS 真实分布：核对表。
 *
 * 回答的是导师问的那句「如何保证仿真输出与数据集真实分布一致——
 * 是数据集本身只有那几项，还是项目只挑了几项」。
 *
 * 结论先写在这里，脚本跑出来的表是证据：
 *   ① 原始人表 `from muse/csv_pdc (2)/psam_p11.csv` 有 **285 列**；
 *      `data/real/acs_dc.json` 的微观样本只保留 **10 列**（年龄/五岁带/性别/
 *      SOC 大类/JWTRNS/户内有未成年/户车数/户规模/与户主关系码/PWGTP）。
 *      所以不是「数据集只有几项」，是**项目只挑了 10 项**——这 10 项恰好是
 *      仿真用得到的，其余（残障 DIS、就业状态 ESR、工作地 POWPUMA、通勤时长
 *      JWMNP、到达时刻 JWAP…）在原始表里都有，只是没接。
 *   ② 仿真里每个人是**按 PWGTP 权重从 3 万多行里抽一行真实记录**，不是按
 *      自设比例拼边际。所以年龄/性别/职业/户车数/户规模之间的联合关系天然成立。
 *   ③ 抽样必然有噪声：n=1000 时，某个占比 p 的二项标准差是 sqrt(p(1-p)/n)，
 *      例如 p=0.5 时约 1.6 个百分点。**偏差在这条线以内属于抽样噪声，不是模型错。**
 *
 * 用法：node tools/check/acs-fidelity.mjs [n=1000] [seed=20261117]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { samplePerson } from '../../web/src/kernel/population.js';

const N = Number(process.argv[2] || 1000);
const SEED = Number(process.argv[3] || 20261117);

const ACS = JSON.parse(readFileSync(new URL('../../data/real/acs_dc.json', import.meta.url), 'utf8'));
const COLS = ACS.microsample.columns;
const COL = Object.fromEntries(COLS.map((c, i) => [c, i]));
const ROWS = ACS.microsample.rows;
const W = ROWS.map((r) => Number(r[COL['PWGTP权重']]) || 0);
const WSUM = W.reduce((a, b) => a + b, 0);

const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
const pct = (m, total) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v / total]));

/** ACS 全量加权分布（基准真值）。 */
function acsDist(keyOf) {
  const m = {};
  ROWS.forEach((r, i) => { const k = keyOf(r); m[k] = (m[k] || 0) + W[i]; });
  const tot = Object.values(m).reduce((a, b) => a + b, 0);
  return pct(m, tot);
}

/** 仿真人口的分布（同一条抽样路径）。 */
function simDist(keyOf, n, seed) {
  const m = {};
  for (let i = 0; i < n; i++) bump(m, keyOf(samplePerson(i, seed)));
  return pct(m, n);
}

const DIMS = [
  {
    name: '年龄带（五岁）',
    acs: acsDist((r) => String(r[COL['五岁带']])),
    sim: simDist((p) => String(p.ageBand5y), N, SEED),
  },
  {
    name: '性别',
    acs: acsDist((r) => String(r[COL['性别']]) === '1' ? '男' : '女'),
    sim: simDist((p) => String(p.sex) === '1' ? '男' : '女', N, SEED),
  },
  {
    name: '职业 SOC 大类（前 8）',
    acs: acsDist((r) => String(r[COL['SOC两位数大类']])),
    sim: simDist((p) => String(p.socCode), N, SEED),
  },
  {
    name: '户车数',
    // VEH 的 NA 在 samplePerson 里按 0 辆计（台账登记的建模映射），
    // 所以这里两侧都按「0 辆（含 NA）」合并比，否则会把口径差误报成分布不一致。
    acs: acsDist((r) => {
      const s = String(r[COL['户车数']]);
      if (s === 'NA') return '0 辆';
      const n = Number(s);
      return n === 0 ? '0 辆' : n === 1 ? '1 辆' : '2 辆以上';
    }),
    sim: simDist((p) => {
      const n = p.householdVehicles;
      return n === 0 ? '0 辆' : n === 1 ? '1 辆' : '2 辆以上';
    }, N, SEED),
  },
  {
    name: '户内有未成年',
    acs: acsDist((r) => String(r[COL['户内有未成年(1/0)']]) === '1' ? '有' : '无'),
    sim: simDist((p) => (p.hasMinor ? '有' : '无'), N, SEED),
  },
  {
    name: '户规模',
    acs: acsDist((r) => { const n = Number(r[COL['户规模']]); return n >= 5 ? '5 人以上' : `${n} 人`; }),
    sim: simDist((p) => (p.householdSize >= 5 ? '5 人以上' : `${p.householdSize || 1} 人`), N, SEED),
  },
];

const sig = (p) => Math.sqrt(Math.max(p * (1 - p), 1e-9) / N); // 二项标准误（百分点）
const lines = [];
lines.push(`# 仿真人口 vs ACS 真实分布（n=${N}，种子 ${SEED}）\n`);
lines.push(`- 基准：ACS 2020–2024 5-Year PUMS 特区人表，共 ${ROWS.length.toLocaleString('zh-CN')} 行、按 PWGTP 加权 ${WSUM.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}。`);
lines.push(`- 仿真：`+ '`web/src/kernel/population.js` 的 `samplePerson(i, seed)` 按权重抽一行真实记录（与浏览器里造人的路径相同）。');
lines.push(`- 抽样噪声基准：`+ '`sqrt(p(1-p)/n)`，n=1000 时占比 50% 处约 ±1.6 个百分点。**偏差在这条线内 = 抽样噪声，不是模型不一致。**\n');

let worst = { dim: '', key: '', gap: 0 };
for (const d of DIMS) {
  const keys = Object.keys(d.acs).sort((a, b) => d.acs[b] - d.acs[a]);
  const show = keys.slice(0, 10);
  lines.push(`## ${d.name}\n`);
  lines.push('| 类别 | ACS 加权 | 仿真 | 差 | 抽样噪声(±) | 判定 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const k of show) {
    const a = d.acs[k] || 0;
    const s = d.sim[k] || 0;
    const gap = (s - a) * 100;
    const e = sig(a) * 100;
    const verdict = Math.abs(gap) <= 2 * e ? '噪声内' : Math.abs(gap) <= 4 * e ? '偏大' : '**不一致**';
    if (Math.abs(gap) > Math.abs(worst.gap)) worst = { dim: d.name, key: k, gap };
    lines.push(`| ${k} | ${(a * 100).toFixed(1)}% | ${(s * 100).toFixed(1)}% | ${gap >= 0 ? '+' : ''}${gap.toFixed(1)} pp | ${e.toFixed(1)} | ${verdict} |`);
  }
  lines.push('');
}

lines.push('> 户车数一栏把 VEH=NA 按 0 辆并入（`samplePerson` 的建模映射，见 `web/src/kernel/population.js` 与 `docs/依据台账.md`）。\n');
lines.push('## 结论\n');
lines.push(`最大单项偏差：**${worst.dim} · ${worst.key}，${worst.gap >= 0 ? '+' : ''}${worst.gap.toFixed(1)} pp**。`);
lines.push('');
lines.push('这是 n=' + N + ' 的抽样结果，不是「模型里写死了某个分布」。要看稳定性应换几个种子重复跑（脚本第二个参数）。');
lines.push('');
lines.push('**数据集的取舍要说清楚**：原始人表 285 列，我们保留 10 列；没接的列里有 DIS（残障，门 5 的「行动受限」需要它）、ESR（就业状态）、POWPUMA/JWAP/JWMP（工作地与到达时刻，路线级水情与通勤时段需要它）。这不是数据集没有，是项目没接——写报告时按这个口径说。');

const out = lines.join('\n');
mkdirSync('web/out/_acs', { recursive: true });
writeFileSync('web/out/_acs/fidelity.md', out);
console.log(out);
console.log('\n写出 web/out/_acs/fidelity.md');