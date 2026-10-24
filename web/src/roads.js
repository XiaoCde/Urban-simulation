/**
 * L2_road —— 真实道路、标线、路缘人行道与跨河桥。
 *
 * 数据来源：`data/streets/dc_streets.json`（OSM 24,660 条 way，来自
 * out/dc_real3_clean.blend 的 CURVE 图层），由 tools/terrain/export_web_roads.py
 * 沿每条 way 按剖面半宽 extrude 成带子，导出为：
 *   assets/roads/road.mesh   车行道
 *   assets/roads/walk.mesh   路缘石 + 人行道（每条车行道两侧各 1.8 m）
 *   assets/roads/path.mesh   步道 / 台阶 / 自行车道
 *   assets/roads/marky.mesh  中心双黄线
 *   assets/roads/markw.mesh  两侧白边线
 *   assets/roads/*.idx       索引
 *   assets/roads/roads.json  顶点/三角数与贴图 tile
 *
 * 顶点布局 stride = 5 个 float：[x, y(占位 0), z, u, v]
 *   —— Python 端不知道地形，y 一律写 0；**高程必须在这里按 DTM 采样补上**。
 *   —— u = 沿路累积长度 / tile_m，v = 横向 0 .. 2*half_w / tile_m。
 *
 * 【桥】这一层最容易被看出破绽的是跨河：way 是贴着地表画的，波托马克河床
 *   被挖到 -6 m，不处理的话桥面要么沉到河里、要么贴在水面上变成「河中间一条线」。
 *   所以按 landcover 判定水面，跨河段抬成真实桥面（水面 + 6 m），两侧加坡堤
 *   引道、桥面护栏，桥下按跨度下桥墩。这一套全部是程序化的，不需要外部桥梁数据。
 */

import * as THREE from 'three';
import { ribbonMesh } from './roadmesh.js';

const STRIDE = 6;

/** 读一条带子的二进制 + 索引。长度必须精确校验（防 Chrome 把扩展名拦成 204）。 */
async function loadRibbon(base, key, meta) {
  const [mv, mi] = await Promise.all([
    fetch(base + key + '.mesh'),
    fetch(base + key + '.idx'),
  ]);
  if (!mv.ok || !mi.ok) throw new Error(`${key} 取回失败 ${mv.status}/${mi.status}`);

  const vb = await mv.arrayBuffer();
  const ib = await mi.arrayBuffer();
  const wantV = meta.verts * STRIDE * 4;
  const wantI = meta.tris * 3 * 4;
  if (vb.byteLength !== wantV) {
    throw new Error(`${key}.mesh 长度 ${vb.byteLength} != ${wantV}`);
  }
  if (ib.byteLength !== wantI) {
    throw new Error(`${key}.idx 长度 ${ib.byteLength} != ${wantI}`);
  }
  return { verts: new Float32Array(vb), idx: new Uint32Array(ib), nv: meta.verts };
}

/**
 * @returns {{road,path,walk,marky,markw,tile,walk_w}}
 */
export async function loadRoads(base = 'assets/roads/') {
  const meta = await (await fetch(base + 'roads.json')).json();
  const pick = (k) => (meta.count[k] ? loadRibbon(base, k, meta.count[k]) : Promise.resolve(null));
  const [road, path, walk, marky, markw] = await Promise.all([
    pick('road'), pick('path'), pick('walk'), pick('marky'), pick('markw'),
  ]);
  const n = (r) => (r ? r.idx.length / 3 : 0);
  console.log(`[roads] 车行道 ${n(road)} 三角, 路缘人行道 ${n(walk)} 三角`
    + `, 步道 ${n(path)} 三角, 标线 黄 ${n(marky)} / 白 ${n(markw)} 三角`);
  return { road, path, walk, marky, markw, tile: meta.tile_m, walk_w: meta.walk_w_m || 1.8 };
}

