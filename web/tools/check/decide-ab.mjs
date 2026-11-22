/**
 * 决策结构 A/B 对照（2026-11-22）
 *
 * 用法：
 *   cd web && node tools/check/decide-ab.mjs out/_cas2_s1.json out/_abl_merge.json out/_abl_raw.json
 *
 * 先核对两边是不是同一场实验：minutes / people / seed / case / startMinute 必须全同，
 * 不同就直接报错退出——否则会拿「不同口径的两批跑」得出「门结构让死亡翻倍」这种假结论。
 * 不写文件，只打印表；写进文档时照抄打印结果。
 */
import fs from 'node:fs';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));  // --hourly 是开关，不是文件
if (files.length < 2) {
  console.error('用法: node tools/check/decide-ab.mjs <基准.json> <对照.json> [更多.json …]');
  process.exit(2);
}

const rows = files.map((f) => {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  // 收尾快照失败的结果：final.sim=null，所有指标都会读成 0。
  // 不拦住它，就会拿「0 死亡」当结论（我们已经因此白跑过一整批）。
  // 【2026-11-22 20:15 分档】有 error 但 final.sim 还在 = 降级结果（个案缺失、
  // 指标可信）。那种要**照常比**，只打 warning；只有 sim 为 null 才是真坏结果。
  if (j.final && j.final.error && !j.final.sim) {
    console.error(`[refuse] ${f}: 收尾快照失败（${j.final.error}）——这份结果的指标全是空值，不能比。`);
    process.exit(1);
  }
  if (j.final && j.final.error && j.final.sim) {
    console.error(`[warn] ${f}: 降级结果（${j.final.error}）——指标可用，但没有个案，归因不能读它。`);
  }
  if (!j.final || !j.final.sim) {
    console.error(`[refuse] ${f}: final.sim 为 null，不能比。`);
    process.exit(1);
  }
  const inc = (j.final && j.final.sim && j.final.sim.incidents) || {};
  const act = j.byAction || {};
  const hourly = Array.isArray(j.hourly) ? j.hourly : [];
  const firstEvac = hourly.find((h) => (h.evacuated || 0) > 0);
  const firstDead = hourly.find((h) => (h.dead || 0) > 0);
  return {
    file: f.replace(/\\/g, '/').split('/').pop(),
    minutes: j.minutes, people: j.people, seed: j.seed,
    caseName: (j.caseMeta && j.caseMeta.name) || j.case || '?',
    startMinute: j.startMinute, wallSec: j.wallSec,
    dead: inc.dead || 0, stranded: inc.stranded || 0, injured: inc.injured || 0,
    evacuated: inc.evacuated || 0, wading: inc.wading || 0,
    abandonedCar: inc.abandonedCar || 0, slip: inc.slip || 0, rescued: inc.rescued || 0,
    stalled: inc.stalled || 0, safe: inc.safe || 0,
    maxDepthCm: j.maxDepthSeen != null ? Math.round(j.maxDepthSeen * 100) : null,
    byCause: inc.deathsByCause || {},
    driveRequests: (j.final && j.final.sim && j.final.sim.driving && j.final.sim.driving.requests) ?? null,
    driveChosen: (j.final && j.final.sim && j.final.sim.driving && j.final.sim.driving.driveChosen) ?? null,
    abandons: (j.final && j.final.sim && j.final.sim.driving && j.final.sim.driving.abandons) ?? null,
    carKm: (j.final && j.final.sim && j.final.sim.driving && j.final.sim.driving.carKm) ?? null,
    // route.walked 的单位是**米**（ped.js 里 `R.walked += stepReal` 累加的是米）。
    // 早期这里直接叫 walkM 却贴在「步行 km」一列上，会把 53 万米印成 53 万公里。
    walkKm: (j.final && j.final.route && j.final.route.walked) != null
      ? Math.round((j.final.route.walked / 1000) * 10) / 10 : null,
    judged: hourly.reduce((a, h) => a + (h.judged || 0), 0),
    firstEvacHour: firstEvac ? firstEvac.minute : null,
    firstDeadHour: firstDead ? firstDead.minute : null,
    travelWalk: act['travel:walk'] || 0,
    travelDrive: act['travel:drive'] || 0,
    hurry: act.hurry || 0,
    detour: act.detour || 0,
    wait: act.wait || 0,
    mode: hoursModeTag(j),
    // 逐小时序列留着给 --hourly 用（撤离/死亡/判断/涉水），别在 row 里算死
    series: hourly.map((h) => ({
      minute: h.minute,
      judged: h.judged || 0,
      evacuated: (h.evacuated || 0),
      dead: (h.dead || 0),
      wading: (h.wading || 0),
    })),
  };
});

