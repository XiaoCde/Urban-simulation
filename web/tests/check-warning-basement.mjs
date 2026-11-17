// 2026-11-17 A/B/C 三项改动的专项自检
//   A 预警按人分发（覆盖率 35.5% 收不到、前置时间中位 1 小时）
//   B 地下室层存在且可进入、进入后不受楼层保护
//   C 弃车不等于安全：深水里下车后头两分钟挪不动
import { createIncidents } from '../src/incidents.js';
import {
  receivesWarning, warningLeadMin, warnAtOf, WARNING_MEASURED, WARNING_SELF_SET,
} from '../src/kernel/warning.js';
import {
  BASEMENT, goesToBasement, basementStayMin, basementElevationM, floorElevationM,
} from '../src/kernel/floors.js';

const ok = [];
const check = (name, pass, extra = '') => {
  ok.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

function makeInc(n) {
  let minute = 0;
  const clock = { get minute() { return minute; } };
  const INC = createIncidents({ peds: Array.from({ length: n }, (_, i) => ({ i })), clock });
  return { INC, setMinute: (m) => { minute = m; } };
}

// ---------------------------------------------------------------- A 预警
{
  const N = 1000;
  let got = 0;
  const leads = [];
  for (let i = 0; i < N; i++) {
    if (receivesWarning(i)) { got++; leads.push(warningLeadMin(i)); }
  }
  const share = 1 - got / N;
  check('收不到预警的比例接近实测 35.5%', Math.abs(share - WARNING_MEASURED.neverWarnedShare) < 0.04,
    `${(share * 100).toFixed(1)}%（实测 35.5，n=448）`);

  leads.sort((a, b) => a - b);
  const med = leads[leads.length >> 1];
  check('预警前置时间中位数接近实测 1 小时', Math.abs(med - 60) <= 8, `${med.toFixed(0)} 分钟`);

  const [lo, hi] = WARNING_SELF_SET.leadClipMin;
  check('前置时间都在截断区间内', leads.every((v) => v >= lo && v <= hi),
    `区间 ${lo}–${hi} 分钟`);

  // 收不到的人：任何见水时刻都拿不到预警
  let neverIdx = -1;
  for (let i = 0; i < 200; i++) if (!receivesWarning(i)) { neverIdx = i; break; }
  check('收不到的人 warnAt 恒为 Infinity', warnAtOf(900, neverIdx) === Infinity);

  // 收到的人：warnAt = 见水 − 前置，且不早于 0
  let gotIdx = -1;
  for (let i = 0; i < 200; i++) if (receivesWarning(i)) { gotIdx = i; break; }
  const w = warnAtOf(900, gotIdx);
  const lead = warningLeadMin(gotIdx);
  check('收到的人 warnAt = 见水时刻 − 前置时间', Math.abs(w - (900 - lead)) < 1e-6,
    `warnAt=${w.toFixed(0)} 见水 900 前置 ${lead.toFixed(0)}`);
  check('见水太早时 warnAt 夹到 0，不出现负时刻', warnAtOf(10, gotIdx) === 0);
}

// ---------------------------------------------------------------- B 地下室
{
  const N = 1000;
  const down = Array.from({ length: N }, (_, i) => goesToBasement(i)).filter(Boolean).length;
  check('下地下室的比例与设定的 35% 一致', Math.abs(down / N - BASEMENT.goesDownShare) < 0.04,
    `${(down / N * 100).toFixed(1)}%`);

  const stays = Array.from({ length: 500 }, (_, i) => basementStayMin(i));
  check('停留时长落在 10–25 分钟',
    stays.every((v) => v >= 10 && v <= 25), `${Math.min(...stays).toFixed(1)}–${Math.max(...stays).toFixed(1)} 分钟`);

  check('地下室地板在室外地坪以下', basementElevationM() < 0, `${basementElevationM()} m`);

  // 同一栋 4 层楼、水深 1.5 m：在 3 层的人受楼层保护；在地下室的人不受保护
  {
    const { INC } = makeInc(2);
    for (let k = 0; k < 600; k++) {
      INC.tick(0, 1, { x: 0, z: 0, depth: 1.5, speed: 0, indoor: true,
        floor: 3, totalFloors: 4, sheltered: false, basement: false });
      INC.tick(1, 1, { x: 0, z: 0, depth: 1.5, speed: 0, indoor: true,
        floor: 0, totalFloors: 4, sheltered: false, basement: true });
    }
    check('楼上的人受楼层保护、不进涉水暴露', INC.statusOf(0) !== 'dead' && !INC.row(0).everWaded,
      `状态 ${INC.statusOf(0)}`);
    check('地下室的人不受楼层保护、按涉水判',
      INC.row(1).everWaded && INC.statusOf(1) !== 'safe', `状态 ${INC.statusOf(1)}`);
  }

  // 地下室水位与室外齐平：室外 1.5 m，地下室人踩的就是 1.5 m
  {
    const { INC } = makeInc(1);
    for (let k = 0; k < 60; k++) {
      INC.tick(0, 1, { x: 0, z: 0, depth: 1.5, speed: 0, indoor: true,
        floor: 0, totalFloors: 3, sheltered: false, basement: true });
    }
    check('地下室的人被记进"下到地下室"事件',
      INC.row(0).events.some((e) => e.type === 'basement'), INC.row(0).events.map((e) => e.type).join(','));
  }
}

// ---------------------------------------------------------------- C 弃车
{
  // 弃车后立刻在 1.5 m 水里"走"：头两分钟按站不住算，stillSec 要涨
  const { INC, setMinute } = makeInc(1);
  INC.mark(0, 'abandonedCar', '熄火后水还在涨，弃车改步行', { depth: 1.5 });
  for (let k = 0; k < 30; k++) {
    INC.tick(0, 1, { x: 0, z: 0, depth: 1.5, speed: 1.2, indoor: false,
      sheltered: false, inVehicle: false, stamina: 80 });
  }
  const stillNow = INC.row(0).stillSec;
  check('弃车后两分钟内即使步速 1.2 m/s 也算挪不动', stillNow > 20,
    `stillSec=${stillNow.toFixed(0)} s`);

  // 过了两分钟，同样的状态应当能走起来，stillSec 回落
  setMinute(5);
  for (let k = 0; k < 40; k++) {
    INC.tick(0, 1, { x: 0, z: 0, depth: 1.5, speed: 1.2, indoor: false,
      sheltered: false, inVehicle: false, stamina: 80 });
  }
  check('两分钟之后恢复按真实步速判', INC.row(0).stillSec < stillNow,
    `stillSec=${INC.row(0).stillSec.toFixed(0)} s`);

  // 浅水里弃车不该被这条规则误伤
  const { INC: INC2 } = makeInc(1);
  INC2.mark(0, 'abandonedCar', '浅水弃车', { depth: 0.3 });
  for (let k = 0; k < 30; k++) {
    INC2.tick(0, 1, { x: 0, z: 0, depth: 0.3, speed: 1.2, indoor: false,
      sheltered: false, inVehicle: false, stamina: 80 });
  }
  check('浅水弃车不触发"站不住"（低于失稳深度）', INC2.row(0).stillSec === 0,
    `stillSec=${INC2.row(0).stillSec}`);
}

const bad = ok.filter((x) => !x).length;
console.log(`\n=== ${ok.length - bad}/${ok.length} 通过 ===`);
process.exit(bad ? 1 : 0);
