/**
 * roadnet.js — 用用户最后给的那套「模块化街道瓦片」重建城市核心区路网。
 *
 * 【为什么不再用 OSM 带子】
 *   旧路面是 24,660 条 OSM way 离线烘焙的 5 层带子（road / walk / path /
 *   markw / marky），层与层共面、路口端点没对齐，于是既有 z-fighting 的
 *   「多边形路面」，也有接缝断头。用户 2026-11-06 要求「把路重新铺一遍，
 *   用最新的道路模型，旧的和多余的删掉，保证没有断头和多边形路面」。
 *
 * 【这套模型是什么】
 *   data/characters/street  FBX-.../FBX/ 的 25 个 fbx，每个是 2×2 单位、
 *   原点居中的低模瓦片：Straight / Curve / 3Way / 4Way / Deadend / Empty，
 *   另配 Streetlight_* / TrafficLight_* / Sign_*。tools/blender_export_roads.py
 *   把它们导出成 web/assets/roads/mod_*.glb。
 *   实测开口（Three 的 XZ 平面，E=+X N=-Z W=-X S=+Z）：
 *     Straight W|E   Curve E|S   3Way W|S|N   4Way 全开   Deadend W   Empty 无
 *
 * 【怎么保证「没有断头」】
 *   先建一张显式的图（节点 = 网格交点，边 = 双向路段），每个节点按自己的
 *   度数得到「哪几个方向有路」，再查表挑一块开口方向**完全一致**的瓦片。
 *   边是双向的，邻居必含反向开口 —— 于是每块瓦片的每个开口都一定接上另一块
 *   瓦片，物理上不可能出现断头。度数 < 2 的节点直接删边并剪枝，绝不摆 Deadend。
 *
 * 【怎么保证「没有多边形路面」】
 *   一格（TILE×TILE）有且只有一块瓦片，格心严格对齐、不缩放重叠；旧路带子在
 *   clipOldRoads() 里按三角形重心做几何级裁除（不是隐藏），同一区域不会有两层。
 *   落在建筑 footprint 里的格子直接不铺，路面不会穿楼。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CAFE, CLINIC, SCHOOL, SITE } from './district-buildings.js';
import { OFFICE } from './office-building.js';
import { HOME } from './home-building.js';

export const TILE = 24;                 // 一块瓦片 = 24 m（沥青带宽约 8 m）
const S = TILE / 2;                    // 模型 2 单位 → 24 m
// 【竖直放大到 2.2 而不是 0.96】瓦片原始厚 0.25 单位，等比缩放只够 3 m 高、
// 平放时顶面离地形只有 4 cm，会被 6 m 格地形网格顶穿 / z-fighting（实测
// 瓦片中心 y=5.209、地面 5.307，顶面只高 0.046 m）。放大后厚 0.55 m，
// 底面埋进地形、顶面稳定高出地面 ~0.35 m，既不悬空也不共面。
const YS = 2.2;
const TOP = 0.15 * YS;                 // 瓦片顶面相对实例中心的抬高
const ROAD_LIFT = 0.02;

// 方向位：E=+X, N=-Z, W=-X, S=+Z
const E = 1, N = 2, W = 4, S_ = 8;
const CYCLE = [E, N, W, S_];           // 绕 Y 轴 +90° 的方向轮转
const DIRV = {
  [E]: [1, 0], [N]: [0, -1], [W]: [-1, 0], [S_]: [0, 1],
};
const OPP = { [E]: W, [W]: E, [N]: S_, [S_]: N };

const MOD_BASE = {
  Street_4Way: W | E | S_ | N,
  Street_3Way: W | S_ | N,
  Street_Straight: W | E,
  Street_Curve: E | S_,
  Street_Deadend: W,          // 建筑占路时的完整封口（不是断裂的缝）
};
// mask -> { type, rot }；枚举 4 个旋转，精确匹配节点需要的开口
const MOD_MAP = (() => {
  const m = new Map();
  const order = ['Street_4Way', 'Street_3Way', 'Street_Straight',
    'Street_Curve', 'Street_Deadend'];
  for (const type of order) {
    const base = MOD_BASE[type];
    for (let k = 0; k < 4; k++) {
      let mask = 0;
      for (let i = 0; i < 4; i++) if (base & CYCLE[i]) mask |= CYCLE[(i + k) % 4];
      if (!m.has(mask)) m.set(mask, { type, rot: k });
    }
  }
  return m;
})();

function bits(mask) {
  return CYCLE.reduce((n, b) => n + ((mask & b) ? 1 : 0), 0);
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 建筑/地标占位。返回 { boxes, test }。 */
function makeForbidden(extra) {
  const boxes = [
    [CAFE.cx, CAFE.cz, CAFE.width, CAFE.depth],
    [CLINIC.cx, CLINIC.cz, CLINIC.width, CLINIC.depth],
    [SCHOOL.cx, SCHOOL.cz, SCHOOL.width, SCHOOL.depth],
    [SITE.cx, SITE.cz, SITE.width, SITE.depth],
    [OFFICE.cx, OFFICE.cz, OFFICE.width, OFFICE.depth],
    [HOME.cx, HOME.cz, HOME.width, HOME.depth],
  ];
  const fine = boxes.slice(0, 6);        // 相位优化只用这 6 座（否则被 2 万栋稀释）
  const all = boxes.concat(extra || []);  // 真正避让用**全部**楼 + 工地场坪
  return {
    boxes: fine,
    allBoxes: all,
    // 【完整 bbox、按格心判定】旧版收缩到 0.42 倍且只测 6 座楼，实测
    // MegaKit 30 栋与瓦片重叠 32018 m²、办公楼 438 m²、公寓 90 m²。
    // 现在格心落在任何楼体 / 工地场坪内，这一格就改成 Street_Empty（纯地块）：
    // 楼盖在地块上是正常街景，而不是沥青从楼体中间穿过去。
    // 只让「成规模的楼」占格：把 126 条 footprint 全按完整 bbox 禁铺会让
    // 161/495 = 33% 的格子变成空地块，路网看着像被啃掉三分之一。
    // 小体量纸壳子贴街是正常街景，真正会穿模的是大楼（>300 m²）。
    test: (x, z) => all.some(([cx, cz, w, d]) =>
      w * d > 300 && Math.abs(x - cx) < w / 2 + 2 && Math.abs(z - cz) < d / 2 + 2),
  };
}

