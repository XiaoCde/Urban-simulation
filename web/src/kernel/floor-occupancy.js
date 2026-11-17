/**
 * floor-occupancy.js — 把真实建筑清单 + 人的住址/岗位坐标，落成逐人楼层状态。
 * 内核层，纯数值，不碰 three/window/document。
 *
 * 这是「人进楼在几层、每层容纳多少、水深上来往哪层退」的完整内核实现。
 * 输入是真实建筑数据（web/assets/city/buildings.json，OSM，21,943 栋，
 * 带真实 height_m / function / area_m2 / center），由调用方读好后传进来，
 * 本模块不 import 资源文件，保持浏览器与纯 Node 都能跑。
 *
 * 数据来源与自设项见 kernel/floors.js 顶部与文末来源附录。
 */
import { floorsFromHeight, floorElevationM, capacityPerFloor, assignFloor,
  floodFloor, occupancyClass, floorHeightFor } from './floors.js';

/**
 * 建一个建筑空间索引（简单网格），用于把人按坐标就近分配到真实建筑。
 * @param {Array} buildings 建筑数组，元素含 center:[x,z], height_m, function, area_m2, id
 */
export function buildBuildingIndex(buildings, cellM = 200) {
  const grid = new Map();
  const key = (cx, cz) => `${cx},${cz}`;
  const all = [];
  for (const b of buildings) {
    const c = b && b.center;
    if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    // 【修 2026-11-17】assignFloor / capacityPerFloor 读的是 b.function，
    // 这里原来只存了 fn，导致离线评估把每栋楼都当成 'other'（层高 3.3、
    // 人均 46.8 m²），与运行时按真实功能取值不一致。两个字段都保留：
    // fn 供返回对象用，function 供内核函数用。
    const item = { id: b.id, name: b.name, fn: b.function, function: b.function,
      height_m: b.height_m, area_m2: b.area_m2, x: c[0], z: c[1],
      floorHeightM: floorHeightFor(b.function),
      // 层高按建筑功能取（办公 3.8／住宅 2.7／其他 3.3），不传 function 会用 3.3。
      floors: floorsFromHeight(b.height_m, null, b.function) };
    all.push(item);
    const cx = Math.floor(item.x / cellM), cz = Math.floor(item.z / cellM);
    const k = key(cx, cz);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(item);
  }
  /** 找 (x,z) 一定半径内最近的建筑；半径内没有就返回 null（人不在任何楼里）。 */
  function nearest(x, z, radiusM = 45) {
    const cx = Math.floor(x / cellM), cz = Math.floor(z / cellM);
    let best = null, bestD = radiusM * radiusM;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const arr = grid.get(key(cx + i, cz + j));
      if (!arr) continue;
      for (const b of arr) {
        const d = (b.x - x) ** 2 + (b.z - z) ** 2;
        if (d < bestD) { bestD = d; best = b; }
      }
    }
    return best;
  }
  return { nearest, buildings: all, count: all.length };
}

/**
 * 给一个人分配「家」或「岗位」的楼层。
 * @param {object} idx buildBuildingIndex 的返回
 * @param {number} x,z 这个人的住址 / 岗位坐标
 * @param {number} ordinalFallback 当建筑容量无法从真实门牌确定时的楼内序号
 * @param {'home'|'work'} kind 用途，只影响 default 功能档
 * @returns {object} {buildingId, buildingName, floors, floor, elevationM, indoor,
 *                    capacity, reason}
 */
export function assignPersonFloor(idx, x, z, ordinalFallback = 0, kind = 'home') {
  const b = idx.nearest(x, z);
  if (!b) {
    return { buildingId: null, buildingName: null, floors: 0, floor: 0,
      elevationM: 0, indoor: false, capacity: 0,
      reason: '住址/岗位附近没有匹配到真实建筑，判为室外' };
  }
  const ord = Math.max(0, Math.floor(Number(ordinalFallback) || 0));
  const a = assignFloor(b, ord);
  return { buildingId: b.id, buildingName: b.name, floors: b.floors,
    floor: a.floor, elevationM: a.elevationM, indoor: a.indoor,
    capacity: a.capacity, floorHeightM: a.floorHeightM,
    function: b.fn, kind, reason: a.reason };
}

/**
 * 一批人的楼层状态 + 楼内占用统计。同楼内按传入顺序分配层号（确定性）。
 * @param {object} idx buildBuildingIndex 的返回
 * @param {Array} people 元素含 x,z,kind(可选)
 * @returns {{people:Array, byBuilding:Map}}
 */
export function assignCohortFloors(idx, people) {
  const byBuilding = new Map();
  const out = [];
  for (let i = 0; i < people.length; i++) {
    const p = people[i] || {};
    const b = idx.nearest(p.x, p.z);
    if (!b) {
      out.push({ i, indoor: false, floor: 0, buildingId: null });
      continue;
    }
    const ord = byBuilding.get(b.id) || 0;
    byBuilding.set(b.id, ord + 1);
    const a = assignPersonFloor(idx, p.x, p.z, ord, p.kind || 'home');
    out.push({ i, ...a, buildingX: b.x, buildingZ: b.z });
  }
  return { people: out, byBuilding };
}

/**
 * 逐人楼层淹没推演：给每个已分楼层的人一个室外水深，算安全/上楼/遇险。
 * @param {Array} floorStates assignCohortFloors 的 people 数组
 * @param {(x,z)=>number} depthAt 建筑坐标处的水深
 * @returns {{counts:object, details:Array}}
 */
export function evaluateFloodOnFloors(floorStates, depthAt) {
  const counts = { outdoor: 0, safe: 0, moveUp: 0, drowning: 0 };
  const details = [];
  for (const s of floorStates) {
    if (!s || !s.indoor) { counts.outdoor++; continue; }
    const w = typeof depthAt === 'function' ? depthAt(s.buildingX, s.buildingZ) : 0;
    // 层高必须跟着建筑功能走（办公 3.8／住宅 2.7／其他 3.3）。不传就会退回
    // 默认 3.3，离线评估算出的楼层高程会与运行时 incidents.js 不一致。
    const r = floodFloor({ waterDepthM: w, currentFloor: s.floor,
      totalFloors: s.floors, floorHeightM: s.floorHeightM });
    counts[r.status] = (counts[r.status] || 0) + 1;
    details.push({ i: s.i, buildingId: s.buildingId, floor: s.floor,
      targetFloor: r.targetFloor, waterDepthM: w, status: r.status, reason: r.reason });
  }
  return { counts, details };
}
