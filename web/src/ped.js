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
import { createRoutePlanner } from './route-brain.js';
import { createLiveAgents, ACTION_SPEED_MUL } from './live-agent.js';
import { createExperience } from './experience.js';
import { STATUS_BASE } from './roles.js';
import { WALK, ANIM, CAR, assertSpeedConsistency } from './motion-units.js';
import { circleOf, summarize as summarizeCircles } from './social-circles.js';
import { createIncidents } from './incidents.js';
import { createDriveLayer } from './drive-layer.js';
import { warnAtOf, WARNING_SELF_SET } from './kernel/warning.js';
import { wadingSpeed } from './kernel/hazard-input.js';
import { BASEMENT, goesToBasement, basementStayMin, basementElevationM }
  from './kernel/floors.js';

// ---------------------------------------------------------------- 常量
const TARGET_H_MALE = 1.82;     // 男性身高（米）
const TARGET_H_FEMALE = 1.68;
// 【2026-11-13 速度单一真值】步速/跑速/避险速度全部读 motion-units.js，
// 不再各写一份 1.42 / 3.05 / 3.3 / 1.7。倍率只在 clock.js 乘一次。
const SPEED_WALK = WALK.BASE;
const SPEED_RUN = WALK.RUN;
const VIS_DIST = 360;           // 超过这个距离整个隐藏（全城铺开后街景里也要看得见人）
const SHADOW_DIST = 90;
const MIXER_LOD_DIST = 70;
const CELL_PED = 4.0;           // 人-人分离的空间哈希格
const LOOK_AHEAD = 2.6;         // 静态障碍探测距离（米，"差几米就掉头"）
const PED_AVOID = 3.2;          // 前方多远算被人挡

// ---------------------------------------------------------------- 积水避险（2026-10-26）
// 用户要求：「让人对积水有反应，可以自主前往高处未有积水的地方，比如高地、高楼
//          （不用真的进去，站在房顶就表示进入高楼）」。
// 【2026-11-10 修正】用户反馈「好多人都在空中、有的在屋顶」——把人整批抬上
// 屋顶（45 m 高、还从地面插值爬升）看起来就是悬浮。改为：
//   · 高楼避难所（kind=1）＝「进楼」：人沿真实路网走到**楼边墙根/檐下**就停，
//     站在地面高程，不再水平挪进楼心、更不再抬到顶面；
//   · 高地避难所（kind=0）＝ walknet 上高程靠前的真实抬高点，人站在那块
//     真实地面上（本来就是贴地的）。
// 任何状态下都不再有「人凌空站立」的帧。
// 做法：人脚下的水深 ≥ FLEE_DEPTH 就切换成『逃难』——沿路网走向最近的避难所；
//      走到（或碰到墙）就转入『躲着』并停住，水退了再回步行网继续走。
const FLEE_DEPTH = 0.12;        // 米。12 cm 齐踝，普通人不会继续走
const FLEE_SPEED = WALK.FLEE;    // 逃难速度（米/仿真秒，接近快跑）
const RAIN_SPEED = WALK.RAIN;    // 避雨速度（米/仿真秒，快步走）
const FLEE_TURN_IN = 0.55;      // 每帧朝目标转多少（0..1，越大越急）
const REFUGE_MAX = 620;         // 最近避难所超过这个距离就不找了（不现实）
const REFUGE_TRIES = 6;         // 直线被楼挡住时最多再换几个候选
const SHELTER_CALM = 8.0;       // 水退干净这么久之后才敢回街上（秒）
const HIGH_Q = 0.80;            // 「高地」定义：walknet 高程前 20% 的点
// 决策运行时在下方装配；play() 的首次调用发生在装配之前（初始化动画），
// 因此这里先声明为 null，避免 TDZ。clipTimeScale() 会自动走兜底。
let LIVE = null;
const RAIN_SHELTER_MMH = 10;    // 雨强超过这个（mm/h）才躲雨；毛毛雨照常走
const RAIN_REFUGE_MAX = 220;    // 躲雨只找 220 m 内，不跨城冲向同一个高地

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

  // 【马克】office_worker.glb 是之前给单人分镜导出的高模（65 骨骼 / 18 段动作，
  // 动作名与 ped.js 的 idle / walk / run / look / side_l 一致，能直接复用状态机）。
  // 只加载一份、只给一个人用，所以不进 LOD 列表。
  let hero = null;
  try {
    const g = await loader.loadAsync(base + 'office_worker.glb');
    g.scene.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(g.scene);
    g.userData.height = Math.max(0.1, bb.max.y - bb.min.y);
    g.userData.minY = bb.min.y;
    g.userData.scale = TARGET_H_MALE / g.userData.height;
    hero = g;
    console.log(`[ped] 马克高模已载入：${(g.animations || []).length} 段动作`);
  } catch (e) {
    console.warn('[ped] 马克高模缺失，用普通模板代替', e && e.message);
  }

  return { templates: [male, female], lod, net, hero };
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
/**
 * 【2026-11-16 阶段2B】行人微行为状态机。
 * 用户反馈「走两步停一下，很呆板」。旧版 walk 每秒有 1% 概率转 look，
 * look 又常转 idle，纯无记忆随机跳，没有「至少走满一段」的约束，于是
 * 平均十几秒就被打断一次，看着一顿一顿。
 *
 * 依据（别人怎么做）：Springer 2023 疏散 ABM 的三层决策里，最底层
 * 「操作层」每步都在走，只在被挡/避碰时才改；Christensen & Sasaki 的
 * 离散步行模型里人一直走到格子被占才停。也就是说「走」是默认持续态，
 * 「停/张望」由事件触发（被挡、到端点、决策层要求等），不是定时随机跳。
 *
 * 改法：walking 至少持续 WALK_MIN_SEC；这段时间内只响应 blocked/yield，
 * 不随机转 look/idle。look 也设最短时长，避免 look↔idle 来回抖。
 * 这些最低时长是工程实现，台账标「目前自己定的」。
 */
