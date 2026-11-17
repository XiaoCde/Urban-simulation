/**
 * 街道寻路 —— 一份实现，三处复用（日程通勤 / 马克步行 / 马克车行）。
 *
 * 【为什么需要独立模块】2026-11-06 用户指出两件事：
 *   1) 马克回家的时候**直接横贯草地**走过去；
 *   2) 六个人的日程通勤也要沿街走。
 * 两者的数据源不同（马克是 dc_streets.json 的旧街心线，日程是起终点），
 * 但落到地上必须是同一张网 —— roadnet 的瓦片路。所以寻路只能有一份，
 * 各模块 import 同一套图，避免"人能走路、马克不走"这种不一致。
 */

/**
 * 把 roadnet 的双向边做成邻接表。
 * 节点直接复用 roadnet.nodes（同一个对象引用），最短路返回的链就是节点本身，
 * 调用方拿 x/z 即可，不需要 id 映射。
 */
export function buildStreetGraph(roadnet) {
  if (!roadnet || !roadnet.nodes || !roadnet.edges) return null;
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    const w = Math.hypot(b.x - a.x, b.z - a.z);
    adj.get(a).push({ to: b, w });
    adj.get(b).push({ to: a, w });
  };
  for (const e of roadnet.edges) link(e.a, e.b);
  return { adj, nodes: roadnet.nodes, edges: roadnet.edges };
}

/**
 * 把任意点投影到**最近的路段线段上**（不是节点）。用于「楼门口 → 路边」的
 * 最后一公里：门口本来就不在路口上，直接连到最近节点会斜穿半个街区，
 * 垂直走到最近的路边才是「出门上人行道」。
 */
export function projectToEdge(G, x, z) {
  if (!G || !G.edges) return null;
  let best = null;
  let bd = Infinity;
  for (const e of G.edges) {
    const dx = e.b.x - e.a.x, dz = e.b.z - e.a.z;
    const L2 = dx * dx + dz * dz;
    let t = L2 > 1e-9 ? ((x - e.a.x) * dx + (z - e.a.z) * dz) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = e.a.x + dx * t, pz = e.a.z + dz * t;
    const d = (x - px) ** 2 + (z - pz) ** 2;
    if (d < bd) { bd = d; best = { x: px, z: pz, d: Math.sqrt(d), t, edge: e }; }
  }
  return best;
}

/** 图上离 (x,z) 最近的节点；超过 maxD 米返回 null（防止把人吸到几公里外）。 */
export function nearestNode(G, x, z, maxD = Infinity) {
  let best = null;
  let bd = maxD * maxD;
  for (const n of G.nodes) {
    const d = (n.x - x) ** 2 + (n.z - z) ** 2;
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

/**
 * 最短路。图很小（473 节点），朴素 Dijkstra 够快，不值得上二叉堆。
 * 返回节点链（含首尾），无解返回 null。
 *
 * opt.blocked(x,z) —— 实体占位测试。落在建筑里的边不直接禁用（棋盘路网
 * 一旦断边就可能整片不连通，退化成直线穿楼更糟），而是加 12 倍代价：
 * 有绕路就绕，实在没有也能求出一条路径，交给 sanitizePolyline 清扫。
 */
export function shortestPath(G, a, b, opt = {}) {
  if (!a || !b) return null;
  if (a === b) return [a];
  const blocked = opt.blocked || null;
  const penalty = opt.blockPenalty || 12;
  const edgeCost = (u, v, w) => {
    if (!blocked) return w;
    const L = Math.hypot(v.x - u.x, v.z - u.z);
    const n = Math.max(2, Math.ceil(L / 5));
    for (let i = 1; i < n; i++) {
      if (blocked(u.x + (v.x - u.x) * i / n, u.z + (v.z - u.z) * i / n)) return w * penalty;
    }
    return w;
  };
  const dist = new Map([[a, 0]]);
  const prev = new Map();
  const open = new Set([a]);
  const done = new Set();
  while (open.size) {
    let u = null;
    let du = Infinity;
    for (const n of open) {
      const d = dist.get(n) ?? Infinity;
      if (d < du) { du = d; u = n; }
    }
    if (!u) break;
    open.delete(u);
    done.add(u);
    if (u === b) break;
    for (const { to, w } of G.adj.get(u) || []) {
      if (done.has(to)) continue;
      const nd = du + edgeCost(u, to, w);
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd);
        prev.set(to, u);
        open.add(to);
      }
    }
  }
  if (!dist.has(b)) return null;
  const chain = [];
  let cur = b;
  while (cur) { chain.push(cur); cur = prev.get(cur); }
  chain.reverse();
  return chain;
}

