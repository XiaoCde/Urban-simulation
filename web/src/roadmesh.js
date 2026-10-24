/**
 * L2_road 的路面/结构几何（v2 重写）。
 *
 * 相对 v1（留在 roads.js 里的 ribbonMeshLegacy）修掉用户投诉的四件事：
 *
 * 1) 「路面像一层纸，很平，没有立体感」
 *    v1 每个横断面只有一个 y，左右两个顶点共用 —— 于是路面天然是一块【水平板】，
 *    坡地上它一头扎进土里、一头悬空。v2 左右顶点各自取**本地地形**高程：
 *      yEdge = max(terrain(edge) + 0.14, yCenter - CAMBER)
 *    路面于是会随地形横向倾斜/起伏，同时在中间保留 6 cm 路拱。
 *
 * 2) 「跟地形融在一块 / 穿模」
 *    路面有厚度了：两侧加 0.30 m 高的**路缘立面**（skirt），从路面边一直落到
 *    地面以下。远处看是一条实心的带子，不是一个零厚度的面片。
 *
 * 3) 「河边的路飞到天上」
 *    v1 里 isShore 分支把「落在水体多边形里」的路一律抬到 waterY + 1.4 m，
 *    于是滨河步道整条浮在江面上空 1.4 m。v2 给 path 层传 noShoreLift：
 *    地面低于水面的断面直接标记为 dead，对应的三角面不发射（路在这里断掉，
 *    这是对的 —— 真正的滨江步道走岸上，不走水里）。
 *
 * 4) 「立交桥完全没有体现」
 *    数据结构新增第 6 个 float：**grade**（带符号的高程偏移，米）。
 *    +7 = 高架（Whitehurst Freeway / Potomac Freeway），-6 = 路堑
 *    （12th/9th/E Street Expressway，DC 真实的浅埋隧道段）。
 *    高架段自动长桥墩 + 护栏，路堑段自动长挡土墙。
 *
 * 顶点布局 stride = 6：[x, y(0 占位，高程在 JS 里补), z, u, v, grade]
 */

import * as THREE from 'three';

export const STRIDE = 6;

const LIFT = 0.16;      // 路面比地形高多少
const CAMBER = 0.06;    // 路拱（中间比边缘高多少）
const SKIRT = 0.45;     // 路缘立面高度
const OFF = 1.7;        // 纵向取样半径
const RPAD = 3.2;       // 中心线取样的横向半径（决定「叠在同一块地上的多条 way 同高」）
const MAX_BRIDGE_PAIRS = 520;
const DECK_MIN_CLEAR = 2.4;
const DECK_ABOVE_BANK = 0.55;
const DECK_CROWN = 0.7;
const RAMP_PAIRS = 10;
const RAIL_H = 1.05;
const GIRDER = 1.5;
const PIER_EVERY = 26.0;   // 高架桥墩间距（米）
const WALL_T = 0.28;

// 【路口高程共享缓存】用户说「路都是一节一节的断头」。
// 根因：每条 way 各自按「中心线 ±3.2 m 地形最高 + 量化到 5 cm」取高程。
// 两条路在路口相交时，交点坐标只差几十厘米，但各自 ±3.2 m 采样到的点不同，
// 于是同一块路口得到两个高度，路口就出现台阶（实测 11% 的邻近顶点对 >5 cm，
// 5.5% >20 cm，最狠 32 m —— 那是高架和地面路相邻）。
// 办法：把「中心点 → 高程」按 2 m 格子缓存。落在同一格里的所有 way 共用第一次
// 算出来的值，路口天然齐平。
const Y_CACHE = new Map();
const CELLY = 2.0;

/**
 * @param {{verts:Float32Array, idx:Uint32Array, nv:number}} rb
 * @param {object|null} T  loadTerrain()
 * @param {THREE.Material} mat
 * @param {string} name
 * @param {number} waterY
 * @param {number} extraLift
 * @param {THREE.Material|null} railMat 结构材质（路缘石/桥墩/挡墙）
 * @param {object|null} W  loadWater()
 * @param {object} opt { yPad, snap, snapLift, noShoreLift, noStructure }
 */
// ---- 路廊下切栅格（由 terrain.js 的 loadRoadCut 提供）
// 为什么必须读它：地形网格的顶点会被 cut.i16 下压（路面切进坡里），但路面 ribbon
// 如果只读原始 DTM，就会和「实际画出来的地面」差 0.1~4 m —— 这正是用户说的
// 「路跟地融在一块 / 路像一层纸 / 河边的路飞到天上」的共同来源。
// 读 cut 之后，路面 = 可见地面 + LIFT，处处贴合，且跟着地形起伏走。
let ROAD_CUT = null;
export function setRoadCut(c) { ROAD_CUT = c || null; }

