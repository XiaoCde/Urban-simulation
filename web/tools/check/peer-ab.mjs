/**
 * peer-ab.mjs — 参照群体 A/B 对比：把两次跑批的结果并排打出来
 *
 * 用法（在本目录 = web/）：
 *   node tools/check/peer-ab.mjs out/sweep_v61/u_p40_s0.json out/_peer8_p40_synthetic.json
 *
 * 为什么单独写一个脚本：A/B 对比最容易出错的地方不是模型，是「两边不是同一件事」。
 * 本脚本先核对 minutes / people / seed / case 完全一致，不一致直接报错退出——
 * 避免拿两个不同口径的跑批并排，得出「换了网络死亡翻倍」这种假结论。
 */
import { readFileSync } from 'node:fs';

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error('用法：node tools/check/peer-ab.mjs <旧.json> <新.json>');
  process.exit(2);
}

const load = (p) => {
  const j = JSON.parse(readFileSync(p, 'utf8'));
  const sim = j.final && j.final.sim ? j.final.sim : null;
  if (!sim) { console.error(`${p} 里没有 final.sim，跑批可能没跑完`); process.exit(2); }
  return { j, sim, inc: sim.incidents, live: sim.live };
};
const A = load(aPath), B = load(bPath);

// ---- 前置核对：两边必须是同一件事，只有网络不同
const fields = ['minutes', 'people', 'seed', 'case'];
const bad = fields.filter((f) => A.j[f] !== B.j[f]);
if (bad.length) {
  console.error('两边的运行条件不一致，不能直接比：');
  for (const f of bad) console.error(`  ${f}: ${A.j[f]} vs ${B.j[f]}`);
  process.exit(1);
}
console.log(`口径核对通过：${A.j.case} · ${A.j.people} 人 · ${A.j.minutes} 分 · seed ${A.j.seed}`);
console.log(`  旧：${aPath}`);
console.log(`  新：${bPath}`);

const bins = (live) => {
  const b = (live && live.peerBins) || [];
  const tot = b.reduce((x, y) => x + y, 0) || 1;
  return {
    zero: +(b[0] / tot * 100).toFixed(1),
    mid: +(((tot - b[0] - (b[9] || 0)) / tot) * 100).toFixed(1),
    high: +((b[9] || 0) / tot * 100).toFixed(1),
  };
};
const bA = bins(A.live), bB = bins(B.live);

const rows = [
  ['死亡', A.inc.dead, B.inc.dead],
  ['累计被困', A.inc.stranded, B.inc.stranded],
  ['受伤', A.inc.injured, B.inc.injured],
  ['滑倒次数', A.inc.slip, B.inc.slip],
  ['避险', A.inc.evacuated, B.inc.evacuated],
  ['涉水暴露（人次）', A.inc.wading, B.inc.wading],
  ['被救', A.inc.rescued, B.inc.rescued],
  ['弃车', A.inc.abandonedCar, B.inc.abandonedCar],
  ['零同伴档 %', bA.zero, bB.zero],
  ['中间档 %', bA.mid, bB.mid],
  ['高档 %', bA.high, bB.high],
  ['判断次数', A.live.judged, B.live.judged],
];

const fmt = (v) => (typeof v === 'number' && !Number.isInteger(v)) ? v.toFixed(1) : String(v);
const w = 18;
console.log(`\n${'指标'.padEnd(w)}${'旧（邻居规则）'.padStart(14)}${'新（合成网络）'.padStart(16)}${'差'.padStart(10)}`);
console.log('-'.repeat(w + 40));
for (const [name, a, b] of rows) {
  const d = (typeof a === 'number' && typeof b === 'number') ? (b - a) : null;
  const ds = d === null ? '' : (d > 0 ? '+' : '') + (Number.isInteger(d) ? d : d.toFixed(1));
  console.log(`${name.padEnd(w)}${fmt(a).padStart(14)}${fmt(b).padStart(16)}${ds.padStart(10)}`);
}

// ---- 逐死因对比（死亡数一样但死因结构变了，也是信息）
const causes = new Set([...Object.keys(A.inc.deathsByCause || {}), ...Object.keys(B.inc.deathsByCause || {})]);
if (causes.size) {
  console.log('\n逐死因：');
  for (const c of [...causes].sort()) {
    const x = (A.inc.deathsByCause || {})[c] || 0;
    const y = (B.inc.deathsByCause || {})[c] || 0;
    console.log(`  ${c.padEnd(20)} 旧 ${String(x).padStart(3)} → 新 ${String(y).padStart(3)}`);
  }
}

// ---- 驾驶侧（同伴网络会改「谁被劝上车」，所以要看）
const drv = (s) => s.driving || {};
const dA = drv(A.sim), dB = drv(B.sim);
console.log('\n驾驶：');
for (const [k, label] of [['requests', '请求次数'], ['driveChosen', '选择开车'], ['walkChosen', '选择步行'], ['pickups', '上车次数'], ['arrivals', '到达'], ['abandons', '弃车'], ['carKm', '行驶 km']]) {
  const x = dA[k], y = dB[k];
  if (x === undefined && y === undefined) continue;
  const fx = typeof x === 'number' ? (Number.isInteger(x) ? x : x.toFixed(1)) : '-';
  const fy = typeof y === 'number' ? (Number.isInteger(y) ? y : y.toFixed(1)) : '-';
  console.log(`  ${label.padEnd(10)} 旧 ${String(fx).padStart(8)} → 新 ${String(fy).padStart(8)}`);
}

console.log('\n读法提醒：单 seed 单工况；死亡基数小（个位数）时，「一样」和「差一两人」都不能当结论。');