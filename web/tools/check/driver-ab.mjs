/**
 * driver-ab.mjs — 跨驱动并排（创新点 #4 的比较器）。
 *
 * 和 tools/check/decide-ab.mjs 的区别：
 *   · decide-ab 比的是「同一驱动、两种决策结构」，所以要求 case 必须相同；
 *   · 本脚本比的是「同一决策结构、两种驱动」，所以允许 case 不同，**但必须
 *     人数 / seed / 分钟数 / 起点分钟数相同**，否则比出来的差不是驱动的差。
 *
 * 用法：
 *   node tools/check/driver-ab.mjs out/_surge_s40.json out/ablate_v1/gate__u_p24_s0.json
 *   node tools/check/driver-ab.mjs A.json B.json [--hourly]
 */
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const wantHourly = process.argv.includes('--hourly');
if (files.length < 2) {
  console.error('用法：node tools/check/driver-ab.mjs <A.json> <B.json> [--hourly]');
  process.exit(2);
}

const load = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) {
    console.error(`读不了 ${p}: ${e.message}`); process.exit(2);
  }
};
const runs = files.map(load);

// ---- 前置：只有「同一批人、同一段时间」的差才叫驱动差 ----
const keys = ['people', 'seed', 'minutes', 'startMinute'];
for (const k of keys) {
  const vals = runs.map((r) => r[k]);
  if (vals.some((v) => v !== vals[0])) {
    console.error(`[不可比] ${k} 不一致：` + runs.map((r, i) => `${files[i]}=${r[k]}`).join(' / '));
    console.error('驱动对比必须同人数、同 seed、同分钟数、同起点；否则差里混了别的因素。');
    process.exit(1);
  }
}

const sim = (r) => (r.final && r.final.sim) || {};
const inc = (r) => sim(r).incidents || {};
const drv = (r) => sim(r).driving || {};
const hourly = (r) => (r.hourly || []);
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const caseName = (r) => (r.caseMeta && r.caseMeta.name) || r.case || '?';
const pmmh = (r) => (r.caseMeta && r.caseMeta.pMmH != null ? r.caseMeta.pMmH : '?');
const surge = (r) => (r.caseMeta && r.caseMeta.surgeM != null ? r.caseMeta.surgeM : '?');
const peakWet = (r) => (r.caseMeta && r.caseMeta.peakWetHa != null ? r.caseMeta.peakWetHa : '?');

// 逐小时：把「湿区/淹路」当驱动侧信号，把「撤离/死亡/涉水」当行为侧信号。
const sumH = (h, f) => h.reduce((s, x) => s + num(x[f]), 0);
const firstMin = (h, f) => {
  const row = h.find((x) => num(x[f]) > 0);
  return row ? row.minute : null;
};

const rows = [];
const push = (label, fn, fmt = (v) => String(v)) => {
  rows.push([label, ...runs.map((r) => fmt(fn(r)))]);
};

push('工况', caseName);
push('雨强 mm/h', pmmh);
push('增水 m', surge);
push('峰值湿区 ha', peakWet);
push('死亡', (r) => num(inc(r).dead));
push('  · 车内·开车', (r) => num((inc(r).deathsByCause || {})['车内·开车'] || 0));
push('  · 路面·被困', (r) => num((inc(r).deathsByCause || {})['路面·被困'] || 0));
push('  · 路面·涉水行走', (r) => num((inc(r).deathsByCause || {})['路面·涉水行走'] || 0));
push('  · 地下室·进入地下室', (r) => num((inc(r).deathsByCause || {})['地下室·进入地下室'] || 0));
push('被困（累计）', (r) => num(inc(r).stranded));
push('受伤', (r) => num(inc(r).injured));
push('避险（撤离到高处）', (r) => num(inc(r).evacuated));
push('涉水人次', (r) => num(inc(r).wading));
push('弃车', (r) => num(inc(r).abandonedCar));
push('滑倒', (r) => num(inc(r).slip));
push('被救', (r) => num(inc(r).rescued));
push('首次撤离分钟', (r) => firstMin(hourly(r), 'evacuated') ?? '—');
push('首次死亡分钟', (r) => firstMin(hourly(r), 'dead') ?? '—');
push('首次涉水分钟', (r) => firstMin(hourly(r), 'wading') ?? '—');
push('最深水 cm', (r) => Math.max(0, ...hourly(r).map((x) => num(x.maxDepthCm))));
push('开车请求', (r) => num(drv(r).requests));
push('选择开车', (r) => num(drv(r).driveChosen));
push('行驶 km', (r) => num(drv(r).carKm).toFixed(1));
push('判断次数', (r) => sumH(hourly(r), 'judged'));

const w = files.map((f) => Math.max(14, Math.min(22, f.split(/[\\/]/).pop().length + 2)));
const line = (a) => '| ' + a.map((c, i) => String(c).padEnd(i === 0 ? 18 : w[i - 1])).join(' | ') + ' |';
const sep = '| ' + ['—'.padEnd(18), ...files.map((f, i) => '—'.padEnd(w[i]))].join(' | ') + ' |';

console.log(`# 跨驱动并排（同 ${runs[0].people} 人 · seed ${runs[0].seed} · ${runs[0].minutes} 分 · 起点 ${runs[0].startMinute}）`);
console.log('');
console.log(line(['指标', ...files.map((f) => f.split(/[\\/]/).pop())]));
console.log(sep);
for (const r of rows) console.log(line(r));

if (wantHourly) {
  const hours = Math.min(...runs.map((r) => hourly(r).length));
  console.log('');
  console.log('## 逐小时（驱动侧：最深水 cm；行为侧：撤离/死亡）');
  console.log(line(['小时', ...files.map((f) => f.split(/[\\/]/).pop())]));
  console.log(sep);
  for (let i = 0; i < hours; i++) {
    const cells = runs.map((r) => {
      const h = hourly(r)[i] || {};
      return `${num(h.maxDepthCm)}cm 撤${num(h.evacuated)} 死${num(h.dead)}`;
    });
    console.log(line([String(hourly(runs[0])[i].hour).padStart(2, '0'), ...cells]));
  }
}

console.log('');
console.log('读法（写进文档时照抄这三条）：');
console.log('1) 驱动差别看「涨水速率」：降雨组湿区/淹路在几十分钟内跳变，增水组是几小时缓坡。');
console.log('2) 行为差别看死因结构：车内死亡对「涨水快慢」最敏感（慢涨来得及驶离）。');
console.log('3) 撤离时点差别看「首次撤离分钟 + 逐小时撤离数」：慢涨的窗口更长，但威胁等级升得慢，');
console.log('   模型可能给出「更晚走」这种非平凡预测——这正是跨驱动实验要检验的东西。');