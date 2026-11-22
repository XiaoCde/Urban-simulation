// 论文用表生成器：把跑批结果直接变成「能贴进论文的表」，不做手抄。
//
// 用法：
//   cd web
//   node tools/check/paper-tables.mjs ablate out/ablate_v1            # 消融表（gate vs single）
//   node tools/check/paper-tables.mjs driver out/surge_v1 out/ablate_v1 --rain=u_p24_s0
//                                                                     # 跨驱动表（慢涨 vs 快涨）
//
// 为什么要有这个：手抄数字是这类项目最容易出的错（我们已经在「受伤列」上踩过一次，
// 把新判据的上升误读成模型变危险）。表必须由结果直接生成，且把「不能比」的列标出来。
import fs from 'node:fs';
import path from 'node:path';

const [mode, ...rest] = process.argv.slice(2);

function loadDir(dir) {
  if (!fs.existsSync(dir)) throw new Error(`目录不存在: ${dir}`);
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_') && !f.includes('.partial.'))
    .sort()
    .map((f) => {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const s = (j.final && j.final.sim) || {};
      const inc = s.incidents || {};
      const drv = s.driving || {};
      const hour = j.hourly || [];
      const sum = (k) => hour.reduce((a, x) => a + (x[k] || 0), 0);
      let firstEvac = null;
      for (const x of hour) if (x.evacuated > 0) { firstEvac = x.minute; break; }
      let peak = { minute: null, cm: 0 };
      for (const x of hour) if ((x.maxDepthCm || 0) > peak.cm) peak = { minute: x.minute, cm: x.maxDepthCm };
      return {
        file: f,
        caseName: (j.caseMeta && j.caseMeta.name) || f.replace(/\.json$/, ''),
        mode: f.includes('__') ? f.split('__')[0] : 'gate',      // gate / single
        people: j.people, minutes: j.minutes, seed: j.seed, startMinute: j.startMinute,
        pMmH: (j.caseMeta || {}).pMmH, surgeM: (j.caseMeta || {}).surgeM,
        peakWetHa: (j.caseMeta || {}).peakWetHa,
        dead: inc.dead || 0, stranded: inc.stranded || 0,
        // 【2026-11-23】injured 是「此刻仍在伤」的点值，everInjured 才是「累计受过伤」的
        // 全量口径；论文表格要报累计（与 sweep 汇总的 injured 列同义），否则同一工况会在
        // 两张表里出现 27 与 93 两个数。
        injured: inc.everInjured != null ? inc.everInjured : (inc.injured || 0),
        evacuated: inc.evacuated || 0, wading: inc.wading || 0, abandonedCar: inc.abandonedCar || 0,
        rescued: inc.rescued || 0, slip: inc.slip || 0,
        judged: sum('judged'),
        firstEvacMinute: firstEvac,
        peakMinute: peak.minute, peakCm: peak.cm,
        byCause: inc.deathsByCause || {},
        byZone: inc.deathsByZone || {},
        carKm: drv.carKm || 0, driveChosen: drv.driveChosen || 0, abandons: drv.abandons || 0,
        wallSec: j.wallSec,
      };
    });
}

const fmt = (v, d = 0) => (v == null ? '—' : (typeof v === 'number' ? v.toFixed(d) : String(v)));
const causeOf = (r) => {
  const e = Object.entries(r.byCause).filter(([, v]) => v);
  return e.length ? e.map(([k, v]) => `${k} ${v}`).join('；') : '—';
};

function ablate(dir) {
  const rows = loadDir(dir);
  // 没有完整结果就别生成（批跑期间目录里只有 .partial.json）
  if (rows.length === 0) {
    console.error(`[ablate] ${dir} 里没有完整结果（只有 .partial.json？）。等跑完再生成。`);
    process.exit(3);
  }
  const cases = [...new Set(rows.map((r) => r.caseName))].sort();
  const get = (c, m) => rows.find((r) => r.caseName === c && r.mode === m);

  const cols = [
    ['dead', '死亡', 0], ['stranded', '被困（累计）', 0], ['injured', '受伤（累计）', 0],
    ['evacuated', '避险', 0], ['wading', '涉水（人次）', 0],
    ['firstEvacMinute', '首次撤离（分）', 0], ['judged', '判断次数', 0],
    ['carKm', '行驶 km', 1],
  ];

  const out = [];
  out.push('# 消融：门结构 vs 单式效用（数据表，自动生成）');
  out.push('');
  out.push(`> 生成：\`node tools/check/paper-tables.mjs ablate ${dir}\``);
  out.push(`> 事实前提：单式对照组只换决策结构，水情/人口/种子完全相同（同 case、同 people、同 seed、同 startMinute）。`);
  out.push('');
  out.push('## 一、逐工况并排（gate = 五道门；single = 单式加权效用 merge 变体）');
  out.push('');
  out.push('| 指标 | ' + cases.map((c) => `${c} gate | ${c} single`).join(' | ') + ' |');
  out.push('|---|' + cases.map(() => '---:|---:').join('|') + '|');
  for (const [k, label, d] of cols) {
    const cells = cases.map((c) => {
      const g = get(c, 'gate'), s = get(c, 'single');
      return `${fmt(g && g[k], d)} | ${fmt(s && s[k], d)}`;
    });
    out.push(`| ${label} | ${cells.join(' | ')} |`);
  }
  out.push('');
  out.push('## 二、死因结构（这一节才是「结构差异」的证据；死亡总数被水情决定，别拿它当卖点）');
  out.push('');
  out.push('| 工况 | gate 死因 | single 死因 |');
  out.push('|---|---|---|');
  for (const c of cases) {
    const g = get(c, 'gate'), s = get(c, 'single');
    out.push(`| ${c} | ${g ? causeOf(g) : '—'} | ${s ? causeOf(s) : '—'} |`);
  }
  out.push('');
  out.push('## 三、对照条件自检（不一致的行不能比）');
  out.push('');
  out.push('| 工况 | people | seed | startMinute | gate 墙钟 s | single 墙钟 s |');
  out.push('|---|---:|---:|---:|---:|---:|');
  let bad = 0;
  for (const c of cases) {
    const g = get(c, 'gate'), s = get(c, 'single');
    const same = g && s && g.people === s.people && g.seed === s.seed && g.startMinute === s.startMinute;
    if (!same) bad++;
    out.push(`| ${c} | ${g ? g.people : '—'} | ${g ? g.seed : '—'} | ${g ? g.startMinute : '—'} | ${fmt(g && g.wallSec)} | ${fmt(s && s.wallSec)} |`);
  }
  out.push('');
  out.push(bad === 0 ? '✅ 全部工况的对照条件一致。' : `❌ 有 ${bad} 个工况对照条件不一致，**这几行不能比**。`);
  return out.join('\n');
}