export function ribbonMesh(rb, T, mat, name, waterY = 0.046, extraLift = 0, railMat = null, W = null, opt = {}) {
  const { verts: src, idx, nv } = rb;
  const pos = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const pairs = Math.floor(nv / 2);

  const OFFY = opt.yPad || OFF;
  const terr = (x, z) => (T ? T.sampleHeight(x, z) : 0);

  // 「离水多远」（米）。用 web/assets/terrain/wet.u8：0 = 水边，255 = 30 m 外。
  // 用户投诉「河流两边全是蜘蛛丝」—— 那是 1.6 万条 OSM footway 沿江岸铺成的一张网。
  const WET_MAX = 30.0;
  const waterDist = (T && T.wet) ? (x, z) => {
    const c = Math.round((x - T.x0) / T.step - 0.5);
    const r = Math.round((T.meta.grid.y1 + z) / T.step - 0.5);
    if (c < 0 || r < 0 || c >= T.cols || r >= T.rows) return WET_MAX;
    return T.wet[r * T.cols + c] / 255 * WET_MAX;
  } : () => WET_MAX;

  // 可见地面高程 = min(DTM 双线性, 下切值 - 0.12)。与 terrain.js 顶点位移同一公式。
  const gsurf = T ? (x, z) => {
    let h = T.sampleHeight(x, z);
    if (ROAD_CUT) {
      const g = T.meta.grid;
      const c = Math.round((x - g.x0) / T.step - 0.5);
      const r = Math.round((g.y1 + z) / T.step - 0.5);
      if (c >= 0 && r >= 0 && c < T.cols && r < T.rows) {
        const v = ROAD_CUT[r * T.cols + c];
        if (v !== -32768) { const cv = v * 0.01 - 0.12; if (cv < h) h = cv; }
      }
    }
    return h;
  } : () => 0;

  // 地形在 (x,z) 附近取最大：路不能比它脚下的地低，否则地面会顶穿路面
  const yOf = T ? (x, z) => {
    let m = T.sampleHeight(x, z);
    const a = T.sampleHeight(x + OFFY, z), b = T.sampleHeight(x - OFFY, z);
    const c = T.sampleHeight(x, z + OFFY), d = T.sampleHeight(x, z - OFFY);
    if (a > m) m = a; if (b > m) m = b; if (c > m) m = c; if (d > m) m = d;
    return m;
  } : () => 0;

  // ---- 第一遍：中心线高程 + 水面标记
  const gy = new Float32Array(pairs);
  const over = new Uint8Array(pairs);
  const grade = new Float32Array(pairs);
  for (let i = 0; i < pairs; i++) {
    const s0 = i * 2 * STRIDE, s1 = (i * 2 + 1) * STRIDE;
    const cx = (src[s0] + src[s1]) / 2, cz = (src[s0 + 2] + src[s1 + 2]) / 2;
    const ck = Math.round(cx / CELLY) * 1000003 + Math.round(cz / CELLY);
    let base = Y_CACHE.get(ck);
    if (base === undefined) {
      // 【路面不许骑在坡上】取 ±3.2 m 最大值是为了「地面别顶穿路面」，但在
      // 陡坡/河岸上会让路面比正下方地面高出 1~4 m，整条路变成悬空带子。
      // 折中：最大值再和「中心点 + 0.55 m」取小 —— 允许的最多悬空 0.55 m，
      // 正好被 0.45 m 路缘立面 + 0.16 m 抬升吃掉。
      // 【不再取 ±3.2 m 最大值】下切栅格已经把整条走廊削平，路面只要跟着
      // 可见地面走就能既贴地又不被顶穿；取最大值反而会造出悬空带子。
      base = Math.round(gsurf(cx, cz) * 20) / 20;
      Y_CACHE.set(ck, base);
    }
    const m = base;
    gy[i] = m + LIFT + extraLift;
    grade[i] = src[s0 + 5] || 0;
    let wet = false;
    if (W) wet = W.sampleBed(cx, cz) !== null;
    else if (T) wet = T.classify(cx, cz) === 0;
    const hDem = terr(cx, cz);
    over[i] = (wet && hDem < waterY + 0.35) ? 1 : 0;
  }

  // ---- way 边界标记（关键！）
  //
  // `pairs` 是**所有 way 首尾相连**拼成的全局数组。第 i 个断面的前一个断面 i-1
  // 可能属于另一条相隔几公里的 way。以前桥面判定只看 `i > 0 && j < pairs`，
  // 于是「一条路走到河边就断了」这种情况被当成「有桥台」，桥面高程从**另一条路**
  // 的地面取 —— 实测造出 23 m 高的桥 (x=725,z=331 处地面只有 0.3 m)，
  // 一排在江面上的高跷：正是用户说的「浮在空中的蜘蛛网 / 一节一节断头」。
  //
  // 导出时每条 way 内部已细分到 ≤6 m，所以相邻断面中心距 > 24 m 一定是 way 接缝。
  const brk = new Uint8Array(pairs + 1);
  brk[0] = 1; brk[pairs] = 1;
  for (let i = 1; i < pairs; i++) {
    const a = i * 2 * STRIDE, b = (i - 1) * 2 * STRIDE;
    if (Math.hypot(src[a] - src[b], src[a + 2] - src[b + 2]) > 24) brk[i] = 1;
  }

  // ---- 第二遍：桥面 / 河岸段
  const isBridge = new Uint8Array(pairs);
  const isShore = new Uint8Array(pairs);
  const deckAt = new Float32Array(pairs);
  const dead = new Uint8Array(pairs);
  const deckMin = waterY + DECK_MIN_CLEAR + extraLift;
  let nBridged = 0, nShoreRuns = 0;
  for (let i = 0; i < pairs;) {
    if (!over[i]) { i++; continue; }
    let j = i;
    while (j < pairs && over[j]) j++;
    // 两端都必须是**同一条 way 的连续断面**，才算真正落到岸上
    const landed = i > 0 && !brk[i] && j < pairs && !brk[j];
    const len = j - i;
    // 【2026-10-24 定案：路面不再自己造桥】
    // 以前这里把「两端都落地的涉水段」抬成桥面 + 桥头引道 + 桥墩护栏，判定靠
    // landcover + DTM 猜。只要判错一段，整条路就在江面或岸坡上凭空升起 2~7 m，
    // 再配上竖直护栏和桥墩，从任何角度看都是一排悬空的细线 —— 这正是用户连着
    // 三天在骂的「浮在空中的蜘蛛网 / 一节一节断头 / 桥很离谱 / 河边的路飞到天上」。
    // 现在：所有涉水断面一律判死，路到岸边为止。真正要看的桥由 bridges.js 单独
    // 出图（bridge_deck / bridge_arch_stone / ...，按 path 逐点找水面跨度，
    // 桥面命中率 83/84）。路面只负责一件简单事：贴着可见地面走。
    {
      for (let k = i; k < j; k++) { isShore[k] = 1; dead[k] = 1; }
      nShoreRuns++;
    }
    i = j;
  }

  // ---- 桥头引道（防止「断头」）
  // 桥面在 waterY+2~6.5 m，而岸边路面只比水高 0.5~2 m。以前两者在同一个 4 m
  // 断面上直接切换，等于凭空立起一道 4 m 的墙 —— 用户说的「一节一节、断头、
  // 立交桥很离谱」就是这个。现在用 RAMP 个断面把路面从地面渐变抬到桥面，
  // 桥头是一条 60~70 m 的引道，桥就接进路网里了。
  const RAMP = 16;
  const rampY = new Float32Array(pairs).fill(NaN);
  for (let i = 0; i < pairs; i++) {
    if (!isBridge[i]) continue;
    let j = i;
    while (j < pairs && isBridge[j]) j++;
    const yIn = deckAt[i], yOut = deckAt[j - 1];
    // 引道**不许跨 way 边界**：跨过去就是把桥抬到另一条街上空几十米。
    for (let k = 1; k <= RAMP; k++) {
      const a = i - k;
      if (a < 0 || isBridge[a] || brk[a + 1]) break;
      const u = k / (RAMP + 1);
      const v = gy[a] + (yIn - gy[a]) * (1 - u);
      rampY[a] = Number.isNaN(rampY[a]) ? v : Math.max(rampY[a], v);
    }
    for (let k = 1; k <= RAMP; k++) {
      const b = j - 1 + k;
      if (b >= pairs || isBridge[b] || brk[b]) break;
      const u = k / (RAMP + 1);
      const v = gy[b] + (yOut - gy[b]) * (1 - u);
      rampY[b] = Number.isNaN(rampY[b]) ? v : Math.max(rampY[b], v);
    }
    i = j - 1;
  }

  const by = new Float32Array(pairs);
  for (let i = 0; i < pairs; i++) {
    if (isBridge[i]) { by[i] = deckAt[i]; continue; }
    if (!Number.isNaN(rampY[i])) { by[i] = Math.max(gy[i], rampY[i]); continue; }
    if (isShore[i]) {
      // 【沿岸段一律贴地，绝不许抬到水位之上】
      // v1 把「落在水体多边形里」的断面抬到 waterY + 1.4，本意是给堤岸路一点
      // 高度感，结果整条滨江路浮在江面上空 1.4 m —— 用户原话「河边的路都飞到
      // 天上去了」。水体多边形经过平滑外扩，岸边几十米的干地都在里面，
      // 所以这个「补偿」扫到的全是本来就在岸上的路。
      // 现在：贴地。地面真的低于水面就让它被水盖住（看起来是没入水的河滩），
      // 步道更极端时整段删掉（见 noShoreLift）。
      if (opt.noShoreLift && gy[i] < waterY + 0.25) { dead[i] = 1; }
      by[i] = gy[i];
      continue;
    }
    by[i] = gy[i] + grade[i];
  }

  // ---- 「路不许浮空」硬约束（2026-10-24 补）
  //
  // 第 1 条「地形与路面不匹配」的残留：walk_ways 有 101 个顶点（0.33%）比可见地面
  // 高出 0.6 m 以上，最大 **7.97 m**，均值 1.86 m —— 那就是悬在半空的步道。
  // 来源是 `by[i] = gy[i] + grade[i]`，grade 来自导出的第 6 个分量，个别断面
  // 拿到一个远大于横坡的绝对值。
  //
  // 与其去追 grade 的语义，不如加一条**不可能违反的兜底**：路面任何一点都不许
  // 高过脚下可见地面 1.2 m（1.2 m 已经足够容纳「跨沟/过涵洞」这种小抬升，又远低于
  // 「看起来浮空」的门限）。桥不在 roadmesh 里造（isBridge 全零），所以不会误伤。
  {
    let nClamp = 0;
    for (let i = 0; i < pairs; i++) {
      if (isBridge[i] || dead[i]) continue;
      const cx = (src[i * 2 * STRIDE] + src[(i * 2 + 1) * STRIDE]) / 2;
      const cz = (src[i * 2 * STRIDE + 2] + src[(i * 2 + 1) * STRIDE + 2]) / 2;
      const g = gsurf(cx, cz);
      if (!isFinite(g)) continue;
      const cap = g + 1.2;
      if (by[i] > cap) { by[i] = cap; nClamp++; }
    }
    if (nClamp) console.log(`[roads] ${name} 浮空夹紧 ${nClamp}`);
  }

  // ---- 水皮上的路一律判死（2026-10-24 补）
  //
  // 第 4 条「河道上的路删掉」的残留根因就在这里：
  // 上面 over[] 的判据是 `hDem < waterY + 0.35`。而河床在很多地方被 DTM 插平成
  // 0.3~0.9 m（3DEP 在水体里基本给的是水面高度），这个条件**不成立**，断面于是
  // 被当成「岸上路」保留下来 —— 水面上就出现一条贴着水皮的路。
  //
  // 实测（`node _check5.mjs`，把地面换成 gsurf 之后）落在「水体多边形内、且
  // y <= waterY+1.2」的顶点：road_ways 225 / walk_ways 203 / path_ways 251。
  //
  // 为什么这条不会误杀桥：2026-10-24 起 roadmesh 已经不再自己造桥（见上面那段），
  // isBridge 全零；真正的桥由 bridges.js 单独出图，桥面高程在 waterY+2~6.5，
  // 远高于这里的 1.25 m 门限。
  {
    let nd = 0;
    for (let i = 0; i < pairs; i++) {
      if (dead[i] || isBridge[i]) continue;
      if (by[i] > waterY + 1.25) continue;
      const cx = (src[i * 2 * STRIDE] + src[(i * 2 + 1) * STRIDE]) / 2;
      const cz = (src[i * 2 * STRIDE + 2] + src[(i * 2 + 1) * STRIDE + 2]) / 2;
      let wet = false;
      if (W) wet = W.sampleBed(cx, cz) !== null;
      else if (T) wet = T.classify(cx, cz) === 0;
      if (wet) { dead[i] = 1; nd++; }
    }
    if (nd) console.log(`[roads] ${name} 水皮断面判死 ${nd}`);
  }

  // ---- 沿岸碎线清扫（用户：「河流两边这怎么都是蜘蛛丝了」）
  // 根因：DC 有 1.6 万条 OSM footway/path，其中大量沿江岸跑。它们每条约 2~4 个
  // 断面、宽 0.5~2 m、各自贴地 —— 从空中看就是一张贴着江面的蛛网。
  // 处理：距水 N 米以内的断面直接删掉，再把删完剩不到 MIN_RUN 个断面的小岛一起
  // 删掉（只删断面会把整条路切成虚线，更难看）。
  const MIN_RUN = opt.minRun || 10;
  if (opt.dropNearWater) {
    const lim = opt.dropNearWater;
    let nd = 0;
    for (let i = 0; i < pairs; i++) {
      if (isBridge[i]) continue;
      const cx = (src[i * 2 * STRIDE] + src[(i * 2 + 1) * STRIDE]) / 2;
      const cz = (src[i * 2 * STRIDE + 2] + src[(i * 2 + 1) * STRIDE + 2]) / 2;
      if (waterDist(cx, cz) < lim) { dead[i] = 1; nd++; }
    }
    // 吸收被切碎的孤岛
    let absorbed = 0;
    for (let i = 0; i < pairs;) {
      if (dead[i]) { i++; continue; }
      let j = i;
      while (j < pairs && !dead[j]) j++;
      if (j - i < MIN_RUN) {
        for (let k = i; k < j; k++) { if (!isBridge[k]) { dead[k] = 1; absorbed++; } }
      }
      i = j;
    }
    console.log(`[roads] ${name} 沿岸清扫：删断面 ${nd} + 碎岛 ${absorbed}`);
  }

  // 标线吸附到已建好的路面
  if (opt.snap) {
    let hit = 0, miss = 0;
    for (let i = 0; i < pairs; i++) {
      const s0 = i * 2 * STRIDE, s1 = (i * 2 + 1) * STRIDE;
      const cx = (src[s0] + src[s1]) / 2, cz = (src[s0 + 2] + src[s1 + 2]) / 2;
      const y = opt.snap(cx, cz);
      // 【吸附必须有上限】用户：「河流两边怎么都是蜘蛛丝了」。
      // 真凶在标线：makeRoadSurf 是按 6 m 格子做的空间哈希，标线顶点落在江面
      // 上时，最近的三角形常常是几十米外的**桥面**或坡上一条路，于是白/黄线被
      // 抬到半空，在江面上拉成一条条细丝（实测 1417 对顶点悬空 >4 m）。
      // 修法：吸附结果必须落在自身地形高程 ±1.5 m 内，超出就当作没命中。
      const lo = gy[i] - 1.0, hi = gy[i] + 1.0;
      if (y === null || y < lo || y > hi) miss++;
      else { by[i] = y + (opt.snapLift || 0.012); hit++; }
    }
    console.log(`[roads] ${name} 吸附路面 ${hit}/${pairs}（未命中 ${miss}）`);
  }

  // 引道渐变（对齐到桥面）
  for (let i = 0; i < pairs; i++) {
    if (isBridge[i] || isShore[i] || dead[i]) continue;
    let d = 999;
    for (let k = 1; k <= RAMP_PAIRS + 1 && d > k; k++) {
      if (i - k >= 0 && isBridge[i - k]) { d = k; break; }
      if (i + k < pairs && isBridge[i + k]) { d = k; break; }
    }
    if (d <= RAMP_PAIRS) {
      const t = 1 - d / (RAMP_PAIRS + 1);
      let near = i;
      for (let k = 1; k <= RAMP_PAIRS + 1; k++) {
        if (i - k >= 0 && isBridge[i - k]) { near = i - k; break; }
        if (i + k < pairs && isBridge[i + k]) { near = i + k; break; }
      }
      const target = gy[i] + (deckAt[near] - gy[i]) * t;
      if (target > by[i]) by[i] = target;
    }
  }

  // ---- 写路面顶点：左右各自跟随地形
  for (let i = 0; i < pairs; i++) {
    const s0 = i * 2 * STRIDE, s1 = (i * 2 + 1) * STRIDE;
    const y = by[i];
    const x0 = src[s0], z0 = src[s0 + 2], x1 = src[s1], z1 = src[s1 + 2];
    let yl = y, yr = y;
    if (T && !isBridge[i] && !dead[i]) {
      // 【横向必须「铺」在地形上，不能「悬」在地形上】用户连着三天在骂
      // 「浮在空中的蜘蛛网 / 一条条悬空的线」。
      // 以前：edge = max(地形+0.16, 中心-0.06)。上坡侧用「地形+0.16」没问题，
      // 下坡侧却被「中心-0.06」锁住 —— 12 m 宽的路跨在 20% 的坡上时，下坡那侧的
      // 路缘比它脚下的地高出 5~17 m（实测最大 17.69 m），从空中看就是一条条
      // 飘在半空、还带着影子的窄带。
      // 现在：两侧顶点直接贴自身地面（gsurf + LIFT），只允许比中心高出 1.2 m
      // （上坡侧横向折叠上限，避免三角形翻面）。下坡侧因此永远躺在地面上。
      const cap = y + 1.2;
      yl = Math.min(gsurf(x0, z0) + LIFT + extraLift, cap);
      yr = Math.min(gsurf(x1, z1) + LIFT + extraLift, cap);
    }
    const v0 = i * 2, v1 = i * 2 + 1;
    pos[v0 * 3] = x0; pos[v0 * 3 + 1] = yl; pos[v0 * 3 + 2] = z0;
    pos[v1 * 3] = x1; pos[v1 * 3 + 1] = yr; pos[v1 * 3 + 2] = z1;
    uv[v0 * 2] = src[s0 + 3]; uv[v0 * 2 + 1] = src[s0 + 4];
    uv[v1 * 2] = src[s1 + 3]; uv[v1 * 2 + 1] = src[s1 + 4];
  }

  // ---- 索引：去掉 dead 断面所在的三角面
  let useIdx = idx;
  if (dead.some((d) => d)) {
    const keep = [];
    const nTri = idx.length / 3;
    for (let t = 0; t < nTri; t++) {
      const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
      if (dead[a >> 1] || dead[b >> 1] || dead[c >> 1]) continue;
      keep.push(a, b, c);
    }
    useIdx = new Uint32Array(keep);
  }

  // ---- 结构几何：路缘立面 + 高架（桥墩/护栏）+ 路堑挡墙 + 桥
  const bpos = [], bidx = [];
  const put = (x, y, z) => { bpos.push(x, y, z); return bpos.length / 3 - 1; };
  const quad = (a, b, c, d) => { bidx.push(a, b, c, a, c, d); };
  const dquad = (a, b, c, d) => { quad(a, b, c, d); quad(d, c, b, a); };

  let nPier = 0, nWall = 0, nSkirt = 0;
  if (railMat && !opt.noStructure) {
    let acc = 0;
    for (let i = 0; i + 1 < pairs; i++) {
      if (dead[i] || dead[i + 1]) { acc = 0; continue; }
      const s0 = i * 2 * STRIDE, s1 = (i * 2 + 1) * STRIDE;
      const t0 = (i + 1) * 2 * STRIDE, t1 = ((i + 1) * 2 + 1) * STRIDE;
      const xa0 = src[s0], za0 = src[s0 + 2], xb0 = src[t0], zb0 = src[t0 + 2];
      const xa1 = src[s1], za1 = src[s1 + 2], xb1 = src[t1], zb1 = src[t1 + 2];
      const ya0 = pos[(i * 2) * 3 + 1], ya1 = pos[(i * 2 + 1) * 3 + 1];
      const yb0 = pos[((i + 1) * 2) * 3 + 1], yb1 = pos[((i + 1) * 2 + 1) * 3 + 1];
      const segL = Math.hypot(xb0 - xa0, zb0 - za0);

      // 【跨 way 的假断面必须跳过】
      // `pairs` 是**所有 way 首尾相连**拼起来的全局数组，第 i 个断面属于哪条 way
      // 这里并不知道。当 i 正好是某条 way 的最后一圈时，i+1 就是**下一条 way 的
      // 第一圈**，两者相隔几公里 —— 直接连起来会拉出一片 3.7 km 长的巨型四边形，
      // 斜插过大半座城（实测就有一条从 (8.6,35,448) 横到 (896,36,-3219) 的
      // 3773 m 三角形，正是用户截图里那条「横穿画面的白楔形/纸片」）。
      // 导出时已经把线段细分到 ≤6 m，所以任何 >24 m 的相邻断面一定是 way 边界。
      if (segL > 24) { acc = 0; continue; }

      // 沿岸 / 水边一律不画任何立面构件。
      // 用户「河流两边这怎么都是蜘蛛丝了」的真凶就是这一族薄幕：路缘立面、
      // 挡土墙、护栏都是 0.45~1.05 m 高的竖直薄片，在城市里它们被建筑和树挡住，
      // 一到开阔的江面就成了沿江几十公里的细线；透视上还全部收敛到灭点，
      // 看起来就是从画面左下角「扇形发散」的一把丝线。
      const gA = terr(xa0, za0), gB = terr(xb0, zb0);
      const nearWater = isShore[i] || isShore[i + 1] || Math.min(gA, gB) < waterY + 0.7;

      // (a) 路缘立面：**已删除**（2026-10-23 晚，用户「整个平面多了这么多蜘蛛网一样的线条」）
      //
      // 这一段曾经在每一条路的两侧各拉一道 0.11~0.45 m 高的竖直薄片，想给
      // 零厚度路面一点「厚度感」。实测（web/_close.mjs 隐藏单图层 + 逐像素统计）
      // 满屏细暗线里有 **66.9%** 来自这个 _struct 网格：路网有 41,606 条 way，
      // 含全部步道/巷/服务道，每条两侧各一道 → 8 万片薄幕，从空中看就是一张
      // 覆盖整个城市的蛛网；而它带来的「厚度」肉眼几乎看不见，代价远大于收益。
      //
      // 真正的厚度感来自：① 人行道 slab 抬高 0.15 m 自带的立面（真实路缘石）
      // ② 太阳 33° 的低角度投影 ③ 路面按 ±3.2 m 地形最大值起伏（不再是纸片）。
      // 所以这里**只保留**高架段（桥墩+护栏）与路堑挡墙，平路段一律不再出竖直面。
      // 想恢复：把下面的 if 改回 !isBridge[i] && !nearWater 并去掉 false。
      if (railMat && (opt.curbFace || false) && !isBridge[i] && !nearWater) {
        const CURB = opt.curbH ?? 0.18;
        for (const [xa, za, xb, zb, ya, yb] of [
          [xa0, za0, xb0, zb0, ya0, yb0],
          [xa1, za1, xb1, zb1, ya1, yb1],
        ]) {
          const yBotA = Math.max(ya - CURB, gsurf(xa, za) + 0.04);
          const yBotB = Math.max(yb - CURB, gsurf(xb, zb) + 0.04);
          const i0 = put(xa, ya, za), i1 = put(xb, yb, zb);
          const i2 = put(xb, yBotB, zb), i3 = put(xa, yBotA, za);
          dquad(i0, i1, i2, i3);
          nSkirt++;
        }
      }

      // (b) 高架：桥墩 + 护栏
      // 判定条件不再只看 OSM 的 grade 标记：桥头引道（rampY）也会把路面抬到
      // 离地 2~6 m，那些段如果没有桥墩，就是一排悬空的黑带子
      // （用户看到的「空中细横杆、有影子、没有立柱」）。
      const liftAboveGround = by[i] - gsurf((xa0 + xa1) / 2, (za0 + za1) / 2);
      // 注意：这里**不能**加 nearWater 判断。跨河的桥恰恰都靠水，加了就变成
      // 「一条没有立柱的悬空黑带子横在江面上」—— 用户看到的空中细横杆。
      if (grade[i] > 1.5 || liftAboveGround > 1.2) {
        acc += segL;
        if (acc > PIER_EVERY) {
          acc = 0;
          const cx = (xa0 + xa1) / 2, cz = (za0 + za1) / 2;
          const yTop = Math.min(ya0, ya1) - SKIRT;
          const yBot = terr(cx, cz) - 0.4;
          const hw = Math.hypot(xa1 - xa0, za1 - za0) / 2 * 0.62;
          if (yTop - yBot > 1.2) {
            const n = [-(za1 - za0) / (2 * hw || 1), (xa1 - xa0) / (2 * hw || 1)];
            const dx = n[0] * hw * 0.45, dz = n[1] * hw * 0.45;
            const c0 = put(cx - dx, yBot, cz - dz), c1 = put(cx + dx, yBot, cz + dz);
            const d0 = put(cx - dx, yTop, cz - dz), d1 = put(cx + dx, yTop, cz + dz);
            const ex = 0.9, ez = 0.9;
            const p0 = put(cx - dx - ex, yBot, cz - dz - ez), p1 = put(cx + dx + ex, yBot, cz + dz + ez);
            const p2 = put(cx + dx + ex, yTop, cz + dz + ez), p3 = put(cx - dx - ex, yTop, cz - dz - ez);
            dquad(p0, p1, p2, p3);
            dquad(c0, c1, d1, d0);
            nPier++;
          }
        }
        for (const [xa, za, xb, zb, ya, yb] of [
          [xa0, za0, xb0, zb0, ya0, yb0], [xa1, za1, xb1, zb1, ya1, yb1],
        ]) {
          const i0 = put(xa, ya, za), i1 = put(xb, yb, zb);
          const i2 = put(xb, yb + RAIL_H, zb), i3 = put(xa, ya + RAIL_H, za);
          dquad(i0, i1, i2, i3);
        }
        continue;
      }

      // (c) 路堑：两侧挡土墙从路面边升到地面
      if (grade[i] < -1.5 && !nearWater) {
        for (const [xa, za, xb, zb, ya, yb] of [
          [xa0, za0, xb0, zb0, ya0, yb0], [xa1, za1, xb1, zb1, ya1, yb1],
        ]) {
          const hA = terr(xa, za), hB = terr(xb, zb);
          if (hA - ya > 0.6 && hB - yb > 0.6) {
            const i0 = put(xa, ya - 0.1, za), i1 = put(xb, yb - 0.1, zb);
            const i2 = put(xb, hB + 0.35, zb), i3 = put(xa, hA + 0.35, za);
            dquad(i0, i1, i2, i3);
            // 顶部压顶
            const ox = 0.25, oz = 0.25;
            const j0 = put(xa, hA + 0.35, za), j1 = put(xb, hB + 0.35, zb);
            const j2 = put(xb + ox, hB + 0.28, zb + oz), j3 = put(xa + ox, hA + 0.28, za + oz);
            dquad(j0, j1, j2, j3);
            nWall++;
          }
        }
      }

      // (d) 跨河：主梁 + 护栏 + 桥墩
      if (railMat && isBridge[i] && isBridge[i + 1]) {
        const y = by[i], y1 = by[i + 1];
        for (const [xa, za, xb, zb] of [[xa0, za0, xb0, zb0], [xa1, za1, xb1, zb1]]) {
          const i0 = put(xa, y, za), i1 = put(xb, y1, zb);
          const i2 = put(xb, y1 - GIRDER, zb), i3 = put(xa, y - GIRDER, za);
          dquad(i0, i1, i2, i3);
        }
        {
          const a = put(xa0, y - GIRDER, za0), b = put(xb0, y1 - GIRDER, zb0);
          const c = put(xb1, y1 - GIRDER, zb1), d = put(xa1, y - GIRDER, za1);
          dquad(a, b, c, d);
        }
        for (const [xa, za, xb, zb] of [[xa0, za0, xb0, zb0], [xa1, za1, xb1, zb1]]) {
          const i0 = put(xa, y, za), i1 = put(xb, y1, zb);
          const i2 = put(xb, y1 + RAIL_H, zb), i3 = put(xa, y + RAIL_H, za);
          dquad(i0, i1, i2, i3);
        }
        const cx2 = (xa0 + xa1) / 2, cz2 = (za0 + za1) / 2;
        if ((i % 3) === 0) {
          const hw = Math.hypot(xa1 - xa0, za1 - za0) * 0.28;
          const bedY = terr(cx2, cz2) - 0.5;
          const top = y - GIRDER + 0.1;
          if (top > bedY + 1) {
            const c0 = put(cx2 - 1.2, bedY, cz2 - hw), c1 = put(cx2 + 1.2, bedY, cz2 - hw);
            const c2 = put(cx2 + 1.2, bedY, cz2 + hw), c3 = put(cx2 - 1.2, bedY, cz2 + hw);
            const d0 = put(cx2 - 1.2, top, cz2 - hw), d1 = put(cx2 + 1.2, top, cz2 - hw);
            const d2 = put(cx2 + 1.2, top, cz2 + hw), d3 = put(cx2 - 1.2, top, cz2 + hw);
            quad(c0, c1, d1, d0); quad(c1, c2, d2, d1); quad(c2, c3, d3, d2); quad(c3, c0, d0, d3);
            nPier++;
          }
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(useIdx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.receiveShadow = true;
  mesh.castShadow = true;

  let structMesh = null;
  if (bpos.length) {
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(bpos, 3));
    bg.setIndex(bidx);
    bg.computeVertexNormals();
    bg.computeBoundingSphere();
    structMesh = new THREE.Mesh(bg, railMat);
    structMesh.name = name + '_struct';
    structMesh.castShadow = true;
    structMesh.receiveShadow = true;
  }

  let span = 0, shore = 0, ndead = 0;
  for (let i = 0; i < pairs; i++) {
    if (isBridge[i]) span++; else if (isShore[i]) shore++;
    if (dead[i]) ndead++;
  }
  return {
    mesh, bridgeMesh: structMesh,
    bridges: { pairs: span, piers: nPier, shore, walls: nWall, skirts: nSkirt, dead: ndead },
  };
}