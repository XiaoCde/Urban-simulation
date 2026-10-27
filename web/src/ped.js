/**
 * L6_agents —— 全城行人。
 *
 * 资产来源（全部由本仓库脚本生成，没有外部下载模型）：
 *   assets/ped/male.glb / female.glb
 *     tools/ped/export_ped_glb.py 从 data/characters 的 Mixamo FBX 压出来。
 *     一个角色带 13 段动作（walk / run / idle / look / side_l / side_r / back /
 *     turn180 / start / stop / run_stop / crouch / idle2）。
 *     **根位移已削平**：Mixamo 的 walking 每循环自带 1.96 m 前移，不削会
 *     「走一段闪回一次」。实际位移由本文件按速度积分，动画只负责腿。
 *   assets/ped/walknet.json
 *     tools/ped/export_walknet.py 生成的步行图：每条车行道两侧各一条人行道
 *     中心线（偏移 = 半宽 + 0.9 m）+ OSM 独立 footway。
 *
 * 为什么人必须走在 walknet 上：直接把行人撒在地形上，人会穿墙、走草地、
 * 走在马路正中。walknet 是「人能站的地方」的显式表达。
 *
 * 行为（状态机 nextState 是纯函数，可单测）：
 *   idle  → 站着；look → 左右张望；walk → 走；yield → 停下侧身让路（其余情况）
 *   静态障碍（建筑 / 水面 / 场景边界）在**几米外**就触发 → 原地调头（turn180）
 *   前方有人 → 先横向让开 0.5 m，让不开才停
 *
 * 性能：每人是 4 个 SkinnedMesh + 一个 AnimationMixer，很贵。三层裁剪：
 *   · 距离 > 130 m 整个隐藏并停 mixer（都市远景里本来也看不见人）
 *   · 距离 > 45 m mixer 降频到 1/3
 *   · 阴影只在 70 m 内打开
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { roofSurfaceY } from './terrain.js';
import { createTrappedIndex } from './trapped.js';

// ---------------------------------------------------------------- 常量
const TARGET_H_MALE = 1.82;     // 男性身高（米）
const TARGET_H_FEMALE = 1.68;
const SPEED_WALK = 1.42;        // 米/秒（Mixamo walk 反推 1.517，取略慢更自然）
const SPEED_RUN = 3.05;
const VIS_DIST = 260;           // 超过这个距离整个隐藏（街景 100 m 内至少要有人）
const SHADOW_DIST = 90;
const MIXER_LOD_DIST = 70;
const CELL_PED = 4.0;           // 人-人分离的空间哈希格
const LOOK_AHEAD = 2.6;         // 静态障碍探测距离（米，"差几米就掉头"）
const PED_AVOID = 3.2;          // 前方多远算被人挡

// ---------------------------------------------------------------- 积水避险（2026-10-26）
// 用户要求：「让人对积水有反应，可以自主前往高处未有积水的地方，比如高地、高楼
//          （不用真的进去，站在房顶就表示进入高楼）」。
// 做法：人脚下的水深 ≥ FLEE_DEPTH 就切换成『逃难』——离开步行网直走最近的避难所；
//      避难所只有两类，房顶（站到上表面）和地势高点（walknet 上高程靠前的点）。
//      走到就转入『躲着』并停住，水退了再回步行网继续走。
const FLEE_DEPTH = 0.12;        // 米。12 cm 齐踝，普通人不会继续走
const FLEE_SPEED = 3.3;         // 逃难速度（米/秒，接近快跑）
const FLEE_TURN_IN = 0.55;      // 每帧朝目标转多少（0..1，越大越急）
const REFUGE_MAX = 620;         // 最近避难所超过这个距离就不找了（不现实）
const REFUGE_TRIES = 6;         // 直线被楼挡住时最多再换几个候选
const SHELTER_CALM = 8.0;       // 水退干净这么久之后才敢回街上（秒）
const HIGH_Q = 0.80;            // 「高地」定义：walknet 高程前 20% 的点

// ---------------------------------------------------------------- 确定性随机
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- 资产
export async function loadPedAssets(base = 'assets/ped/') {
  const loader = new GLTFLoader();
  // 近景版（55k 三角）与 LOD 版（~2~3k 三角，tools/ped/make_lod.py 生成）。
  // 两套共用同一批 clip 名，所以状态机代码不用变。
  const [male, female, maleLod, femaleLod, netRes] = await Promise.all([
    loader.loadAsync(base + 'male.glb'),
    loader.loadAsync(base + 'female.glb'),
    loader.loadAsync(base + 'male_lod.glb').catch(() => null),
    loader.loadAsync(base + 'female_lod.glb').catch(() => null),
    fetch(base + 'walknet.json'),
  ]);
  if (!netRes.ok) throw new Error('walknet.json 取回失败 ' + netRes.status);
  const net = await netRes.json();

  // 【身高归一化】male 的 FBX 带 2.18 倍尺度（实测高 3.785 m），female 是 1:1。
  // 按包围盒实测高度缩到目标身高，换素材不用改代码。
  for (const g of [male, female]) {
    g.scene.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(g.scene);
    g.userData.height = Math.max(0.1, bb.max.y - bb.min.y);
    g.userData.minY = bb.min.y;
  }
  male.userData.scale = TARGET_H_MALE / male.userData.height;
  female.userData.scale = TARGET_H_FEMALE / female.userData.height;

  // LOD 版单独量一遍（decimate 后 bbox 会有几毫米偏差，但缩放必须一致才不跳）
  const lod = [];
  for (const [g, hi] of [[maleLod, male], [femaleLod, female]]) {
    if (!g) continue;
    g.userData.scale = hi.userData.scale;
    g.userData.minY = hi.userData.minY;
    lod.push(g);
  }

  return { templates: [male, female], lod, net };
}

// ---------------------------------------------------------------- 步行图
/**
 * 载入「铺装顶面栅格」assets/roads/surf.i16（由 tools/terrain/export_road_cut.py
 * 与 cut.i16 同一次导出）。
 *
 * 为什么必须有它：人行道 ribbon 的顶点高度 = 可见地面 + LIFT(0.16) + extraLift(0.30)
 * = 地面 + 0.46 m，而行人原来只用 T.sampleHeight（纯地形）。于是每个人的脚都埋在
 * 人行道板下面 0.46 m —— 1.82 m 的人埋掉小腿以下，坡地上地形还被下切 0.12 m，
 * 看起来就是用户说的「半个身子在路面以下」。
 *
 * 返回 {cols, rows, x0, y1, step, at(x, z)}，at 越界返回 -Infinity。
 */
