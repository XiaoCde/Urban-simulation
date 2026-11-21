#!/usr/bin/env node
/**
 * param-table.mjs — 从 param-registry.js 生成「参数依据总表」Markdown
 *
 * 目的：让「这张表」永远是代码的投影，不能手写、不能与代码分叉。
 *   改常数 → 改登记 → 重跑 `node tools/check/param-evidence.mjs` 与
 *   `node tools/check/param-table.mjs` → 表格自动跟上。
 *
 * 用法（在 web/ 下）：node tools/check/param-table.mjs > ../docs/参数依据表_V7_2026-11-21.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENTRIES, KINDS, CHAINS, UNWIRED_INPUTS, REGISTRY_META,
} from '../../src/kernel/param-registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHAIN_LABEL = {
  population: '一、人群画像（谁在这座城里）',
  warning: '二、预警与时序（他什么时候知道）',
  cognition: '三、认知层（他知道什么）',
  mobilisation: '四、启动（他多快进入保护行动）',
  choice: '五、选择层（他选走还是留）',
  crowd: '六、从众（别人走不走如何影响他）',
  impediment: '七、阻碍（他走不了的理由）',
  casualty: '八、伤亡链（水到什么程度会死人）',
  vehicle: '九、车辆（开车的人怎么死）',
  engineering: '十、工程/表现参数（不进任何结论）',
};
const fmt = (v) => {
  if (Array.isArray(v)) return v.map((x) => String(x)).join(' / ');
  if (v && typeof v === 'object') {
    return Object.entries(v).map(([k, x]) => `${k}=${x}`).join('，');
  }
  return String(v);
};
const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

const out = [];
out.push('# 参数依据总表 V7');
out.push('');
out.push(`> **版本**：${REGISTRY_META.version}　**登记项**：${ENTRIES.length} 条（另有 ${UNWIRED_INPUTS.length} 条未接线输入）`);
out.push('>');
out.push('> **这张表不是手写的**：它由 `web/src/kernel/param-registry.js` 生成，'
  + '机检 `node tests/check-param-evidence.mjs` 会核对「运行时真值 = 表里登记的值」，'
  + '并核对每一行指向的源文件里那个字面量确实还在。改代码不改登记 → 机检红。');
out.push('');
out.push('## 怎么用这张表');
out.push('');
out.push('导师/评委问「这个数凭什么」时，按三档回答，别含糊：');
out.push('');
out.push('1. **真实数据集**（ACS / NHTS / DC311）：指到列名与加权口径，可用 `tools/check/acs-fidelity.mjs` 现场重算偏差。');
out.push('2. **文献实测值**：指到作者-年份-表号，报告里写清是「估计系数」还是「实验测得的限值」，两者不能混说。');
out.push('3. **目前自己定的**：先讲**为什么是这个数**（构造逻辑、量级、上下界常识），再讲**怎么扫敏感性**，'
  + '最后明说「这条我没找到一手依据」。三条缺一条都算没回答。');
out.push('');
out.push('性质图例：' + Object.entries(KINDS).map(([k, v]) => `**${v}**`).join(' · '));
out.push('');

for (const chain of CHAINS) {
  const rows = ENTRIES.filter((e) => e.chain === chain);
  if (!rows.length) continue;
  out.push(`## ${CHAIN_LABEL[chain] || chain}`);
  out.push('');
  out.push('| # | 参数 | 登记值 | 性质 | 出处 | 为什么是这个数 / 依据 | 敏感性 |');
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  rows.forEach((e, i) => {
    const why = e.why || (e.formula ? `推导：${e.formula}` : '');
    out.push(`| ${chain}-${i + 1} | ${esc(e.label)}${e.unit ? `（${esc(e.unit)}）` : ''} | ${esc(fmt(e.expect))}`
      + ` | ${KINDS[e.kind]} | ${esc(e.source)} | ${esc(why)} | ${esc(e.sens)} |`);
  });
  out.push('');
}

out.push('## 十一、未接线的输入（系数有出处，输入恒 0）');
out.push('');
out.push('这一类是「看着接了、实际乘 0」，和 2026-11-21 修掉的 `peersRide` 同一性质。'
  + '惯例：可以留着不接，但**必须**写清为什么是 0、上界影响多大、要什么数据才能接。');
out.push('');
out.push('| 输入 | 位置 | 为什么是 0 | 上界影响 | 要什么才能接 | 状态 |');
out.push('| --- | --- | --- | --- | --- | --- |');
for (const u of UNWIRED_INPUTS) {
  out.push(`| ${esc(u.id)} | ${esc(u.where)} | ${esc(u.whyZero)} | ${esc(u.effectBound)} | ${esc(u.liftRequires)} | ${esc(u.status)} |`);
}
out.push('');

out.push('## 十二、已退役的自设项（留档，防止有人再加回来）');
out.push('');
out.push('2026-11-21 删掉的五个自设缩放，真实身份是**跨论文 logit 的尺度参数 λ 比值**'
  + '（Swait & Louviere 1993, JMR 30(3):305–314）：拿不到原始数据就估不出 λ，'
  + '正确做法不是另定一个能跑的数，而是不让它们进同一个式子。现在决策是串行门，一个缩放都不需要。');
out.push('');
out.push('| 项 | 旧值 | 为什么删 |');
out.push('| --- | --- | --- |');
const retired = [
  ['knowledgeToActionScale', '0.50', '有序 logit 预测子 → 1–6 知识量表的映射，无出处；λ 不可估'],
  ['actionToUtilityScale', '0.80', 'Thieken 线性预测子 → Borowski 效用尺度，无出处；λ 不可估'],
  ['borowskiUtilityScale', '0.25', 'stated-choice 效用 → 归一，无出处'],
  ['threatUtility', 'none 0 / low 0.35 / moderate 1.30 / extreme 2.60', 'Borowski Table 4 未印威胁主效应'],
  ['baselineExposure', '0.15', '无雨起点暴露，无出处'],
];
for (const r of retired) out.push(`| ${esc(r[0])} | ${esc(r[1])} | ${esc(r[2])} |`);
out.push('');

out.push('## 十三、还差的（主动写出来，比被问出来好）');
out.push('');
out.push('- **有序 logit 的 cut points**：Thieken Table S2/S3 只印斜率，没印 cut1…cut5。'
  + '现在用「得分相对参考人的差」做动员倍数，不依赖 cut；要报告绝对概率必须向作者要 cut 或微观数据。');
out.push('- **伤亡链的暴露时长（150/80 s）与滑倒率（0.30）**：三轮检索没有一手依据，'
  + '是本项目最需要被质疑的两个数，整组 ×0.5/×2 的敏感性尚未跑批。');
out.push('- **同伴比例的真实网络**：Borowski 的数据要 IRB；现在用「同户 + 3 邻居」合成网络，已在表中如实标注。');
out.push('- **门 5 第四条（行动受限 / DIS）**：ACS 微样本没有 DIS 列，未接（见第十一节）。');
out.push('- **8 个工况尚未整族重跑**：本表登记的改动（peersRide、照护门、车队绑定）会影响结果，'
  + 'V6 及以前的死亡数不能与改动后混引。');
out.push('');
out.push('---');
out.push('');
out.push(`生成命令：\`cd web && node tools/check/param-table.mjs > ../docs/参数依据表_V7_2026-11-21.md\``);
out.push('');
process.stdout.write(out.join('\n'));