export const WALK_MIN_SEC = 2.2;   // 一次起步至少走这么久才允许随机张望
export const LOOK_MIN_SEC = 0.8;
export function nextState(st, obs) {
  // 【修 2026-11-17】obs 为空时原先直接抛错；rnd 为 undefined/NaN 时所有
  // 比较为 false，idle 会变成吸收态（人永久站着不动）。
  const o = obs && typeof obs === 'object' ? obs : {};
  const rawR = Number(o.rnd);
  const r = Number.isFinite(rawR) ? Math.max(0, Math.min(1, rawR)) : 0.5;
  const t = Number.isFinite(o.stateT) ? o.stateT : 999; // 缺省视为已走够，兼容旧调用
  switch (st) {
    case 'idle':
      if (o.nearEnd) return 'walk';
      if (r < 0.34) return 'walk';
      if (r < 0.50) return 'look';
      return 'idle';
    case 'look':
      if (o.blocked) return 'yield';
      if (t < LOOK_MIN_SEC) return 'look';     // 张望也要有个最短时长，不来回抖
      if (r < 0.30) return 'idle';
      return 'walk';
    case 'walk':
      if (o.blocked) return 'yield';         // 被挡是事件，立刻响应，不受最短时长限制
      if (t < WALK_MIN_SEC) return 'walk';     // 走满一段之前不随机停
      if (r < 0.006) return 'look';            // 随机张望概率从 1%/s 降到 0.6%/s
      return 'walk';
    case 'yield':
      if (!o.blocked && o.cooldownOk) return 'walk';
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
/**
 * 个体档案（A 档：20~30 人，每个人要是「一个人」而不是「一个模板换颜色」）。
 *
 * 【为什么要有 wade】原来所有人一踩到水就往高处跑 —— 3000 人整齐划一，
 * 那不叫自主性。真实情况是：赶时间的硬涉，膝盖不好的见水就绕，
 * 外卖员戴着耳机根本没听见预警，工头觉得「这边从来没淹过」。
 * 所以每个人有自己的涉水上限、风险厌恶和职责，行为自然分叉。
 */
/**
 * 马克的档案。**刻意不放进 PROFILES** —— 放进去会被 pickProfile 随机抽到，
 * 于是场上出现好几个「马克」（实测 24 人里出现 3 个）。
 * 他只是一个普通档案 + 高模，没有第二套逻辑。
 */
export const HERO_PROFILE = {
  id: 'mark', label: '马克', wade: 0.26, risk: 1.2, duty: 'home',
  note: '联邦雇员，今天本来只是来上班',
};

export const PROFILES = [
  { id: 'commuter', label: '上班族',   wade: 0.30, risk: 1.0, duty: 'home',  note: '赶时间，水到小腿也硬走' },
  { id: 'elder',    label: '老人',     wade: 0.10, risk: 1.7, duty: null,    note: '膝盖不好，见水就绕，宁可多走两公里' },
  { id: 'parent',   label: '接孩子的家长', wade: 0.24, risk: 1.3, duty: 'school', note: '先往学校方向去，孩子还在那儿' },
  { id: 'worker',   label: '工地工人', wade: 0.46, risk: 0.7, duty: 'site',  note: '干惯了，不当回事，还敢往回走' },
  { id: 'rider',    label: '外卖员',   wade: 0.34, risk: 0.9, duty: null,    note: '耳机里在放歌，可能压根没听见预警' },
  { id: 'nurse',    label: '护士',     wade: 0.26, risk: 1.1, duty: 'hospital', note: '要回医院接班，绕远也得去' },
  { id: 'tourist',  label: '游客',     wade: 0.20, risk: 1.4, duty: null,    note: '不认路，容易跟着人群跑错方向' },
  { id: 'resident', label: '本地居民', wade: 0.28, risk: 1.2, duty: 'home',  note: '认得哪条巷子不积水' },
];

/** 按随机数挑一个档案（带权重：上班族和居民最多）。 */
function pickProfile(r) {
  const w = [3, 1, 2, 1, 2, 1, 1, 3];      // 与 PROFILES 一一对应
  const tot = w.reduce((a, b) => a + b, 0);
  let x = r * tot;
  for (let i = 0; i < w.length; i++) {
    x -= w[i];
    if (x <= 0) return PROFILES[i];
  }
  return PROFILES[0];
}

export function buildPedestrians(assets, opt = {}) {
  const T = opt.T;
  // 【2026-11-07】随机行人的社会层（身份 / Brain / 生理 / 场景），无则退回纯随机游走
  const CROWD = opt.crowdLife || null;
  // 相机此刻进的是哪栋楼（main.js 的剖切判定）。楼里的人只有剖开那一栋
  // 才显示，否则实心楼体外面会看到一群人穿墙站在半空。
  const CAM_PLACE = typeof opt.camPlace === 'function' ? opt.camPlace : null;
  // 统一实体碰撞层：灯杆 / 树 / 停放车 / 家具。行人是「人」，不该被楼体挡住
  // （楼体由路网和出生点筛选负责），所以查询时忽略 building 标签。
  const COLLIDE_PED = opt.collide || null;
  const IGNORE_BUILDING = new Set(['building']);
  // 【2026-11-13 建筑实体硬约束】可走链只在初始化时筛过一次，route 模式的
  // A* 折线、flee 的直线兜底、以及 net 换链都可能把室外的人送进楼体 AABB。
  // main.js 装配完 SOLIDS 后晚绑定进来，写位置的那一帧统一做「室内豁免」检查。
  let SOLIDS = opt.solids || null;
  const setSolids = (s) => { SOLIDS = s || null; };
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
  // 【LDT 图层】有就把「最晚出发时刻」也接进来（见 web/src/ldt.js）。
  // 没有就退化成老口径（只统计静止快照的被困人数），不影响场景。
  let LDT = opt.ldt || null;   // `let`：main.js 切工况时可以整体换表（见 setLdt）

  const isWater = (x, z) => !!(T && T.classify && T.classify(x, z) === 0);
  const W = { x0: -1277, x1: 4701, z0: -4189, z1: 931 };
  const inBounds = (x, z) => x > W.x0 + 8 && x < W.x1 - 8 && z > W.z0 + 8 && z < W.z1 - 8;

  // 可走段：整条链每隔一段抽检，任何一处被建筑/水/界外占住就整条丢掉。
  // （步行图是按路网算的，理论上都在人行道上；这一步是防数据脏。）
  const usable = [];
  let dropped = { short: 0, blocked: 0, water: 0, ldt: 0 };
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
      // LDT 标了「开局就泡在深水里」的格：人不能站那儿（4 m 增水一来就是一米多深）
      if (LDT && LDT.spawnOk && !LDT.spawnOk(p.x, p.z)) { bad = true; dropped.ldt++; break; }
    }
    if (!bad) usable.push(ci);
  }
  // 【只在一个街区里放人】默认 24 人如果撒在全城 16595 条链上，彼此相隔几公里，
  // 谁也看不见谁，更谈不上「社会关系」。传 opt.center = [x, z, r] 就把出生地
  // 收进半径 r 内 —— A 档的 20~30 人本来就该挤在同一条街上。
  if (opt.center && usable.length) {
    const [cx, cz, cr] = opt.center;
    const near = [];
    const _p = new THREE.Vector3();
    for (const ci of usable) {
      const c = G.chains[ci];
      let best = 1e9;
      for (let d = 0; d <= c.len; d += 12) {
        pointAt(c, d, _p);
        const dd = Math.hypot(_p.x - cx, _p.z - cz);
        if (dd < best) best = dd;
        if (best < cr) break;
      }
      if (best < cr) near.push(ci);
    }
    if (near.length >= 6) {
      console.log(`[ped] 收拢到街区：${usable.length} 条链 → ${near.length} 条（半径 ${cr} m）`);
      usable.length = 0;
      usable.push(...near);
    }
  }

  if (!usable.length) throw new Error('没有可走的步行链（walknet 数据异常）');

  // ---------------------------------------------------------------- 避难所索引
  // 【积水避险】2026-10-26 按用户要求新增：
  //   「让人对积水有反应，可以自主前往高处未有积水的地方，比如高地、高楼
  //    （不用真的进去，站在房顶就表示进入高楼）」。
  // 【2026-11-10 修正】站屋顶在画面上就是「人悬在空中」。屋顶目标保留（它
  // 仍代表「这栋楼可以进」），但人到达后停在楼边檐下的**地面**上：
  //   ① 楼（kind=1）：height>=6 m、面积>=80 m²。目标点取楼心（A* 会把路线
  //      引到楼附近），人走到墙边就算进去了 —— 不再爬上顶面。
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

  // 【避免故意扎堆 2026-11-12】每个避难所有真实容量与当前占用。旧版所有人
  // 一律选「最近且高出 1 m」的那一个点，实测 18:00 一个 120 m 网格挤了
  // 240 人（224 个 shelter）。现在选点时把占用量折算成距离惩罚，并按人序
  // 做确定性扰动，人自然铺到附近多处楼边/高地，而不是全城冲向同一栋楼。
  for (let ri = 0; ri < refuges.length; ri++) {
    const R = refuges[ri];
    R.idx = ri;
    R.cap = R.kind === 1 ? 12 : 8;
  }
  const refugeLoad = new Map();           // idx -> 当前占用人数
  const rLoad = (R) => refugeLoad.get(R.idx) || 0;
  // 【灾害履历验收接口】每次避险选址把「这个人经验多少 / 选了多高 / 走了多远」
  // 记下来，探针可以逐人核对经验是不是真的改变了选址，而不是只看代码注释。
  const refugePicks = new Map();
  function syncRefugeLoad() {
    refugeLoad.clear();
    for (const p of peds) {
      if (p.refugeRef && (p.mode === 'flee' || p.mode === 'shelter'
        || (p.route && p.route.onArrive === 'shelter'))) {
        refugeLoad.set(p.refugeRef.idx, rLoad(p.refugeRef) + 1);
      }
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

  /**
   * 找离 (x,z) 最近且直线可达的避难所；avoid 用来排除刚失败的那个。
   *
   * 【needHigh】避雨用：必须真的比脚下高。下雨时人不会往低处跑，
   * 而「最近避难所」可能只是一个比脚面高 20 cm 的路缘 —— 那不是避雨。
   * 先只挑「至少高 1.0 m」的候选；一个都没有时退回不限制（否则会有人原地不动）。
   */
  function findRefuge(x, z, avoid, needHigh = false, pedI = -1, maxDist = REFUGE_MAX,
    forcedHz = null) {
    // 基准高程始终是真地形高度：积水逃难时「哪儿更高」同样有意义。
    const y0 = groundAt(x, z);
    const cand = [];
    const hi = [];
    // 【灾害履历进避险选址】亲历过内涝 / 受过训的人更看重「真的高」和
    // 「能进的楼」，并愿意为此多走一段；没有灾害经验的人更就近、更容易
    // 跟着已经有人去的方向走。旧版所有人一律选最近且容量最空的点。
    const per = (CROWD && CROWD.persons && pedI >= 0) ? CROWD.persons[pedI] : null;
    const hzObj = per && (per.hazard || (per.citizen && per.citizen.hazard));
    // forcedHz 只供验收探针做「同一位置、只换经验」的反事实对照；
    // 正常运行永远是 null，读的是这个人真实的灾害履历。
    const hz = forcedHz !== null ? forcedHz : (hzObj ? hzObj.score : 0);
    const preferHigh = needHigh || hz > 0.45;
    // 经验足的人对「高」要求更严：1 m 的路缘不算，要真的更高才进优先池。
    const highGate = 1.0 + hz * 1.8;
    // 同一街区的人给不同的确定性偏置，避免「最近的那一个」被全城选中。
    const bias = pedI >= 0
      ? ((((pedI * 2654435761) >>> 0) / 4294967296) - 0.5) * 34 : 0;
    const push = (d, R) => {
      if (avoid && R === avoid) return;
      const load = rLoad(R);
      // 每多一个人占着，等效远 52 m；满了直接排除。
      const rise = Math.max(0, R.y - y0);
      // 【高度分档而非线性累加】旧版 rise*1.5 对 6~50 m 的楼几乎全部撞到
      // 130 m 上限，所有候选拿同一个减免，排序完全没变（实测避险高度只差
      // 0.15 m）。现在按「楼 30 m / 高地 8 m」归一化：经验足的人会挑**更高**
      // 的那栋楼或那片高地，经验不足的人仍主要就近。
      const riseScore = R.kind === 1 ? Math.min(1, rise / 30) : Math.min(1, rise / 8);
      const highBonus = hz * (riseScore * 100 + (R.kind === 1 ? 30 : 0));
      // 没经验的人从众：已有 1~3 人在那儿的点略微更吸引，但远不足以
      // 抵消容量惩罚，不会重新造成几百人扎堆。
      const crowdPull = (1 - hz) * Math.min(load, 3) * 5;
      const pen = load * 52 + (load >= R.cap ? 100000 : 0) + bias - highBonus - crowdPull;
      const item = [d + pen, R, d, rise];
      cand.push(item);
      if (preferHigh && R.y >= y0 + highGate) hi.push(item);
    };
    const c0x = Math.floor(x / RC), c0z = Math.floor(z / RC);
    const maxRing = Math.ceil(maxDist / RC) + 1;
    for (let ring = 0; ring <= maxRing; ring++) {
      if (cand.length >= 24) break;
      for (let i = -ring; i <= ring; i++) {
        for (let j = -ring; j <= ring; j++) {
          if (ring > 0 && Math.abs(i) !== ring && Math.abs(j) !== ring) continue;
          const a = rGrid.get(rk(c0x + i, c0z + j));
          if (!a) continue;
          for (const ri of a) {
            const R = refuges[ri];
            const d = Math.hypot(R.x - x, R.z - z);
            if (d > maxDist) continue;
            push(d, R);
          }
        }
      }
    }
    if (!cand.length) return null;
    // 避雨、以及有灾害经验的人逃难：优先只在高处挑；高处一个都没有才放开。
    const pool = (preferHigh && hi.length) ? hi : cand;
    const notePick = (R, item) => {
      if (R && pedI >= 0) refugePicks.set(pedI, {
        i: pedI, hazard: +hz.toFixed(3),
        rise: +(item ? item[3] : Math.max(0, R.y - y0)).toFixed(2),
        dist: item ? +item[2].toFixed(1) : +Math.hypot(R.x - x, R.z - z).toFixed(1),
        kind: R.kind, highPool: !!(preferHigh && hi.length),
      });
      return R;
    };
    pool.sort((a, b) => a[0] - b[0]);
    const tries = Math.min(REFUGE_TRIES, pool.length);
    for (let i = 0; i < tries; i++) {
      const R = pool[i][1];
      if (lineClear(x, z, R.x, R.z, R.kind === 1 ? 9 : 0)) return notePick(R, pool[i]);
    }
    for (let i = 0; i < pool.length; i++) if (pool[i][1].kind === 1) return notePick(pool[i][1], pool[i]);
    return null;
  }

  /** 同一个楼边 / 高地按人序散到不同位置：真实地点不变，人不再叠成一个点。 */
  function scatterRefuge(p, R) {
    if (!blocker.blocked) return { x: R.x, z: R.z };
    const ang = (p.i * 2.399963) % (Math.PI * 2);
    for (let k = 0; k < 6; k++) {
      const rad = 3 + ((p.i + k) % 7) * 2.4;
      const a = ang + k * 0.42;
      const x = R.x + Math.cos(a) * rad, z = R.z + Math.sin(a) * rad;
      if (!blocker.blocked(x, z, 0.35)) return { x, z };
    }
    return { x: R.x, z: R.z };
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

  // ---------------------------------------------------------------- 决策寻路
  // 【用户 2026-11-10】「日常决策肯定是要有路网的…不是让你意淫的故事」。
  // 在真实 walknet（usable 链）上建链级 A*：边权含当前帧真实水深、实体阻挡，
  // 经验决定绕水力度。它同时供：① 决策候选打分 ② 选中路线执行 ③ 积水逃难。
  const DEPTH_AT = typeof opt.depthAt === 'function' ? opt.depthAt : () => 0;
  const NOW_MIN = typeof opt.minute === 'function' ? opt.minute : () => 0;
  const PLANNER = createRoutePlanner({
    G, usable, groundAt,
    blocked: (x, z, pad) => blocker.blocked(x, z, pad),
    depthAt: (x, z, t) => DEPTH_AT(x, z, t) || 0,
    minute: () => NOW_MIN(),
    findRefuge: (x, z, avoid, needHigh) => findRefuge(x, z, avoid, needHigh),
  });
  // 回注给社会层：decide() 才能为每个候选生成真实折线、把选中路线交回来。
  if (CROWD && CROWD.setRouting) CROWD.setRouting(PLANNER, () => peds);
  const routeStats = {
    started: 0, finished: 0, replanned: 0, arrivedShelter: 0,
    held: 0, walked: 0, byKind: {}, zeroMoveFrames: 0,
  };

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

  // 【分布策略（用户 2026-10-29 定案）】
  // 「先让除去需要观察行人状态的格子，每个人都出现在随机的位置上」
  //   → 取消原来的热点集中区（白宫/拉斐特广场占 14% 的那 420 人配额），
  //     全部人员按人行道长度加权均匀随机撒在全城步行网上。
  //   长度加权 = 沿人行道**面积均匀**：某条街上人多，是因为那条路长，
  //   不是被指定的「热点」。用 ?seed=N 可以完全复现同一批站位。
  //   （`midX/midZ` 仍照旧算出来——以后想再开区域权重时直接用。）
  // 【全城多中心（用户 2026-11-10「全城随机加人」）】
  // 全城均匀撒虽然覆盖广，但几百人摊到 6km×5km 上每条街几乎看不见人；
  // 只收在一个 340 m 街区又不是全城。折中：把可走链按 420 m 网格聚成若干
  // 片区中心，选彼此相距 ≥420 m 的 K 个中心，每人固定属于一个片区，从该片区
  // 280 m 内的链里出生 —— 既铺满全城，每个片区又有一小群人能互相看见。
  let clusterPools = null;
  if (opt.spread && usable.length > 20) {
    const K = Math.max(6, Math.min(16, Math.round(count / 18)));
    const CELL = 420, R = 280;
    const grid = new Map();
    for (let u = 0; u < usable.length; u++) {
      const k = `${Math.floor(midX[u] / CELL)}|${Math.floor(midZ[u] / CELL)}`;
      let a = grid.get(k); if (!a) grid.set(k, (a = []));
      a.push(u);
    }
    const buckets = [...grid.values()].map((arr) => {
      let sx = 0, sz = 0;
      for (const u of arr) { sx += midX[u]; sz += midZ[u]; }
      return { x: sx / arr.length, z: sz / arr.length, arr };
    }).sort((a, b) => b.arr.length - a.arr.length);
    const chosen = [];
    for (const gap of [CELL, CELL * 0.6, 0]) {
      for (const b of buckets) {
        if (chosen.length >= K) break;
        if (chosen.every((c) => Math.hypot(c.x - b.x, c.z - b.z) > gap)) chosen.push(b);
      }
      if (chosen.length >= K) break;
    }
    // 两个官方机位对应的街区必须各有一个片区：默认 FAA/MegaKit 街区 +
    // 页面「9 行人近景 / 0 行人俯视」的白宫-拉斐特广场 (1060,-700)。
    // 否则全城铺开以后，用户点官方行人机位反而看到一条空街。
    const FOCUS = opt.focus
      ? (Array.isArray(opt.focus[0]) ? opt.focus : [opt.focus]) : [];
    const picked = [];
    const focusFor = new Map();
    for (const [fx, fz] of FOCUS) {
      let best = null, bestD = Infinity;
      for (const bk2 of buckets) {
        const d = Math.hypot(bk2.x - fx, bk2.z - fz);
        if (d < bestD) { bestD = d; best = bk2; }
      }
      if (best && !picked.includes(best)) {
        picked.push(best);
        focusFor.set(best, [fx, fz]);
      }
    }
    if (picked.length) {
      const rest = chosen.filter((b) => !picked.includes(b));
      chosen.length = 0;
      chosen.push(...picked, ...rest.slice(0, Math.max(0, K - picked.length)));
    }
    clusterPools = chosen.map((c) => {
      // 官方机位街区：出生链要落在机位 110 m 内，否则「9 行人近景」眼高
      // 机位下人还在几百米外，只有几个像素（实测 80 m 内 0–2 人）。
      const f = focusFor.get(c);
      const cx = f ? f[0] : c.x, cz = f ? f[1] : c.z;
      const rr = f ? 110 : R;
      const pool = [];
      for (let u = 0; u < usable.length; u++) {
        if (Math.hypot(midX[u] - cx, midZ[u] - cz) < rr) pool.push(usable[u]);
      }
      if (!pool.length && f) {
        for (let u = 0; u < usable.length; u++) {
          if (Math.hypot(midX[u] - cx, midZ[u] - cz) < R) pool.push(usable[u]);
        }
      }
      return pool.length ? pool : [usable[0]];
    });
    // 每个焦点街区多给 2 个权重槽：夜里 / 上午街上人本来就少，槽太少会
    // 出现「全城 90 人在走，官方机位下却空街」。
    for (let j = 0; j < picked.length; j++) {
      clusterPools.push(clusterPools[j], clusterPools[j]);
    }
    console.log(`[ped] 全城多中心：${clusterPools.length} 个片区 / ${usable.length} 条可走链`
      + (picked.length ? ` · ${picked.length} 个官方机位街区加权` : ''));
  }
  const clusterOf = new Int16Array(count);
  const pickChain = (i = 0) => {
    if (!clusterPools) return pickGlobal();
    const slot = i % clusterPools.length;
    clusterOf[i] = slot;
    const pool = clusterPools[slot];
    return pool[(rnd() * pool.length) | 0];
  };

  const group = new THREE.Group();
  group.name = 'L6_agents';

  const peds = [];
  // 【马克的外部驱动】主场景把 _legacy 的单人故事迁进来后，第 0 个人不再走
  // walknet：由 mark.js 每帧直接写位置/朝向/动作/决策。留一个 hook 而不是在
  // main.js 里覆盖，是为了不让两套逻辑同时给他记录决策、同时抢 mixer。
  let heroStep = null;
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _tmp = new THREE.Vector3();
  const _sp0 = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    // 第 0 个人是马克（如果高模载入了）；其余按性别随机
    const isHero = (i === 0 && !!opt.hero);
    const tpl = isHero ? opt.hero
      : useTpl[Math.min(useTpl.length - 1, rnd() < 0.52 ? 0 : 1)];
    let ci = pickChain(i);
    let c = G.chains[ci];
    let s0 = rnd() * c.len;
    // 【出生点不能在深水里】链级抽检只看了 3~9 个采样点，一条长链可能中间
    // 穿过 4 m 增水淹掉的那片（实测 185/3000 人一开始就站在水里）。
    // 这里对「这个人实际站的那一点」再查一次 LDT，撞到就重抽，最多 24 次。
    if (LDT && LDT.spawnOk) {
      for (let k = 0; k < 24; k++) {
        pointAt(c, s0, _sp0);
        if (LDT.spawnOk(_sp0.x, _sp0.z)) break;
        ci = pickChain(i); c = G.chains[ci]; s0 = rnd() * c.len;
      }
    }

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
    obj.userData.pedIndex = i;
    obj.traverse((o) => { o.userData.pedIndex = i; });
    peds.push({
      i, obj, mixer, acts, tpl,
      ci, dir: rnd() < 0.5 ? 1 : -1,
      s: s0,
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
      why: 'flood',      // 这次躲起来的原因：'flood' 踩水 / 'rain' 避雨
      lazy: rnd() < 0.45 ? 1 : 0,   // 1 = 下雨也不挪窝（撑伞/躲屋檐），模拟「不是所有人都会跑」
      trapped: 0,
      // 【可拾取】点一下就要能查到「这是谁」——group 里是 SkinnedMesh 的若干 part，
      // 命中后只能拿到 obj，所以把索引挂在 obj 上，raycast 一路向上找回来。
      // 【个体档案 + 决策记录】profile 决定「他能涉多深、多怕、有什么职责」，
      // decision 是他最近一次真正的权衡（UI 直接读这两个字段显示）。
      profile: isHero ? HERO_PROFILE : pickProfile(rnd()),
      hero: isHero,
      decision: null,
      wading: 0,                     // 正在硬涉水的累计秒数
      decisions: [],                 // 最近几条判断（最多留 6 条）
      // 供拾取反查（每个 part 都挂，命中任意一个 mesh 都能找回 ped）
    });
    // 【社会层】确定性色相偏移 + 挂上身份 + 逐人独立的心理档案。
    const pNew = peds[peds.length - 1];
    if (CROWD && !pNew.hero) {
      const q0 = CROWD.at(pNew.i);
      pNew.lifeName = q0 ? q0.name : `路人${pNew.i}`;
      pNew.baseSpeed = pNew.speed;
      // ped.js 的 pickProfile() 返回模块级共享对象，若不复制，改一个人的
      // 涉水线 / 风险偏好会污染同档案的所有市民（几百人共用一个 wade）。
      pNew.profile = { ...pNew.profile };
      if (q0) {
        pNew.profile.wade = q0.wade;
        pNew.profile.risk = 0.7 + (1 - q0.experience) * 1.1;
        pNew.speed = q0.speedAbs || pNew.speed;
        pNew.ageGroup = q0.ageGroup;
        pNew.thinking = q0.thinking;
      }
      const hue = ((pNew.i * 0.137) % 1 - 0.5) * 0.34;
      pNew.obj.traverse((o) => {
        if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
        const mat = o.material.clone();
        if (mat.color) mat.color.offsetHSL(hue, 0, ((pNew.i % 3) - 1) * 0.05);
        o.material = mat;
      });
    }
  }

  const clipOf = (p) => {
    // 【2026-11-08 全天审计】社会层的动作是唯一真值：在屋里就 sit，
    // 通勤就 walk，避险就 run。旧版只有 run/idle 两个特例，导致「夜班
    // 保安在街上站着不动」「在家的人播走路」。
    if (CROWD) {
      const q = CROWD.at(p.i);
      if (q) {
        // 【2026-11-08 用户「好多人物一直在原地跑步 / 下雨时很奇怪」】
        // 社会层的 clip 是「这段作息该做什么」，不是「这一帧有没有位移」。
        // 室内的人被钉在房间锚点、避雨的人站定在避难所，旧版仍硬套
        // walk/run；暴雨段 24 人全员 run 原地踏步就是这么来的（实测 94–98%
        // 的走跑分钟里锚点纹丝不动）。只有真的在步行网上移动才播走跑。
        // net 模式只有状态机真的判成「walk」才算在走；yield / idle / look
        // 都是站定。flee 由避险状态机单独驱动，不受这里限制。
        const halted = p.mode !== 'flee' && p.state !== 'walk';
        const routeMoving = p.mode === 'route' && p.route && p.route.speed > 0.001;
        // 【2026-11-12】旧版把 route 模式排除在 movingNow 之外，导致沿真实
        // 折线位移的人被帧末兜底切成 idle（滑步），而等规划的人反而播 walk
        // （零位移走跑）。这里统一按「这一刻是否真的允许位移」判定。
        const holding = (p.holdT || 0) > 0 || p.mode === 'shelter'
          || (p.liveClipT > 0 && p.liveClip === 'idle');
        const movingNow = (p.mode === 'net' || p.mode === 'flee' || routeMoving)
          && !q.indoor && !halted && !holding && (Number(p.speed) || 0) > 0.25;
        if (!movingNow) {
          if (q.indoor) return p.acts.sit ? 'sit' : (p.acts.idle ? 'idle' : 'walk');
          return p.acts.idle ? 'idle' : 'walk';
        }
        // 【动作跟着决策走】hurry 播跑、slow 播慢走、换街/掉头播走；
        // 持续到下一次判断自动失效，不会出现「说继续却一直跑」。
        if (p.liveClipT > 0 && p.liveClip) {
          if (p.liveClip === 'run' && p.acts.run) return 'run';
          if (p.liveClip === 'walk' && p.acts.walk) return 'walk';
          if (p.liveClip === 'idle' && p.acts.idle) return 'idle';
        }
        if (q.clip === 'run' && p.acts.run) return 'run';
        if (q.clip === 'walk' && p.acts.walk) return 'walk';
        if (q.clip === 'sit') return p.acts.sit ? 'sit' : (p.acts.idle ? 'idle' : 'walk');
        if (q.clip === 'idle' && p.acts.idle) return 'idle';
      }
    }
    // 社会层给的作息动作优先：赶路播 walk/run，室内/待机播 idle；
    // 【2026-11-07】用户反馈随机行人「经常转圈、倒退着转圈、侧身位移」。
    // 来源就是 look / side_l / side_r / turn180 / back 这几段原地动作，再叠加
    // 硬掉头时 p.yaw += Math.PI 的瞬时 180° 反转。随机行人只保留
    // idle / walk / run 三个循环；转身一律交给已有的平滑 yaw 插值
    // （p.yaw += dYaw * min(1, dt*6.5)），不会再出现原地打转。
    if (p.state === 'idle' || p.state === 'look' || p.state === 'yield') return 'idle';
    return p.jogger ? 'run' : 'walk';
  };

  /** 步频跟着真实步速走：加速时腿快、慢走/涉水时腿慢，不是恒定 1×。 */
  function clipTimeScale(p, name) {
    const cur = (p.mode === 'route' && p.route && p.route.speed > 0.01)
      ? p.route.speed : (p.speed || WALK.BASE);
    // 【唯一口径】实际 m/s ÷ 该 clip 的设计步速 m/s。旧版这里用「当前/本人基准」、
    // people.js 用「当前/clip 设计速度」、mark.js 干脆不设，三套 timeScale
    // 让同一个人换个模型步频就变；现在统一读 motion-units.ANIM。
    let ts = ANIM.timeScale(cur, name);
    if (name === 'run') ts = Math.max(ts, 1.05);
    return ts;
  }

  function play(p, name, fade = 0.28) {
    const a = p.acts[name] || p.acts.idle;
    if (!a) return;
    const ts = clipTimeScale(p, name);
    if (p.cur === a) { a.setEffectiveTimeScale(ts); return; }
    a.reset();
    a.setEffectiveTimeScale(ts);
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
    // 这个人的「家所在的街区」：从屋里出来时回到自己这一片，而不是全部
    // 瞬移到剧情楼门口（全城几百人不能一出门就挤到一个坐标）。
    p.homeXZ = { x: _v.x, z: _v.z };
  }

  // ---------------------------------------------------------------- 实时决策主体
  // 【2026-11-11】慢层目标（goal.js）+ 群体内核（cohort.js）+ 每 0.5~1 仿真秒
  // 一次「此刻该干什么」的判断（live-agent.js）。时间表不再给台词，只给门牌
  // 和时间窗；想法由状态与内核现算，动作由下面的 applyLiveAction 落到真实路网。
  // 【今日经历】每子步从真实位移 / 水深 / 生理量 / 伞累积，再回灌决策打分。
  const EXP = createExperience(peds, CROWD);
  // ---- 细粒度圈层 / 驾驶层 / 伤亡台账（2026-11-13）----
  // 圈层按「真实出生门牌坐标」分居住片区；用 p.homeXZ 而不是 CROWD.at()，
  // 因为社会层的 bindResidents 要等本函数返回后才跑，此刻 at() 还没门牌。
  const CIRCLES = peds.map((p) => circleOf(p.i,
    CROWD && CROWD.persons ? CROWD.persons[p.i] : null,
    () => ({ doors: { home: p.homeXZ || null } })));
  const INC = createIncidents({ peds, clock: opt.clock || null,
    circles: CIRCLES, crowd: CROWD });
  const DRIVE = createDriveLayer({ traffic: opt.traffic || null, peds,
    clock: opt.clock || null, circles: CIRCLES, incidents: INC,
    flood: opt.flood || null });
  LIVE = createLiveAgents({ peds, crowd: CROWD, seed: 20261111, experience: EXP,
    circles: CIRCLES, drive: DRIVE, incidents: INC });
  // 自检：任何一处速度常量和真值源不一致，启动时直接报出来。
  const SPEED_AUDIT = assertSpeedConsistency({
    walkBase: WALK.BASE, walkRun: WALK.RUN,
    clipWalk: ANIM.CLIP_V0.walk, clipRun: ANIM.CLIP_V0.run,
    carLimit: CAR.URBAN_LIMIT, laneOff: CAR.LANE_OFF, stopLine: CAR.STOP_LINE,
    // 【跨模块真比对】决策层导出的系数、职业真值表里的各档步速，
    // 都拿过来跟执行层的同一组常量核对，不是自己跟自己比。
    slowDecision: ACTION_SPEED_MUL.slow,
    hurryDecision: ACTION_SPEED_MUL.hurry,
    statusSpeeds: Object.fromEntries(Object.entries(STATUS_BASE).map(([k, v]) => [k, v.speed])),
  });
  if (!SPEED_AUDIT.ok) console.warn('[speed] 一致性自检未通过', SPEED_AUDIT.errors);

  // ---- 行人空间索引：交通层查「斑马线附近有没有人」用，O(1) 网格 ----
  let pedBuckets = null;
  const hashCell = (cx, cz) => cx * 73856093 ^ cz * 19349663;
  function pedNear(x, z, r) {
    if (!pedBuckets) return 0;
    let n = 0;
    const R = Math.ceil(r / CELL_PED);
    const cx = Math.floor(x / CELL_PED), cz = Math.floor(z / CELL_PED);
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
      const arr = pedBuckets.get(hashCell(cx + dx, cz + dz));
      if (!arr) continue;
      for (const p of arr) {
        if (p.inVehicle || p.enabled === false) continue;
        const ddx = p.obj.position.x - x, ddz = p.obj.position.z - z;
        if (Math.abs(ddx) < r && Math.abs(ddz) < r && ddx * ddx + ddz * ddz < r * r) n++;
      }
    }
    return n;
  }
  // 社会层统一接管：CROWD.at() 返回前就覆盖好 indoor / dest / wantDecision，
  // 行人层、HUD、验收脚本看到的是同一份状态（不再各处偷偷改副本）。
  if (CROWD && CROWD.setLiveOverride) {
    CROWD.setLiveOverride((i, m, q) => LIVE.applySocial(q, peds[i]));
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
  // 累计口径（见 update 里的说明）
  let trapPeak = 0, strandPeak = 0, trapPersonMin = 0, trapFirstMin = -1;
  let lastSimMin = -1;
  let lastRaining = false;
  // 【LDT 逃生余量】2026-10-29：人不是站着不动的，所以除了「此刻通不通」，
  // 还要回答「还来不来得及」。margin = LDT - t，见 web/src/ldt.js。
  let ldtDoomed = 0;          // 当前时刻已经来不及走掉的人
  let ldtOn = false;          // 这一帧有没有 LDT 表可用（simMin 也可能为 null）
  let ldtTight = 0;           // 富余 < 10 min，很紧
  let ldtCovered = 0;         // 有 LDT 数据的人（站不到步行网上的不算）
  let ldtMedian = null;       // 余量中位数（分钟）
  let ldtMin = 0;             // 全场最紧的那一个
  let ldtDoomPeak = 0;        // 最惨时刻有多少人已来不及
  let ldtFirstDoomMin = -1;   // 第一次出现「已经来不及」的情景时刻
  const ldtBuf = new Float64Array(peds.length);   // 复用，不每帧分配

  /**
   * 开始逃难：找最近可直达的避难所。返回是否找到。
   * @param why 'flood' 踩到水才跑 / 'rain' 一开下雨就去找高处避雨（用户 2026-10-29 要求）
   */
  /**
   * 记一条判断。UI 直接读 `ped.decision` / `ped.decisions`。
   * 刻意保留「他不知道什么」——自主性的反面不是「选错」，是「全知」。
   */
  function recordDecision(p, kind, text, depth) {
    const d = {
      i: p.i,
      t: NOW_MIN(),
      kind, text,
      depth: Math.round((depth || 0) * 100),
      who: p.profile.label,
      at: [+p.obj.position.x.toFixed(0), +p.obj.position.z.toFixed(0)],
    };
    p.decision = d;
    p.decisions.push(d);
    if (p.decisions.length > 6) p.decisions.shift();
    return d;
  }

  /**
   * 谁真的会去躲雨。伞只在后台状态里存在（用户明确说不用单独建模）：
   * 带伞的人雨中继续赶路，只是淋得慢、步子略慢；没伞的人暴雨必躲，
   * 中雨看已经淋湿多少。这样一场雨里人流自然分成两股，不会全城同时
   * 涌向同一个楼边 —— 也就不存在「故意扎堆」。
   */
  function shouldShelter(p, mmh) {
    const ps = CROWD && CROWD.persons[p.i] ? CROWD.persons[p.i].phys : null;
    if (!ps) return true;
    const wet = ps.wetness || 0;
    if (ps.hasUmbrella) return mmh >= 18 && wet > 0.72;
    if (mmh >= 16) return true;
    return wet > 0.50;
  }

  function startFlee(p, why = 'flood') {
    const isRain = why === 'rain';
    // 躲雨是「就近找个檐下」，不是全城跑半公里冲向同一个高地。
    const R0 = findRefuge(p.obj.position.x, p.obj.position.z, null, isRain,
      p.i, isRain ? RAIN_REFUGE_MAX : REFUGE_MAX);
    if (!R0) return false;
    const t = scatterRefuge(p, R0);
    const R = { ...R0, x: t.x, z: t.z, baseX: R0.x, baseZ: R0.z };
    p.refugeRef = R0;
    p.shelterRef = R;
    p.refuge = R;
    p.why = why;
    if (EXP) EXP.note(p.i, 'shelter', isRain ? '下雨找檐下' : '积水找高处');
    // 【逃难也走真实路网】旧版从当前位置拉一条直线冲向避难所，会横穿楼体、
    // 横穿草地。现在先 A* 规划一条沿人行道、绕开深水的折线，人真的走过去。
    const rt = PLANNER.planTo(R.x, R.z, p.obj.position, {
      // 有灾害履历的人对「没走过的路 / 积水路段」更保守，逃难路线也更倾向
      // 绕开深水；不额外加距离，只是改 A* 边权里的熟悉度罚分。
      exp: (() => {
        const per0 = CROWD && CROWD.persons[p.i];
        const h0 = per0 && (per0.hazard || (per0.citizen && per0.citizen.hazard));
        return Math.max(0, Math.min(1,
          ((per0 && per0.citizen) ? per0.citizen.experience : 0.5)
          + (h0 ? h0.score * 0.25 : 0)));
      })(),
      wade: p.profile.wade || 0.3,
      minute: NOW_MIN(), speed: Math.max(1.2, (p.speed || 1.2) * 1.5),
      refuge: R,
    });
    if (rt && rt.ok) {
      startRoute(p, { ...rt, onArrive: 'shelter' },
        why === 'rain' ? '下雨了，沿路网找高处' : '积水太深，沿路网逃向高处');
      p.why = why;
      p.refuge = R;
      return true;
    }
    // 找不到路才退回原来的直线兜底（保证极端情况下人仍有去处）
    p.mode = 'flee';
    p.state = 'flee';
    p.stateT = 0;
    p.calmT = 0;
    play(p, why === 'rain' ? 'walk' : 'run', 0.16);
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
    p.refugeRef = null;
    p.shelterRef = null;
    p.ci = hit.ci;
    p.s = Math.min(Math.max(hit.s, 0.4), Math.max(0.4, G.chains[hit.ci].len - 0.4));
    p.dir = rnd() < 0.5 ? 1 : -1;
    p.state = 'walk';
    p.stateT = 0;
    p.lat = 0; p.latTarget = 0;
    play(p, 'walk', 0.25);
    return true;
  }

  // ================================================================ 实时判断落地
  // 【2026-11-11】live-agent 每 0.5~1 仿真秒算出一个动作，这里把它变成
  // 真实位移：换街 / 改道一律重跑链级 A*，减速 / 等待 / 掉头改 p.route.speed，
  // 放弃目标则换一条真实的路。HUD 那句话是结果的翻译，不是数据源。
  function recordLive(p, act, minute) {
    const d = {
      i: p.i, t: minute,
      kind: act.type === 'abandon' ? 'flee' : (act.type === 'wait' ? 'wade' : 'shelter'),
      text: act.reason || '', depth: 0, who: p.profile.label,
      at: [+p.obj.position.x.toFixed(0), +p.obj.position.z.toFixed(0)],
    };
    p.decision = d;
    p.decisions.push(d);
    if (p.decisions.length > 6) p.decisions.shift();
  }

  /** 目标 → 真实路网折线。全城换路只走这一条口子，绝不凭空拉直线。 */
  function planToGoal(g, from, ctx, detours = 0) {
    if (!g || !g.dest) return null;
    const per = CROWD && CROWD.persons[ctx.i];
    const baseExp = (per && per.citizen) ? per.citizen.experience : 0.5;
    const exp = Math.max(0, Math.min(1, baseExp + (detours ? 0.25 : 0)));
    const rt = PLANNER.planTo(g.dest.x, g.dest.z, from, {
      exp,
      wade: detours ? Math.max(0.12, (ctx.wade || 0.3) * 0.8) : (ctx.wade || 0.3),
      minute: ctx.minute, speed: ctx.speed || 1.2,
      refuge: { x: g.dest.x, z: g.dest.z, y: 0, kind: 0 },
      maxEscape: 4000,
    });
    if (!rt || !rt.ok) return null;
    return { ...rt, onArrive: 'arrive', kind: 'goal:' + (g.type || 'goal'),
      speed: Math.max(0.6, Math.min(2.2, ctx.speed || 1.2)) };
  }

  /** 快判断产生的可见动作，持续到下一次判断（0.5~1 仿真秒）自动失效。 */
  function setLiveClip(p, clip, secs) {
    p.liveClip = clip;
    p.liveClipT = secs;
  }

  function applyLiveAction(p, act, dInfo, ctx) {
    if (!act) return;
    recordLive(p, act, ctx.minute);
    p.liveAction = act.type;
    // 正在避险的人优先级最高，日常目标不打断逃难
    if ((p.mode === 'flee' || p.mode === 'shelter') && act.type !== 'resume') return;
    const from = { x: p.obj.position.x, z: p.obj.position.z };
    const pc = { ...ctx, i: p.i, wade: p.profile.wade || 0.3, speed: p.speed || 1.2 };
    switch (act.type) {
      case 'goal':
      case 'abandon': {
        const g = act.goal;
        const rt = g ? planToGoal(g, from, pc, 0) : null;
        if (rt) {
          setLiveClip(p, act.type === 'abandon' ? 'walk' : 'walk', 2.5);
          startRoute(p, rt, act.reason);
          LIVE.noteAction(p.i, { type: 'goal', goal: g, minute: ctx.minute });
        } else if (act.type === 'abandon') {
          // 放弃且没有「此刻该办」的下一件事：先站住一下，动作上看得见
          // 「算了」，而不是毫无痕迹地继续随机走。
          p.mode = 'net'; p.state = 'idle';
          p.holdT = 1.5 + (p.i % 5) * 0.3;
          setLiveClip(p, 'idle', 2.0);
          play(p, 'idle', 0.22);
        } else { p.mode = 'net'; rejoinNet(p, dInfo); }
        break;
      }
      case 'detour':
      case 'turnback': {
        const g = act.goal;
        const rt = g ? planToGoal(g, from, pc, act.detours || 1) : null;
        if (rt) {
          setLiveClip(p, 'walk', 2.5);
          startRoute(p, rt, act.reason);
        }
        break;
      }
      case 'idle':
        p.mode = 'net'; rejoinNet(p, dInfo);
        setLiveClip(p, 'idle', 1.5);
        break;
      case 'wait':
        if (p.route) p.route.speed = 0;
        // 不在路线上（随机走网）也要真的停住，不能只改 route.speed。
        p.holdT = Math.max(p.holdT || 0, act.seconds || 1);
        p.state = 'idle';
        setLiveClip(p, 'idle', (act.seconds || 1) + 0.4);
        play(p, 'idle', 0.2);
        break;
      case 'resume':
        // 只恢复步速，不立刻播 walk：等下一子步真的挪动了再切，避免
        // 「说在走却原地跑」的那一帧。
        if (p.route) p.route.speed = act.speed || p.speed || 1.2;
        setLiveClip(p, null, 0);
        break;
      case 'slow':
        if (p.route) p.route.speed = Math.max(WALK.SLOW_FLOOR, p.route.speed * WALK.SLOW_MUL);
        setLiveClip(p, 'walk', 1.4);
        // clipOf 不是每帧都跑（只在场景/状态切换时），所以决策产生的
        // 动作必须在这里立刻落到动画上，否则「说加快却一直走」。
        if (p.mode !== 'shelter' && p.mode !== 'flee') play(p, 'walk', 0.18);
        break;
      case 'hurry':
        if (p.route) p.route.speed = Math.min(WALK.HURRY_CAP, p.route.speed * WALK.HURRY_MUL);
        setLiveClip(p, p.acts.run ? 'run' : 'walk', 1.4);
        if (p.mode !== 'shelter' && p.mode !== 'flee') {
          play(p, p.acts.run ? 'run' : 'walk', 0.18);
        }
        break;
    }
  }

  // ================================================================ 决策路线执行
  // Brain 选中的不是一句文案，而是 route-brain 在真实 walknet 上算出的折线。
  // 这里每帧沿折线推进**真实位移**，到终点才按目标收尾：上高处 / 到门牌 /
  // 站定 / 回网。任何一帧没挪动就不许播走跑；卡死会从当前位置重新规划。
  function startRoute(p, R, label) {
    if (!R || !R.ok || !R.pts || R.pts.length < 2) {
      // 「等雨小 / 先站着看 / 歇一会儿」也是真实决策：原地站定，不瞬移不跑
      p.mode = 'net'; p.route = null;
      p.holdT = 6 + (p.i % 7) * 0.8;
      p.state = 'idle';
      p.nextThink = Math.max(p.nextThink || 0, p.holdT);
      play(p, 'idle', 0.25);
      p.routeInfo = { kind: (R && R.kind) || 'wait', label, dist: 0,
        walked: 0, onArrive: 'wait', done: false, pts: 0 };
      routeStats.held++;
      return false;
    }
    const speed = Math.max(WALK.ROUTE_MIN, Math.min(WALK.ROUTE_MAX, R.speed || p.speed || 1.2));
    const r = {
      pts: R.pts, i: 0, t: 0, cur: [R.pts[0][0], R.pts[0][1]],
      goal: R.goal || null, onArrive: R.onArrive || 'arrive',
      kind: R.kind || 'steady', label: label || '', speed,
      dist: R.dist || 0, maxDepth: R.maxDepth || 0,
      walked: 0, stuck: 0, replan: 0, minute: R.minute, done: false,
    };
    p.mode = 'route';
    p.route = r;
    p.routeInfo = r;
    p.state = 'walk'; p.stateT = 0; p.holdT = 0;
    play(p, speed > 2.1 ? 'run' : 'walk', 0.18);
    routeStats.started++;
    routeStats.byKind[r.kind] = (routeStats.byKind[r.kind] || 0) + 1;
    return true;
  }

  function finishRoute(p, dInfo) {
    const R = p.route;
    if (!R) { p.mode = 'net'; return; }
    routeStats.finished++;
    routeStats.walked += R.walked;
    R.done = true;
    if (R.onArrive === 'shelter' && R.goal) {
      p.mode = 'shelter';
      p.refuge = p.shelterRef || R.goal.refuge || {
        x: R.goal.x, z: R.goal.z, kind: R.goal.kind || 0,
        y: R.goal.y || groundAt(R.goal.x, R.goal.z),
      };
      p.shelterRef = null;
      p.state = 'shelter'; p.stateT = 0; p.calmT = 0; p.climb = 1;
      p.baseY = groundAt(p.obj.position.x, p.obj.position.z);
      p.fromX = p.obj.position.x; p.fromZ = p.obj.position.z;
      play(p, 'idle', 0.22);
      routeStats.arrivedShelter++;
    } else {
      // 到达真实门牌 / 领路人 / 街口：站定几秒再回步行网，不瞬移、不原地跑
      p.mode = 'net';
      p.holdT = 4 + (p.i % 6);
      p.state = 'idle';
      rejoinNet(p, dInfo);
      p.nextThink = Math.max(p.nextThink || 0, p.holdT);
      play(p, 'idle', 0.25);
    }
    p.route = null;
  }

  function updateRoute(p, dt, dInfo, fb) {
    const R = p.route;
    if (!R) { p.mode = 'net'; return; }
    // 【等待】实时判断让人「等一下」时步速归零：不推进、不播走跑、
    // 也不计零位移帧，保持 idle，恢复时再继续走。
    if (R.speed <= 0.001) { placeShadow(p, dt); return; }
    const x0 = p.obj.position.x, z0 = p.obj.position.z;

    // 脚下突然涨水：立刻从当前位置重新规划一条到真实高处的路网逃生路线。
    if (dInfo && R.onArrive !== 'shelter') {
      dInfo(x0, z0, _ds);
      if (fb && dt > 0 && _ds.d > 0.02) fb.wade(x0, z0, _ds.d, dt);
      p.routeFleeCd = Math.max(0, (p.routeFleeCd || 0) - dt);
      // 冷却：脚下一直有水时不能每帧都重新规划，否则人会被反复重启、
      // 永远走不到第一步（暂停态 dt=0 时尤其明显）。
      if (_ds.d > (p.profile.wade || 0.3) && p.routeFleeCd <= 0) {
        const RR = findRefuge(x0, z0, null, true, p.i, REFUGE_MAX);
        if (RR) {
          const t = scatterRefuge(p, RR);
          const R2 = { ...RR, x: t.x, z: t.z, baseX: RR.x, baseZ: RR.z };
          const per = CROWD && CROWD.persons[p.i];
          const rt = PLANNER.planTo(R2.x, R2.z, { x: x0, z: z0 }, {
            exp: per ? per.citizen.experience : 0.5,
            wade: p.profile.wade || 0.3, minute: NOW_MIN(),
            speed: R.speed * 1.4, refuge: R2,
          });
          if (rt && rt.ok) {
            p.why = 'flood'; p.refuge = R2; p.refugeRef = RR; p.shelterRef = R2;
            if (EXP) EXP.note(p.i, 'shelter', '脚下涨水改走高处');
            p.routeFleeCd = 3;
            startRoute(p, { ...rt, onArrive: 'shelter' }, '遇深水，改走高处');
            routeStats.replanned++;
            return;
          }
        }
      }
    } else if (dInfo && fb && dt > 0) {
      dInfo(x0, z0, _ds);
      if (_ds.d > 0.02) fb.wade(x0, z0, _ds.d, dt);
    }

    let budget = R.speed * Math.max(0, dt);
    let dx = 0, dz = 0;
    while (budget > 1e-4 && R.i < R.pts.length - 1) {
      const a = R.pts[R.i], b = R.pts[R.i + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 1e-4) { R.i++; R.t = 0; continue; }
      const step = Math.min(budget, L - R.t);
      R.t += step; budget -= step;
      dx = (b[0] - a[0]) / L; dz = (b[1] - a[1]) / L;
      R.cur[0] = a[0] + dx * R.t;
      R.cur[1] = a[1] + dz * R.t;
      if (R.t >= L - 1e-4) { R.i++; R.t = 0; }
    }
    if (Math.abs(dx) + Math.abs(dz) < 1e-6) { dx = Math.sin(p.yaw); dz = Math.cos(p.yaw); }
    let nx = R.cur[0], nz = R.cur[1];

    // 实体避让：折线本身在 usable 人行道链上，但树 / 停放车 / 灯杆可能挡住末段
    if (COLLIDE_PED) {
      const gy0 = groundAt(nx, nz);
      if (COLLIDE_PED.blockedCircle(nx, nz, 0.32, gy0 + 0.1, gy0 + 1.7,
        { ignoreTags: IGNORE_BUILDING })) {
        const sx = nx + dz * 0.6, sz = nz - dx * 0.6;   // 右法向侧滑
        const gy1 = groundAt(sx, sz);
        if (!COLLIDE_PED.blockedCircle(sx, sz, 0.32, gy1 + 0.1, gy1 + 1.7,
          { ignoreTags: IGNORE_BUILDING })) {
          R.cur[0] = sx; R.cur[1] = sz; nx = sx; nz = sz;
        } else R.stuck++;
      }
    }
    // 【屋顶/楼内目标不穿墙】避难路线的终点是楼心（kind=1 的目标点），
    // 折线最后一段会穿墙进楼。人走到墙边就算到达：停在檐下（地面），
    // 不钻进楼里、也不再被抬上屋顶 —— 「人在空中/屋顶」的根因之一。
    if (R.onArrive === 'shelter' && blocker.blocked(nx, nz, 0.3)) {
      finishRoute(p, dInfo);
      return;
    }
    const gy = groundAt(nx, nz);
    p.obj.position.set(nx, gy + p.footFix, nz);
    const yawWanted = Math.atan2(dx, dz);
    let dYaw = yawWanted - p.yaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    p.yaw += dYaw * Math.min(1, dt * 7);
    p.obj.rotation.y = p.yaw;

    const stepReal = Math.hypot(nx - x0, nz - z0);
    R.walked += stepReal;
    // 等待结束 / 刚启动路线后，只有真的挪动了才把 idle 切回 walk
    if (stepReal >= 0.004 && p.cur && /idle/.test(String(p.cur.getClip().name))) {
      play(p, 'walk', 0.2);
    }
    // 折线已经走完的那一帧本来就不该再挪，也不算「零位移帧」
    if (stepReal < 0.004 && R.i < R.pts.length - 1) {
      routeStats.zeroMoveFrames++;
      R.stuck++;
      // 有步速却一帧没挪动（转弯 / 刚接上折线 / 被挡）：当帧就切 idle，
      // 不等帧末的连续 3 帧兜底，绝不给观众「原地跑步」。
      if (p.obj.visible && p.cur && /walk|run/.test(String(p.cur.getClip().name))) {
        play(p, 'idle', 0.12);
      }
      if (R.stuck >= 4) play(p, 'idle', 0.2);
    } else R.stuck = 0;

    if (R.stuck >= 12) {
      // 卡死：从当前位置重新规划到同一个真实目标，最多两次
      if (R.goal && R.replan < 2) {
        const per = CROWD && CROWD.persons[p.i];
        const rt = PLANNER.planTo(R.goal.x, R.goal.z, { x: nx, z: nz }, {
          exp: per ? per.citizen.experience : 0.5,
          wade: p.profile.wade || 0.3, minute: NOW_MIN(),
          speed: R.speed, refuge: R.goal.refuge,
        });
        if (rt && rt.ok) {
          R.replan++;
          startRoute(p, { ...rt, onArrive: R.onArrive }, R.label);
          routeStats.replanned++;
          return;
        }
      }
      finishRoute(p, dInfo);
      return;
    }
    p.dist = p.obj.position.distanceTo(camPos);
    const rv = p.dist < VIS_DIST;
    if (rv !== p.visible) { p.visible = rv; p.obj.visible = rv; }
    placeShadow(p, dt);
    if (R.i >= R.pts.length - 1) finishRoute(p, dInfo);
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
  function updateFlee(p, dt, dInfo, raining = false) {
    const R = p.refuge;
    if (!R) { p.mode = 'net'; return; }

    const px = p.obj.position.x, pz = p.obj.position.z;
    const dx = R.x - px, dz = R.z - pz;
    const dist = Math.hypot(dx, dz);

    // ---- 已经站定了：等水退
    if (p.mode === 'shelter') {
      p.stateT += dt;
      // 【2026-11-10 修正「人在空中/屋顶」】屋顶避难所不再把人抬上顶面：
      // 人就停在到达点（楼边檐下 / 高地真实地面），任何帧都不凌空。
      // 水退判定：避水的人以避难所位置的地面水深为准；**避雨的人只看雨**——
      // 雨小了就该回街上（他们脚下的路干不干由 rejoinNet 把关），不能跟着
      // 等楼心处的积水退（旧逻辑让 80+ 人在 6 mm/h 的小雨里站到深夜）。
      let dry = true;
      if (p.why !== 'rain' && dInfo) { dInfo(R.x, R.z, _ds); dry = !_ds.wet; }
      // 【避雨的人】雨还大（raining 参数此刻语义 = 雨强 ≥ 阈值）就不走。
      // 否则 2 m 高的小土包上一块没水，人会立刻回街上淋雨。
      if (p.why === 'rain' && raining) dry = false;
      p.calmT = dry ? p.calmT + dt : 0;
      // 雨一停 1.5 s 就回街（避水的人仍等满 SHELTER_CALM）。顺带修复：
      // 从雨夜往回拖时间轴到白天时，避雨的人不会在大太阳底下一直站着。
      const need = (p.why === 'rain' && !raining) ? 1.5 : SHELTER_CALM;
      if (p.calmT >= need) {
        if (!rejoinNet(p, dInfo)) p.calmT = 0;
      }
      placeShadow(p, dt);
      return;
    }

    // ---- 还在跑
    const arrive = R.kind === 1 ? 4.5 : 2.4;
    if (dist <= arrive) { arriveShelter(p); placeShadow(p, dt); return; }

    // 朝避难所直走（沿路网规划失败时的直线兜底）；走到墙边就算「进楼」，
    // 不再钻进楼体内部、也不再被抬上屋顶。
    const ux = dx / (dist || 1), uz = dz / (dist || 1);
    const yawWanted = Math.atan2(ux, uz);
    let dYaw = yawWanted - p.yaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    p.yaw += dYaw * Math.min(1, dt * (1 / Math.max(0.05, 1 - FLEE_TURN_IN)));

    const step = Math.min(dist, (p.why === 'rain' ? RAIN_SPEED : FLEE_SPEED) * dt);
    const nx2 = px + ux * step, nz2 = pz + uz * step;
    if (R.kind === 1 && blocker.blocked(nx2, nz2, 0.3)) {
      // 下一脚要踩进楼体：停在墙根（檐下），视为已进楼避难
      arriveShelter(p);
      placeShadow(p, dt);
      return;
    }
    const gy = groundAt(nx2, nz2);
    p.obj.position.set(nx2, gy + p.footFix, nz2);
    p.obj.rotation.y = p.yaw;
    placeShadow(p, dt);
  }

  /** 到达避难所：站定在当前位置的**地面**上（檐下 / 高地），等水退/雨停。 */
  function arriveShelter(p) {
    p.mode = 'shelter';
    p.state = 'shelter';
    p.stateT = 0;
    p.calmT = 0;
    p.climb = 1;                        // 兼容旧字段：不再有爬升动画
    p.baseY = groundAt(p.obj.position.x, p.obj.position.z);
    p.fromX = p.obj.position.x; p.fromZ = p.obj.position.z;
    p.obj.position.y = p.baseY + p.footFix;
    play(p, 'idle', 0.22);
  }

  let frameXZ = null;
  function update(dt, camera, flood) {
    frame++;
    // 避难所占用每 30 帧按真实状态重算一次（O(n)），不依赖易漏的加减账。
    if (frame % 30 === 1) syncRefugeLoad();
    // 实时决策运行时按同一个子步累计仿真秒（判断间隔、等待、重规划预算都读它）
    if (LIVE) LIVE.begin(dt);
    // 【同一时间层】驾驶执行层也只吃这一个仿真秒 h：等灯时长、跟车距离、
    // 涉水熄火计时、行驶里程、快层 driveJudge 的 0.5~1 秒判断全部按它推进。
    // 倍率开到 24× 时，车、人、水、判断一起变快，不存在哪一层漏乘。
    if (DRIVE) DRIVE.step(dt, NOW_MIN());
    // 帧初位置：循环结束后统一核对「这一帧到底挪没挪」，覆盖 net / flee /
    // shelter / 室内 / 换链所有分支，不再有漏网的原地跑步。
    if (!frameXZ || frameXZ.length < peds.length * 2) frameXZ = new Float64Array(peds.length * 2);
    for (let fi = 0; fi < peds.length; fi++) {
      frameXZ[fi * 2] = peds[fi].obj.position.x;
      frameXZ[fi * 2 + 1] = peds[fi].obj.position.z;
    }
    camPos.copy(camera.position);
    const dInfo = (flood && flood.depthInfo) ? flood.depthInfo : null;
    // 双向耦合的回写口：涉水的人把「这一格被踩过」写回去，积涝层据此拖慢退水
    const FB = (flood && flood.fb) ? flood.fb : null;
    // 正在下雨？避雨触发条件（用户 2026-10-29：不该等人脚泡水才动）
    const raining = !!(flood && flood.raining);
    lastRaining = raining;
    // 【雨强分级 2026-11-10】u_p8 工况 raining 全天为 true，但清早只有
    // 2.5 mm/h 的毛毛雨 —— 旧逻辑让 180 人从早到晚站在楼边「躲雨」，街上
    // 越走越空。现在读真实雨强：≥ RAIN_SHELTER_MMH（接近傍晚峰值）才躲，
    // 小雨照常走（现实里撑伞赶路的人不会因为 3 mm/h 的雨站一小时）。
    const rainMMH = raining && flood.rainRate ? flood.rainRate() : (raining ? 99 : 0);
    const heavyRain = rainMMH >= RAIN_SHELTER_MMH;
    // 实时判断的感知上下文：全部读这一子步的真实值，复用给所有人（不每人建对象）
    // 【2026-11-18】删掉旧的「降雨一开始就算全城收到预警」初值。预警时刻一律
    // 由 kernel/warning.js 的 warnAtOf() 按人算，在下面逐人分支里写入 liveCtx；
    // 这里只给安全默认值（0 分钟、未收到），避免旧口径在分支条件变化时复活。
    const liveCtx = {
      minute: NOW_MIN(), dInfo, rainMMH,
      minutesSinceWarning: 0,
      officialWarning: false,
      blocked: (x, z, pad) => blocker.blocked(x, z, pad),
      far: false, indoor: false, busy: false, sheltered: false,
    };
    const simMin = (flood && typeof flood.tMin === 'number') ? flood.tMin : null;

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
    const bk = hashCell;
    // 人也是实体：本帧已摆位的人用来做「人对人」的最小间距检查（24 人，O(n²) 可接受）
    const placedThisFrame = [];
    for (const p of peds) {
      if (!p.visible) continue;
      const a = buckets;
      const k = bk(Math.floor(p.obj.position.x / CELL_PED), Math.floor(p.obj.position.z / CELL_PED));
      let arr = a.get(k);
      if (!arr) a.set(k, (arr = []));
      arr.push(p);
    }
    pedBuckets = null;
    // 【交规用索引按「真实存在的人」建，不受相机距离裁剪影响】
    // 旧版复用 buckets（只收 p.visible 的人），无头/远景时街上明明有人，
    // 车却一个行人都查不到，礼让次数恒为 0。行人优先必须按真实人群算。
    const yb = new Map();
    for (const p of peds) {
      if (p.enabled === false || p.inVehicle) continue;
      const k = bk(Math.floor(p.obj.position.x / CELL_PED), Math.floor(p.obj.position.z / CELL_PED));
      let arr = yb.get(k);
      if (!arr) yb.set(k, (arr = []));
      arr.push(p);
    }
    pedBuckets = yb;   // 交通层的行人优先查询复用同一份索引

    // LDT 余量按帧聚合：所有人共用同一个 nowMin，所以可以先攒再算
    let ln = 0;
    ldtOn = !!(LDT && simMin !== null);
    ldtDoomed = 0; ldtTight = 0; ldtCovered = 0; ldtMedian = null; ldtMin = 0;

    for (const p of peds) {
      if (p.enabled === false) continue;   // 被 setCount 关掉的：不更新也不显示
      // 【伤亡冻结】困死的人不再移动、不再判断，位置留原地供逐人回查。
      if (INC.isDead(p.i)) { p.obj.visible = false; continue; }
      // 【人在车里】行人模型隐藏，位置就是 traffic 认领车的真实位置
      // （DRIVE.step 每个子步写回）。这里绝不跑步行位移，但生理 / 今日经历 /
      // 伤亡判定仍按车所在的水深逐子步累积 —— 不是「换了个动画」。
      if (p.inVehicle) {
        p.obj.visible = false;
        let vd = 0;
        if (dInfo) { const dv = dInfo(p.obj.position.x, p.obj.position.z, _ds); vd = dv.d || 0; }
        const vps = CROWD && CROWD.persons[p.i] ? CROWD.persons[p.i].phys : null;
        const vSpeed = Math.max(0, p.driveSpeed || 0);
        const vPhys = vps ? { wetness: vps.wetness * 100, hunger: vps.hunger,
          stamina: vps.stamina, umbrella: vps.umbrella, hasUmbrella: vps.hasUmbrella }
          : { wetness: 0, hunger: 30, stamina: 70, umbrella: 'none', hasUmbrella: false };
        if (CROWD) CROWD.tick(p.i, CROWD.now(), {
          depth: vd, speed: vSpeed, raining: rainMMH >= 2, rainMMH,
          inVehicle: true, inBuilding: false, moving: vSpeed > 0.1, asleep: false,
        });
        EXP.tick(p.i, dt, { depth: vd, speed: vSpeed, mode: 'drive', indoor: false,
          raining: rainMMH >= 2, minute: liveCtx.minute, phys: vPhys });
        const vLive = LIVE && LIVE.agent ? LIVE.agent(p.i) : null;
        const vGoal = vLive && vLive.plan && vLive.plan.active
          ? vLive.plan.active() : null;
        INC.tick(p.i, dt, {
          x: p.obj.position.x, z: p.obj.position.z, depth: vd, speed: vSpeed,
          indoor: false, sheltered: false, inVehicle: true,
          carStalled: !!(p.driveInfo && p.driveInfo.stalled),
          stamina: vPhys.stamina, rainMMH, umbrella: vPhys.umbrella, mode: 'drive',
          action: (vLive && vLive.lastAction) || '',
          reason: (vLive && vLive.lastReason) || '',
          goalLabel: (vGoal && vGoal.label) || '',
        });
        continue;
      }
      // 被故事引擎接管的马克：整段常规更新（行走、避水、状态机）全部跳过。
      // 放在循环最前面，连距离裁剪也交出去 —— 否则 ped.js 会把「人在车里」
      // 那帧的 obj.visible 又改回 true。
      if (p.hero && heroStep) {
        // 马克由故事引擎管，但他也是人 —— 他在水里走同样要写回流场
        if (FB && dt > 0 && dInfo) {
          const dd = dInfo(p.obj.position.x, p.obj.position.z, _ds);
          if (dd.d > 0.02) FB.wade(p.obj.position.x, p.obj.position.z, dd.d, dt);
        }
        heroStep(dt, p, { dInfo, raining, simMin, flood });
        continue;
      }
      // q 已由 CROWD.at() 内的实时目标接管口对齐好（室内外 / 目的地 / 步速）。
      const q = CROWD ? CROWD.at(p.i) : null;
      // 帧末「室外不许在楼体里」的检查读这个标记，避免再查一次社会层。
      p.qIndoor = !!(q && q.indoor);
      // 【室外高度硬约束】从屋里/楼上切到街面时，旧位置可能还带着 6F/9F 的
      // 楼板高度；若这一帧正好可见，就会看到“人在空中”。只要判定在室外，
      // 就把脚底接回这一刻的真实地面，再继续走网/路线。
      if (q && !q.indoor) {
        const gyNow = groundAt(p.obj.position.x, p.obj.position.z);
        // 0.9 m 是路缘/台阶/脚底修正的正常范围；超过 1.2 m 一律视为残留楼板高度。
        if (p.obj.position.y - gyNow > 1.2) {
          p.obj.position.y = gyNow + p.footFix;
          if (p.mode === 'net') rejoinNet(p, dInfo);
        }
      }
      if (LIVE) {
        liveCtx.minute = NOW_MIN();
        liveCtx.rainMMH = rainMMH;
        liveCtx.far = p.visible === false;
        liveCtx.indoor = !!(q && q.indoor);
        // 【2026-11-17 A 预警按人分发】旧口径是「降雨开始之后就算收到预警」，
        // 而这批工况降雨从 0 点起，等于午夜全城都收到、一路累积到傍晚十九小时。
        // 现在：他脚下第一次见水（3 cm）的那一刻才确定预警时刻 = 见水 − 前置时间，
        // 35.5% 的人自始至终收不到（Thieken 2022 表 4，内涝 n=448）。
        // 只在第一次见水时算一次，之后记在 p.warnAt 上，不再逐帧查水深。
        if (p.warnAt === undefined && dInfo
          && (p.warnChk === undefined || NOW_MIN() - p.warnChk >= 1)) {
          p.warnChk = NOW_MIN();
          const dw = dInfo(p.obj.position.x, p.obj.position.z, _ds).d || 0;
          if (dw >= WARNING_SELF_SET.wetThresholdM) {
            p.warnAt = warnAtOf(NOW_MIN(), p.i);
          }
        }
        const warnAt = p.warnAt;
        const warned = Number.isFinite(warnAt) && NOW_MIN() >= warnAt;
        liveCtx.officialWarning = warned;
        liveCtx.minutesSinceWarning = warned ? Math.max(0, NOW_MIN() - warnAt) : 0;
        // 正在跑向高处的人交给避险状态机；已经站在檐下的人仍每 0.5~1
        // 仿真秒判断一次「继续等还是走」，只是候选池受限、动作不打断避险。
        liveCtx.busy = (p.mode === 'flee');
        liveCtx.sheltered = (p.mode === 'shelter');
        const act = LIVE.stepOne(p, dt, liveCtx);
        if (act) applyLiveAction(p, act, dInfo, liveCtx);
      }
      // 【放在所有 continue 之前】暴雨避险的人会走 flee 分支直接 continue，
      // 决策若写在位移段就永远不触发。Brain 的感知 / 效用打分 / 生理累积
      // 必须每帧都有机会跑，和 6 个具名角色一样。
      if (q && CROWD) {
        p.lazy = q.lazy ? 1 : 0;
        p.wadeMax = q.wade;
        // 涉水线按年龄 / 经验逐人不同（profile 已在初始化时复制成独立对象）。
        p.profile.wade = q.wade;
        if (q.speedAbs > 0) p.speed = q.speedAbs;
        let dd0 = 0;
        if (dInfo) { const ds0 = dInfo(p.obj.position.x, p.obj.position.z, _ds); dd0 = ds0.d || 0; }
        // 【生理状态真的跟着人走】旧版这里写死 speed:0，于是体力永远按静止
        // 恢复、饥饿永远按静止涨、淋湿与雨强脱钩 —— 状态值成了摆设。现在
        // 用这一子步真实的步速 / 水深 / 雨强 / 室内外喂给 PersonState。
        // 站定 / 等待 / 檐下躲避 / 路线速度为零时，真实步速就是 0：
        // 否则体力与「今日走了多少米」会把站着不动的时间也算成赶路。
        const standing = q.indoor || p.mode === 'shelter' || p.state === 'idle'
          || (p.holdT || 0) > 0
          || (p.mode === 'route' && p.route && p.route.speed <= 0.001);
        const realSpeed = standing ? 0
          : (p.mode === 'route' && p.route ? p.route.speed
            : (p.mode === 'flee' ? (p.speed || 1.2) * WALK.FLEE_MUL : (p.speed || 0)));
        const wetRain = rainMMH >= 2;         // 毛毛雨也算淋，但雨强决定淋湿速率
        const dmNow = NOW_MIN();
        // 【2026-11-17 B 地下室】人在家、脚下已经开始进水时，有一部分人会下去
        // 抢救财物 / 查看水泵——Thieken 2026 里，室内死者有 22% 就是这么死的。
        // 每人只有一次机会，下去待 10–25 分钟；这段时间按"地下室"判，
        // 不受楼层保护（下面 incidents 走涉水暴露，不走楼层分支）。
        const atHome = !!q.indoor && q.where === 'home';
        if (p.basementTried !== true && atHome && dd0 >= BASEMENT.entryDepthM) {
          p.basementTried = true;
          // 【修 2026-11-17】时钟量程只有 0–1440 分钟。23:20 之后下去的人，
          // 原本 basementUntil 会算到 >1440，而 dmNow 封顶 1440，
          // 「dmNow < basementUntil」永远成立 —— 人一整天都出不来；
          // 时间轴回拨到次日 0 点时「0 < 1450」同样恒真。
          // 改为「起点 + 经过时长」：正常推进时与原来完全等价，
          // 一旦回拨（dmNow < 起点）立即判为上楼。
          if (goesToBasement(p.i)) {
            p.basementFrom = dmNow;
            p.basementStay = basementStayMin(p.i);
            p.basementUntil = dmNow + p.basementStay;
          }
        }
        let inBasement = false;
        // 用「经过时长」而不是「绝对时刻是否小于 deadline」：日末段下去时
        // deadline 会超过 1440，而 dmNow 封顶 1440，绝对时刻比较会永远成立。
        if (p.basementUntil) {
          const elapsed = dmNow - (Number.isFinite(p.basementFrom) ? p.basementFrom : 0);
          // 兼容一次性载入的旧状态（只有 deadline、没有 stay）：用差值兜底。
          const stay = Number.isFinite(p.basementStay) ? p.basementStay
            : (Number.isFinite(p.basementFrom) ? p.basementUntil - p.basementFrom : 0);
          if (elapsed >= 0 && elapsed < stay) inBasement = true;
          else p.basementUntil = 0;       // 待够时间／时间回拨就上来
        }
        CROWD.tick(p.i, CROWD.now(), {
          depth: dd0, speed: realSpeed, raining: wetRain, rainMMH,
          inVehicle: false, inBuilding: !!q.indoor, moving: realSpeed > 0.1,
          asleep: !!q.indoor && (dmNow < 360 || dmNow > 1320),
        });
        const ps = CROWD.persons[p.i] ? CROWD.persons[p.i].phys : null;
        EXP.tick(p.i, dt, {
          depth: dd0, speed: realSpeed, mode: p.mode, indoor: !!q.indoor,
          raining: wetRain, minute: liveCtx.minute,
          phys: ps ? { wetness: ps.wetness * 100, hunger: ps.hunger,
            stamina: ps.stamina, umbrella: ps.umbrella, hasUmbrella: ps.hasUmbrella } : q.phys,
        });
        // 【伤亡台账】逐子步读这一刻的真实水深 / 位移 / 室内外 / 体力，
        // 判涉水、被困、滑倒受伤、困死、避险成功。没有任何预写数字。
        const wLive = LIVE && LIVE.agent ? LIVE.agent(p.i) : null;
        const wGoal = wLive && wLive.plan && wLive.plan.active
          ? wLive.plan.active() : null;
        INC.tick(p.i, dt, {
          x: p.obj.position.x, z: p.obj.position.z, depth: dd0,
          speed: realSpeed, indoor: !!q.indoor,
          // 【阶段3】室内楼层：真实建筑高度派生，供回放把人摆在对应楼层。
          // 相对楼层高度叠加地形，回放人偶 y 与场景里人的绝对高度一致。
          // totalFloors 只在「在家」时给（家里真实建筑层数；工作场所没有真实
          // 层数，不硬套，避免把办公楼按住宅层数误判）。
          floor: inBasement ? 0 : (q.floor || 0),
          // 【2026-11-17 B】地下室：不受楼层保护，按涉水暴露判。
          basement: inBasement,
          totalFloors: (q.indoor && q.where === 'home') ? (q.totalFloors || 0) : 0,
          // 这栋楼的层高（住宅 2.7 m，Choi 2002）：淹到第几层、该层积多深，
          // 都按它算，不用全局默认值。
          floorHeightM: (q.indoor && q.where === 'home') ? (q.floorHeightM || 0) : 0,
          floorY: inBasement
            ? groundAt(q.x, q.z) + basementElevationM()
            : ((q.indoor && Number.isFinite(q.floorRelY) && q.floorRelY > 0)
              ? groundAt(q.x, q.z) + q.floorRelY : null),
          sheltered: p.mode === 'shelter', inVehicle: false, carStalled: false,
          stamina: ps ? ps.stamina : 70, rainMMH,
          umbrella: ps ? ps.umbrella : null, mode: p.mode,
          action: (wLive && wLive.lastAction) || '',
          reason: (wLive && wLive.lastReason) || '',
          goalLabel: (wGoal && wGoal.label) || '',
        });
        if (q.wantDecision && dt > 0) {
          const rec = CROWD.decide(p.i, CROWD.now(), p.obj.position);
          if (rec) {
            const d = {
              i: p.i, who: q.name, kind: 'decide', text: rec.chosen,
              detail: rec.reason, at: [+p.obj.position.x.toFixed(0), +p.obj.position.z.toFixed(0)],
            };
            p.decisions.push(d);
            if (p.decisions.length > 6) p.decisions.shift();
            p.decision = d;
            // 【闭环】选中的真实路网折线立刻执行：人从当前位置沿它走完。
            // 只在正常走网时启动 —— 逃难路线 / 已在躲雨的人不能被一条日常
            // 通勤决策覆盖掉，险情优先级更高。
            if (!q.indoor && p.mode === 'net'
              && (rec.route || rec.goalKind === 'wait')) {
              startRoute(p, rec.route, rec.chosen);
            }
          }
        }
        // 【场景落地 + 动作连贯】旧版每次跨时段都 position.set 到房间锚点，
        // 人会从街上瞬间跳到 9F。现在：
        //   · 室外段之间不重挂，人继续沿步行网走（不瞬移）
        //   · 进屋先沿步行网再走 enterDist 米（真实位移 + walk 动画），
        //     到门口阈值 enterRadius 就直接收起 —— 用户明确说不用做精细进门动画
        //   · 出屋回到自己那个片区的街面，挂回网，不全挤到剧情楼门口
        if (p.lastScene !== q.sceneId || p.lastSeg !== q.segment) {
          const first = p.lastSeg === undefined;
          const wasIndoor = !!p.wasIndoor;
          p.lastScene = q.sceneId; p.lastSeg = q.segment;
          // 作息切到「该进屋」时结束未走完的路线并接回步行网：否则人会带着
          // 几小时前的折线在屋里挂着，切回街上时被拉回旧坐标（可见瞬移）。
          if (p.mode === 'route' && q.indoor) {
            p.route = null;
            rejoinNet(p, dInfo);
          }
          if (q.indoor) {
            p.enterWalk = (!first && p.obj.visible)
              ? { remain: q.enterDist, speed: Math.max(WALK.ENTER_MIN, q.speedAbs || 1.0) }
              : null;
          } else {
            p.enterWalk = null;
            // 只有「确实在屋里」（两种可见性都为 false）才允许重挂到片区街面。
            // 可见的人保持在步行链上继续走 —— 否则出屋会从几百米外瞬移回来。
            const hidden = !p.obj.visible && !p.visible;
            if (wasIndoor && hidden) {
              const h = p.homeXZ || { x: q.x, z: q.z };
              const far = Math.hypot(h.x - p.obj.position.x, h.z - p.obj.position.z) > 80;
              if (!far) {
                const ang = (p.i * 2.399963) % (Math.PI * 2);
                const rad = 2 + (p.i % 5);
                const hx = h.x + Math.cos(ang) * rad, hz = h.z + Math.sin(ang) * rad;
                p.obj.position.set(hx, groundAt(hx, hz) + p.footFix, hz);
              }
              // 出生片区在几公里外时（全城多中心），绝不跨城重挂：
              // 留在当前街段，只把链索引接回最近的可走链。
              rejoinNet(p, dInfo);
            }
          }
          p.wasIndoor = !!q.indoor;
          play(p, clipOf(p), 0.22);
        }
      }
      p.stateT += dt;
      if (p.liveClipT > 0) {
        p.liveClipT = Math.max(0, p.liveClipT - dt);
        // 快判断的动作到期 → 立刻按此刻真实状态恢复常速动画，
        // 不会「加快一次就一直跑」也不会「说继续却还停着」。
        if (p.liveClipT === 0) { p.liveClip = null; play(p, clipOf(p), 0.22); }
      }

      // ---- 距离裁剪
      p.dist = p.obj.position.distanceTo(camPos);
      const vis = p.dist < VIS_DIST;
      if (vis !== p.visible) { p.visible = vis; p.obj.visible = vis; }
      // 真实社会状态：此刻在楼里的人（夜里睡觉、白天上班）不站在街上，
      // 而是摆在 life-scenes 的真实房间锚点上；只有镜头剖开这一栋时才显示，
      // 否则从实心外墙外会看到一群人穿墙浮在 9F。
      if (q && q.indoor) {
        // 【进屋过渡】沿当前步行链再走几米才收起：有真实位移才播 walk，
        // 不会「说在走动却原地跑」；走满 enterDist / 已在门口 enterRadius
        // 内就直接进去（模型收起），不做楼梯电梯等精细动作。
        const nearDoor = Math.hypot(
          p.obj.position.x - q.dest.x, p.obj.position.z - q.dest.z) <= q.enterRadius;
        if (p.enterWalk && !nearDoor && p.enterWalk.remain > 0 && p.obj.visible && dt > 0
          && p.mode === 'net') {
          const cc = G.chains[p.ci];
          const step = Math.min(p.enterWalk.remain, p.enterWalk.speed * dt);
          if (step > 0) {
            p.s = Math.min(cc.len, Math.max(0, p.s + step * p.dir));
            pointAt(cc, p.s, _v);
            const gy0 = groundAt(_v.x, _v.z);
            p.obj.position.set(_v.x, gy0 + p.footFix, _v.z);
            p.enterWalk.remain -= step;
            play(p, p.acts.walk ? 'walk' : 'idle', 0.16);
            p.mixer.update(Math.max(dt, 1 / 60));
            p.stillFrames = 0;
          }
          if (p.enterWalk.remain > 0) continue;
        }
        p.enterWalk = null;
        // 【阶段3】室内人脚底高度 = 门牌处真实地形高程 + 楼层相对高度。
        // 内核只给相对高度 q.floorRelY（floorElevationM，来自真实建筑高度派生），
        // 这里在显示层叠加地形，人就在对应楼层的绝对高度，不再贴地显示在楼外。
        const indoorGround = groundAt(q.x, q.z);
        const indoorY = (Number.isFinite(q.floorRelY) && q.floorRelY > 0)
          ? indoorGround + q.floorRelY : (q.y || indoorGround);
        const inside = CAM_PLACE ? CAM_PLACE() : null;
        // 一个房间不必挤进 20 人：隔一个显示一个，仍然读得出「屋里有人」。
        let show = !!inside && inside === q.place && q.interiorVisible !== false && (p.i % 2 === 0 || p.i < 1);
        // 镜头剖楼时把「屋里的人」摆到房间锚点。若这一帧人还可见、且锚点
        // 在几十米外，就会看到他从街上瞬间跳到 9F。先收起这一帧，下一帧
        // 再从房间锚点出现（用户允许「到阈值直接进去」，不需要进门动画）。
        const jumpToRoom = Math.hypot(q.x - p.obj.position.x, q.z - p.obj.position.z);
        if (show && jumpToRoom > 3 && p.obj.visible) {
          p.obj.position.set(q.x, indoorY + p.footFix, q.z);
          show = false;
        } else if (show) {
          p.obj.position.set(q.x, indoorY + p.footFix, q.z);
        } else if (!p.obj.visible) {
          // 不可见时也要把脚底放到真实房间锚点：否则跟拍机位仍对着“楼门口
          // + 街上高度”，用户点到人只看到一堵外墙。收起状态下的摆位不可见，
          // 不是瞬移；镜头剖开这一栋时他已经在自己的房间里。
          p.obj.position.set(q.x, indoorY + p.footFix, q.z);
        }
        play(p, clipOf(p), 0.2);
        p.obj.visible = show;
        p.visible = show;
        // 屋里的人只有镜头剖开那一栋才可见；不可见时不跑骨骼动画。
        // 1000 人里大半在室内，这一句省掉几百次 mixer.update / 子步。
        if (show) p.mixer.update(Math.max(dt, 1 / 60));
        // 生理状态 / 今日经历已在循环开头用真实参数统一推进过一次，
        // 这里不再重复 tick（重复会让 dtMin=0 且覆盖即时位置位）。
        continue;
      }

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

      // ---- LDT 逃生余量：和被困统计同一处（必须在所有 continue 之前，
      // 否则被距离裁剪掉的人不算，城市总览机位下 3000 人全在裁剪范围外）。
      // 一次查表 = O(1)：margin = 这一格的最晚出发时刻 - 当前情景时刻。
      if (ldtOn) {
        const m = LDT.marginAt(p.obj.position.x, p.obj.position.z, simMin);
        if (m !== null) {
          ldtBuf[ln++] = m;
          if (m <= 0) ldtDoomed++;
          else if (m <= 10) ldtTight++;
        }
      }

      // ---- 决策路线执行（必须在 dInfo 的 net/flee 分支之前）
      // 沿 Brain 选中的真实 walknet 折线逐帧走完；脚下突涨深水会在
      // updateRoute 里重新规划一条通往真实高处的逃生路线。
      if (p.mode === 'route') {
        updateRoute(p, dt, dInfo, FB);
        continue;
      }

      // ---- 积水避险：先看脚下有没有水；没水但正在下雨也得先找高处
      // 【必须在距离裁剪之前】城市总览机位下 3000 人全在 VIS_DIST 之外，
      // 放在裁剪之后人就永远不动 —— 实测 5 秒后 flee 人数一直是 0。
      // 水深采样是 O(1) 查表，跑动也是一次向量运算，全量算不心疼。
      // 只有真的开了积涝叠层（flood 传进来且可见）才响应，否则人照常走路。
      if (dInfo) {
        dInfo(p.obj.position.x, p.obj.position.z, _ds);
        // 涉水回写：脚在水里就记一笔（人·秒 + 排水体积）。走路的人自己也会被
        // 这笔记账改写的水深反过来影响 —— 走的人越多，这格退水越慢，后来者
        // 看到的水更久不散，于是更多人改道，负载下降，退水恢复。
        if (FB && dt > 0 && _ds.d > 0.02) FB.wade(p.obj.position.x, p.obj.position.z, _ds.d, dt);
        if (p.mode === 'net') {
          p.tryT = (p.tryT || 0) - dt;
          if (p.tryT <= 0) {
            // ① 踩到水（≥12 cm）→ 逃难
            // ② 只是在下雨 → 找高处避雨（用户 2026-10-29：一开下雨人就该动）
            //    留一半的人不动，模拟「有人嫌麻烦 / 有地方躲」——全员同时上山不真实
            if (_ds.wet) {
              // 【按个人上限决定跑不跑】原来一踩水就全员逃跑，3000 人整齐划一。
              // 现在：水没过他自己的涉水线才跑；没过就继续硬涉，并且把这件事记下来。
              const wade = p.profile.wade;
              if (_ds.d > wade) {
                p.tryT = 1.5;
                p.wading = 0;
                recordDecision(p, 'flee', `前方积水 ${Math.round(_ds.d * 100)} cm，`
                  + `超过我能走的 ${Math.round(wade * 100)} cm，先找高处`, _ds.d);
                startFlee(p, 'flood');
              } else {
                p.wading += dt;
                if (p.wading > 2.5 && !p.decision) {
                  recordDecision(p, 'wade', `积水 ${Math.round(_ds.d * 100)} cm，还能走，`
                    + `不绕（${p.profile.note}）`, _ds.d);
                }
              }
            } else if (heavyRain && p.lazy !== 1 && shouldShelter(p, rainMMH)) {
              p.tryT = 2.5;
              const ps = CROWD && CROWD.persons[p.i] ? CROWD.persons[p.i].phys : null;
              recordDecision(p, 'shelter',
                ps && ps.hasUmbrella ? '伞也挡不住了，先找个檐下' : '雨下大了，先找地方避一下', 0);
              startFlee(p, 'rain');
            } else {
              p.wading = 0;
              p.tryT = 1.0;
            }
          }
        } else {
          updateFlee(p, dt, dInfo, heavyRain);
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
        // 【不许倒着走】旧版翻转 p.dir 后立刻按新方向位移，而 yaw 靠
        // dt*6.5 平滑插值，20h 实测有上万帧「位移方向与朝向相反」。
        // 现在原地站 0.35 s 把身转过来，期间 state=idle 不产生位移。
        p.state = 'idle'; p.stateT = 0;
        p.holdT = Math.max(p.holdT || 0, 0.35);
        play(p, p.acts.idle ? 'idle' : 'walk', 0.12);
        continue;
      }
      p.blockedT = 0;

      // ---- 状态推进（每 0.4~1.2 s 想一次）
      p.nextThink -= dt;
      // 「先停一下 / 等雨小 / 刚走到真实目的地」：站定期间不许状态机把人
      // 改回 walk，否则决策选了「等」却还在原地跑。
      if (p.holdT > 0) {
        p.holdT -= dt;
        p.state = 'idle';
        if (p.nextThink <= 0) p.nextThink = Math.max(0.2, p.holdT);
      }
      if (p.nextThink <= 0) {
        p.nextThink = 0.4 + rnd() * 0.9;
        const ns = nextState(p.state, {
          blocked: pedAhead && p.blockedT > 0.6,
          nearEnd: p.s > c.len - 2.0 || p.s < 2.0,
          rnd: rnd(),
          cooldownOk: p.stateT > 0.6,
          stateT: p.stateT,   // 阶段2B：让状态机知道当前状态已持续多久
        });
        if (ns !== p.state) {
          p.state = ns; p.stateT = 0;
          play(p, clipOf(p), ns === 'walk' ? 0.22 : 0.34);
        }
      }

      // ---- 位移
      const sBefore = p.s;
      let spd = 0;
      if (p.state === 'walk') spd = p.speed * (pedAhead ? WALK.CROWD_MUL : 1.0);
      else if (p.state === 'yield') spd = 0;
      // 【2026-11-19 第5步：涉水真的走不动】
      // 此前 kernel 的 wadingSpeed 只喂给决策输入，**位移完全不受水深影响**，
      // 人在 90 cm 的水里和干地一样快。这解释了为什么涉水死亡的暴露时间偏短。
      // 现在把同一张实测自由速度表当唯一来源，按「当前水深 / 干地」的比值
      // 乘到实际位移上，不另写一套数值。表本身来自中科大泳池实验
      // （0/0.35/0.60/0.90 m），已在 params 里标过出处与同源问题。
      if (spd > 0 && dInfo) {
        dInfo(p.obj.position.x, p.obj.position.z, _ds);
        const dNow = Number.isFinite(_ds.d) ? _ds.d : 0;
        if (dNow > 0.05) {
          const v0 = wadingSpeed(0);
          const vd = wadingSpeed(dNow);
          if (v0 > 0 && vd > 0) spd *= Math.max(0.25, Math.min(1, vd / v0));
        }
      }
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
          // 死胡同才掉头，且不播 turn180（原地转圈）；同样先站定转身，
          // 别让下一帧按新方向位移时人还是背朝前。
          p.dir = -p.dir;
          p.s = atHead ? c.len - 0.25 : 0.25;
          p.state = 'idle'; p.stateT = 0;
          p.holdT = Math.max(p.holdT || 0, 0.35);
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
      let px = _v.x + nx * p.lat, pz = _v.z + nz * p.lat;
      // 【实体碰撞】灯杆 / 树 / 停放车 / 家具都登记在 COLLIDE 里。撞上就退回
      // 上一帧的里程并把横向让路量往旁边推一点 —— 人贴着障碍滑过去，不穿模。
      if (COLLIDE_PED) {
        const hit = COLLIDE_PED.blockedCircle(px, pz, 0.32, gy + 0.1, gy + 1.7,
          { ignoreTags: IGNORE_BUILDING });
        if (hit) {
          p.s = sBefore;
          p.latTarget = Math.max(-1.1, Math.min(1.1, p.latTarget + (p.lat >= 0 ? 0.45 : -0.45)));
          p.blockedT += dt;
          const back = pointAt(c2, Math.min(Math.max(p.s, 0), c2.len), _v);
          px = _v.x + nx * p.lat; pz = _v.z + nz * p.lat;
        }
      }
      // 【人对人】0.62 m 内算碰到：停一下，并往右让一点，避免两个人叠着走
      const fwdX = Math.sin(p.yaw), fwdZ = Math.cos(p.yaw);
      for (const q2 of placedThisFrame) {
        const dxp = px - q2.x, dzp = pz - q2.z;
        if (dxp * dxp + dzp * dzp >= 0.62 * 0.62) continue;
        // 只避让「身前的」人：否则两个人面对面会互相判定、一起钉死。
        if (dxp * fwdX + dzp * fwdZ > -0.1) {
          p.blockedT += dt;
          p.latTarget = Math.max(-1.1, Math.min(1.1, p.latTarget + 0.3));
          p.nextThink = Math.min(p.nextThink, 0.05);
        }
        break;
      }
      placedThisFrame.push({ x: px, z: pz });
      p.obj.position.set(px, gy + p.footFix, pz);
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

    // ---- 【整帧兜底】可见的人这一帧没挪动，就不许继续播 walk/run ----
    // 被前车 / 灯杆 / 家具卡住、或社会层把人钉在室内锚点时，clipOf 仍可能
    // 给 walk/run。连续 3 帧位移 <2 cm 才切 idle：转弯换链偶尔一帧不动不切，
    // 避免动画来回闪。
    // 【2026-11-12】不再只管「可见的人」：距离裁剪掉的人下一次可见时
    // 不该带着上一帧的 walk 动画突然出现在原地。全城 3000 人一律核对。
    if (dt > 0) for (let fi = 0; fi < peds.length; fi++) {
      const p = peds[fi];
      if (!p.cur) continue;
      let moved = Math.hypot(p.obj.position.x - frameXZ[fi * 2],
        p.obj.position.z - frameXZ[fi * 2 + 1]);
      // 【建筑实体硬约束】室外的人不许停在楼体 AABB 内部。可走链只在初始化
      // 筛过一次，A* 折线 / flee 直线兜底 / 换链都可能把人送进楼里；这里用
      // 与出生门牌同一份 SOLIDS 把人推到最近的楼边，室内的人豁免。
      // 静止的人位置不会新变，跳过哈希查询（全城 2 万栋楼，别每帧全量扫）。
      if (moved > 0.02 && !p.qIndoor && !p.inVehicle && SOLIDS && SOLIDS.hit && SOLIDS.snapOut
          && SOLIDS.hit(p.obj.position.x, p.obj.position.z, -1.0)) {
        const out = SOLIDS.snapOut(p.obj.position.x, p.obj.position.z, 1.0);
        p.obj.position.x = out.x;
        p.obj.position.z = out.z;
        p.buildingPush = (p.buildingPush || 0) + 1;
        moved = 0;
        // 路线撞楼就尽快重规划，别一直贴着同一面墙原地磨。
        if (p.mode === 'route' && p.route) p.route.stuck = (p.route.stuck || 0) + 4;
      }
      // 【帧内瞬移保护】跨段出屋重挂 / 换链 / 避险落点偶尔会把人从几公里外
      // 挪过来（全城多中心后片区相隔 2–3 km）。这种跳绝不能给观众看到：
      // 这一帧收起模型，下一帧距离裁剪按真实距离重新显示。逻辑位置不回退，
      // 状态机照常继续，所以不会卡住也不会丢人。
      // 2 m/帧 已远超任何人一帧能走的量（1.5 m/s × 0.2 s ≈ 0.3 m）。
      // 阈值放到 2 m，把「可见的人跨 2~3 m 重挂」也收进这一帧的隐藏保护。
      if (moved > 2) {
        p.obj.visible = false;
        p.visible = false;
        p.stillFrames = 0;
        continue;
      }
      // 【隐藏只管一帧】net 模式刻意不做距离裁剪（全城 3000 人都要能看见），
      // 旧版却没有任何恢复分支：被上面这次瞬移保护收起的人，会一直消失到
      // 他切进 route / 室内分支为止。这里对普通步行的人立即放出来；室内
      // 剖切与未启用的人仍由各自的分支管，不在这里乱改。
      if (p.visible === false && p.enabled !== false
          && p.mode === 'net' && !p.qIndoor) {
        p.visible = true; p.obj.visible = true;
      }
      // 可见的人这一帧挪动不足 6 cm 就不许继续播 walk/run
      p.stillFrames = moved < 0.06 ? (p.stillFrames || 0) + 1 : 0;
      // 【姿态跟真实位移走】旧版 play() 只在状态切换时调用，决策层 slow /
      // hurry / resume 改了 p.speed 或 p.route.speed 后，clip 的 timeScale
      // 还停在旧值 —— 人「加快」了但腿还是原来的频率。这里每帧用**实测
      // 位移速度**刷新播放速率；同时把「明明在走却还播 idle/sit」纠正回来。
      const clipName = String(p.cur.getClip().name);
      if (moved > 0.06) {
        if (/idle|sit/i.test(clipName)) play(p, 'walk', 0.18);
        else {
          const realV = moved / Math.max(1e-3, dt);
          p.cur.setEffectiveTimeScale(ANIM.timeScale(realV, clipName));
        }
      } else if (/walk|run/i.test(clipName)) {
        play(p, p.acts.idle ? 'idle' : 'walk', 0.18);
      }
    }

    // ---- 累计口径（用户 2026-10-29：「每次的困死数都一样吗？应该是随机的」）
    // 【必须放在循环之后】trapStats 在循环前被归零，循环里逐人累加；
    // 放在循环前就只能读到 0（第一版就这么错，peak 永远 0）。
    // 三个量：峰值、人·分钟（∫N dt）、第一次被困的时刻。
    if (tst) {
      if (tst.trapped > trapPeak) trapPeak = tst.trapped;
      if (tst.stranded > strandPeak) strandPeak = tst.stranded;
      if (simMin !== null) {
        if (tst.trapped > 0 && trapFirstMin < 0) trapFirstMin = simMin;
        const dtm = lastSimMin >= 0 ? simMin - lastSimMin : 0;
        if (dtm > 0) trapPersonMin += tst.trapped * dtm;
        lastSimMin = simMin;
      }
    }

    // ---- LDT 聚合（循环之后，同上：必须在逐人累加完之后）
    if (ldtOn && ln > 0) {
      ldtCovered = ln;
      if (ln > ldtBuf.length) ln = ldtBuf.length;
      const sub = ldtBuf.subarray(0, ln);
      sub.sort();                                  // Float64Array.sort 是数值排序
      ldtMedian = sub[ln >> 1];
      ldtMin = sub[0];
      if (ldtDoomed > ldtDoomPeak) ldtDoomPeak = ldtDoomed;
      if (ldtDoomed > 0 && ldtFirstDoomMin < 0) ldtFirstDoomMin = simMin;
    }
  }

  // ---------------------------------------------------------------- 开关
  function setVisible(on) { group.visible = !!on; }
  /** 换 LDT 表（切工况时用）。传 null = 关掉逃生余量统计。 */
  function setLdt(l) { LDT = l || null; }

  /**
   * 【缩小区域】按登记住址（homeXZ）把仿真限制在一个矩形片区里。
   * 默认 null = 全城；传 {x0,x1,z0,z1} 时，住址在片外的人不推进、不绘制、
   * 不进伤亡判定。这是「跟着具体的人看全过程」用的观察开关，
   * 不改任何判断公式；片区外的人仍然登记存在，只是不参与这一段推演。
   * 统计分母仍是全部登记人口，文档里已写明这个口径。
   */
  let regionRect = null;
  function inRegion(p) {
    if (!regionRect) return true;
    const h = p.homeXZ;
    if (!h) return true;
    return h.x >= regionRect.x0 && h.x <= regionRect.x1
      && h.z >= regionRect.z0 && h.z <= regionRect.z1;
  }
  function setRegion(rect) {
    regionRect = rect || null;
    let kept = 0;
    for (const p of peds) {
      const on = inRegion(p);
      p.enabled = on;
      p.obj.visible = false;
      p.visible = false;
      if (on) kept++;
    }
    return { enabled: kept, total: peds.length, rect: regionRect };
  }

  function setCount(n) {
    n = Math.max(0, Math.min(peds.length, n | 0));
    for (let i = 0; i < peds.length; i++) {
      // setCount 每帧会被 main 调用一次；让它也遵守片区，否则会把裁掉的人重新打开。
      const on = i < n && inRegion(peds[i]);
      peds[i].enabled = on;
      // obj.visible 与 p.visible 必须同步：只改前者的话，距离裁剪看到
      // vis === p.visible 就不会把人重新打开，被裁掉的行人永久隐身。
      peds[i].obj.visible = false;
      peds[i].visible = false;   // 下一帧由距离裁剪按真实距离重新决定
    }
    return n;
  }

  /**
   * 拖动进度条时把人「快进」到那一帧该有的样子。
   * 【为什么需要】拖滑块水变了、人没变，那「困死数」就是「这批人 + 那一帧的水」
   * 错位配对。这里在跳轴后补一小段，让行人和当前水深对齐。
   *
   * 【2026-11-13 修复】旧版 n=ceil(sec/20)、dt=sec/n，sec 最大 120 ⇒ 6 步、
   * 每步 20 仿真秒 ⇒ 一步跨 28 m，帧末「moved>2 隐藏保护」把全城人一次性
   * 收起，拖完时间轴整城消失；同时 LIVE/EXP 被灌进 120 秒虚假经历。
   * 现在步长锁死 ≤0.2 仿真秒（与 clock 子步一致），总补跑不超过 12 秒：
   * 只负责对齐水深，不再假装补完 8 万秒。
   * @returns 补跑了几步
   */
  function catchUp(sec, camera, flood) {
    if (!(sec > 0)) return 0;
    const total = Math.min(sec, 12);
    const n = Math.max(1, Math.min(60, Math.ceil(total / 0.2)));
    const dt = total / n;
    for (let i = 0; i < n; i++) update(dt, camera, flood);
    return n;
  }

  /** 拖时间轴后清掉上一时刻残留的逐人执行状态，并强制恢复可见。
   *  live-agent.restore 只重摆在家/在岗的人，p.mode / p.route / p.holdT /
   *  liveClip / 动画 clip 这些执行层状态会跨时刻带过来；帧末隐藏保护也不会
   *  自己把人放出来。不清理就会出现「拖完时间轴全城消失 / 站着播旧动画」。 */
  function resetAfterSeek() {
    if (!frameXZ || frameXZ.length < peds.length * 2) frameXZ = new Float64Array(peds.length * 2);
    refugePicks.clear();
    for (const p of peds) {
      p.mode = 'net';
      p.route = null;
      p.holdT = 0;
      p.state = 'idle';
      p.stateT = 0;
      p.nextThink = 0;
      p.stillFrames = 0;
      p.liveClip = null;
      p.liveClipT = 0;
      p.liveAction = null;
      p.enterWalk = null;
      p.justParked = false;
      p.wasIndoor = false;
      p.inVehicle = false;
      p.driveSpeed = 0;
      p.driveInfo = null;
      p.visible = true;
      p.obj.visible = true;
      p.obj.scale.setScalar(1);
      frameXZ[p.i * 2] = p.obj.position.x;
      frameXZ[p.i * 2 + 1] = p.obj.position.z;
      if (p.cur) play(p, p.acts.idle ? 'idle' : 'sit', 0.01);
    }
  }

  return {
    group, peds, update, catchUp, resetAfterSeek, setSolids, setVisible,
    setCount, setRegion, getRegion: () => regionRect, setLdt, graph: G,
    crowdLife: CROWD, planner: PLANNER,
    /** 实时决策主体：目标 / 群体内核 / 每 0.5~1 仿真秒的判断日志（演示与验收读它）。 */
    live: LIVE,
    /** 「今天干了什么 / 经历了什么」的真实累积状态，逐人可查。 */
    experience: EXP,
    /** 细粒度人群圈层：逐人画像 + 到底分了多少种。 */
    circles: CIRCLES,
    circleStats: () => summarizeCircles(CIRCLES),
    /** 逐人避险选址记录：经验值 / 选了多高 / 走了多远（验收灾害履历用）。 */
    /** 「同一位置、只换经验」的反事实对照，供专项探针验证避险选址偏好。 */
    probeRefuge(x, z, forcedHz) {
      const R = findRefuge(x, z, null, false, -1, REFUGE_MAX, forcedHz);
      if (!R) return null;
      return { x: +R.x.toFixed(1), z: +R.z.toFixed(1), y: +R.y.toFixed(2),
        kind: R.kind, rise: +(R.y - groundAt(x, z)).toFixed(2),
        dist: +Math.hypot(R.x - x, R.z - z).toFixed(1) };
    },
    refugePick: (i) => refugePicks.get(i) || null,
    refugePicks: () => [...refugePicks.values()],
    /** 伤亡 / 被困 / 事故台账：逐人可回查 minute / 坐标 / 水深 / 原因。 */
    incidents: INC,
    /** L3 出行方式 + L4 驾驶判断 + 交规统计。 */
    drive: DRIVE,
    /** 速度真值自检结果（启动即跑，不一致会 warn）。 */
    speedAudit: SPEED_AUDIT,
    /** 交通层做「斑马线行人优先」查询用的空间索引。 */
    pedNear,
    /** 帧末一次取走全部统计（HUD / 24h 验收用）。 */
    fullStats() {
      return {
        live: LIVE ? LIVE.stats() : null,
        circles: summarizeCircles(CIRCLES),
        driving: DRIVE.stats(),
        incidents: INC.stats(),
        speed: SPEED_AUDIT,
      };
    },
    /** 决策路线实时统计（HUD / 验收）：多少人真的在按自己选的路走。 */
    routeStats() {
      let active = 0, walking = 0, sumDist = 0, sumWalked = 0, toHigh = 0;
      for (const p of peds) {
        if (p.mode !== 'route' || !p.route) continue;
        active++;
        if (p.route.walked > 0.5) walking++;
        sumDist += p.route.dist || 0;
        sumWalked += p.route.walked || 0;
        if (p.route.onArrive === 'shelter') toHigh++;
      }
      return { ...routeStats, active, walking, toHigh,
        plannedDist: +sumDist.toFixed(1), walkedDist: +sumWalked.toFixed(1) };
    },
    /** 让外部（mark.js）完全接管第 0 个人；传 null 恢复常规行为。 */
    setHeroStep(fn) { heroStep = fn; },
    /** 供外部按剧情播动作（复用同一套 crossFade，避免和内部状态机打架）。 */
    playFor(p, name, fade = 0.28) { play(p, name, fade); },
    /** 积水避险的实时状态（验收/截图时用：console 里看有多少人在跑、多少人躲着）。 */
    fleeStats() {
      let net = 0, flee = 0, shelter = 0, roof = 0, escaped = 0;
      let rainShelter = 0, floodShelter = 0, routing = 0;
      for (const p of peds) {
        if (p.mode === 'route') routing++;
        if (p.mode === 'flee') flee++;
        else if (p.mode === 'shelter') {
          shelter++;
          if (p.refuge && p.refuge.kind === 1) roof++;
          if (p.why === 'rain') rainShelter++; else floodShelter++;
        }
        else net++;
        if (p.mode === 'shelter') escaped++;
      }
      return {
        net, flee, shelter, roof, routing, refuges: refuges.length,
        byProfile: peds.reduce((a, q) => { a[q.profile.id] = (a[q.profile.id] || 0) + 1; return a; }, {}),
        // 避雨 / 避水 分别有多少人躲在避难所（用户 2026-10-29 要求「下雨就动」）
        rainShelter, floodShelter, raining: lastRaining,
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
        // 累计口径：整场最惨的时候有多少人被困、被困了多久
        trappedPeak: trapPeak,
        strandedPeak: strandPeak,
        trappedPersonMin: Math.round(trapPersonMin),
        firstTrapMin: trapFirstMin,
        wadeMax: 0.30,
        // 【LDT 逃生余量】margin = 最晚出发时刻 - 当前时刻（分钟）。
        // 这几个数回答的是「人一直在动」下的问题：还剩多少时间跑得掉。
        ldtOn,
        ldtCovered,
        ldtDoomed,            // 此刻已来不及走掉的人
        ldtTight,             // 富余 0~10 min，很紧
        ldtMedian,            // 余量中位数（分钟；大数表示整场都不会淹）
        ldtMin,               // 全场最紧的那个人还剩多少
        ldtDoomPeak,          // 最惨时刻已来不及的人数
        ldtFirstDoomMin,      // 第一次出现「来不及」的情景时刻
      };
    },
    clusterOf,
    stats: {
      usable: usable.length, total: G.chains.length, dropped, count: peds.length,
      // 站位策略：长度加权均匀随机（no hot spots）。改回热点配额会在这里反映。
      placement: 'uniform',
      planned: count,
    },
  };
}