const keys = ['minutes', 'people', 'seed', 'caseName', 'startMinute'];
for (const k of keys) {
  const vals = [...new Set(rows.map((r) => String(r[k])))];
  if (vals.length > 1) {
    console.error(`拒绝比较：${k} 不一致 → ${vals.join(' / ')}`);
    console.error('这几份结果不是同一场实验（时间窗、人数、种子、工况、起点至少有一项不同）。');
    process.exit(1);
  }
}

const COLS = [
  ['死亡', 'dead'], ['被困（累计）', 'stranded'], ['受伤', 'injured'], ['避险', 'evacuated'],
  ['涉水（人次）', 'wading'], ['弃车', 'abandonedCar'], ['滑倒', 'slip'], ['被救', 'rescued'],
  ['开场仍安全', 'safe'], ['最深水 cm', 'maxDepthCm'],
  ['首次撤离分钟', 'firstEvacHour'], ['首次死亡分钟', 'firstDeadHour'],
  ['开车请求', 'driveRequests'], ['选择开车', 'driveChosen'], ['行驶 km', 'carKm'], ['弃车（驾驶层）', 'abandons'], ['步行 km', 'walkKm'],
  ['判断次数', 'judged'], ['步行动作', 'travelWalk'], ['开车动作', 'travelDrive'],
  ['催促动作', 'hurry'], ['绕行动作', 'detour'],
];

const head = ['指标', ...rows.map((r) => r.file)];
const width = COLS.map(([label]) => Math.max(label.length * 2, 10));
const pad = (s, n) => {
  const w = [...String(s)].reduce((a, ch) => a + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};
console.log(`\n同一场实验：${rows[0].caseName} · ${rows[0].people} 人 · ${rows[0].minutes} 分 · 起点 ${rows[0].startMinute} 分 · seed ${rows[0].seed}\n`);
console.log(pad(head[0], 16) + rows.map((r) => pad(r.file, 26)).join(''));
COLS.forEach(([label, k], i) => {
  const vals = rows.map((r) => (typeof r[k] === 'number' && k === 'walkM' ? (r[k] / 1000).toFixed(1) : r[k]));
  console.log(pad(label, 16) + vals.map((v) => pad(v ?? '—', 26)).join(''));
  void i;
});

console.log('\n死因分解（地点·动作）：');
const allCauses = [...new Set(rows.flatMap((r) => Object.keys(r.byCause)))].sort();
console.log(pad('死因', 22) + rows.map((r) => pad(r.file, 26)).join(''));
allCauses.forEach((c) => {
  console.log(pad(c, 22) + rows.map((r) => pad(r.byCause[c] || 0, 26)).join(''));
});

// --hourly：把「什么时候开始撤」摊开。死亡总数常常被水情决定，
// 但「撤离时点」和「判断次数」是决策结构直接决定的量——消融要拿这两个说话。
if (process.argv.includes('--hourly')) {
  // hourly 只在雨窗内每 60 分钟打一行（起点随工况变），所以取并集、不做「整点」过滤
  const mins = [...new Set(rows.flatMap((r) => r.series.map((x) => x.minute)))].sort((a, b) => a - b);
  // judged 是「本小时新增」，要累加；dead / evacuated 是「当前累计」，取最后一个不晚于该时点的值
  const FLOW = new Set(['judged']);
  const cum = (r, minute, field) => {
    const upto = r.series.filter((x) => x.minute <= minute);
    if (!upto.length) return 0;
    return FLOW.has(field) ? upto.reduce((a, x) => a + x[field], 0) : upto[upto.length - 1][field];
  };
  console.log('\n累计撤离（人）随时点：');
  console.log(pad('分钟', 8) + rows.map((r) => pad(r.file, 26)).join(''));
  for (const m of mins) console.log(pad(m, 8) + rows.map((r) => pad(cum(r, m, 'evacuated'), 26)).join(''));
  console.log('\n累计死亡（人）随时点：');
  console.log(pad('分钟', 8) + rows.map((r) => pad(r.file, 26)).join(''));
  for (const m of mins) console.log(pad(m, 8) + rows.map((r) => pad(cum(r, m, 'dead'), 26)).join(''));
  console.log('\n累计判断次数（万条）随时点：');
  console.log(pad('分钟', 8) + rows.map((r) => pad(r.file, 26)).join(''));
  for (const m of mins) console.log(pad(m, 8) + rows.map((r) => pad((cum(r, m, 'judged') / 1e4).toFixed(0), 26)).join(''));
}

function hoursModeTag(j) {
  const h = Array.isArray(j.hourly) ? j.hourly : [];
  return h.length ? `${h[0].minute}–${h[h.length - 1].minute} 分` : '—';
}