/**
 * 从 (x0,z0) 到 (x1,z1) 的步行折线：就近上路 → 图最短路 → 进目标点。
 * 起点/终点各留一段"最后一公里"，因为门口通常不在路口上。
 */
export function routeOnGraph(G, x0, z0, x1, z1, maxD = 400, opt = {}) {
  const pts = [[x0, z0]];
  if (!G) { pts.push([x1, z1]); return pts; }
  const a = nearestNode(G, x0, z0, maxD);
  const b = nearestNode(G, x1, z1, maxD);
  if (!a || !b) { pts.push([x1, z1]); return pts; }
  const chain = shortestPath(G, a, b, opt);
  if (!chain) { pts.push([b.x, b.z], [x1, z1]); return pts; }
  for (const n of chain) pts.push([n.x, n.z]);
  pts.push([x1, z1]);
  return pts;
}

/**
 * 折线清扫：把 ANY 落在建筑实体内的点推出去，并递归细分两点之间的连线，
 * 保证整条折线（不只是端点）都不穿楼。
 *
 * 【为什么需要】Dijkstra 只保证**节点**在路网上，节点之间那条直线可能从
 * 一栋楼的中间穿过去；首尾「门口 → 最近节点」的最后一公里也是直线。
 * 车沿折线插值时就会开进楼里（用户实测：连穿 565 Penn 与 FAA 两栋）。
 *
 * @param {Array<[number,number]>} pts XZ 折线
 * @param {object} opt { blocked(x,z,pad), snapOut(x,z,pad), pad, pushPad, step }
 */
export function sanitizePolyline(pts, opt = {}) {
  if (!pts || !pts.length) return [];
  const { blocked, snapOut } = opt;
  if (!blocked || !snapOut) return pts.map((p) => [p[0], p[1]]);
  const pad = opt.pad ?? 0;
  const pushPad = opt.pushPad ?? 2.2;
  const step = opt.step ?? 3;
  let sideHint = 0;               // 一整条折线固定往同一侧绕，避免左右横跳
  const safe = (x, z) => {
    // 离开障碍区就重置偏好：否则整条折线会一路沿同一侧被推到几百米外
    if (!blocked(x, z, pad)) { sideHint = 0; return [x, z]; }
    const s = snapOut(x, z, pushPad, sideHint);
    const dz = s.z - z;
    if (Math.abs(dz) > 0.2) sideHint = dz > 0 ? 1 : -1;
    return [s.x, s.z];
  };
  // 两点之间若中点命中实体，就把它推出去当拐点，再递归检查两半。
  const bridge = (a, b, depth = 0) => {
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    if (!blocked(mx, mz, pad) && !blocked(a[0], a[1], pad)) return [b];
    if (depth >= 5) return [safe(mx, mz), b];
    const mid = safe(mx, mz);
    return [...bridge(a, mid, depth + 1), ...bridge(mid, b, depth + 1)];
  };
  let out = [];
  let prev = null;
  for (const p of pts) {
    const cur = safe(p[0], p[1]);
    if (!prev) { out.push(cur); prev = cur; continue; }
    const L = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    const n = Math.max(1, Math.ceil(L / step));
    let last = prev;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const q = safe(prev[0] + (cur[0] - prev[0]) * t,
        prev[1] + (cur[1] - prev[1]) * t);
      for (const mid of bridge(last, q)) {
        const e = out[out.length - 1];
        if (!e || Math.hypot(mid[0] - e[0], mid[1] - e[1]) > 0.25) out.push(mid);
      }
      last = q;
    }
    prev = cur;
  }
  // 【锯齿清理】bridge 递归会在一排楼之间反复把中点推到矩形两侧，生成
  // 「前进一步、倒退一步」的密集折线（实测小女孩 15:00–15:16 的 z 在
  // -553.8↔-559.3 来回跳，x 每 0.25 分钟只挪 0.15 m）—— 人沿它走就是
  // 用户说的「一直在撞墙」。把方向反转的中间点拉到前后两点中点；只有当
  // 新点及其与前后点的中点都不在实体里时才替换，保证绕行仍然有效。
  for (let pass = 0; pass < 2; pass++) {
    const sm = out.slice();
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1], b = out[i], c = out[i + 1];
      const d1x = b[0] - a[0], d1z = b[1] - a[1];
      const d2x = c[0] - b[0], d2z = c[1] - b[1];
      if (d1x * d2x + d1z * d2z >= 0) continue;              // 没有反向，保留
      const cand = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
      if (blocked(cand[0], cand[1], pad)) continue;
      if (blocked((a[0] + cand[0]) / 2, (a[1] + cand[1]) / 2, pad)) continue;
      if (blocked((cand[0] + c[0]) / 2, (cand[1] + c[1]) / 2, pad)) continue;
      sm[i] = cand;
    }
    out = sm;
  }
  return out.length >= 2 ? out : [pts[0], pts[pts.length - 1]];
}