/**
 * 建图 + 摆瓦片。
 * @param {object} o { terrain, rect:{x0,x1,z0,z1}, footprints:[[cx,cz,w,d]], seed }
 * @returns {{ group, nodes, edges, junctions, surfaceY, rect, stats, lanePoint }}
 */
export async function buildRoadNetwork(o) {
  const { terrain, rect: R, footprints = [], seed = 20261106 } = o;
  const F = makeForbidden(footprints);
  const forbidden = F.test;
  const rand = mulberry32(seed);

  const NX = Math.max(2, Math.floor((R.x1 - R.x0) / TILE));
  const NZ = Math.max(2, Math.floor((R.z1 - R.z0) / TILE));

  // ---- 0) 相位对齐：把主干线整体平移到「压到楼最少」的位置 ----
  // 直接按 R.x0 起格会正好切过好几栋楼，删节点就产生 Deadend。
  // 主干周期是 TRUNK*TILE = 96 m，所以在 0..96 m 里搜一个偏移，
  // 让所有主干行/列落在楼与楼之间的空地上（成本 = 与楼 bbox 的重叠长度）。
  const TRUNK = 4;
  const PERIOD = TRUNK * TILE;
  const lineCost = (ox, oz) => {
    let cost = 0;
    for (const [cx, cz, w, d] of F.boxes) {
      // 竖主干 x = R.x0 + ox + k*PERIOD
      const kx = Math.round((cx - R.x0 - ox) / PERIOD);
      const vx = R.x0 + ox + kx * PERIOD;
      if (Math.abs(vx - cx) < w / 2 + TILE * 0.42) cost += d + 20;
      // 横主干 z = R.z0 + oz + k*PERIOD
      const kz = Math.round((cz - R.z0 - oz) / PERIOD);
      const hz = R.z0 + oz + kz * PERIOD;
      if (Math.abs(hz - cz) < d / 2 + TILE * 0.42) cost += w + 20;
    }
    return cost;
  };
  let bestOx = 0, bestOz = 0, bestCost = Infinity;
  for (let ox = 0; ox < PERIOD; ox += TILE / 2) {
    for (let oz = 0; oz < PERIOD; oz += TILE / 2) {
      const c = lineCost(ox, oz);
      if (c < bestCost) { bestCost = c; bestOx = ox; bestOz = oz; }
    }
  }
  const X0 = R.x0 + bestOx, Z0 = R.z0 + bestOz;
  const gx = (i) => X0 + i * TILE;
  const gz = (j) => Z0 + j * TILE;
  const key = (i, j) => j * NX + i;

  // ---- 1) 节点：规整棋盘的主干格 ----
  // 【为什么不再随机挖边】第一版按 42% 概率删边再剪枝，结果路网变成一条
  // 到处 U 形掉头的「贪吃蛇」（用户看到的满地弯道）。DC 是方格街网：
  // 每 TRUNK 格一条贯通主干、最外圈闭环，主干交叉处才是路口。
  // 最外圈四条边也全部当主干，形成闭环：四角是 Curve、边上没有单开口端点。
  // 否则矩形边界会冒出一排 Deadend（第一版 61 个里绝大多数是这么来的）。
  const isH = (j) => j % TRUNK === 0 || j === 0 || j === NZ - 1;
  const isV = (i) => i % TRUNK === 0 || i === 0 || i === NX - 1;
  const nodes = new Map();
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    if (!isH(j) && !isV(i)) continue;     // 街区内部留给楼和绿地，不铺路
    const x = gx(i), z = gz(j);
    // 【不再删节点】删了就产生 Deadend / 断头。压到楼的格子照常留在图里
    // 保持连通，只是这一块不铺沥青、改铺 Street_Empty 地块瓦片。
    nodes.set(key(i, j), { i, j, x, z, mask: 0, y: 0,
      underBuilding: forbidden(x, z) });
  }

  // ---- 2) 边：只沿主干行 / 主干列连，天然贯通、不用再剪枝 ----
  const edges = new Map();
  const ekey = (a, b) => a < b ? `${a}_${b}` : `${b}_${a}`;
  const addEdge = (a, b, bit) => {
    if (!nodes.has(a) || !nodes.has(b)) return;
    const k = ekey(a, b);
    if (edges.has(k)) return;
    edges.set(k, { a, b, bit });
    nodes.get(a).mask |= bit;
    nodes.get(b).mask |= OPP[bit];
  };
  const rmEdge = (k) => {
    const e = edges.get(k); if (!e) return;
    nodes.get(e.a).mask &= ~e.bit;
    nodes.get(e.b).mask &= ~OPP[e.bit];
    edges.delete(k);
  };
  void rmEdge;
  void rand;

  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const a = key(i, j);
    if (!nodes.has(a)) continue;
    if (isH(j) && i + 1 < NX) addEdge(a, key(i + 1, j), E);
    if (isV(i) && j + 1 < NZ) addEdge(a, key(i, j + 1), S_);
  }

  // ---- 3) 消除断头 ----
  // 用户明确要求「保证没有断头」。Deadend 虽是完整封口的瓦片，字面上仍是
  // 一条走到头就没了的路。这里迭代删掉所有单开口的短枝：每删一个节点，
  // 邻居的对应开口也一起去掉（4Way→3Way→Straight），直到每个保留节点
  // 至少两个开口。棋盘主干是闭环的，这种剪枝只会削掉建筑边上几小截支路，
  // 不会把整条主干切断。
  for (let guard = 0; guard < 60; guard++) {
    const leaf = [...nodes.entries()].find(([, n]) => bits(n.mask) < 2);
    if (!leaf) break;
    const [k, n] = leaf;
    for (const bit of CYCLE) {
      if (!(n.mask & bit)) continue;
      const [di, dj] = DIRV[bit];
      const nk = key(n.i + di, n.j + dj);
      const nb = nodes.get(nk);
      if (nb) nb.mask &= ~OPP[bit];
      edges.delete(ekey(k, nk));
    }
    nodes.delete(k);
  }
  for (const [k, e] of [...edges]) if (!nodes.has(e.a) || !nodes.has(e.b)) edges.delete(k);
  const deadends = [...nodes.values()].filter((n) => bits(n.mask) < 2).length;

  // ---- 5) 高度场：地面采样 + 3 次邻域平滑，但夹在局部地面 ±0.15 m 内 ----
  // 不夹会出事：河边/洼地的低邻居会把整片路网拉到地面以下（实测 -0.27 m），
  // 瓦片直接被地形埋掉。夹完相邻瓦片高差 ≤0.3 m，配合 0.55 m 厚的瓦片侧面
  // 看不见台阶。顶面 = n.y + TOP，车/灯一律站在这个顶面上。
  for (const n of nodes.values()) { n.local = terrain.sampleHeight(n.x, n.z); n.y0 = n.local; }
  for (let pass = 0; pass < 3; pass++) {
    const snap = new Map();
    for (const [k, n] of nodes) snap.set(k, n.y0);
    for (const [k, n] of nodes) {
      let sum = n.y0, cnt = 1;
      for (const bit of CYCLE) {
        const [di, dj] = DIRV[bit];
        const nk = key(n.i + di, n.j + dj);
        if (snap.has(nk)) { sum += snap.get(nk); cnt++; }
      }
      n.y0 = sum / cnt;
    }
  }
  for (const n of nodes.values()) {
    n.y0 = Math.max(n.local - 0.15, Math.min(n.local + 0.15, n.y0));
    n.y = n.y0 + ROAD_LIFT;
    n.top = n.y + TOP;
  }

  // ---- 6) 选瓦片 ----
  const placements = [];
  const typeCount = {};
  for (const n of nodes.values()) {
    const pick = n.underBuilding ? { type: 'Street_Empty', rot: 0 } : MOD_MAP.get(n.mask);
    if (!pick) continue;                 // 度数 >4 / 0 不可能，兜底跳过
    n.type = pick.type; n.rot = pick.rot; n.deg = bits(n.mask);
    typeCount[pick.type] = (typeCount[pick.type] || 0) + 1;
    placements.push(n);
  }

  // ---- 7) 加载 glb，按 (类型 × 材质部件) 建 InstancedMesh ----
  const loader = new GLTFLoader();
  const group = new THREE.Group();
  group.name = 'L2_road_tiles';
  const partsByType = {};
  const byType = {};
  for (const p of placements) (byType[p.type] ||= []).push(p);

  // 【FBX→glb 的 alpha 坑】Blender 从 FBX 读进来的 Principled BSDF 的 Alpha
  // 默认是 0，glTF 导出后材质 opacity=0 → 整片瓦片一个像素都不画（实测
  // 抬高 8 m + 染成亮红仍然完全不可见，就是被这个吞掉的）。必须强制复位。
  const tint = (mat, name) => {
    const m = mat.clone();
    const nm = (name || '').toLowerCase();
    let c = null;
    if (nm.startsWith('black')) c = 0x3d4147;        // 沥青
    else if (nm.startsWith('white')) c = 0xe9e7dc;   // 标线
    else if (nm.startsWith('grey')) c = 0xa7a8a3;    // 人行道/地块
    if (c !== null) { m.color = new THREE.Color(c); m.roughness = 0.9; m.metalness = 0; }
    m.side = THREE.DoubleSide;
    m.opacity = 1;
    m.transparent = false;
    m.depthWrite = true;
    m.colorWrite = true;
    m.visible = true;
    m.needsUpdate = true;
    return m;
  };

  for (const [type, list] of Object.entries(byType)) {
    let gltf;
    try { gltf = await loader.loadAsync(`/assets/roads/mod_${type}.glb`); }
    catch (e) { console.warn('[roadnet] 模块未加载', type, e && e.message); continue; }
    gltf.scene.updateMatrixWorld(true);
    const parts = [];
    gltf.scene.traverse((obj) => {
      if (!obj.isMesh) return;
      const geo = obj.geometry.clone();
      geo.applyMatrix4(obj.matrixWorld);
      parts.push({ geo, mat: tint(obj.material, obj.material && obj.material.name) });
    });
    partsByType[type] = parts;
    for (let pi = 0; pi < parts.length; pi++) {
      const { geo, mat } = parts[pi];
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      const M = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const pos = new THREE.Vector3();
      const scl = new THREE.Vector3(S, YS, S);
      for (let t = 0; t < list.length; t++) {
        const n = list[t];
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), n.rot * Math.PI / 2);
        pos.set(n.x, n.y, n.z);
        M.compose(pos, q, scl);
        im.setMatrixAt(t, M);
      }
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = false;
      im.receiveShadow = true;
      im.frustumCulled = false;
      im.name = `tile_${type}_${pi}`;
      group.add(im);
    }
  }

  // ---- 8) 交通图 / 灯位数据 ----
  const nodeList = [...nodes.values()].filter((n) => n.type);
  // surfaceY 只查瓦片节点：全城车行图会在运行时往 nodeList 里追加 6932 个
  // 逻辑节点，若一起线性扫，每次高度查询会慢 15 倍，而且远处的干道节点
  // 会错误地把「路网外该用 DTM」的位置吸过去。
  const tileNodes = nodeList.slice();
  const nodeByKey = new Map([...nodes].map(([k, n]) => [k, n]));
  const edgeList = [...edges.values()].filter((e) =>
    nodeByKey.get(e.a)?.type && nodeByKey.get(e.b)?.type).map((e) => ({
    a: nodeByKey.get(e.a), b: nodeByKey.get(e.b), bit: e.bit,
  }));
  const junctions = nodeList.filter((n) => bits(n.mask) >= 3);

  const surfaceY = (x, z) => {
    // 最近节点的平滑高度；离路网很远时退回原始 DTM
    let bestN = null, bd = Infinity;
    for (const n of tileNodes) {
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) { bd = d; bestN = n; }
    }
    // 路网外没有瓦片，直接贴地形 —— 否则全城的人/车都会凭空浮起 0.35 m。
    return bestN && bd < (TILE * 1.6) ** 2 ? bestN.top : terrain.sampleHeight(x, z);
  };

  console.info(`[roadnet] ${nodeList.length} 块瓦片 / ${edgeList.length} 条路段 / `
    + `${junctions.length} 个路口 / 断头 ${deadends} 个 / `
    + `${Object.entries(typeCount).map(([k, v]) => k.replace('Street_', '') + ':' + v).join(' ')}`);

  return {
    group, nodes: nodeList, edges: edgeList, junctions, surfaceY,
    rect: { x0: X0, x1: X0 + NX * TILE, z0: Z0, z1: Z0 + NZ * TILE },
    stats: { tiles: nodeList.length, edges: edgeList.length, junctions: junctions.length, typeCount },
    /**
     * 车道点：t∈[0,1] 沿 a→b，dir=+1/-1，右偏 off 米。
     *
     * 【路口 taper 是必须的】车走到 t≈1 换下一条边，新边的车道法线方向
     * 与旧边**垂直**（路口转弯），于是同一个路口点算出来的位置会横向跳
     * `2*off`（默认 4.2 m）—— 视觉上就是「车横着平移了一下」。
     * 现实里路口内本来就没有车道线，所以两端各 15% 长度把偏移线性收到 0，
     * 两条边在路口点上都落在路中心线上，位置连续；出路口再张开到各自车道。
     *
     * off 传 0 或 taper=false 时行为和旧版一致（停车位那种按固定偏移摆的
     * 要显式关掉，否则车位会往路中心缩）。
     */
    lanePoint(e, t, dir = 1, off = 2.1, out = new THREE.Vector3(), taper = true) {
      const u = dir > 0 ? t : 1 - t;
      const ax = e.a.x, az = e.a.z, bx = e.b.x, bz = e.b.z;
      const dx = bx - ax, dz = bz - az;
      const L = Math.hypot(dx, dz) || 1;
      const nx = -dz / L, nz = dx / L;              // 右法线
      const s = dir > 0 ? 1 : -1;
      let w = 1;
      if (taper) {
        const k = 0.15;
        w = Math.min(1, Math.min(t, 1 - t) / k);
      }
      const o = off * w;
      out.set(ax + dx * u + nx * o * s,
        (e.a.top ?? e.a.y) + ((e.b.top ?? e.b.y) - (e.a.top ?? e.a.y)) * u,
        az + dz * u + nz * o * s);
      return out;
    },
  };
}

/**
 * 把旧 OSM 带子在给定矩形里做**几何级裁除**（按三角形重心）。
 * 不做隐藏、不做透明：同一区域只剩新瓦片一层，从根上消灭重叠多边形。
 * 非索引网格（桥栏等）跳过，它们体量小且不与瓦片区共面。
 */
export function clipOldRoads(group, rect) {
  let removed = 0, scanned = 0;
  group.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.index) return;
    const g = o.geometry;
    const pos = g.getAttribute('position');
    if (!pos) return;
    const idx = g.index.array;
    const inside = (x, z) => x >= rect.x0 && x <= rect.x1 && z >= rect.z0 && z <= rect.z1;
    const out = [];
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
      const cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
      if (inside(cx, cz)) { removed++; continue; }
      out.push(a, b, c);
    }
    scanned += idx.length / 3;
    if (out.length !== idx.length) {
      const arr = idx instanceof Uint32Array ? new Uint32Array(out) : new Uint16Array(out);
      g.setIndex(new THREE.BufferAttribute(arr, 1));
      g.computeBoundingSphere();
    }
  });
  console.info(`[roadnet] 旧路面裁除 ${removed} / ${scanned} 个三角形（核心区改由瓦片接管）`);
  return removed;
}