function driver(surgeDir, rainDir, rainCase) {
  const surge = loadDir(surgeDir);
  if (surge.length === 0) {
    console.error(`[driver] ${surgeDir} 里没有完整结果。等跑完再生成。`);
    process.exit(3);
  }
  const rain = loadDir(rainDir).filter((r) => r.mode === 'gate');
  const pick = rainCase ? rain.filter((r) => r.caseName === rainCase) : rain;
  const rows = [...pick, ...surge];
  const out = [];
  out.push('# 跨驱动：降雨型 vs 河道漫堤——同一决策层、同一城市');
  out.push('');
  out.push(`> 生成：\`node tools/check/paper-tables.mjs driver ${surgeDir} ${rainDir}${rainCase ? ' --rain=' + rainCase : ''}\``);
  out.push('> 两类的驱动完全不同：降雨是「雨停后退」（有雨窗可循），漫堤是「堤顶越流」——');
  out.push('> 2026-11-22 实测 s4：堤顶一破，河front 街区**头一小时就进水**（5.7 分 11.5 ha、');
  out.push('> 45 分 110.9 ha），之后才慢慢爬到 173 ha。所以不要写「慢涨」，');
  out.push('> 要写「瞬时越流 + 缓慢爬升」。');
  out.push('> **这不是跨灾种**（都是洪水），论文里只能写 cross-driver。');
  out.push('');
  out.push('| 指标 | ' + rows.map((r) => r.caseName).join(' | ') + ' |');
  out.push('|---|' + rows.map(() => '---:').join('|') + '|');
  const cols = [
    ['pMmH', '雨强 mm/h', 0], ['surgeM', '河道增水 m', 2], ['peakWetHa', '峰值湿区 ha', 0],
    ['peakCm', '最深水 cm', 0], ['peakMinute', '最深水时刻（分）', 0],
    ['dead', '死亡', 0], ['stranded', '被困（累计）', 0], ['injured', '受伤（累计）', 0],
    ['evacuated', '避险', 0], ['firstEvacMinute', '首次撤离（分）', 0], ['carKm', '行驶 km', 1],
  ];
  for (const [k, label, d] of cols) {
    out.push(`| ${label} | ${rows.map((r) => fmt(r[k], d)).join(' | ')} |`);
  }
  out.push('');
  out.push('## 死因结构（跨驱动最该看的一列）');
  out.push('');
  out.push('| 工况 | 死因 |');
  out.push('|---|---|');
  for (const r of rows) out.push(`| ${r.caseName} | ${causeOf(r)} |`);
  out.push('');
  out.push('**读法**：漫堤工况若「车内」死亡不升、「地下室」明显上升、「首次撤离」提前，');
  out.push('说明决策层确实在读输入（而不是被写死的行为表）；反之若两者死因结构几乎一样，');
  out.push('说明决策层对「涨水速率」不敏感——那反而是个该记录的负结果。');
  return out.join('\n');
}

if (mode === 'ablate') {
  const dir = rest[0] || 'out/ablate_v1';
  const md = ablate(dir);
  const outp = rest[1] || '../docs/消融_数据_2026-11-22.md';
  fs.writeFileSync(outp, md + '\n', 'utf8');
  console.log(md);
  console.log(`\n已写 ${outp}`);
} else if (mode === 'driver') {
  const surgeDir = rest[0] || 'out/surge_v1';
  const rainDir = rest[1] || 'out/ablate_v1';
  const rainCase = (rest.find((a) => a.startsWith('--rain=')) || '').slice(7) || null;
  const md = driver(surgeDir, rainDir, rainCase);
  const outp = (rest.find((a) => a.startsWith('--out=')) || '').slice(6) || '../docs/跨驱动_数据_2026-11-22.md';
  fs.writeFileSync(outp, md + '\n', 'utf8');
  console.log(md);
  console.log(`\n已写 ${outp}`);
} else {
  console.error('用法:\n  node tools/check/paper-tables.mjs ablate <结果目录> [输出.md]\n  node tools/check/paper-tables.mjs driver <纯增水目录> <降雨目录> [--rain=u_p24_s0] [--out=文件]');
  process.exit(2);
}