/**
 * _sweep_report.mjs — 把多个降雨工况的仿真结果汇总成一张对比表。
 *
 * 读 out/sweep/<工况>.json（_sim_day.mjs 的产出），按降雨类型分两组：
 * 全天连绵雨（p8/16/24/32）与傍晚两小时暴雨（p20/40/80/120）。
 * 两组的累计雨量、降雨时段都不同，**不能直接把数字并成一列排名**，
 * 所以报告里先分组，再在组内按雨强排序。
 *
 * 用法：node _sweep_report.mjs [目录=out/sweep] [输出=out/sweep/降雨对比.md]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIR = resolve(process.argv[2] || 'out/sweep');
const OUT = resolve(process.argv[3] || join(DIR, '降雨对比.md'));

const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
const rows = [];
for (const f of files) {
  let j;
  try { j = JSON.parse(readFileSync(join(DIR, f), 'utf8')); } catch { continue; }
  if (!j || !j.final || !j.final.sim) continue;
  const I = j.final.sim.incidents || {};
  const D = j.final.sim.driving || {};
  const L = j.final.sim.live || {};
  const m = j.caseMeta || {};
  rows.push({
    case: j.case || f.replace(/\.json$/, ''),
    p: m.pMmH, surge: m.surgeM, hyeto: m.hyeto ?? m.hyetograph,
    rainStart: m.rainStart, rainEnd: m.rainEnd, peakWet: m.peakWetHa,
    people: j.people, seed: j.seed, wall: j.sec || j.wallSec,
    dead: I.dead || 0, stranded: I.everStranded || 0, injured: I.everInjured || 0,
    evacuated: I.evacuated || 0, exposed: I.exposed || 0,
    wading: I.wading || 0, stalled: I.stalled || 0, abandoned: I.abandonedCar || 0,
    driveChosen: D.driveChosen || 0, arrivals: D.arrivals || 0, carKm: D.carKm || 0,
    redLight: I.redLightWaits || 0, yields: I.yields || 0,
    judged: L.judged || 0,
    maxDepthCm: Math.round((I.maxDepth || 0) * 100),
    causes: I.deathsByCause || {},
    unjustified: j.unjustified || 0,
    pageErrors: (j.pageErrors || []).length,
  });
}

// 两族分开：day = 全天连绵，pulse = 傍晚两小时
const day = rows.filter((r) => r.hyeto === 'day').sort((a, b) => a.p - b.p);
const pulse = rows.filter((r) => r.hyeto === 'pulse').sort((a, b) => a.p - b.p);
const other = rows.filter((r) => r.hyeto !== 'day' && r.hyeto !== 'pulse');

const n = (v) => Number(v || 0).toLocaleString('zh-CN');
function table(list, title, note) {
  if (!list.length) return '';
  const head = '| 工况 | 雨强 mm/h | 峰值湿区 ha | 困死 | 累计被困 | 累计受伤 | 避险 | 涉水暴露 | 开车/到达 | 行驶 km | 等灯 | 礼让 | 最深水 cm | 墙钟 s |\n'
    + '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n';
  const body = list.map((r) => `| ${r.case} | ${r.p} | ${r.peakWet} | **${r.dead}** | ${r.stranded} | ${r.injured} | ${r.evacuated} | ${n(r.exposed)} | ${n(r.driveChosen)}/${n(r.arrivals)} | ${n(Math.round(r.carKm))} | ${n(r.redLight)} | ${n(r.yields)} | ${r.maxDepthCm} | ${Math.round(r.wall || 0)} |`).join('\n');
  return `## ${title}\n\n${note}\n\n${head}${body}\n\n`;
}

const totalRain = (r) => (r.hyeto === 'day'
  ? `${r.p} mm/h × 24 h = ${(r.p * 24).toFixed(0)} mm`
  : `${r.p} mm/h × ${((r.rainEnd - r.rainStart) / 60).toFixed(0)} h = ${(r.p * (r.rainEnd - r.rainStart) / 60).toFixed(0)} mm`);

let md = `# 不同降雨工况的仿真结果对比\n\n`;
md += `- 人群：同一种子（${day[0] ? day[0].seed : '—'}），${day[0] ? day[0].people : '—'} 人，各工况是同一批人\n`;
md += `- 时段：00:00 → 24:00 连续推进，无 seek\n`;
md += `- 增水：全部为 0 m（主场景口径）\n`;
md += `- 所有伤亡、被困、避险数字都是**模型输出，不是实测**：致死函数用 Jonkman 2007，判定链里的暴露时长与失稳门槛仍是「目前自己定的」，见依据台账\n\n`;
md += table(day, '一、全天连绵雨（8 / 16 / 24 / 32 mm/h，下满 24 小时）',
  '降雨从 0 点开始、到 24 点结束，累计雨量随雨强线性增加。这一族的湿区是慢慢涨起来的，峰值出现在傍晚之后。');
md += table(pulse, '二、傍晚两小时暴雨（20 / 40 / 80 / 120 mm/h，只在 17:00–19:00 下）',
  '雨只下两小时，累计雨量等于雨强 × 2 h。这一族涨水快、退得也快，与上一族的累计雨量不可直接比。');
if (other.length) md += table(other, '三、其他工况', '');

md += `## 四、逐工况的累计雨量与死因\n\n| 工况 | 累计雨量 | 模型溺亡 | 死因分布（模型直接算） | 非溺亡外推（文献比例，不是模型算的） |\n| --- | --- | --- | --- | --- |\n`;
// 【2026-11-19 非溺亡死因】模型只建模水淹，判不了「被冲走 / 被砸 / 触电」。
// 原来用 Jonkman & Kelman (2005) 的 32.4%（13 场洪水 247 例）。文献4 入库后
// 找到两个更大的国家级个案库，口径差别很大，必须三个一起看：
//   意大利 1965–2014（Salvati et al. 2018, STOTEN 610–611:867–879, Table 2）：
//     514 例有室内外分类的洪水死亡，动态分布为 被水冲走 57.9%、困在淹水房间 16.2%、
//     桥倒塌 12.2%、被围困 5.2%、建筑倒塌 3.8%、落水 3.6%、翻船 1.0%。
//     明确的非溺亡（桥与建筑倒塌）＝ 16.0%。
//   澳大利亚 1900–2015（Haynes et al. 2017, Env Sci Policy 76:165–176, §3.1）：
//     1,859 例，溺亡 57% + 很可能溺亡 37%，作者结论 94% 死于溺亡 → 非溺亡约 6%。
//   Jonkman & Kelman 2005：32.4%，但含溃决情境与灾后公共卫生原因，口径最宽。
// 三个来源 6% / 16% / 32.4%，不能平均。主口径取意大利 16%——它按城市道路与车辆
// 分情境，最接近本项目的场景。另两个作区间上下界。
const NON_DROWN = { italy: 0.160, australia: 0.060, jonkman: 0.324 };
const NON_DROWN_MAIN = NON_DROWN.italy;
const extrapOf = (dead, frac) => (frac > 0 && frac < 1 ? dead / (1 - frac) : dead);
for (const r of [...day, ...pulse, ...other]) {
  const causes = Object.entries(r.causes).map(([k, v]) => `${k} ${v}`).join('、') || '无';
  let extrap = '—';
  if (r.dead > 0) {
    const main = extrapOf(r.dead, NON_DROWN_MAIN);
    const lo = extrapOf(r.dead, NON_DROWN.australia);
    const hi = extrapOf(r.dead, NON_DROWN.jonkman);
    extrap = `约 ${Math.round(main)} 人（其中非溺亡约 ${Math.round(main - r.dead)}）；区间 ${Math.round(lo)}–${Math.round(hi)} 人`;
  }
  md += `| ${r.case} | ${totalRain(r)} | ${r.dead} | ${causes} | ${extrap} |\n`;
}

md += `\n## 五、读这张表要注意的\n\n`;
md += `- 两族之间不要横向比「谁更严重」。全天 8 mm/h 累计 192 mm，傍晚 120 mm/h 只累计 240 mm，但后者是两小时内倒下来，涨水率和峰值水深完全不同。要比就比同一族内部的趋势。\n`;
md += `- 伤亡数主要由场景决定，不主要由决策规则决定：湿区面积、水深、涨水速度变了，死亡才会明显变；同一场景下改一个决策系数，通常只动几个人。\n`;
md += `- 「累计被困」会因后来脱困而被保留，「当前被困」是快照，本表用的是累计，便于跨工况比较。\n`;
md += `- 每个工况的完整逐时曲线与个案在各自的 \`.json\` 与 \`.md\` 里，本表只是横向摘要。\n`;
md += `- **「非溺亡外推」不是模型算的**：模型只建模水淹，判不了「被冲走 / 被砸 / 触电」。这一列把模型算出的溺亡数按文献的溺亡占比反推成总死亡，主口径取意大利 1965–2014 那 514 例洪水死亡（Salvati et al. 2018, Table 2）——其中桥与建筑倒塌占 16%，属明确的非溺亡；区间下界取澳大利亚 1900–2015 的 1,859 例（Haynes et al. 2017，作者结论 94% 溺亡，即非溺亡约 6%），上界取 Jonkman & Kelman 2005 的 32.4%（含溃决与灾后公共卫生原因）。三个来源口径不同，区间比单点更可信。**还要看清一件事：意大利那 16% 几乎全是结构倒塌（桥、建筑物），而本模型不建模结构破坏，所以这些人在模型里根本不会死——这一列只是量级参照，不是模型能产出的机制。**\n`;

writeFileSync(OUT, md);
console.log(`[report] ${rows.length} 个工况 → ${OUT}`);
for (const r of [...day, ...pulse, ...other]) {
  console.log(`  ${r.case.padEnd(10)} 死 ${String(r.dead).padStart(3)} · 困 ${String(r.stranded).padStart(3)} · 伤 ${String(r.injured).padStart(3)} · 避险 ${String(r.evacuated).padStart(4)} · 最深 ${String(r.maxDepthCm).padStart(2)} cm`);
}