export async function loadPedSurface(base = 'assets/roads/') {
  const meta = await (await fetch(`${base}../terrain/terrain.json`, { cache: 'no-store' })).json();
  const g = meta.grid;
  const cols = g.cols | 0, rows = g.rows | 0;
  const res = await fetch(`${base}surf.i16`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`surf.i16 HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const want = cols * rows * 2;
  if (buf.byteLength !== want) {
    throw new Error(`surf.i16 长度 ${buf.byteLength} != ${want}`);
  }
  const v = new Int16Array(buf);
  const x0 = +g.x0, y1 = +g.y1, step = +g.step_m;
  // 【必须双线性，不能取最近格】地形查询 T.sampleHeight 是双线性的，surf 若按
  // 最近格取整，两者在陡坡上会差好几米 —— 人行道被抬到空中，人跟着浮起来。
  // 这里用与 terrain.js makeSampler 完全一致的 fx/fy 公式，保证两个栅格同口径。
  const atCell = (c, r) => {
    c = c < 0 ? 0 : (c >= cols ? cols - 1 : c);
    r = r < 0 ? 0 : (r >= rows ? rows - 1 : r);
    const t = v[r * cols + c];
    return t === -32768 ? null : t * 0.01;
  };
  return {
    cols, rows, x0, y1, step,
    at(x, z) {
      const fx = (x - x0) / step - 0.5;
      // 【符号】与本文件 buildTerrainMesh 相同：栅格 row0 = 最北（planY 最大），
      // three 的 z = -planY → row = (y1 + z)/step。写成 (y1 - z) 会上下翻转，
      // 取到地球另一头的格子（实测把人抬到 10 m 高空）。terrain.js:92 同式。
      const fy = (y1 + z) / step - 0.5;
      const c0 = Math.floor(fx), r0 = Math.floor(fy);
      const tx = fx - c0, ty = fy - r0;
      const v00 = atCell(c0, r0), v10 = atCell(c0 + 1, r0);
      const v01 = atCell(c0, r0 + 1), v11 = atCell(c0 + 1, r0 + 1);
      if (v00 === null || v10 === null || v01 === null || v11 === null) return -Infinity;
      return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
    },
  };
}

/**
 * walknet: nodes = [[planX, planY]], chains = [[nodeId...]]
 * 这里一次性把 planY 折成 three 的 z = -planY，并把每个顶点的**可站立高度**
 * （地形与铺装顶面取大）采好。
 */
export function buildWalkGraph(net, T, SURF = null) {
  const nodes = net.nodes.map(([x, y]) => new THREE.Vector3(x, 0, -y));
  const chains = net.chains.map((ids) => ids.slice());

  // 站立高度：铺装面若存在且更高，就站到铺装上（人行道比地形高 0.46 m）。
  const groundAt = (x, z) => {
    const g = T ? T.sampleHeight(x, z) : 0;
    if (!SURF) return g;
    const s = SURF.at(x, z);
    return s > g ? s : g;
  };

  const chainInfo = chains.map((ids) => {
    const pts = ids.map((i) => nodes[i].clone());
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    for (const p of pts) p.y = groundAt(p.x, p.z);
    return { ids, pts, cum, len: cum[cum.length - 1] };
  });

  // node -> [{ci, dir}]，dir=+1 表示沿 chain 正序走
  const adj = Array.from({ length: nodes.length }, () => []);
  chainInfo.forEach((c, ci) => {
    if (c.len < 1e-3) return;
    adj[c.ids[0]].push({ ci, dir: 1 });
    adj[c.ids[c.ids.length - 1]].push({ ci, dir: -1 });
  });

  return { nodes, chains: chainInfo, adj, groundAt };
}

/** 沿 chain 取弧长 s 处的点（three 坐标），写进 out。 */
function pointAt(c, s, out) {
  const cum = c.cum, pts = c.pts;
  if (s <= 0) return out.copy(pts[0]);
  if (s >= c.len) return out.copy(pts[pts.length - 1]);
  let lo = 0, hi = cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid; else hi = mid;
  }
  const t = (s - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
  return out.lerpVectors(pts[lo], pts[hi], t);
}

// ---------------------------------------------------------------- 状态机（纯函数）
/**
 * @param {string} st  当前状态
 * @param {object} obs {blocked, nearEnd, rnd, cooldownOk}
 * @returns {string}
 */
export function nextState(st, obs) {
  const r = obs.rnd;
  switch (st) {
    case 'idle':
      if (obs.nearEnd) return 'walk';
      if (r < 0.34) return 'walk';
      if (r < 0.58) return 'look';
      return 'idle';
    case 'look':
      if (obs.blocked) return 'yield';
      if (r < 0.46) return 'idle';
      if (r < 0.82) return 'walk';
      return 'look';
    case 'walk':
      if (obs.blocked) return 'yield';
      if (r < 0.010) return 'look';
      return 'walk';
    case 'yield':
      if (!obs.blocked && obs.cooldownOk) return 'walk';
      return 'yield';
    default:
      return 'walk';
  }
}

// ---------------------------------------------------------------- 静态障碍
/**
 * 把 21,943 栋楼的真实轮廓做成 24 m 空间哈希，用于「这个点能不能站」。
 * 用 buildings.json 的 v0/vc + buildings.mesh 顶点（stride 4: x, z, top, base），
 * 不用 bbox 近似 —— 细长的楼用正方形近似会把半条街堵死。
 *
 * 顺带产出「屋顶避难所」清单（2026-10-26 加的积水避险）：
 * 只收 height_m >= 6 且面积 >= 80 m² 的楼，因为用户要的是「站房顶表示进了高楼」，
 * 低矮的棚子站上去也不像躲水。
 */
function buildBlocker(B) {
  const CELL = 24;
  const grid = new Map();
  const kk = (cx, cz) => cx * 73856093 ^ cz * 19349663;
  const polys = [];   // {pts:[[x,z]...], x0,x1,z0,z1,top}
  const roofs = [];   // {x,z,top,area}  —— 屋顶避难所
  const V = B.verts, meta = B.meta;

  for (const b of B.buildings) {
    if (!(b.height_m > 2.0)) continue;      // 台阶/平台不算障碍
    const v0 = b.v0, vc = b.vc || 4;
    const pts = [];
    let topY = -Infinity;
    for (let i = 0; i < vc; i++) {
      const o = (v0 + i) * 4;
      pts.push([V[o], V[o + 1]]);           // x, z 已经是 three 坐标
      if (V[o + 2] > topY) topY = V[o + 2];
    }
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of pts) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    polys.push({ pts, x0, x1, z0, z1, top: topY });
    if (b.height_m >= 6 && (b.area_m2 || 0) >= 80 && Number.isFinite(topY)) {
      const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
      // 屋顶中心必须落在轮廓里（凹形楼用 bbox 中心可能掉到街上）
      //
      // 【踩过的坑】这里第一版直接把 `topY`（檐口高程）当站立高度，
      // 结果 15,119 个屋顶候选里约 72% 是坡屋顶/折坡/攒尖 —— 人站到檐口
      // 高度上，整个人被长出来的屋面实体埋掉，肉眼一只都看不见。
      // 统一交给 terrain.js 的 roofSurfaceY 算「人脚底该放在哪个 y」。
      if (inPoly(pts, cx, cz)) {
        const sy = roofSurfaceY(b, V);
        roofs.push({ x: cx, z: cz, top: Number.isFinite(sy) ? sy : topY, area: b.area_m2 || 0 });
      }
    }
    const pi = polys.length - 1;
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const k = kk(cx, cz);
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push(pi);
      }
    }
  }

  // 奇偶规则点在多边形内（轮廓都是凸矩形，但统一处理更安全）
  function inPoly(pts, x, z) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], zi = pts[i][1];
      const xj = pts[j][0], zj = pts[j][1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  }

  return {
    /** 该点是否被建筑占住；margin 是外墙外余量（米） */
    blocked(x, z, margin = 0.6) {
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          const a = grid.get(kk(cx + i, cz + j));
          if (!a) continue;
          for (const pi of a) {
            const p = polys[pi];
            if (x < p.x0 - margin || x > p.x1 + margin) continue;
            if (z < p.z0 - margin || z > p.z1 + margin) continue;
            if (inPoly(p.pts, x, z)) return true;
            // 靠墙 margin 内也算挡（避免人贴墙穿模）
            if (margin > 0) {
              for (let k = 0; k < p.pts.length; k++) {
                const a2 = p.pts[k], b2 = p.pts[(k + 1) % p.pts.length];
                const dx = b2[0] - a2[0], dz = b2[1] - a2[1];
                const L2 = dx * dx + dz * dz;
                let t = L2 > 0 ? ((x - a2[0]) * dx + (z - a2[1]) * dz) / L2 : 0;
                t = Math.max(0, Math.min(1, t));
                const ex = a2[0] + t * dx - x, ez = a2[1] + t * dz - z;
                if (ex * ex + ez * ez < margin * margin) return true;
              }
            }
          }
        }
      }
      return false;
    },
    count: polys.length,
    roofs,
  };
}

// ---------------------------------------------------------------- 主构建
/**
 * @param {object} assets  loadPedAssets() 的返回
 * @param {object} opt     { T, B, count, seed }
 */
export function buildPedestrians(assets, opt = {}) {
  const T = opt.T;
  const B = opt.B;
  const count = opt.count || 1500;
  const rnd = mulberry32(opt.seed || 20261024);
  // 用高模还是 LOD：'hi' 只给特写调试用，默认 'lod'（2~3k 三角，600 人可跑）
  const useTpl = (opt.detail === 'hi' || !assets.lod || !assets.lod.length)
    ? assets.templates : assets.lod;
  const G = buildWalkGraph(assets.net, T, opt.SURF);
  // 站立高度 = max(地形, 铺装顶面)。没有 SURF 时退回地形（会有 0.46 m 下沉）。
  const groundAt = G.groundAt;
  const blocker = buildBlocker(B);

  const isWater = (x, z) => !!(T && T.classify && T.classify(x, z) === 0);
  const W = { x0: -1277, x1: 4701, z0: -4189, z1: 931 };
  const inBounds = (x, z) => x > W.x0 + 8 && x < W.x1 - 8 && z > W.z0 + 8 && z < W.z1 - 8;

  // 可走段：整条链每隔一段抽检，任何一处被建筑/水/界外占住就整条丢掉。
  // （步行图是按路网算的，理论上都在人行道上；这一步是防数据脏。）
  const usable = [];
  let dropped = { short: 0, blocked: 0, water: 0 };
  for (let ci = 0; ci < G.chains.length; ci++) {
    const c = G.chains[ci];
    if (c.len < 8) { dropped.short++; continue; }
    const n = Math.max(3, Math.min(9, Math.ceil(c.len / 14)));
    let bad = false;
    for (let i = 0; i <= n && !bad; i++) {
      const p = pointAt(c, (c.len * i) / n, new THREE.Vector3());
      if (!inBounds(p.x, p.z)) { bad = true; dropped.blocked++; break; }
      if (isWater(p.x, p.z)) { bad = true; dropped.water++; break; }
      if (blocker.blocked(p.x, p.z, 0.2)) { bad = true; dropped.blocked++; break; }
    }
    if (!bad) usable.push(ci);
  }
  if (!usable.length) throw new Error('没有可走的步行链（walknet 数据异常）');

  // ---------------------------------------------------------------- 避难所索引
  // 【积水避险】2026-10-26 按用户要求新增：
  //   「让人对积水有反应，可以自主前往高处未有积水的地方，比如高地、高楼
  //    （不用真的进去，站在房顶就表示进入高楼）」。
  // 两类避难所：
  //   ① 屋顶（kind=1）：height>=6 m、面积>=80 m² 的楼，站位取轮廓中心、高度取顶面。
  //      人到楼下墙边就算「进去了」，直接站上屋顶（不做楼梯/电梯）。
  //   ② 高地（kind=0）：把可行走网按 24 m 采样，取高程前 20%（HIGH_Q）的点。
  //      这样「高地」是真实抬高的街区（国会山、山丘公园），不是凭空造的点。
  const refuges = [];
  for (const r of (blocker.roofs || [])) refuges.push({ x: r.x, z: r.z, y: r.top, kind: 1 });
  {
    const _sp = new THREE.Vector3();
    const samples = [];
    for (const ci of usable) {
      const c = G.chains[ci];
      const n = Math.max(1, Math.floor(c.len / 24));
      for (let i = 0; i <= n; i++) {
        pointAt(c, Math.min(c.len, i * 24), _sp);
        samples.push([_sp.x, _sp.z, groundAt(_sp.x, _sp.z)]);
      }
    }
    samples.sort((a, b) => b[2] - a[2]);
    const take = Math.min(9000, Math.floor(samples.length * (1 - HIGH_Q)));
    for (let i = 0; i < take; i++) {
      const [sx, sz, sy] = samples[i];
      refuges.push({ x: sx, z: sz, y: sy, kind: 0 });
    }
  }

  // 避难所空间索引：150 m 一格，查询时一圈圈外扩。
  const RC = 150;
  const rGrid = new Map();
  const rk = (cx, cz) => cx * 73856093 ^ cz * 19349663;
  for (let i = 0; i < refuges.length; i++) {
    const R = refuges[i];
    const k = rk(Math.floor(R.x / RC), Math.floor(R.z / RC));
    let a = rGrid.get(k); if (!a) rGrid.set(k, (a = []));
    a.push(i);
  }

  /** 直线可达性：起点到终点每 4 m 抽一检。末段允许穿墙（那是「进楼」）。 */
  function lineClear(x0, z0, x1, z1, allowWallTail) {
    const dx = x1 - x0, dz = z1 - z0;
    const L = Math.hypot(dx, dz);
    if (L < 1e-3) return true;
    const n = Math.max(1, Math.ceil(L / 4));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const px = x0 + dx * t, pz = z0 + dz * t;
      if (!inBounds(px, pz)) return false;
      if (L * (1 - t) < allowWallTail) continue;   // 最后 allowWallTail 米不判墙
      if (blocker.blocked(px, pz, 0.25)) return false;
    }
    return true;
  }

  /** 找离 (x,z) 最近且直线可达的避难所；avoid 用来排除刚失败的那个。 */
  function findRefuge(x, z, avoid) {
    const cand = [];
    const c0x = Math.floor(x / RC), c0z = Math.floor(z / RC);
    const maxRing = Math.ceil(REFUGE_MAX / RC) + 1;
    for (let ring = 0; ring <= maxRing; ring++) {
      // 已经攒够 24 个候选就不用再外扩（近的优先，够挑了）
      if (cand.length >= 24) break;
      for (let i = -ring; i <= ring; i++) {
        for (let j = -ring; j <= ring; j++) {
          if (ring > 0 && Math.abs(i) !== ring && Math.abs(j) !== ring) continue;
          const a = rGrid.get(rk(c0x + i, c0z + j));
          if (!a) continue;
          for (const ri of a) {
            const R = refuges[ri];
            if (avoid && R === avoid) continue;
            const d = Math.hypot(R.x - x, R.z - z);
            if (d > REFUGE_MAX) continue;
            cand.push([d, R]);
          }
        }
      }
    }
    if (!cand.length) return null;
    cand.sort((a, b) => a[0] - b[0]);
    const tries = Math.min(REFUGE_TRIES, cand.length);
    for (let i = 0; i < tries; i++) {
      const [d, R] = cand[i];
      if (lineClear(x, z, R.x, R.z, R.kind === 1 ? 9 : 0)) return R;
      void d;
    }
    // 全都不可达：退一步，要最近的屋顶（哪怕穿墙，至少有个去处）
    for (let i = 0; i < cand.length; i++) if (cand[i][1].kind === 1) return cand[i][1];
    return null;
  }

  // 链索引：水退后把人接回步行网用（60 m 一格）。每条链的**每个顶点**都登记，
  // 否则 200 m 的长街只在格子里留一个中点，回网时会跳到隔壁街。
  const CC = 60;
  const cGrid = new Map();
  const ck = (cx, cz) => cx * 73856093 ^ cz * 19349663;
  for (const ci of usable) {
    const c = G.chains[ci];
    const seen = new Set();
    for (const p of c.pts) {
      const cx = Math.floor(p.x / CC), cz = Math.floor(p.z / CC);
      const k = ck(cx, cz);
      if (seen.has(k)) continue;
      seen.add(k);
      let a = cGrid.get(k); if (!a) cGrid.set(k, (a = []));
      a.push(ci);
    }
  }
  /**
   * 找最近的步行链，并给出该链上离 (x,z) 最近的弧长 —— 水退后把人原地接回网。
   *
   * 【为什么带 dInfo】审查发现的死循环：`updateFlee` 判定「水退了」用的是
   * **避难所位置**的水深，但 `rejoinNet` 只按几何找最近链。如果最近的那条链
   * 还泡在 12 cm 深的水里，人一落地下一帧就又开始逃 —— 于是「跑 2.4 m →
   * 爬 1.2 s → 等 8 s → 回网 → 再逃」无限循环，远处看起来是人原地抽搐。
   * 所以这里按「干」优先挑落点，一个干的都没有就返回 null，让调用方继续躲。
   */
  function nearestChain(x, z, dInfo) {
    let wetBest = null, wetBestD = Infinity;
    for (let ring = 0; ring <= 4; ring++) {
      let best = -1, bestS = 0, bestD = Infinity;
      const c0x = Math.floor(x / CC), c0z = Math.floor(z / CC);
      for (let i = -ring; i <= ring; i++) {
        for (let j = -ring; j <= ring; j++) {
          if (ring > 0 && Math.abs(i) !== ring && Math.abs(j) !== ring) continue;
          const a = cGrid.get(ck(c0x + i, c0z + j));
          if (!a) continue;
          for (const ci of a) {
            const c = G.chains[ci];
            for (let k = 0; k < c.pts.length; k++) {
              const p = c.pts[k];
              const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
              if (d >= bestD) continue;
              if (dInfo) {
                dInfo(p.x, p.z, _ds);
                if (_ds.wet) { if (d < wetBestD) { wetBestD = d; wetBest = { ci, s: c.cum[k] }; } continue; }
              }
              bestD = d; best = ci; bestS = c.cum[k];
            }
          }
        }
      }
      if (best >= 0) return { ci: best, s: bestS };
    }
    // 四条链以内一个干点都没有 → 不勉强，返回 null（人继续待在避难所）
    void wetBest;
    return null;
  }

  // 按「链长 × 区域密度」加权抽样。
  // 只按长度加权时，600 人摊在 1772 km 步行网上 = 每 3 km 才一个人，任何一条
  // 街景里都看不到人。真实城市的行人 90% 集中在国家广场/市中心/国会山，
  // 所以这里乘一个区域权重，让「该有人的地方人多」。
  // 【分布策略（用户 2026-10-24 定案）】
  // 「保留一个地方，就是可以在视角下集中分布，剩下的就均匀分布。」
  // 所以：只留**一个**集中区（默认机位 = 白宫 / 拉斐特广场，索引 0 的机位），
  // 其余全部按步行网**长度**均匀撒（不做核心区倍率加权）。
  const CORE = [];   // 不再按核心区加权：全局按链长均匀
 
  const regionW = (x, y) => {
    for (const [a, b, c, d, w] of CORE) if (x >= a && x <= b && y >= c && y <= d) return w;
    return 1.0;
  };

  // 链中点（three 坐标）。区域判定与热点配额都用它。
  const midX = new Float64Array(usable.length);
  const midZ = new Float64Array(usable.length);
  const cumW = new Float64Array(usable.length);
  let acc = 0;
  for (let i = 0; i < usable.length; i++) {
    const c = G.chains[usable[i]];
    let mx = 0, mz = 0;
    for (const p of c.pts) { mx += p.x; mz += p.z; }
    mx /= c.pts.length; mz /= c.pts.length;
    midX[i] = mx; midZ[i] = mz;
    acc += c.len * regionW(mx, -mz);   // regionW 用 plan 坐标，planY = -z
    cumW[i] = acc;
  }

  const pickGlobal = () => {
    const r = rnd() * acc;
    let lo = 0, hi = cumW.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cumW[m] < r) lo = m + 1; else hi = m; }
    return usable[lo];
  };

  // 【热点配额】只做全局加权，人会均摊到 1772 km 人行道网上——默认机位
  // （4 km 高空俯瞰 / 街景平视）一个人都碰不到，用户看到的就是空城。
  // 这里给每个默认机位圈一个半径，先保证圈内至少这么多个行人，
  // 剩下的再按全局权重撒。坐标是 three（z = -planY）。
  const HOT = [
    // [x, z, radius_m, quota]  —— 只留一个集中区（用户：「保留一个地方集中分布」）
    // 与 main.js 的初始机位对齐：白宫 + 拉斐特广场（视角正对的那一片）。
    [1144, -815, 230, 420],
  ];
  // 集中区之外的人数：其余全部按链长均匀撒在全城步行网上。
  const CLUSTER_SHARE = 0.14;   // 集中区占 14%
  const nCluster = Math.round(count * CLUSTER_SHARE);
  // 每条热点预先挑出半径内的可用链
  const hotPools = HOT.map(([hx, hz, hr]) => {
    const pool = [];
    let w = 0;
    const cum = [];
    for (let i = 0; i < usable.length; i++) {
      const dx = midX[i] - hx, dz = midZ[i] - hz;
      if (dx * dx + dz * dz > hr * hr) continue;
      const L = G.chains[usable[i]].len;
      w += L; pool.push(i); cum.push(w);
    }
    return { pool, cum, w };
  });
  const pickHot = (h) => {
    const { pool, cum, w } = hotPools[h];
    const r = rnd() * w;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m; }
    return usable[pool[lo]];
  };

  // 先铺集中区，其余走全局均匀（按链长）。
  const plan = [];
  for (let h = 0; h < hotPools.length; h++) {
    if (!hotPools[h].pool.length) continue;
    const quota = h === 0 ? nCluster : HOT[h][3];
    const want = Math.min(quota, count - plan.length);
    for (let i = 0; i < want; i++) plan.push(pickHot(h));
  }
  while (plan.length < count) plan.push(pickGlobal());
  // 打散顺序，避免同一热点的链连续出生（否则初始画面像排队）
  for (let i = plan.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = plan[i]; plan[i] = plan[j]; plan[j] = t;
  }
  let planCursor = 0;
  const pickChain = () => (planCursor < plan.length ? plan[planCursor++] : pickGlobal());

  const group = new THREE.Group();
  group.name = 'L6_agents';

  const peds = [];
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _tmp = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    const tpl = useTpl[Math.min(useTpl.length - 1, rnd() < 0.52 ? 0 : 1)];
    const ci = pickChain();
    const c = G.chains[ci];

    const obj = skeletonClone(tpl.scene);
    obj.scale.setScalar(tpl.userData.scale);
    obj.name = 'ped_' + i;
    obj.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
        o.frustumCulled = true;
      }
    });
    group.add(obj);

    const mixer = new THREE.AnimationMixer(obj);
    const acts = {};
    for (const clip of tpl.animations) {
      const a = mixer.clipAction(clip);
      a.setLoop(THREE.LoopRepeat, Infinity);
      acts[clip.name] = a;
    }

    const jogger = rnd() < 0.07;
    peds.push({
      i, obj, mixer, acts, tpl,
      ci, dir: rnd() < 0.5 ? 1 : -1,
      s: rnd() * c.len,
      speed: (jogger ? SPEED_RUN : SPEED_WALK) * (0.86 + rnd() * 0.28),
      state: rnd() < 0.22 ? 'idle' : 'walk',
      stateT: 0,
      nextThink: rnd() * 1.2,
      cur: null,
      jogger,
      // 身高归一化后脚底未必正好在 0：补一个固定偏移
      footFix: -tpl.userData.minY * tpl.userData.scale,
      lat: 0,
      latTarget: 0,
      blockedT: 0,
      visible: true,
      dist: 1e9,
      yaw: 0,
      // 积水避险（2026-10-26）：mode = 'net' 正常走网 / 'flee' 正在跑 / 'shelter' 已到
      mode: 'net', refuge: null, calmT: 0, climb: 1, baseY: 0, fromX: 0, fromZ: 0,
      trapped: 0,
    });
  }

  const clipOf = (p) => {
    if (p.state === 'idle') return 'idle';
    if (p.state === 'look') return 'look';
    if (p.state === 'yield') return rnd() < 0.5 ? 'side_l' : 'side_r';
    return p.jogger ? 'run' : 'walk';
  };

  function play(p, name, fade = 0.28) {
    const a = p.acts[name] || p.acts.idle;
    if (!a || p.cur === a) return;
    a.reset();
    a.setEffectiveTimeScale(1);
    a.setEffectiveWeight(1);
    if (p.cur) { a.crossFadeFrom(p.cur, fade, false); a.play(); }
    else { a.fadeIn(fade).play(); }
    p.cur = a;
  }

  for (const p of peds) play(p, clipOf(p), 0.01);

  // 【必须】出生位置立刻算好。
  // 之前只在 update() 的距离裁剪之后才摆位置，而距离是用 obj.position 量的 ——
  // 新生的 obj 还在 (0,0,0)，到相机几千 DOM 米，于是「不可见 → 不摆位 → 永远不可见」死锁。
  for (const p of peds) {
    const c = G.chains[p.ci];
    pointAt(c, Math.min(Math.max(p.s, 0), c.len), _v);
    pointAt(c, Math.min(p.s + 1.2, c.len), _v2);
    let tx = (_v2.x - _v.x) * p.dir, tz = (_v2.z - _v.z) * p.dir;
    if (Math.abs(tx) + Math.abs(tz) < 1e-5) { tx = 0; tz = p.dir; }
    p.yaw = Math.atan2(tx, tz);
    const gy = groundAt(_v.x, _v.z);
    p.obj.position.set(_v.x, gy + p.footFix, _v.z);
    p.obj.rotation.y = p.yaw;
  }

  // ---------------------------------------------------------------- 每帧
  const camPos = new THREE.Vector3();
  let frame = 0;
  const _ds = { d: 0, wet: false };   // 水深采样回填
  // 【被困统计】2026-10-26 按用户要求新增「有多少人被彻底困住无法逃生」。
  // 每换一帧积涝数据重算一次可涉水连通域（6 m 栅格，85 万格，约 20~30 ms），
  // 人只查自己落在哪一块：是不是主城（最大干地连通域）、那块有没有避难所。
  const trappedIdx = createTrappedIndex(refuges);
  let trapStats = { trapped: 0, stranded: 0, drowning: 0, reachable: 0,
                    comps: 0, islets: 0, passCells: 0, mainlandPct: 0 };
  let trapDirty = true;

  /** 开始逃难：找最近可直达的避难所。返回是否找到。 */
  function startFlee(p) {
    const R = findRefuge(p.obj.position.x, p.obj.position.z, null);
    if (!R) return false;
    p.mode = 'flee';
    p.refuge = R;
    p.state = 'flee';
    p.stateT = 0;
    p.calmT = 0;
    play(p, 'run', 0.16);
    return true;
  }

  /**
   * 水退了：接回最近的步行链，继续正常行走。
   * @param dInfo 可选，水深采样器。传了就会避开还泡在水里的链（见 nearestChain）。
   * @returns 是否真的接回了网（false = 附近没有干的地方，继续躲）
   */
  function rejoinNet(p, dInfo) {
    const hit = nearestChain(p.obj.position.x, p.obj.position.z, dInfo || null);
    if (!hit) return false;
    p.mode = 'net';
    p.refuge = null;
    p.ci = hit.ci;
    p.s = Math.min(Math.max(hit.s, 0.4), Math.max(0.4, G.chains[hit.ci].len - 0.4));
    p.dir = rnd() < 0.5 ? 1 : -1;
    p.state = 'walk';
    p.stateT = 0;
    p.lat = 0; p.latTarget = 0;
    play(p, 'walk', 0.25);
    return true;
  }

  /** 阴影距离裁剪 + 动画降频（逃难和正常行走共用） */
  function placeShadow(p, dt) {
    const shadowOn = p.dist < SHADOW_DIST;
    if (p.shadowOn !== shadowOn) {
      p.shadowOn = shadowOn;
      p.obj.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) o.castShadow = shadowOn; });
    }
    const far = p.dist > MIXER_LOD_DIST;
    if (!far || (frame + p.i) % 3 === 0) p.mixer.update(dt * (far ? 3 : 1));
  }

  /** 逃难/躲避：离开步行网，直走最近避难所；到了就站定，水退干净再回街上。 */
  function updateFlee(p, dt, dInfo) {
    const R = p.refuge;
    if (!R) { p.mode = 'net'; return; }

    const px = p.obj.position.x, pz = p.obj.position.z;
    const dx = R.x - px, dz = R.z - pz;
    const dist = Math.hypot(dx, dz);

    // ---- 已经站定了：等水退
    if (p.mode === 'shelter') {
      p.stateT += dt;
      if (p.climb < 1) {
        // 从楼下"上到屋顶"：1.2 秒内抬到位，不做楼梯（用户明说不用真进去）
        p.climb = Math.min(1, p.climb + dt / 1.2);
      }
      // 水平：从进楼点平滑挪到屋顶中心；竖直：从地面抬到顶面
      const k = p.climb;
      const x = p.fromX + (R.x - p.fromX) * k;
      const z = p.fromZ + (R.z - p.fromZ) * k;
      const base = R.kind === 1 ? (p.baseY + (R.y - p.baseY) * k) : R.y;
      p.obj.position.set(x, base + p.footFix, z);
      // 水退判定：以避难所位置的地面水深为准，干满 SHELTER_CALM 秒才敢出来
      let dry = true;
      if (dInfo) { dInfo(R.x, R.z, _ds); dry = !_ds.wet; }
      p.calmT = dry ? p.calmT + dt : 0;
      // 【别在这里只判 dry 不回网】rejoinNet 会自己再查一次落点水深，
      // 落点还湿就返回 false —— 那就把 calmT 归零，下一轮重新等。
      if (p.climb >= 1 && p.calmT >= SHELTER_CALM) {
        if (!rejoinNet(p, dInfo)) p.calmT = 0;
      }
      placeShadow(p, dt);
      return;
    }

    // ---- 还在跑
    const arrive = R.kind === 1 ? 4.5 : 2.4;
    if (dist <= arrive) {
      p.mode = 'shelter';
      p.state = 'shelter';
      p.stateT = 0;
      p.calmT = 0;
      p.climb = R.kind === 1 ? 0 : 1;
      p.baseY = groundAt(px, pz);
      p.fromX = px; p.fromZ = pz;
      play(p, 'idle', 0.22);
      placeShadow(p, dt);
      return;
    }

    // 朝避难所直走（忽略路网与楼，最后一小段是"进楼"）
    const ux = dx / (dist || 1), uz = dz / (dist || 1);
    const yawWanted = Math.atan2(ux, uz);
    let dYaw = yawWanted - p.yaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    p.yaw += dYaw * Math.min(1, dt * (1 / Math.max(0.05, 1 - FLEE_TURN_IN)));

    const step = Math.min(dist, FLEE_SPEED * dt);
    const nx2 = px + ux * step, nz2 = pz + uz * step;
    const gy = groundAt(nx2, nz2);
    p.obj.position.set(nx2, gy + p.footFix, nz2);
    p.obj.rotation.y = p.yaw;
    placeShadow(p, dt);
  }

  function update(dt, camera, flood) {
    frame++;
    camPos.copy(camera.position);
    const dInfo = (flood && flood.depthInfo) ? flood.depthInfo : null;

    // ---- 被困判定用的连通域：换帧才重算
    // 【为什么绑帧不绑时间】连通域只跟水深场有关，同一帧里人怎么移动都不改变
    // 「哪块地是岛、岛上有不有避难所」。按帧缓存，播放时每换一帧算一次
    // （约 20~30 ms），拖时间轴、暂停都不浪费。
    let tst = null;
    if (flood && flood.depthGrid) {
      const g = flood.depthGrid;
      const key = flood.frameKey || '';
      const base = trappedIdx.update(g, key);
      // 复制一份再归零计数：update() 返回的是模块内部复用的对象，
      // 直接改它会把「连通域层面」的统计（comps/islets/passCells）一起写坏
      trapStats = {
        trapped: 0, stranded: 0, drowning: 0, reachable: 0,
        comps: base.comps, islets: base.islets,
        passCells: base.passCells, mainlandPct: base.mainlandPct,
      };
      tst = trapStats;
    }

    // 人-人分离：4 m 空间哈希，O(n)
    const buckets = new Map();
    const bk = (cx, cz) => cx * 73856093 ^ cz * 19349663;
    for (const p of peds) {
      if (!p.visible) continue;
      const a = buckets;
      const k = bk(Math.floor(p.obj.position.x / CELL_PED), Math.floor(p.obj.position.z / CELL_PED));
      let arr = a.get(k);
      if (!arr) a.set(k, (arr = []));
      arr.push(p);
    }

    for (const p of peds) {
      p.stateT += dt;

      // ---- 距离裁剪
      p.dist = p.obj.position.distanceTo(camPos);
      const vis = p.dist < VIS_DIST;
      if (vis !== p.visible) { p.visible = vis; p.obj.visible = vis; }

      // ---- 被困判定：必须在**所有** continue 之前（全城 3000 人全要统计，
      // 不能只算看得见的；避险状态的人也要算 —— 他们最可能是被困的那批）
      // p.trapped: 0=在主城干地上能走掉 1=孤岛但有避难所（活着但出不去）
      //            2=孤岛且无避难所（彻底被困） 3=已泡在深水里
      p.trapped = tst ? trappedIdx.query(p.obj.position.x, p.obj.position.z) : 0;
      if (tst) {
        if (p.trapped === 0) trapStats.reachable++;
        else if (p.trapped === 1) trapStats.stranded++;
        else if (p.trapped === 2) trapStats.trapped++;
        else if (p.trapped === 3) { trapStats.drowning++; trapStats.trapped++; }
      }

      // ---- 积水避险：先看脚下有没有水
      // 【必须在距离裁剪之前】城市总览机位下 3000 人全在 VIS_DIST 之外，
      // 放在裁剪之后人就永远不动 —— 实测 5 秒后 flee 人数一直是 0。
      // 水深采样是 O(1) 查表，跑动也是一次向量运算，全量算不心疼。
      // 只有真的开了积涝叠层（flood 传进来且可见）才响应，否则人照常走路。
      if (dInfo) {
        dInfo(p.obj.position.x, p.obj.position.z, _ds);
        if (p.mode === 'net') {
          if (_ds.wet) {
            // 找不到避难所时不要每帧都去搜（findRefuge 要扫空间索引）
            p.tryT = (p.tryT || 0) - dt;
            if (p.tryT <= 0) { p.tryT = 1.5; startFlee(p); }
          }
        } else {
          updateFlee(p, dt, dInfo);
          continue;
        }
      } else if (p.mode !== 'net') {
        // 叠层被关掉了：原地放回步行网，不要把人留在半空
        rejoinNet(p);
      }

      if (!vis) continue;

      const c = G.chains[p.ci];
      pointAt(c, Math.min(Math.max(p.s, 0), c.len), _v);

      const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);

      // ---- 静态障碍：几米外就掉头
      let hardBlock = false;
      for (const t of [LOOK_AHEAD * 0.5, LOOK_AHEAD]) {
        const ax = _v.x + fx * t, az = _v.z + fz * t;
        if (!inBounds(ax, az) || isWater(ax, az) || blocker.blocked(ax, az, 0.5)) { hardBlock = true; break; }
      }
      // 侧面再探一次，防止宽肩膀擦墙
      if (!hardBlock) {
        const nx = fz, nz = -fx;
        for (const sgn of [1, -1]) {
          const ax = _v.x + nx * 0.7 * sgn + fx * 1.0;
          const az = _v.z + nz * 0.7 * sgn + fz * 1.0;
          if (blocker.blocked(ax, az, 0.3)) { hardBlock = true; break; }
        }
      }

      // ---- 前方有人
      let pedAhead = false;
      const cx = Math.floor(_v.x / CELL_PED), cz = Math.floor(_v.z / CELL_PED);
      const vx = p.obj.position.x, vz = p.obj.position.z;
      for (let i = -1; i <= 1 && !pedAhead; i++) {
        for (let j = -1; j <= 1 && !pedAhead; j++) {
          const arr = buckets.get(bk(cx + i, cz + j));
          if (!arr) continue;
          for (const o of arr) {
            if (o === p) continue;
            const dx = o.obj.position.x - vx, dz = o.obj.position.z - vz;
            if (dx * dx + dz * dz > PED_AVOID * PED_AVOID) continue;
            if (dx * fx + dz * fz > 0.9) { pedAhead = true; break; }
          }
        }
      }
      // 横向让开：往右偏 0.55 m（右侧通行），让完收回
      p.latTarget = pedAhead ? 0.55 : 0;

      // ---- 静态障碍调头
      if (hardBlock) {
        p.blockedT += dt;
        p.dir = -p.dir;
        // 位置沿着当前链回退一点，避免卡在链尾
        p.s = Math.min(Math.max(p.s, 0.4), Math.max(0.4, c.len - 0.4));
        play(p, 'turn180', 0.18);
        p.state = 'walk'; p.stateT = 0;
        // 用当前朝向反推：把 yaw 加 180°，这一刻不要向前走
        p.yaw += Math.PI;
        continue;
      }
      p.blockedT = 0;

      // ---- 状态推进（每 0.4~1.2 s 想一次）
      p.nextThink -= dt;
      if (p.nextThink <= 0) {
        p.nextThink = 0.4 + rnd() * 0.9;
        const ns = nextState(p.state, {
          blocked: pedAhead && p.blockedT > 0.6,
          nearEnd: p.s > c.len - 2.0 || p.s < 2.0,
          rnd: rnd(),
          cooldownOk: p.stateT > 0.6,
        });
        if (ns !== p.state) {
          p.state = ns; p.stateT = 0;
          play(p, clipOf(p), ns === 'walk' ? 0.22 : 0.34);
        }
      }

      // ---- 位移
      let spd = 0;
      if (p.state === 'walk') spd = p.speed * (pedAhead ? 0.55 : 1.0);
      else if (p.state === 'yield') spd = 0;
      p.s += spd * dt * p.dir;

      // ---- 到端点：换相邻链（不掉头优先）
      if (p.s > c.len || p.s < 0) {
        const atHead = p.s > c.len;
        const nodeIdx = atHead ? c.ids[c.ids.length - 1] : c.ids[0];
        const cand = (G.adj[nodeIdx] || []).filter((e) => e.ci !== p.ci);
        if (cand.length) {
          const pick = cand[(rnd() * cand.length) | 0];
          const nc = G.chains[pick.ci];
          p.ci = pick.ci;
          p.dir = pick.dir;
          p.s = pick.dir > 0 ? 0.25 : nc.len - 0.25;
        } else {
          p.dir = -p.dir;
          p.s = atHead ? c.len - 0.25 : 0.25;
          play(p, 'turn180', 0.18);
        }
      }

      // ---- 摆位 + 朝向
      const c2 = G.chains[p.ci];
      const s2 = Math.min(Math.max(p.s, 0), c2.len);
      pointAt(c2, s2, _v);
      pointAt(c2, Math.min(s2 + 1.2, c2.len), _v2);
      let tx = (_v2.x - _v.x) * p.dir, tz = (_v2.z - _v.z) * p.dir;
      if (Math.abs(tx) + Math.abs(tz) < 1e-5) { tx = Math.sin(p.yaw); tz = Math.cos(p.yaw); }
      const yawWanted = Math.atan2(tx, tz);          // 模型朝 +z

      // 平滑转向
      let dYaw = yawWanted - p.yaw;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      p.yaw += dYaw * Math.min(1, dt * 6.5);

      // 横向让路偏移（右法向）
      p.lat += (p.latTarget - p.lat) * Math.min(1, dt * 3.2);
      const nx = Math.cos(p.yaw), nz = -Math.sin(p.yaw);   // 朝 +z 时的右向量
      const gy = groundAt(_v.x + nx * p.lat, _v.z + nz * p.lat);
      p.obj.position.set(_v.x + nx * p.lat, gy + p.footFix, _v.z + nz * p.lat);
      p.obj.rotation.y = p.yaw;

      // ---- 阴影距离 + 动画降频
      const shadowOn = p.dist < SHADOW_DIST;
      if (p.shadowOn !== shadowOn) {
        p.shadowOn = shadowOn;
        p.obj.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) o.castShadow = shadowOn; });
      }
      const far = p.dist > MIXER_LOD_DIST;
      if (!far || (frame + p.i) % 3 === 0) p.mixer.update(dt * (far ? 3 : 1));
    }
  }

  // ---------------------------------------------------------------- 开关
  function setVisible(on) { group.visible = !!on; }
  function setCount(n) {
    n = Math.max(0, Math.min(peds.length, n | 0));
    for (let i = 0; i < peds.length; i++) {
      peds[i].enabled = i < n;
      if (!peds[i].enabled) peds[i].obj.visible = false;
    }
    return n;
  }

  return {
    group, peds, update, setVisible, setCount, graph: G,
    /** 积水避险的实时状态（验收/截图时用：console 里看有多少人在跑、多少人躲着）。 */
    fleeStats() {
      let net = 0, flee = 0, shelter = 0, roof = 0, escaped = 0;
      for (const p of peds) {
        if (p.mode === 'flee') flee++;
        else if (p.mode === 'shelter') { shelter++; if (p.refuge && p.refuge.kind === 1) roof++; }
        else net++;
        if (p.mode === 'shelter') escaped++;
      }
      return {
        net, flee, shelter, roof, refuges: refuges.length,
        // 【彻底被困】站在孤岛上、岛上没有任何高地的那些人 —— 洪水不走，他们就
        // 一天也出不去，救援也进不来。这是用户 m03597 要的那个数。
        trapped: trapStats.trapped,
        // 孤岛但岛上有高地/屋顶：暂时活得下来，等水退才能出来
        stranded: trapStats.stranded,
        // 已经泡在 >30 cm 深水里、12 m 内连干格都没有的那一批（含在 trapped 里）
        drowning: trapStats.drowning,
        // 还在主城干地上、能自由走掉的人
        reachable: trapStats.reachable,
        total: peds.length,
        // 连通域层面：全城被洪水切成多少块可涉水区、其中多大的块还是连着的
        comps: trapStats.comps, islets: trapStats.islets,
        mainlandPct: trapStats.mainlandPct,
        wadeMax: 0.30,
      };
    },
    stats: {
      usable: usable.length, total: G.chains.length, dropped, count: peds.length,
      hot: hotPools.map((h) => h.pool.length),
      quota: HOT.map((h) => h[3]),
      planned: plan.length,
    },
  };
}