// ---------------------------------------------------------------- 桥
// 桥面高程：**跟着两岸路面走**，不是固定 +9 m。
// 早期版本把跨河段一律抬到 waterY+9，等于给每座桥都加了 9 m 净空：
// 岸上只有 2~3 m 高的路要在 6 个横断面（20~40 m）内爬升 7 m —— 会冒出
// 一道直上直下的尖坡，桥面本身也像悬在半空的板。用户说的「桥很离谱」
// 主要就是这个。DC 的实际情况：Memorial Bridge / Key Bridge 的桥面都只比
// 江面高 3~4 m，与两岸街道基本齐平（真正高净空的只有 11th St / Douglass）。
const DECK_MIN_CLEAR = 2.4;  // 桥面至少高出正常水面多少（米）
const DECK_ABOVE_BANK = 0.55; // 桥面比两岸路面高多少（米）
const DECK_CROWN = 0.7;      // 长桥中央的起拱量（米）
const RAMP_PAIRS = 10;       // 引道渐变占多少个横断面（≈ 40~60 m）
const RAIL_H = 1.15;      // 护栏高
const PIER_EVERY = 7;     // 每隔多少个横断面下一道桥墩

/**
 * 把一条带子抬到地形上并生成 mesh。
 *
 * 高程规则（每横断面共用一个 y，路面在横断面上必须水平）：
 *   land : y = max(横断面 7 点采样) + 0.16
 *   water: y = 水面 + 6.0（真实桥面）
 *   引道 : 岸边 RAMP_PAIRS 个断面内从地面线性抬到桥面
 *
 * @param {{verts:Float32Array, idx:Uint32Array, nv:number}} rb
 * @param {object|null} T  loadTerrain() 的返回
 * @param {THREE.Material} mat
 * @param {string} name
 * @param {number} waterY 正常水位（NAVD88 米）
 * @param {number} extraLift 额外抬升
 * @param {THREE.Material|null} railMat 桥栏/桥墩材质（null = 不建桥附件）
 * @returns {{mesh:THREE.Mesh, bridges:object}}
 */
