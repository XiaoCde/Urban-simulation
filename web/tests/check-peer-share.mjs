/**
 * check-peer-share.mjs — 纯 Node，验 Borowski 2023 Table 4 的两个同伴比例真的接上了。
 *
 * 背景（A3）：peersRide 一直没人赋值 → 「Share peers choosing ride」的 −1.27
 * 与 threat × peersRide 交互项恒乘 0；peersStay 又把「已经开车走的人」算成留下，
 * 方向与论文相反。这两条都不是数字问题，是通路问题，所以验收要抓两处：
 *   ① 分类函数本身（kernel/peer-share.js）：乘车走的人不能算「留下」；
 *   ② 全链路确实把比例传进决策内核（cohort.judge → choice-model），
 *      且 live-agent 里 peersRide / peersStay 都由同一个函数给出。
 *
 * 用法：cd web && node tests/check-peer-share.mjs
 */
import { readFileSync } from 'node:fs';
import { peerShares, PEER_SHARE_META } from '../src/kernel/peer-share.js';
import { peerShares as p2 } from '../src/kernel/peer-share.js';
import { protectiveActionUtilities } from '../src/kernel/choice-model.js';
import { BOROWSKI_DESIGN } from '../src/kernel/evidence-tables.js';

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? `  ← ${detail}` : ''}`); }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---- 1 分类：四个方案各自归位 ----
{
  const r = peerShares([
    { mode: 'net', inVehicle: false },        // 还在正常活动 → 留下
    { mode: 'flee', inVehicle: false },       // 步行撤离
    { mode: 'shelter', inVehicle: false },    // 已到避险点 = 已撤离（步行侧）
    { mode: 'route', inVehicle: true },       // 坐在车里撤离 → ride
  ]);
  ok(r.total === 4 && r.ride === 1 && r.walk === 2 && r.stay === 1,
    '四种状态各归各位（ride 1 / walk 2 / stay 1）', JSON.stringify(r));
  ok(near(r.peersStay, 0.25) && near(r.peersRide, 0.25), '两个比例按人数平均');
}

// ---- 2 A3 的核心 bug：开车撤离的人不能算「留下」----
{
  const driving = peerShares([
    { mode: 'route', inVehicle: true },
    { mode: 'route', inVehicle: true },
  ]);
  ok(driving.stay === 0 && near(driving.peersStay, 0),
    '同伴已经开车撤离时 peersStay=0（旧实现会算成 1.0，方向相反）',
    JSON.stringify(driving));
  ok(near(driving.peersRide, 1), '同伴已经开车撤离时 peersRide=1');
}

// ---- 3 空参照群体不编比例 ----
{
  const none = peerShares([]);
  ok(none.total === 0 && none.peersStay === 0 && none.peersRide === 0,
    '参照群体为空时两条比例都给 0（不是「所有人留下」）');
  const junk = p2([null, undefined]);
  ok(junk.total === 0, 'null/undefined 成员被剔除，不污染分母');
  ok(peerShares('not-an-array').total === 0, '非数组输入退回 0');
}

// ---- 4 比例真的进了效用函数：peersRide 必须改变 Ve ----
{
  const base = {
    age: 48, cost: 0, travelTime: 0, waitTime: 0, walkDistance: 0,
    peersStay: 0, threat: 'low', rplZ: [0, 0, 0],
  };
  const u0 = protectiveActionUtilities({ ...base, peersRide: 0 });
  const u1 = protectiveActionUtilities({ ...base, peersRide: 0.6 });
  ok(u1.evacuate < u0.evacuate - 1e-6,
    'peersRide 上升压低疏散效用（Table 4 系数 −1.27 真的在起作用）',
    `${u0.evacuate} → ${u1.evacuate}`);
  const hi = protectiveActionUtilities({ ...base, peersRide: 0.6, threat: 'extreme' });
  ok(hi.evacuate > u1.evacuate + 1e-6,
    '威胁升高时 peersRide 的负效应被交互项抵消一部分（×extreme 1.11）',
    `${u1.evacuate} → ${hi.evacuate}`);
  ok(near(u0.evacuate, 4.22, 1e-9), 'peersRide=0 时退化为原 ASC（没有偷偷加项）');
}

// ---- 5 设计范围截断有出处 ----
{
  ok(PEER_SHARE_META.source.includes('Borowski'), 'meta 记了系数出处');
  ok(PEER_SHARE_META.definition.includes('0.8'), 'meta 记了「同伴留下 0–0.8」的设计范围');
  ok(BOROWSKI_DESIGN.peerFractionRide.max === 1, '搭车设计上限 1（与 meta 一致）');
}

// ---- 6 全链路：live-agent 的两条比例同源，cohort 两条都读 ----
{
  const la = readFileSync(new URL('../src/live-agent.js', import.meta.url), 'utf8');
  ok(/peersStay:\s*shares\.peersStay/.test(la) && /peersRide:\s*shares\.peersRide/.test(la),
    'live-agent 把两个比例同时送进决策输入');
  ok(/const shares = peerSharesOf\(a\)/.test(la), '同一子步只算一次，两条比例同源');
  ok(!/function peersStayOf/.test(la), '旧的 peersStayOf（把开车走算成留下）已删除');

  const co = readFileSync(new URL('../src/cohort.js', import.meta.url), 'utf8');
  ok(/const peersRide = clamp\(Number\(s\.peersRide\)/.test(co), 'cohort 读 s.peersRide');
  ok(/BOROWSKI_DESIGN\.peerFractionRide\.max/.test(co), 'cohort 按论文设计范围截断 peersRide');
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);