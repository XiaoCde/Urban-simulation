/**
 * timeline.mjs —— 把一次 trace 渲染成「某人这一天的可读时间线」。
 *
 * 这文件回答的是导师那个问题：定位某个受困/溺亡者，复现其完整过程。
 * 输入是 sim-day 跑出来的 <case>.trace.json（?trace=<i> 打开时自动写盘），
 * 输出是同名 .timeline.md。
 *
 * 用法：
 *   node tools/trace/timeline.mjs web/out/_trace/u_p80_s0_p74.trace.json
 *   node tools/trace/timeline.mjs <trace.json> <run.json>   # 带上结果文件里的案例摘要
 *
 * 压缩规则（为了让人能读，而不是把 300 条原样倒出来）：
 *   · 逐分钟 tick 只在「水深变动 ≥ 5 cm」或「位置移动 ≥ 120 m」或「所在变了」时保留；
 *   · judge 只在「保护决定翻转」或「威胁档变化」时保留 —— 因为那才是有信息量的那几条；
 *   · 事件链（wading/stranded/dead…）全部保留，那是结果本身。
 *   · 死亡之后还发生的事件会被标成 ⚠ 后置事件：这是顺序 bug，不是剧情。
 */

import { readFileSync, writeFileSync } from 'node:fs';

const tracePath = process.argv[2];
if (!tracePath) {
  console.error('用法：node tools/trace/timeline.mjs <trace.json> [run.json]');
  process.exit(2);
}
const runPath = process.argv[3] || null;
const T = JSON.parse(readFileSync(tracePath, 'utf8'));
const RUN = runPath ? JSON.parse(readFileSync(runPath, 'utf8')) : null;
const id = T.identity || {};
const evs = Array.isArray(T.events) ? T.events : [];

const n = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '—');
const mmss = (t) => {
  const x = Number(t);
  if (!Number.isFinite(x)) return '—';
  const h = Math.floor(x / 60), m = Math.floor(x % 60), s = Math.round((x % 1) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(Math.min(59, s)).padStart(2, '0')}`;
};

// ---------------------------------------------------------------- 事件链
const isEvent = (k) => !['identity', 'tick', 'judge'].includes(k);
const events = evs.filter((e) => isEvent(e.k));
const death = events.find((e) => e.k === 'dead');
const deathT = death ? Number(death.t) : null;
const afterDeath = (t) => deathT !== null && Number(t) > deathT + 1e-6;

// ---------------------------------------------------------------- 抽稀 tick
const ticks = [];
let prev = null;
for (const e of evs) {
  if (e.k !== 'tick') continue;
  const moved = prev ? Math.hypot((e.x || 0) - (prev.x || 0), (e.z || 0) - (prev.z || 0)) : 1e9;
  const dCh = prev ? Math.abs((e.depthM || 0) - (prev.depthM || 0)) : 1;
  const whereCh = prev ? (e.where || '') !== (prev.where || '') : true;
  if (!prev || moved >= 120 || dCh >= 0.05 || whereCh) ticks.push(e);
  prev = e;
}

// ---------------------------------------------------------------- 抽稀 judge
const judges = [];
let lastProtect = null, lastThreat = null;
for (const e of evs) {
  if (e.k !== 'judge') continue;
  if (lastProtect === null || e.protect !== lastProtect || e.threat !== lastThreat) {
    judges.push(e);
    lastProtect = e.protect; lastThreat = e.threat;
  }
}

// ---------------------------------------------------------------- 合并时间轴
const rows = [];
for (const e of ticks) rows.push({ t: Number(e.t), kind: 'tick', e });
for (const e of judges) rows.push({ t: Number(e.t), kind: 'judge', e });
for (const e of events) rows.push({ t: Number(e.t), kind: 'event', e });
rows.sort((a, b) => a.t - b.t);

const NODE = {
  tick: '位置/水深',
  judge: '判断',
};
const lines = [];
for (const r of rows) {
  const warn = afterDeath(r.t) ? ' ⚠' : '';
  if (r.kind === 'tick') {
    const e = r.e;
    lines.push(`| ${mmss(r.t)} | 位置/水深${warn} | ${e.where || '—'}${e.indoor ? '·室内' : ''} · 水深 ${n(e.depthM, 2)} m · ${(e.wet ? '水已到脚' : '干')}${e.rainMMH != null ? ` · 雨强 ${n(e.rainMMH, 1)} mm/h` : ''} |`);
  } else if (r.kind === 'judge') {
    const e = r.e;
    const g = e.gates || {};
    const parts = [
      `收到预警 ${g.received ? '是' : '否'}`,
      `危险度 ${n(e.hazardRatingValue, 2)}（${g.hazardClass || g.threat || '—'}）`,
      `动员 ${n(g.mobilisation ?? e.mobilisation, 3)}`,
      `选择 ${n(e.probability, 3)}`,
      `阻碍 ${g.impediment && g.impediment !== 'none' ? g.impediment : '无'}`,
    ];
    lines.push(`| ${mmss(r.t)} | 判断${warn} | ${e.protect ? '**启动保护**' : '继续日常'} → 动作 \`${e.action}\` ｜ ${parts.join(' · ')} |`);
  } else {
    const e = r.e;
    lines.push(`| ${mmss(r.t)} | **${e.k}**${warn} | ${(e.reason || '').replace(/\|/g, '/')}${e.depth != null ? `（水深 ${n(e.depth, 2)} m）` : ''} |`);
  }
}