/** 点到线段的距离平方（XZ 平面）。 */
function segDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const L2 = dx * dx + dz * dz;
  let t = L2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + dx * t;
  const qz = az + dz * t;
  return (px - qx) ** 2 + (pz - qz) ** 2;
}

/**
 * Ramer–Douglas–Peucker 抽稀（XZ）。抽稀是为了后面逐段跑最短路：
 * 140 个点逐段都跑一遍最短路既慢又会把拐角磨圆。
 */
export function simplify(pts, tol = 9) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const tol2 = tol * tol;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    if (i1 - i0 < 2) continue;
    let best = -1;
    let bd = tol2;
    for (let i = i0 + 1; i < i1; i += 1) {
      const d = segDist2(pts[i][0], pts[i][2], pts[i0][0], pts[i0][2], pts[i1][0], pts[i1][2]);
      if (d > bd) { bd = d; best = i; }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([i0, best], [best, i1]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i += 1) if (keep[i]) out.push(pts[i]);
  return out;
}

/**
 * 把一条「旧街心线」重投影到当前路网上。
 *
 * 【2026-11-07 重写：上一版自己造了斜穿街区的线段】
 * 上一版是「RDP 抽稀 → 每相邻两点各跑一次 Dijkstra → 每段末尾把原始抽稀点
 * 再塞回去」。两个后果，实测在 4 条路线里都出现了：
 *   - 抽稀点本身可能离路网 25 m（旧街心线在草地中间），于是从最后一个路网
 *     节点到它斜拉一条 25–33 m 的直线，**横穿街区和草地**；
 *   - 相邻两段各自求最短路，节点序列会 A→B→A 地折返（诊断里
 *     `[2582,-164]→[2586,-190]→[2582,-164]` 这种成对段有十几处）。
 * 用户 2026-11-07 原话：「中间会穿过几栋楼啊，还会穿过好多草地」。
 *
 * 现在：**整条路线只寻一次路**，中间所有点都是路网节点，不给任何原始点留位置。
 * 只有首尾各留一段「门口 → 最近路段的垂直投影」的短连线（出门上人行道，
 * 不是斜穿街区）。`detour` 路线用旧折线中点选一个 via 节点，保证和主路线不同。
 *
 * @param {number[][]} pts [[x,y,z], ...]
 * @param {object} G buildStreetGraph 的图
 * @param {(x:number,z:number)=>number} surfaceY 路面高程
 * @param {{maxSnap?:number, viaFromPolyline?:boolean, maxDoorWalk?:number}} opt
 */
export function snapPolyline(pts, G, surfaceY, opt = {}) {
  const { maxSnap = 120, viaFromPolyline = false, maxDoorWalk = 10 } = opt;
  if (!G || !pts || pts.length < 2) return pts || [];
  const rawFirst = pts[0];
  const rawLast = pts[pts.length - 1];
  // 【出门段不能超过 10 m】OSM 街心线的端点常常落在楼体正中（比如办公楼
  // 前 32 m 的广场），直接保留会有一条 32 m 的斜线穿过广场/草地。把端点
  // 沿「→ 最近路边投影」方向拉到 10 m 以内：人还是从楼门口方向出现，
  // 但整条室外路线的离路距离不会超过 10 m。
  const trimDoor = (q, p) => {
    if (!p) return q;
    const d = Math.hypot(q[0] - p.x, q[2] - p.z);
    if (d <= maxDoorWalk) return q;
    const k = maxDoorWalk / d;
    return [p.x + (q[0] - p.x) * k, q[1], p.z + (q[2] - p.z) * k];
  };
  const Y = surfaceY || ((x, z) => pts[0][1]);
  const p0 = projectToEdge(G, rawFirst[0], rawFirst[2]);
  const p1 = projectToEdge(G, rawLast[0], rawLast[2]);
  const first = trimDoor(rawFirst, p0);
  const last = trimDoor(rawLast, p1);
  const s = nearestNode(G, first[0], first[2], maxSnap);
  const e = nearestNode(G, last[0], last[2], maxSnap);
  if (!s || !e) return [first, last];       // 整条都在路网之外，别硬掰

  let chain;
  if (viaFromPolyline && pts.length > 4) {
    const mid = pts[Math.floor(pts.length / 2)];
    const v = nearestNode(G, mid[0], mid[2], maxSnap);
    if (v && v !== s && v !== e) {
      const a = shortestPath(G, s, v) || [s];
      const c = shortestPath(G, v, e) || [e];
      chain = a.concat(c.slice(1));
    }
  }
  if (!chain) chain = shortestPath(G, s, e) || [s, e];

  // 把节点链裁到「离门口投影最近的节点」，避免门口 → 投影 → 折返回链首。
  let i0 = 0, i1 = chain.length - 1;
  if (p0) {
    let bd = Infinity;
    for (let i = 0; i < chain.length; i++) {
      const d = (chain[i].x - p0.x) ** 2 + (chain[i].z - p0.z) ** 2;
      if (d < bd) { bd = d; i0 = i; }
    }
  }
  if (p1) {
    let bd = Infinity;
    for (let i = chain.length - 1; i >= i0; i--) {
      const d = (chain[i].x - p1.x) ** 2 + (chain[i].z - p1.z) ** 2;
      if (d < bd) { bd = d; i1 = i; }
    }
  }
  if (i1 < i0) i1 = i0;

  const out = [first];
  if (p0) out.push([p0.x, Y(p0.x, p0.z), p0.z]);
  for (let i = i0; i <= i1; i++) {
    const n = chain[i];
    out.push([n.x, Y(n.x, n.z), n.z]);
  }
  if (p1) out.push([p1.x, Y(p1.x, p1.z), p1.z]);
  out.push(last);

  // 去掉几乎重合的相邻点，但首尾必须保留
  const clean = [out[0]];
  for (let i = 1; i < out.length; i++) {
    const q = out[i];
    const prev = clean[clean.length - 1];
    if (i < out.length - 1 && Math.hypot(q[0] - prev[0], q[2] - prev[2]) < 1.2) continue;
    clean.push(q);
  }
  return clean;
}

