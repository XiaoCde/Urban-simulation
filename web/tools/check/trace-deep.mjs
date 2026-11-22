/**
 * 个体级伤亡归因：把「死者」这一侧的证据摊开（2026-11-22，创新点 #3）
 *
 * 用法：
 *   cd web && node tools/check/trace-deep.mjs out/sweep_v61
 *   cd web && node tools/check/trace-deep.mjs out/ablate_v1
 *
 * 只读 JSON，不碰仿真代码。回答三个问题：
 *   ① 这些人是怎么死的——入水到死亡隔了多久、当时多深、死前有没有受伤/被困；
 *   ② 死在谁身上——年龄组构成与人口构成比，是不是儿童/老人被过度代表；
 *   ③ 有没有一条可检验的因果链——「晚走 → 泡水 → 失足 → 走不动 → 淹」，
 *      以及链条上每一环在死者里的占比。
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.error('用法: node tools/check/trace-deep.mjs <结果目录> [--out=路径.md]');
  process.exit(2);
}
// --out 没给就只打屏幕；给了就把同一份内容写盘（文档里引用的表就是这个文件）
const outArg = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
// 【为什么要 --only】消融目录里 gate 与 single 的结果并存。归因是「模型本身」的证据，
// 默认应当只读 gate（single 是对照组，它的个案不代表主模型）。不滤会把两组的死者
// 混在一起算比例，等于把对照组当模型。
const onlyArg = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);

// 【为什么要滤 .partial.json】批跑边跑边写 `<name>.partial.json`，那是半截结果：
// final.cases 只含已跑到的那一段。混进来会让「死者总数」偏小，而且每个工况都少一截。
const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_') && f !== 'sweep.json'
    && !f.includes('.partial.'))
  .filter((f) => !onlyArg || f.includes(onlyArg));
const runs = [];
const broken = [];
for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  // 收尾快照失败的结果：final.error 有值、final.sim 为 null、cases 空。
  // 静默跳过它会让「死者总数」偏小，所以单独记下来打在屏幕上。
  if (j.final && j.final.error) { broken.push({ file: f, error: j.final.error }); continue; }
  const cases = (j.final && j.final.cases) || [];
  if (!cases.length) continue;
  runs.push({ file: f, caseName: (j.caseMeta && j.caseMeta.name) || f.replace('.json', ''), cases, j });
}
if (!runs.length) {
  console.error(`目录里没有带 final.cases 的结果：${dir}`);
  process.exit(1);
}

if (onlyArg) console.log(`[trace-deep] 只读文件名含 "${onlyArg}" 的结果（共 ${files.length} 个）`);
const buf = [];
const say = (line = '') => { buf.push(line); console.log(line); };

// ---- 完整性核对：个案里数出来的死者，必须等于汇总里的 dead ----
// 这条是「导出上限 12」那个坑的回归：两者不等就说明 cases 被截断，
// 后面所有比例只代表「被导出的那批」，不能当全死者。
const completeness = runs.map((r) => {
  const d = (r.j.final.sim.incidents || {}).dead || 0;
  const inCases = r.cases.filter((c) => c.summary && c.summary.status === 'dead').length;
  return { caseName: r.caseName, dead: d, inCases, ok: d === inCases };
});

const deaths = [];
for (const r of runs) {
  for (const c of r.cases) {
    const s = c.summary || {};
    if (s.status !== 'dead') continue;
    const rp = c.replay || {};
    const ev = Array.isArray(rp.events) ? rp.events.slice().sort((a, b) => a.minute - b.minute) : [];
    const wet = ev.find((e) => e.type === 'wading');
    const hurt = ev.find((e) => e.type === 'injured');
    const stuck = ev.find((e) => e.type === 'stranded');
    const aband = ev.find((e) => e.type === 'abandonedCar');
    // 死者最后一次位置变化：用事件点串起来的里程（近似，事件不是每帧）
    let movedM = 0;
    for (let k = 1; k < ev.length; k++) {
      const dx = (ev[k].x || 0) - (ev[k - 1].x || 0);
      const dz = (ev[k].z || 0) - (ev[k - 1].z || 0);
      const d = Math.hypot(dx, dz);
      if (Number.isFinite(d) && d < 2000) movedM += d;
    }
    deaths.push({
      run: r.caseName, i: s.i, cause: s.cause || '?', zone: zoneOf(s.cause).zone, zoneLabel: zoneOf(s.cause).label,
      minute: s.minute, age: s.age, band: s.band || '?',
      depth: s.depth, maxDepth: s.maxDepth,
      firstMinute: s.firstMinute,
      wetMinute: wet ? wet.minute : null, wetDepth: wet ? wet.depth : null,
      hurtMinute: hurt ? hurt.minute : null, hurtDepth: hurt ? hurt.depth : null,
      stuckMinute: stuck ? stuck.minute : null,
      abandonMinute: aband ? aband.minute : null,
      everWaded: !!rp.everWaded, everInjured: !!rp.everInjured,
      everStranded: !!rp.everStranded, everEvacuated: !!rp.everEvacuated,
      wetToDeathMin: wet && s.minute ? s.minute - wet.minute : null,
      movedM,
      events: ev.length,
    });
  }
}

// 人口年龄组构成（同一 seed 抽 1000 人，作为「如果随机死」的参照）
let popBands = null;
try {
  const pop = await import('../../src/kernel/population.js');
  const seed = (runs[0].j && runs[0].j.seed) || 20261117;
  const cnt = {};
  for (let i = 0; i < 1000; i++) {
    const p = pop.samplePerson(i, seed);
    const b = pop.behaviorBandOf ? pop.behaviorBandOf(p.age) : '?';
    cnt[b] = (cnt[b] || 0) + 1;
  }
  popBands = cnt;
} catch (e) {
  popBands = null;
}

const N = deaths.length;
const pct = (n) => (N ? (100 * n / N).toFixed(1) : '0.0');
const median = (xs) => {
  const a = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const q = (xs, f) => {
  const a = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((p, q2) => p - q2);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.floor(a.length * f))];
};
const fmt = (x, d = 1) => (x == null ? '—' : Number(x).toFixed(d));

if (broken.length) {
  say(`⚠️ 有 ${broken.length} 个结果收尾快照失败（final.sim 为 null），已排除：`);
  for (const b of broken) say(`  ${b.file} → ${b.error}`);
  say('');
}
say('## 0. 完整性核对（个案数 vs 汇总死亡率）');
say('');
for (const c of completeness) {
  say(`  ${String(c.caseName).padEnd(14)} 汇总 dead ${String(c.dead).padStart(4)} · cases ${String(c.inCases).padStart(4)} ${c.ok ? '✅' : '❌ 截断'}`);
}
say('');
say(`死者总数 ${N}（来自 ${runs.length} 个工况：${runs.map((r) => `${r.caseName} ${r.cases.filter((c) => c.summary && c.summary.status === 'dead').length}`).join('、')}）`);

// ① 死因 × 地点
const causes = {};
const zones = {};
for (const d of deaths) {
  const k = d.zoneLabel || d.cause;
  causes[k] = (causes[k] || 0) + 1;
  zones[d.zone] = (zones[d.zone] || 0) + 1;
}
say('\n一、死因构成');
Object.entries(causes).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => say(`  ${k.padEnd(16)} ${String(v).padStart(4)}  ${pct(v)}%`));
Object.entries(zones).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => say(`  地点 ${k.padEnd(12)} ${String(v).padStart(4)}  ${pct(v)}%`));

// ② 入水→死亡时长
const wetDeaths = deaths.filter((d) => d.wetToDeathMin != null);
say('\n二、从第一次下水到死亡（分钟）');
say(`  有下水记录的死者 ${wetDeaths.length}/${N}`);
say(`  中位数 ${fmt(median(wetDeaths.map((d) => d.wetToDeathMin)))}  四分位 ${fmt(q(wetDeaths.map((d) => d.wetToDeathMin), 0.25))}–${fmt(q(wetDeaths.map((d) => d.wetToDeathMin), 0.75))}  最大 ${fmt(Math.max(...wetDeaths.map((d) => d.wetToDeathMin)))}`);
const longSoak = wetDeaths.filter((d) => d.wetToDeathMin >= 5).length;
say(`  泡水 ≥5 分钟才死：${longSoak}（占死者 ${pct(longSoak)}%，占有下水者 ${wetDeaths.length ? (100 * longSoak / wetDeaths.length).toFixed(1) : '0'}%）`);
const shortSoak = wetDeaths.filter((d) => d.wetToDeathMin <= 1).length;
say(`  下水 ≤1 分钟就死：${shortSoak}（${pct(shortSoak)}%）——这批属于「水到人到」，行为改动改不了`);
say(`  首次下水水深中位数 ${fmt(median(wetDeaths.map((d) => d.wetDepth)), 2)} m；死亡时水深中位数 ${fmt(median(deaths.map((d) => d.depth)), 2)} m`);

// ③ 死前状态（因果链各环）
const ring = [
  ['下过水 everWaded', deaths.filter((d) => d.everWaded).length],
  ['死前受过伤 everInjured', deaths.filter((d) => d.everInjured).length],
  ['死前被困 everStranded', deaths.filter((d) => d.everStranded).length],
  ['弃过车', deaths.filter((d) => d.abandonMinute != null).length],
  ['曾成功避险 everEvacuated', deaths.filter((d) => d.everEvacuated).length],
  ['死前 5 分钟内受伤', deaths.filter((d) => d.hurtMinute != null && d.minute - d.hurtMinute <= 5).length],
];
say('\n三、死亡链条各环（占死者）');
ring.forEach(([k, v]) => say(`  ${k.padEnd(22)} ${String(v).padStart(4)}  ${pct(v)}%`));

// ④ 年龄组 vs 人口
const bands = {};
for (const d of deaths) bands[d.band] = (bands[d.band] || 0) + 1;
say('\n四、年龄组：死者构成 vs 人口构成');
const keys = [...new Set([...Object.keys(bands), ...Object.keys(popBands || {})])];
for (const k of keys) {
  const a = bands[k] || 0;
  const b = popBands ? (popBands[k] || 0) : null;
  const deathShare = N ? 100 * a / N : 0;
  const popShare = b == null ? null : 100 * b / 1000;
  const ratio = popShare ? (deathShare / popShare) : null;
  say(`  ${String(k).padEnd(10)} 死 ${String(a).padStart(3)}（${deathShare.toFixed(1)}%）  人口 ${popShare == null ? '—' : popShare.toFixed(1) + '%'}  过度代表 ${ratio == null ? '—' : ratio.toFixed(2) + '×'}`);
}
say(`  死者中位年龄 ${fmt(median(deaths.map((d) => d.age)), 0)}，最小 ${Math.min(...deaths.map((d) => d.age))}，最大 ${Math.max(...deaths.map((d) => d.age))}`);
const minors = deaths.filter((d) => (d.age || 0) < 18).length;
const elders = deaths.filter((d) => (d.age || 0) >= 65).length;
say(`  未成年 ${minors}（${pct(minors)}%）、65+ ${elders}（${pct(elders)}%）`);

// ⑤ 是否有「已经安全又回到水里」
const back = deaths.filter((d) => d.everEvacuated && d.everWaded).length;
say(`\n五、曾避险又回到水里溺亡：${back}（${pct(back)}%）`);

// ⑥ 长浸泡分组：有窗口 vs 没窗口，以及「有窗口但从没尝试避险」这一组
// 这条是「决策层到底有没有起作用」的分水岭：
//   · 有窗口（≥5 min）且从未避险 ⇒ 要么没收到/没动员，要么被阻碍（门5）挡住；
//   · 有窗口且尝试过避险（everEvacuated）却仍死 ⇒ 走了但没走到（路径/体能/二次被困）。
{
  const win = wetDeaths.filter((d) => d.wetToDeathMin >= 5);
  const winNoEvac = win.filter((d) => !d.everEvacuated);
  const winEvac = win.filter((d) => d.everEvacuated);
  const blind = wetDeaths.filter((d) => d.wetToDeathMin <= 1);
  say('');
  say('六、死亡窗口分组（第一次下水 → 死亡）');
  say(`  有窗口 ≥5 min：${win.length}（${pct(win.length)}%）——行为/路径改动能影响的是这一组`);
  say(`    · 其中从未避险：${winNoEvac.length}（占有窗口 ${win.length ? (100 * winNoEvac.length / win.length).toFixed(1) : '0'}%）`);
  say(`    · 其中曾避险但没走到：${winEvac.length}（占有窗口 ${win.length ? (100 * winEvac.length / win.length).toFixed(1) : '0'}%）`);
  say(`  「水到人到」≤1 min：${blind.length}（${pct(blind.length)}%）——改行为也改不了这一组`);
  say('');
  say('  按死因看浸泡时长中位数（分钟）：');
  const byCause = {};
  for (const d of wetDeaths) (byCause[d.zoneLabel] ||= []).push(d.wetToDeathMin);
  for (const [k, v] of Object.entries(byCause).sort((a, b) => b[1].length - a[1].length)) {
    say(`    ${k.padEnd(16)} n=${String(v.length).padStart(4)}  中位 ${fmt(median(v))}  最大 ${fmt(Math.max(...v))}`);
  }
}

// ⑦ 死亡时刻 vs 水峰时刻：是「正在涨」还是「已经在那了」
{
  const peaks = [];
  for (const r of runs) {
    const h = r.j.hourly || [];
    let best = null;
    for (const x of h) if (!best || (x.maxDepthCm || 0) > (best.maxDepthCm || 0)) best = x;
    peaks.push({ caseName: r.caseName, peakMinute: best ? best.minute : null, peakCm: best ? best.maxDepthCm : null });
  }
  say('');
  say('七、死亡时刻 vs 最深处时刻（判断「涨水过程中死」还是「水已到位后死」）');
  for (const p of peaks) say(`  ${String(p.caseName).padEnd(12)} 水峰 ${String(p.peakMinute).padStart(5)} 分 · ${String(p.peakCm).padStart(4)} cm`);
  const rel = deaths.filter((d) => {
    const pk = peaks.find((p) => p.caseName === d.run);
    return pk && pk.peakMinute != null && d.minute != null;
  }).map((d) => {
    const pk = peaks.find((p) => p.caseName === d.run);
    return d.minute - pk.peakMinute;
  });
  say(`  死者死亡时刻 − 水峰时刻：中位 ${fmt(median(rel), 0)} 分（负=水还在涨时就死了，正=水峰之后才死）`);
  say(`    水峰之前死 ${rel.filter((x) => x < 0).length}（${pct(rel.filter((x) => x < 0).length)}%）、之后 ${rel.filter((x) => x >= 0).length}`);
}

// ---- 写盘（--out 给了才写）----
if (outArg) {
  const md = [];
  md.push('# 个体级伤亡归因 · 数据表（自动生成，勿手改）');
  md.push('');
  md.push('> 生成：`node tools/check/trace-deep.mjs ' + dir + ' --out=' + outArg + '`');
  md.push('> 工况 ' + runs.length + ' 个：' + runs.map((r) => r.caseName).join('、'));
  md.push('');
  md.push('```text');
  md.push(...buf);
  md.push('```');
  fs.writeFileSync(outArg, md.join('\n') + '\n', 'utf8');
  console.log('\n已写 ' + outArg);
}

function zoneOf(cause) {
  const c = String(cause || '');
  if (c.includes('车内')) return { zone: '车内', label: '车内·开车' };
  if (c.includes('地下室')) return { zone: '地下室', label: '地下室·进入地下室' };
  if (c.includes('深水被困')) return { zone: '路面', label: '路面·被困' };
  if (c.includes('涉水')) return { zone: '路面', label: '路面·涉水行走' };
  return { zone: null, label: c || '未知' };
}