// ---------------------------------------------------------------- 案例摘要（若给了结果文件）
let caseBlock = '';
if (RUN) {
  const cs = (RUN.final && RUN.final.cases) || [];
  const found = cs.map((c) => c.summary || c).find((c) => Number(c.i) === Number(id.i));
  if (found) {
    caseBlock = `\n- 结果文件里的案例摘要：状态 **${found.status}**，死因/cause ${found.cause || '—'}，时刻 ${n(found.minute, 1)} 分，最大水深 ${n(found.maxDepth, 2)} m，所在片 ${found.circleLabel || '—'}\n`;
  }
}

const md = `# 个体行为追溯 · 第 ${id.i ?? '?'} 号

- 工况文件：\`${tracePath}\`
- 记录条数：${T.records}${T.truncated ? '（**已截断**，后面的记录丢了）' : ''}
- 身份（ACS 逐人）：年龄 ${id.age ?? '—'} · 性别 ${id.sex === '2' ? '女' : id.sex === '1' ? '男' : '—'} · SOC ${id.socCode ?? '—'} · 经验 ${n(id.experience, 2)} · 有车 ${id.hasCar ? '是' : '否'} · 工作场所 ${id.workPlace || '—'}
${caseBlock}
## 时间线

| 时刻 | 类型 | 内容 |
| --- | --- | --- |
${lines.join('\n') || '| — | — | 没有记录（?trace 没传进去，或这个人一天没被判断过） |'}

## 怎么读这张表

- **判断**行是决策内核真正工作的那一刻：五道门各读到什么、乘出多少概率、最后落到哪个动作。保护决定翻转为「启动保护」的那一行，就是他决定不再继续日常的时刻。
- **位置/水深**行是感知输入：他在哪、脚下多深、在室内还是街上。只保留变动明显的那几分钟。
- 事件行（\`wading\` / \`stranded\` / \`injured\` / \`dead\` / \`abandonedCar\` …）来自伤亡模块，是结果。
- 带 ⚠ 的行发生在死亡之后 —— 那不是剧情，是**事件顺序 bug**（模块还在更新一个已经死掉的人），应当修。

## 这次追出来的是什么

${death ? `这个人在 ${mmss(deathT)}（第 ${n(deathT, 1)} 分）因「${death.reason}」死亡，水深 ${n(death.depth, 2)} m。往前看这张表，能看到他是怎么一步步走到那里的：` : '这个人这一天没有死亡。他的过程仍可用于核对决策是否合理：'}
${events.map((e) => `- ${mmss(e.t)} ${e.k}：${(e.reason || '').slice(0, 60)}`).join('\n')}
`;

const out = tracePath.replace(/\.json$/i, '') + '.timeline.md';
writeFileSync(out, md);
console.log('写出 ' + out + `（时间线 ${lines.length} 行，事件 ${events.length} 条，死亡 ${death ? '有' : '无'}）`);