function ribbonMeshLegacy(rb, T, mat, name, waterY = 0.046, extraLift = 0, railMat = null, W = null, opt = {}) {
  const { verts: src, idx, nv } = rb;
  const pos = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const pairs = Math.floor(nv / 2);

  const LIFT = 0.16;
  // 纵向取样半径。车行道取 1.7 m；标线必须取更大值（见 markY 的说明），
  // 否则标线会比路面低半个坡度差，被路面整块盖住。
  const OFF = opt.yPad || 1.7;
  const CROSS = 7;
  const OVER = 0.10;
  const yOf = T ? (x, z) => {
    let m = T.sampleHeight(x, z);
    const a = T.sampleHeight(x + OFF, z), b = T.sampleHeight(x - OFF, z);
    const c = T.sampleHeight(x, z + OFF), d = T.sampleHeight(x, z - OFF);
    if (a > m) m = a; if (b > m) m = b; if (c > m) m = c; if (d > m) m = d;
    return m;
  } : () => 0;

  // ---- 第一遍：地面高程 + 水面标记
  const gy = new Float32Array(pairs);
  const over = new Uint8Array(pairs);
  for (let i = 0; i < pairs; i++) {
    const s0 = i * 2 * STRIDE, s1 = (i * 2 + 1) * STRIDE;
    const x0 = src[s0], z0 = src[s0 + 2];
    const x1 = src[s1], z1 = src[s1 + 2];
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    // 【路面高程只看中心线，不看带宽】OSM 是逐 way 的折线，交叉口会有 2~4 条
    // way 叠在同一块地面上。旧版按各自带宽取「本横断面 7 点最大」，结果路口处
    // 每条 way 得到不同的高度，互相错开几厘米——渲染出来就是一条条交叠的补丁，
    // 也就是用户说的「路重重叠叠，很奇怪的样式」。
    // 现在统一按**中心线 ±3.2 m 的最大高程**取值，再量化到 5 cm：
    // 任何两条 way 在同一位置必然得到同一高度，叠在一起就是一块平整的路面。
    const RPAD = 3.2;
    const m = Math.round(
      Math.max(T ? T.sampleHeight(cx, cz) : 0,
        T ? T.sampleHeight(cx + RPAD, cz) : 0,
        T ? T.sampleHeight(cx - RPAD, cz) : 0,
        T ? T.sampleHeight(cx, cz + RPAD) : 0,
        T ? T.sampleHeight(cx, cz - RPAD) : 0) * 20) / 20;
    gy[i] = m + LIFT + extraLift;
    // 【水面判据】不能用 T.classify：DCGIS 的 Impervious 图层把**桥面本身**
    // 也当成 Road 铺装画进去了，于是桥正上方的 landcover 是 class 2 不是 0，
    // 拿 classify 判水面会在真正需要架桥的地方全部漏掉（实测桥面掉到 -5 m，
    // 沉在河床里）。改用水体栅格 bed.i16：只有落在水体多边形内部才有值。
    // 水面判据 = 「在某个水体多边形内」 且 「原地形（未挖之前的 DTM）低于水面」。
    // 第二个条件必不可少：水体多边形经过平滑外扩，会把河岸/堤岸道路也吞进去，
    // 只判多边形会让沿岸道路整段被当成桥抬到 9 m，长出一条假高架。
    // 注意 T.sampleHeight 读的是原始 DTM 数组（excavateTerrain 只改 mesh 顶点，
    // 不改 heights 数组），所以这里拿到的是挖之前的真实地面高程。
    let wet = false;
    if (W) wet = W.sampleBed(cx, cz) !== null;
    else if (T) wet = T.classify(cx, cz) === 0;
    const hDem = T ? T.sampleHeight(cx, cz) : -5;
    over[i] = (wet && hDem < waterY + 0.35) ? 1 : 0;
  }

  // ---- 第二遍：跨河段抬桥面 + 两端引道渐变
  //
  // 只看「这一段在水上」是不够的：沿河岸平行走的道路（河滨快速路、堤岸道路）
  // 也会整段落在水体多边形里，如果一律按桥抬到 9 m，就会沿岸线长出一条
  // 假的架空高架。真正的桥一定满足：**两端都回到陆地上**，且跨越长度有限。
  // 所以先把 over 切成连续段，逐段判定 bridge / shore：
  //   bridge : 两端都是陆地，段长 <= MAX_BRIDGE_PAIRS  → 抬到 waterY+9，配桥墩护栏
  //   shore  : 其余（沿岸长段 / 一端进水）            → 只抬 waterY+1.4，当低水位堤岸路
  const MAX_BRIDGE_PAIRS = 520;   // ≈ 2 km（横断面间距 1~4 m）
  const deckLow = waterY + 1.4 + extraLift;
  const isBridge = new Uint8Array(pairs);
  const isShore = new Uint8Array(pairs);
  // 每个断面自己的桥面高程（逐桥算，不再是一个常量）
  const deckAt = new Float32Array(pairs);
  for (let i = 0; i < pairs;) {
    if (!over[i]) { i++; continue; }
    let j = i;
    while (j < pairs && over[j]) j++;
    const landed = (i > 0) && (j < pairs);
    const len = j - i;
    if (landed && len <= MAX_BRIDGE_PAIRS) {
      // 桥面高程 = 两端引道地面高的较大者 + 0.55，且至少高过水面 2.4 m；
      // 跨度越长中间起拱越多（真实桥都有纵坡，平直反而假）。
      const gEnd = Math.max(
        i > 0 ? gy[i - 1] : gy[i],
        j < pairs ? gy[j] : gy[j - 1]);
      const base = Math.max(gEnd + DECK_ABOVE_BANK, waterY + DECK_MIN_CLEAR) + extraLift;
      const crown = Math.min(DECK_CROWN, len * 0.02);
      for (let k = i; k < j; k++) {
        isBridge[k] = 1;
        const u = (k - i + 0.5) / len;             // 0..1 沿桥
        deckAt[k] = base + crown * Math.sin(Math.PI * u);
      }
    } else {
      for (let k = i; k < j; k++) isShore[k] = 1;
    }
    i = j;
  }

  const by = new Float32Array(pairs);
  for (let i = 0; i < pairs; i++) {
    by[i] = isBridge[i] ? deckAt[i] : (isShore[i] ? Math.max(gy[i], deckLow) : gy[i]);
  }
  // ---- 标线吸附：把标线钉在已建好的路面上（见 makeRoadSurf 的注释）
  if (opt.snap) {
    let hit = 0, miss = 0;
    for (let i = 0; i < pairs; i++) {
      const s0 = i * 2 * STRIDE, s1 = (i * 2 + 1) * STRIDE;
      const cx = (src[s0] + src[s1]) / 2, cz = (src[s0 + 2] + src[s1 + 2]) / 2;
      const y = opt.snap(cx, cz);
      if (y === null) { miss++; } else { by[i] = y + (opt.snapLift || 0.012); hit++; }
    }
    console.log(`[roads] ${name} 吸附路面 ${hit}/${pairs}（未命中 ${miss}）`);
  }

  for (let i = 0; i < pairs; i++) {
    if (isBridge[i] || isShore[i]) continue;
    // 找最近的跨河断面
    let d = 999;
    for (let k = 1; k <= RAMP_PAIRS + 1 && d > k; k++) {
      if (i - k >= 0 && isBridge[i - k]) { d = k; break; }
      if (i + k < pairs && isBridge[i + k]) { d = k; break; }
    }
    if (d <= RAMP_PAIRS) {
      const t = 1 - d / (RAMP_PAIRS + 1);
      // 取最近那个桥断面的桥面高程（引道要对齐到它，不能对齐到一个常量）
      let near = i;
      for (let k = 1; k <= RAMP_PAIRS + 1; k++) {
        if (i - k >= 0 && isBridge[i - k]) { near = i - k; break; }
        if (i + k < pairs && isBridge[i + k]) { near = i + k; break; }
      }
      const target = gy[i] + (deckAt[near] - gy[i]) * t;
      if (target > by[i]) by[i] = target;
    }
  }

  // ---- 写路面顶点
  for (let i = 0; i < pairs; i++) {
    const s0 = i * 2 * STRIDE, s1 = (i * 2 + 1) * STRIDE;
    const y = by[i];
    for (const [v, s] of [[i * 2, s0], [i * 2 + 1, s1]]) {
      pos[v * 3] = src[s];
      pos[v * 3 + 1] = y;
      pos[v * 3 + 2] = src[s + 2];
      uv[v * 2] = src[s + 3];
      uv[v * 2 + 1] = src[s + 4];
    }
  }

  // ---- 桥附件：桥面梁体 + 护栏 + 桥墩
  //
  // 零厚度的 ribbon 在远处投影成一条线，看起来就是「贴在水面上的纸」。
  // 真桥必须先有侧影：主梁（girder）侧面 + 底板，再挂护栏和桥墩。
  const GIRDER = 1.5;   // 主梁高度（桥面下沿）
  const bpos = [], bidx = [];
  let pierced = 0;
  if (railMat) {
    const put = (x, y, z) => { bpos.push(x, y, z); return bpos.length / 3 - 1; };
    const quad = (a, b, c, d) => { bidx.push(a, b, c, a, c, d); };
    let lastPier = -99;
    for (let i = 0; i + 1 < pairs; i++) {
      if (!isBridge[i] || !isBridge[i + 1]) { lastPier = -99; continue; }
      const s0 = i * 2 * STRIDE, s1 = (i * 2 + 1) * STRIDE;
      const t0 = (i + 1) * 2 * STRIDE, t1 = ((i + 1) * 2 + 1) * STRIDE;
      const y = by[i], y1 = by[i + 1];
      const xa0 = src[s0], za0 = src[s0 + 2], xb0 = src[t0], zb0 = src[t0 + 2];
      const xa1 = src[s1], za1 = src[s1 + 2], xb1 = src[t1], zb1 = src[t1 + 2];
      // 主梁：左右两侧 + 底板（双面，从任何角度都有侧影）
      for (const [xa, za, xb, zb] of [[xa0, za0, xb0, zb0], [xa1, za1, xb1, zb1]]) {
        const i0 = put(xa, y, za), i1 = put(xb, y1, zb);
        const i2 = put(xb, y1 - GIRDER, zb), i3 = put(xa, y - GIRDER, za);
        quad(i0, i1, i2, i3); quad(i3, i2, i1, i0);
      }
      // 底板
      {
        const a = put(xa0, y - GIRDER, za0), b = put(xb0, y1 - GIRDER, zb0);
        const c = put(xb1, y1 - GIRDER, zb1), d = put(xa1, y - GIRDER, za1);
        quad(a, b, c, d); quad(d, c, b, a);
      }
      // 两道护栏（左右各一）
      for (const [xa, za, xb, zb] of [[xa0, za0, xb0, zb0], [xa1, za1, xb1, zb1]]) {
        const i0 = put(xa, y, za), i1 = put(xb, y1, zb);
        const i2 = put(xb, y1 + RAIL_H, zb), i3 = put(xa, y + RAIL_H, za);
        quad(i0, i1, i2, i3);
        quad(i3, i2, i1, i0);
      }
      // 桥墩
      if (lastPier < 0 || i - lastPier >= PIER_EVERY) {
        const cx = (src[s0] + src[s1]) / 2, cz = (src[s0 + 2] + src[s1 + 2]) / 2;
        const w = Math.hypot(src[s1] - src[s0], src[s1 + 2] - src[s0 + 2]) * 0.55;
        const halfW = w / 2;
        const bedY = T ? T.sampleHeight(cx, cz) - 0.5 : -5;
        const top = y - GIRDER + 0.1;
        if (top > bedY + 1) {
          // 墩身四棱柱
          const dx = 1.2, dz = halfW;
          const c0 = put(cx - dx, bedY, cz - dz), c1 = put(cx + dx, bedY, cz - dz);
          const c2 = put(cx + dx, bedY, cz + dz), c3 = put(cx - dx, bedY, cz + dz);
          const d0 = put(cx - dx, top, cz - dz), d1 = put(cx + dx, top, cz - dz);
          const d2 = put(cx + dx, top, cz + dz), d3 = put(cx - dx, top, cz + dz);
          quad(c0, c1, d1, d0); quad(c1, c2, d2, d1); quad(c2, c3, d3, d2); quad(c3, c0, d0, d3);
          pierced++;
        }
        lastPier = i;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.receiveShadow = true;
  // 桥面必须投影：否则从远处看完全没有「离开水面」的感觉
  mesh.castShadow = true;

  let bridgeMesh = null;
  if (bpos.length) {
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(bpos, 3));
    bg.setIndex(bidx);
    bg.computeVertexNormals();
    bg.computeBoundingSphere();
    bridgeMesh = new THREE.Mesh(bg, railMat);
    bridgeMesh.name = name + '_bridges';
    bridgeMesh.castShadow = true;
    bridgeMesh.receiveShadow = true;
  }

  // 跨河断面数 = 桥长（每断面间距 ≈ 1~4 m）；isShore 单独计数供日志核对
  let span = 0, shore = 0;
  for (let i = 0; i < pairs; i++) { if (isBridge[i]) span++; else if (isShore[i]) shore++; }
  return { mesh, bridgeMesh, bridges: { pairs: span, piers: pierced, shore } };
}

/**
 * 建整层 L2_road。
 * @param {object} R loadRoads() 的返回
 * @param {object} T loadTerrain() 的返回
 * @param {{road,path,pier}} mats
 * @param {number} waterY 正常水位
 */
export function buildRoadGroup(R, T, mats, waterY = 0.046, W = null) {
  const g = new THREE.Group();
  g.name = 'L2_road';
  const stat = { span: 0, piers: 0 };

  // 【车道也加 noShoreLift】岸边低于水面的断面直接判死，不再贴着拍平的河床
  // 画出一条「浮在水面上的暗带」（用户：那些浮在空中的蜘蛛网）。
  const road = ribbonMesh(R.road, T, mats.road, 'road_ways', waterY, 0,
    mats.pier || null, W, { noShoreLift: true, minRun: 14 });
  stat.span += road.bridges.pairs; stat.piers += road.bridges.piers;
  stat.walls = (stat.walls || 0) + road.bridges.walls;
  stat.skirts = (stat.skirts || 0) + road.bridges.skirts;
  g.add(road.mesh);
  if (road.bridgeMesh) g.add(road.bridgeMesh);

  if (R.walk) {
    // 人行道/步道比车行道高 15 cm —— 这就是路缘石（立缘）的真实高度。
    // 一箭双雕：① 街景里有可辨的立缘阴影线；② 与车行道不共面，消灭 z-fighting。
    // 人行道比车道高 0.24 m（extraLift 0.30 vs 车道 0.16 的 LIFT），
    // 这个高差就是路缘石立面 —— 平视时能看出「车道 / 路缘 / 人行道」三层，
    // 而不是一整块平板。
    // 立缘石：只给人行道做立面（车行道不做，那正是「蜘蛛网」的来源）。
    // 【curbH 必须 == 人行道抬升量 0.30】立面要从人行道面一直落到地面，
    // 差 0.12 m 就会让整条人行道边缘悬空一条缝（看起来还是纸片）。
    // 实测：细暗线（thin-dark）在加立缘石前后完全不变（10869 → 10869）。
    const walk = ribbonMesh(R.walk, T, mats.path, 'walk_ways', waterY, 0.30,
      mats.curb || null, null, { dropNearWater: 22, minRun: 18, curbFace: true, curbH: 0.30, noBridge: true, noShoreLift: true });
    g.add(walk.mesh);
  }
  // 【OSM 步道不能抬 15 cm】DC 的 OSM 有 1.6 万条 footway，其中大量是沿街
  // 中心线重复描绘的「人行道」，抬 15 cm 后会浮在车行道上方并盖住整条街
  // （实测：街景里看不到路面，只有一片浅色铺装 —— 就是用户说的「穿模感」）。
  // 抬 2 cm 即可：重叠处被 polygonOffset 更强（-4）的车行道压住，
  // 不重叠的地方仍然是正常的步道。
  if (R.path) {
    // 【滨河步道不许抬】见 roadmesh.js 的 noShoreLift：地面低于水面就整段删掉，
    // 而不是像 v1 那样抬到 waterY+1.4 —— 那就是用户看到的「河边的路飞到天上」。
    const pr = ribbonMesh(R.path, T, mats.path, 'path_ways', waterY, 0.02,
      null, null, { noShoreLift: true, dropNearWater: 28, minRun: 18, noBridge: true });
    g.add(pr.mesh);
    if (pr.bridgeMesh) g.add(pr.bridgeMesh);
    stat.pathDead = pr.bridges.dead;
  }

  // ---- 标线
  //
  // 【z-fighting 真正的元凶是 polygonOffset 数值】路面材质用
  // polygonOffsetUnits = -4（往镜头方向拉 4 个单位），标线原本只有 -2，
  // 于是路面反而被拉到标线前面，标线永远被盖住（街景里一条线都看不到）。
  // 标线必须比路面拉得更狠：factor -4 / units -8，再抬高 3 cm。
  // 【为什么要「吸附」】路面在每个横断面上是一个水平平面，高度取该横断面
  // 宽度内 7 个采样点的最大值；而标线是另一条窄带，按它自己的位置采样地形。
  // 两者在坡道/起拱/桥面上必然差几厘米到几十厘米（实测 35% 白线、70% 黄线
  // 落在路面**以下**，整条街一条标线都看不见）。与其去猜 lift，不如把标线
  // 直接射到已经建好的路面三角面上，固定抬起 1.2 cm。
  const roadSurf = makeRoadSurf(road.mesh);

  const markY = (rb, mat, name) => {
    if (!rb) return;
    // 【为什么标线要用更大的取样半径】车行道的横断面高程取的是「整个路面宽度内
    // 7 个采样点的最大值 + 0.16」，也就是一个水平平面；而标线是另外一条窄带，
    // 它按自己的 ±1.7 m 取最大，在坡度 10% 的街上就会比路面平面低 0.3~0.5 m，
    // 于是永远被埋进路面（实测标线网格确实生成了，但整帧一个像素都不显示）。
    // 把标线的取样半径放大到 3.4 m（≥ 半个车道宽 + 原半径），它取到的最大值
    // 必然 ≥ 路面平面的高度，标线就稳定浮在路面之上几厘米。
    const m = ribbonMesh(rb, T, mat, name, waterY, 0.05, null, null,
      { snap: roadSurf, snapLift: 0.045, dropNearWater: 3 });
    m.mesh.receiveShadow = false;
    g.add(m.mesh);
  };
  markY(R.markw, mats.markw, 'mark_white');
  markY(R.marky, mats.marky, 'mark_yellow');

  g.userData.bridges = stat;
  console.log(`[roads] 跨河断面 ${stat.span} 个, 桥墩/高架墩 ${stat.piers} 道`
    + `, 挡土墙 ${stat.walls || 0}, 路缘立面 ${stat.skirts || 0}`
    + `, 滨河步道删除断面 ${stat.pathDead || 0}`);
  return g;
}

/**
 * 把路面三角面做成 XZ 网格索引，用于把标线吸附到路面上。
 * @returns {(x:number, z:number)=>number|null} 该点路面高度；没命中返回 null
 */
export function makeRoadSurf(mesh) {
  const pos = mesh.geometry.attributes.position;
  const idx = mesh.geometry.index;
  const nTri = idx ? idx.count / 3 : pos.count / 3;
  const CELL = 8;
  const buckets = new Map();
  const key = (cx, cz) => cx * 100003 + cz;
  const tri = [];
  for (let t = 0; t < nTri; t++) {
    const a = idx ? idx.getX(t * 3) : t * 3;
    const b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
    const bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b);
    const cx = pos.getX(c), cy = pos.getY(c), cz = pos.getZ(c);
    tri.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    const x0 = Math.floor(Math.min(ax, bx, cx) / CELL), x1 = Math.floor(Math.max(ax, bx, cx) / CELL);
    const z0 = Math.floor(Math.min(az, bz, cz) / CELL), z1 = Math.floor(Math.max(az, bz, cz) / CELL);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gz = z0; gz <= z1; gz++) {
        const k = key(gx, gz);
        let arr = buckets.get(k);
        if (!arr) { arr = []; buckets.set(k, arr); }
        arr.push(t);
      }
    }
  }
  return (x, z) => {
    const arr = buckets.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!arr) return null;
    let best = null;
    for (let i = 0; i < arr.length; i++) {
      const o = arr[i] * 9;
      const ax = tri[o], ay = tri[o + 1], az = tri[o + 2];
      const bx = tri[o + 3], by = tri[o + 4], bz = tri[o + 5];
      const cx = tri[o + 6], cy = tri[o + 7], cz = tri[o + 8];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -0.02 || l2 < -0.02 || l3 < -0.02) continue;
      const y = l1 * ay + l2 * by + l3 * cy;
      if (best === null || y > best) best = y;
    }
    return best;
  };
}

/** 标线用的纯色材质（不带贴图：一条 way 的车道数不同，贴图刷标线必然被拉伸） */
export function makeMarkMaterials() {
  const mk = (hex) => new THREE.MeshStandardMaterial({
    color: hex, roughness: 0.78, metalness: 0.0,
    // 已经几何吸附到路面上 1.2 cm，不再需要靠 polygonOffset 抢深度，
    // 但保留一点点，防止远处深度精度不够时闪。
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -16,
  });
  return { markw: mk(0xd8d4c8), marky: mk(0xc8a144) };
}