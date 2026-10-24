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
 */
function buildBlocker(B) {
  const CELL = 24;
  const grid = new Map();
  const kk = (cx, cz) => cx * 73856093 ^ cz * 19349663;
  const polys = [];   // {pts:[[x,z]...], x0,x1,z0,z1}
  const V = B.verts, meta = B.meta;

  for (const b of B.buildings) {
    if (!(b.height_m > 2.0)) continue;      // 台阶/平台不算障碍
    const v0 = b.v0, vc = b.vc || 4;
    const pts = [];
    for (let i = 0; i < vc; i++) {
      const o = (v0 + i) * 4;
      pts.push([V[o], V[o + 1]]);           // x, z 已经是 three 坐标
    }
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of pts) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    polys.push({ pts, x0, x1, z0, z1 });
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

  function update(dt, camera) {
    frame++;
    camPos.copy(camera.position);

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
    stats: {
      usable: usable.length, total: G.chains.length, dropped, count: peds.length,
      hot: hotPools.map((h) => h.pool.length),
      quota: HOT.map((h) => h[3]),
      planned: plan.length,
    },
  };
}
