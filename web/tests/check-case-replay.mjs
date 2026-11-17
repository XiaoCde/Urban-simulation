/**
 * 事故个案逐帧回放验收（纯 Node，不需要浏览器）。
 *
 * 只验记录层：连续推进一个假的人，看水深/速度/状态/动作有没有按同一子步
 * 记下来，出事后事件链完整、末帧与死亡记录的位置和水深对得上。
 * 不验判定公式（那部分由 _check_choice_model.mjs 负责）。
 */
import { createIncidents } from '../src/incidents.js';

let minute = 0;
const clock = { get minute() { return minute; } };
const peds = Array.from({ length: 3 }, (_, i) => ({ i }));
const circles = [
  { id: 'c0', label: '外环社区 · 有车', districtLabel: '外环社区' },
  { id: 'c1', label: '滨河低洼 · 无车', districtLabel: '滨河低洼' },
  { id: 'c2', label: '学龄前', districtLabel: '外环社区' },
];
const crowd = { at: (i) => ({ age: [8, 42, 74][i], ageBand: ['child', 'prime', 'old'][i] }) };
const INC = createIncidents({ peds, clock, circles, crowd });

const ok = [];
const check = (name, pass, extra = '') => {
  ok.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

// 0 号人：从干地走进深水、越走越慢、最后溺亡。其余两人一直在干地。
const step = (i, h, ctx) => {
  INC.tick(i, h, ctx);
  minute += h / 60;   // 仿真秒 → 分钟
};
for (let k = 0; k < 1200; k++) {
  const depth = k < 60 ? 0 : Math.min(1.6, 0.12 + (k - 60) * 0.004);
  const speed = depth > 1 ? 0.02 : 1.1;
  step(0, 0.2, {
    x: 100 + k * 0.1, z: 200 + k * 0.05, depth, speed,
    indoor: false, sheltered: false, inVehicle: false,
    stamina: Math.max(20, 80 - k * 0.05), rainMMH: 40, mode: 'net',
    action: depth > 0.5 ? 'detour' : 'continue',
    reason: depth > 0.5 ? '前方水深超出能力' : '按日程继续',
    goalLabel: '下班回家',
  });
  step(1, 0.2, { x: 0, z: 0, depth: 0, speed: 1.2, indoor: true, mode: 'home' });
  step(2, 0.2, { x: 0, z: 0, depth: 0, speed: 1.0, indoor: true, mode: 'home' });
}

const S = INC.stats();
const all = INC.cases(50);
check('只有出过事的人进入个案清单', all.length >= 1 && all.every((c) => c.frames > 0),
  `个案数 ${all.length}`);
check('未出事的人不占全天逐帧内存', INC.row(1).trace === null && INC.row(2).trace === null);
check('完整事件链没被截断', INC.row(0).events.length > 0
  && INC.row(0).events[0].type === 'wading',
  `事件数 ${INC.row(0).events.length}，首件 ${INC.row(0).events[0]?.type}`);

const snap = INC.snapshot(0);
check('快照带完整轨迹', snap.trace.length === all.find((c) => c.i === 0).frames,
  `帧数 ${snap.trace.length}`);
check('轨迹字段齐全（位置/水深/速度/状态/动作/理由/目标）',
  ['t', 'x', 'z', 'd', 'v', 'st', 'act', 'why', 'goal', 'mode', 'sta', 'rain']
    .every((k) => k in snap.trace[0]));
check('轨迹里真的记到了判断动作', snap.trace.some((f) => f.act === 'detour')
  && snap.trace.some((f) => f.act === 'continue'));
check('轨迹时间单调不倒退', snap.trace.every((f, i, a) => i === 0 || f.t >= a[i - 1].t));
check('水深在轨迹里是连续上升的（不是事后补的数）',
  snap.trace[snap.trace.length - 1].d > snap.trace[0].d);
check('快照带真实年龄与圈层', snap.age === 8 && snap.district === '外环社区');

const dead = INC.row(0).status === 'dead';
if (dead) {
  const last = snap.trace[snap.trace.length - 1];
  check('末帧状态为 dead', last.st === 'dead');
  check('末帧水深与死亡记录一致', Math.abs(last.d - snap.depth) < 0.002,
    `末帧 ${last.d} / 记录 ${snap.depth}`);
  check('末帧位置与死亡记录一致', Math.abs(last.x - snap.x) < 0.2
    && Math.abs(last.z - snap.z) < 0.2,
    `末帧 ${last.x},${last.z} / 记录 ${snap.x},${snap.z}`);
  check('死因有具体文字', !!snap.cause, snap.cause);
} else {
  check('深水长时暴露最终判为死亡', false, `实际状态 ${INC.row(0).status}`);
}

const exp = INC.exportCases(10);
check('离线导出结构与页面同一份快照', exp.length > 0
  && exp[0].replay.trace.length === exp[0].summary.frames);

// 拖时间轴 = reset：经历与轨迹必须一起清空，不能留着旧数字冒充新时刻。
INC.reset();
check('reset 后个案清单清空', INC.cases().length === 0 && INC.snapshot(0).trace.length === 0);
check('reset 后统计归零', INC.stats().dead === 0 && INC.stats().logSize === 0);

const failed = ok.filter((x) => !x).length;
console.log(`\n${ok.length - failed}/${ok.length} 通过`);
process.exit(failed ? 1 : 0);
