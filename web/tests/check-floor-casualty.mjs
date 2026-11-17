/**
 * 阶段3 验收：楼层淹没判据接进伤亡判定的效果（纯 Node）。
 * 用户要「1/2/3/4 层接受的不一样」：同栋楼低层先遇险、高层能往上退。
 * 只测 incidents.js 的 tick，不碰浏览器。
 */
import { createIncidents } from '../src/incidents.js';
import { jonkmanFatality, personalThreshold, TYPICAL_INUNDATION_HOURS }
  from '../src/kernel/fatality.js';
import { submergenceThresholdM, SELF_SET } from '../src/kernel/floors.js';

const ok = [];
const check = (name, pass, extra = '') => {
  ok.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

function makeInc(n, opts = {}) {
  let minute = 0;
  const clock = { get minute() { return minute; } };
  const peds = Array.from({ length: n }, (_, i) =>
    ({ i, citizen: opts.age != null ? { age: opts.age } : null }));
  const INC = createIncidents({ peds, clock });
  return { INC, setMinute: (m) => { minute = m; } };
}

/** 找阈值最小/最大的样本下标，用来测「体质差异」。 */
function extremeIndex(wantMin, from = 0, to = 4000) {
  let best = from, bestV = personalThreshold(from);
  for (let i = from; i < to; i++) {
    const v = personalThreshold(i);
    if (wantMin ? v < bestV : v > bestV) { bestV = v; best = i; }
  }
  return { i: best, v: bestV };
}

const DEPTH = 2.0;     // 室外地面水深 2 m
const FH = 2.74;       // 住宅层高（Choi 2002 的 2.7 m；LifeSim 默认 9 ft）
const BASE = SELF_SET.foundationHeightM;   // 0.457 m

// ① 4 层楼一楼的人：1 层被淹、2 层(0.457+2.74=3.197m)未淹 → 往上转移，不死
{
  const { INC } = makeInc(1);
  for (let k = 0; k < 60; k++) {
    INC.tick(0, 1, { x: 0, z: 0, depth: DEPTH, speed: 0, indoor: true,
      floor: 1, totalFloors: 4, floorHeightM: FH, sheltered: false });
  }
  check('4 层楼 1 层的人往上转移、不死亡',
    INC.statusOf(0) !== 'dead' && INC.isStranded(0) === false, INC.statusOf(0));
}

// ② 同水深、4 层楼四楼的人：4 层未淹 → 安全，不会遇险
{
  const { INC } = makeInc(1);
  for (let k = 0; k < 120; k++) {
    INC.tick(0, 1, { x: 0, z: 0, depth: DEPTH, speed: 0, indoor: true,
      floor: 4, totalFloors: 4, floorHeightM: FH, sheltered: false });
  }
  check('4 层楼 4 层的人在 2 m 水里安全', INC.statusOf(0) !== 'dead', INC.statusOf(0));
}

// ③ 单层屋、水刚过地板 1.2 m（该层积水 0.74 m）：判被困，但没到高危险深度。
// 这是 LifeSim CPD-97a Table 4-3 的判据：能行动者要接近天花板才算高危险。
{
  const { INC } = makeInc(1);
  for (let k = 0; k < 400; k++) {
    INC.tick(0, 1, { x: 0, z: 0, depth: 1.2, speed: 0, indoor: true,
      floor: 1, totalFloors: 1, floorHeightM: FH, sheltered: false });
  }
  const r = INC.row(0);
  const thr = submergenceThresholdM({ limitedMobility: false, floorHeightM: FH });
  check('水刚过地板：判被困但不累积死亡风险',
    r.status === 'stranded' && r.floodRisk === 0,
    `积水 ${(1.2 - BASE).toFixed(2)} m / 判据 ${thr.toFixed(2)} m，risk=${r.floodRisk}`);
}

// ③-b 同一间屋、水 4 m（该层积水 3.54 m）接近天花板：进入高危险，按 Jonkman 累积。
// 累积速率必须等于 FD ÷ 典型淹没历时。
{
  const { INC } = makeInc(1);
  const local = 4 - BASE;
  const fd = jonkmanFatality({ depthM: local }).fd;
  const want = fd * (3600 / (TYPICAL_INUNDATION_HOURS * 3600));
  for (let k = 0; k < 3600; k++) {
    INC.tick(0, 1, { x: 0, z: 0, depth: 4, speed: 0, indoor: true,
      floor: 1, totalFloors: 1, floorHeightM: FH, sheltered: false });
  }
  const got = INC.row(0).floodRisk;
  check('接近天花板后 1 小时累积风险 ≈ Jonkman FD ÷ 4 小时',
    Math.abs(got - want) < want * 0.08,
    `期望 ${want.toFixed(6)}，实际 ${got.toFixed(6)}，FD=${(fd * 100).toFixed(2)}%`);
}

// ③-c 同一个水深、同一间屋：70 岁（行动不便，判据 1.52 m）先进入高危险，
// 30 岁（能行动，判据 2.44 m）还没到。这是年龄维度的差异。
{
  const depth = 2.2;                       // 该层积水 1.74 m
  const run = (age) => {
    const { INC } = makeInc(1, { age });
    for (let k = 0; k < 1200; k++) {
      INC.tick(0, 1, { x: 0, z: 0, depth, speed: 0, indoor: true,
        floor: 1, totalFloors: 1, floorHeightM: FH, sheltered: false });
    }
    return INC.row(0).floodRisk;
  };
  const oldR = run(70), youngR = run(30);
  check('同样水深：高龄者累积风险、年轻人还没到',
    oldR > 0 && youngR === 0,
    `70 岁 risk=${oldR.toFixed(6)}，30 岁 risk=${youngR.toFixed(6)}`);
}

// ④ 两层楼、水 3.95 m、人在 2 楼：2 楼地板 3.197 m，只泡 0.75 m，能站住不死
{
  const { INC } = makeInc(1);
  for (let k = 0; k < 400; k++) {
    INC.tick(0, 1, { x: 0, z: 0, depth: 3.95, speed: 0, indoor: true,
      floor: 2, totalFloors: 2, floorHeightM: FH, sheltered: false });
  }
  check('两层楼 2 层只泡 0.75 m 不判死（按该层实际积水判）',
    INC.statusOf(0) !== 'dead', INC.statusOf(0));
}

// ④-b 体质差异：同样深水，阈值低的人跑满典型淹没历时会死，阈值高的人不会。
{
  const lo = extremeIndex(true);
  const hi = extremeIndex(false);
  const steps = Math.round(TYPICAL_INUNDATION_HOURS * 3600);
  const depth = 4;
  const run = (id) => {
    const { INC } = makeInc(id + 1);
    for (let k = 0; k < steps; k++) {
      INC.tick(id, 1, { x: 0, z: 0, depth, speed: 0, indoor: true,
        floor: 1, totalFloors: 1, floorHeightM: FH, sheltered: false });
      if (INC.statusOf(id) === 'dead') return true;
    }
    return INC.statusOf(id) === 'dead';
  };
  const diedLo = run(lo.i);
  const diedHi = run(hi.i);
  const fd = jonkmanFatality({ depthM: depth - BASE }).fd;
  check('阈值低的人在同一深水里最终溺亡', diedLo,
    `i=${lo.i} 阈值 ${lo.v.toFixed(4)}，FD=${(fd * 100).toFixed(2)}%`);
  check('阈值高的人在同样时间里活下来', !diedHi,
    `i=${hi.i} 阈值 ${hi.v.toFixed(4)}`);
}

// ⑤ 没有楼层信息（工作场所）时维持旧行为：室内不暴露
{
  const { INC } = makeInc(1);
  for (let k = 0; k < 200; k++) {
    INC.tick(0, 1, { x: 0, z: 0, depth: DEPTH, speed: 0, indoor: true,
      floor: 0, totalFloors: 0, sheltered: false });
  }
  check('无楼层信息时室内维持不暴露', INC.statusOf(0) !== 'dead', INC.statusOf(0));
}

const failed = ok.filter((x) => !x).length;
console.log(`\n${ok.length - failed}/${ok.length} 通过`);
process.exit(failed ? 1 : 0);