/** 折线总长（米）。 */
export function polylineLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i += 1) {
    d += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]);
  }
  return d;
}

/**
 * 造一个「路面走廊」测试函数：`test(x,z)` 为 true 表示这个点在车行道/路缘上。
 *
 * 【为什么需要】树和灌木的点来自 DCGIS 真实数据，`classify(x,z)` 只判了
 * 「在楼里 / 在水里」，**没有判在不在路上**。而地现在铺的是 roadnet 的
 * 瓦片路（规整棋盘，和 OSM 的相位不同），于是 34002 棵树里实测有 1493 棵
 * 的树干直接扎在车行道和斑马线上（用户 2026-11-06「灌木长在斑马线中间」）。
 *
 * 做法：把每条路段按 8 m 切成若干段，按格子哈希存起来；查询时只看周围
 * 半径覆盖的格子。34002 次查询从 1900 万次线段距离降到几十万次。
 */
export function makeRoadCorridorTest(roadnet, radius = 5.0) {
  if (!roadnet || !roadnet.edges) return () => false;
  const CELL = 16;
  const key = (gx, gz) => (gx * 73856093) ^ (gz * 19349663);
  const buckets = new Map();
  const push = (k, seg) => {
    let a = buckets.get(k);
    if (!a) buckets.set(k, a = []);
    a.push(seg);
  };
  for (const e of roadnet.edges) {
    const dx = e.b.x - e.a.x;
    const dz = e.b.z - e.a.z;
    const L = Math.hypot(dx, dz) || 1;
    const n = Math.max(1, Math.ceil(L / 8));
    for (let i = 0; i < n; i += 1) {
      const ax = e.a.x + dx * (i / n);
      const az = e.a.z + dz * (i / n);
      const bx = e.a.x + dx * ((i + 1) / n);
      const bz = e.a.z + dz * ((i + 1) / n);
      const seg = { ax, az, bx, bz };
      // 段覆盖的格子：外扩 radius，保证查询时按点所在格能命中
      const gx0 = Math.floor((Math.min(ax, bx) - radius) / CELL);
      const gx1 = Math.floor((Math.max(ax, bx) + radius) / CELL);
      const gz0 = Math.floor((Math.min(az, bz) - radius) / CELL);
      const gz1 = Math.floor((Math.max(az, bz) + radius) / CELL);
      for (let gx = gx0; gx <= gx1; gx += 1) {
        for (let gz = gz0; gz <= gz1; gz += 1) push(key(gx, gz), seg);
      }
    }
  }
  const r2 = radius * radius;
  return function onRoad(x, z) {
    const arr = buckets.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!arr) return false;
    for (let i = 0; i < arr.length; i += 1) {
      const s = arr[i];
      const ex = s.bx - s.ax;
      const ez = s.bz - s.az;
      const L2 = ex * ex + ez * ez;
      let t = L2 > 1e-9 ? ((x - s.ax) * ex + (z - s.az) * ez) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const qx = s.ax + ex * t - x;
      const qz = s.az + ez * t - z;
      if (qx * qx + qz * qz <= r2) return true;
    }
    return false;
  };
}
