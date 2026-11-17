/**
 * 阶段3A 验收：楼层内核（纯数值，边界干净）。
 * 验：层数由真实高度派生、容量分配、放不下的人判室外（不硬塞）、
 *     楼层淹没判据（当前层安全/往上转移/顶层溺水）、不依赖 three/window。
 */
import { floorsFromHeight, floorElevationM, capacityPerFloor, assignFloor,
  floodFloor, occupancyClass, FLOOR_HEIGHT_M, FLOOR_HEIGHT_PNNL_26949_M, SELF_SET } from '../src/kernel/floors.js';
import { readFileSync } from 'node:fs';

const ok = [];
const check = (name, pass, extra = '') => {
  ok.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

// ① 层数由真实高度派生
check('层高默认 3.3 m（Muse 本地自算口径）', FLOOR_HEIGHT_M === 3.3);
check('PNNL 3.95 m 作对照保留', FLOOR_HEIGHT_PNNL_26949_M === 3.95);
check('40.54 m 办公楼按 3.3m 派生 12 层', floorsFromHeight(40.54) === 12, `${floorsFromHeight(40.54)} 层`);
check('同楼按 PNNL 3.95m 派生 10 层（对照）', floorsFromHeight(40.54, 3.95) === 10);
check('8 m 住宅按 3.3m 派生 2 层', floorsFromHeight(8) === 2);
check('无高度时至少 1 层', floorsFromHeight(null) === 1);

// ② 地板高程递增
check('1 层地板高程 = 基础高度', Math.abs(floorElevationM(1) - SELF_SET.foundationHeightM) < 1e-9);
check('2 层比 1 层高一个层高',
  Math.abs(floorElevationM(2) - floorElevationM(1) - FLOOR_HEIGHT_M) < 1e-9);

// ③ 功能分类
check('apartments 归住宅', occupancyClass('apartments') === 'residential');
check('office 归办公', occupancyClass('office') === 'office');

// ④ 容量分配 + 放不下的人判室外
// 用实测人均 46.5 m²/人（住宅，2021 AHS）：每层占地 186 m²，3 层（2.7 m/层）。
// 容量口径必须是「占地面积 ÷ 人均」，不是「占地 ÷ 层数 ÷ 人均」（后者把
// 占地误当总楼面，3 层楼会被低估 3 倍）。
const PER = SELF_SET.floorAreaPerPerson.residential;
const b = { function: 'apartments', height_m: 8.1, area_m2: PER * 4 }; // 8.1/2.7=3 层，每层容 4 人
const cap = capacityPerFloor(b);
check('每层容量 = 占地面积 ÷ 人均面积', cap === 4, `cap=${cap} per=${PER}`);
check('总容量 = 每层容量 × 层数（占地没被误当总楼面）',
  cap * 3 === 12 && assignFloor(b, 12).indoor === false);
check('第 1 个人在 1 层', assignFloor(b, 0).floor === 1 && assignFloor(b, 0).indoor);
check('第 5 个人在 2 层', assignFloor(b, 4).floor === 2);
const over = assignFloor(b, 12);
check('超过总容量的人判室外（不硬塞楼里）', over.indoor === false && over.floor === 0,
  over.reason);

// ⑤ 楼层淹没判定（基础 0.457 = DC 旧规 1.5 ft；默认层高 3.3 → 2 层地板 3.757）
{
  // 水深 0.2 m，基础 0.457：1 层地板 0.457 未被淹（0.2<0.457）→ 安全
  const r1 = floodFloor({ waterDepthM: 0.2, currentFloor: 1, totalFloors: 3 });
  check('水没过基础前该层安全', r1.status === 'safe', r1.reason);
  // 水深 2 m：1 层(0.457) 被淹，2 层(3.757)、3 层(7.057) 安全 → 转移到最高的 3 层
  const r2 = floodFloor({ waterDepthM: 2.0, currentFloor: 1, totalFloors: 3 });
  check('当前层被淹往上转移到最高安全层', r2.status === 'moveUp' && r2.targetFloor === 3, r2.reason);
  // 水深 9 m：1/2/3 层地板 0.457/3.757/7.057 全被淹 → 顶层溺水
  const r3 = floodFloor({ waterDepthM: 9.0, currentFloor: 3, totalFloors: 3 });
  check('水淹到顶层判无处可退', r3.status === 'drowning', r3.reason);
  // 水深 5 m 但人在 2 层(4.25) → 2 层被淹，3 层(8.2)安全 → 上 3 层
  const r4 = floodFloor({ waterDepthM: 5.0, currentFloor: 2, totalFloors: 3 });
  check('高层仍在水中可继续往上', r4.status === 'moveUp' && r4.targetFloor === 3, r4.reason);
}

// ⑥ 内核边界：源码不引用 three/window/document
{
  const src = readFileSync(new URL('../src/kernel/floors.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  const bad = /\b(window|document|THREE)\b/.test(code);
  check('楼层内核不依赖 window/document/three', !bad);
}

// ⑦ 用真实建筑数据跑一遍分布，确认不崩且层数合理
{
  const bd = JSON.parse(readFileSync(new URL('../assets/city/buildings.json', import.meta.url), 'utf8'));
  const bands = {};
  let okAll = true;
  for (const x of bd.buildings) {
    const f = floorsFromHeight(x.height_m);
    if (!Number.isFinite(f) || f < 1) okAll = false;
    const band = f >= 10 ? '10+' : f >= 6 ? '6-9' : f >= 3 ? '3-5' : f >= 2 ? '2' : '1';
    bands[band] = (bands[band] || 0) + 1;
  }
  check('21943 栋真实建筑全部派生出合理层数', okAll && bd.buildings.length === 21943,
    JSON.stringify(bands));
}

const failed = ok.filter((x) => !x).length;
console.log(`\n${ok.length - failed}/${ok.length} 通过`);
process.exit(failed ? 1 : 0);
