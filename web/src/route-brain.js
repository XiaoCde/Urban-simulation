/**
 * route-brain.js — 把「决策」变成「真实可走的路」。
 *
 * 【用户 2026-11-10】「日常决策肯定是要有路网的啊，让人能自主的在路上走，
 *  在地图上自主的判断逃生路线啊，不是让你意淫的故事，一切都要反映到真实
 *  的场景中去」。
 *
 * 之前断在哪：citizen.js 的候选 path 是 trace() 凭空造的几相对点，只用来
 * 算「未知路况」罚分；Brain.decide() 选完只写 decisions，行人仍沿固定的
 * walknet 链随机换边转圈，连逃难都是穿墙直线跑。决策没有落到地图上。
 *
 * 这一层做闭环，四个环节全部用**同一条真实折线**：
 *   ① 候选 → plan(goal) 用链级 A* 在真实人行道图上算出折线 pts
 *   ② Brain.estimateRoute() 沿这条折线读 Belief 的水深 / 已知度打分
 *   ③ 选中的那条折线随 record.route 交给 ped.js
 *   ④ 行人每帧沿折线推进真实位移，走到终点（高地 / 门牌 / 领路人）才停
 *
 * 边权 = 链长 × (1 + 绕水系数×经验 × maxDepth/涉水线) × 实体阻挡倍率。
 * 「老手绕高处」和「新手只按最短走」不再是两句文案：同一张图、同一时刻，
 * 因为 exp 不同算出不同的边权，于是走出不同的街。
 */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 极简二叉堆（A* open set），避免每次决策对整个路网排序。 */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(node, f) {
    const a = this.a;
    a.push({ node, f });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

export function createRoutePlanner({
  G, usable, groundAt = () => 0, blocked = () => false,
  depthAt = () => 0, minute = () => 0, findRefuge = null, doors = [],
} = {}) {
  const useSet = Array.isArray(usable) ? new Set(usable) : (usable || new Set());
  const chains = G.chains;
  const CELL = 60;
  const key = (cx, cz) => `${cx},${cz}`;

  // ---------------------------------------------------------------- 链图
  // 节点 = walknet 的顶点；边 = 一条真实人行道链（连接 ids[0] 与 ids[last]）。
  const nodeChains = new Map();       // nodeId → [{ci, end}]  end:0=a端 1=b端
  const grid = new Map();             // 60 m 格 → [ci]
  const mid = [];                     // ci → [x,z]（链中点，做实体抽检）
  for (const ci of useSet) {
    const c = chains[ci];
    if (!c || c.len < 1) continue;
    const a = c.ids[0], b = c.ids[c.ids.length - 1];
    if (!nodeChains.has(a)) nodeChains.set(a, []);
    if (!nodeChains.has(b)) nodeChains.set(b, []);
    nodeChains.get(a).push({ ci, end: 0 });
    nodeChains.get(b).push({ ci, end: 1 });
    const m = Math.floor(c.pts.length / 2);
    mid[ci] = [c.pts[m].x, c.pts[m].z];
    // 【按段插值登记格子】只登记顶点会让一条 300 m 长链的中段落进「没有
    // 任何链」的空格：nearestOnNet 查不到它，验收获报「折线脱离路网 47 m」，
    // A* 的起终点也会投到几十米外的别的街。每 20 m 采一格，长链中段可查。
    const seen = new Set();
    const n = Math.max(1, Math.ceil(c.len / 20));
    for (let k = 0; k <= n; k++) {
      const [px, pz] = at(c, c.len * k / n);
      const gk = key(Math.floor(px / CELL), Math.floor(pz / CELL));
      if (seen.has(gk)) continue;
      seen.add(gk);
      let arr = grid.get(gk); if (!arr) grid.set(gk, arr = []);
      arr.push(ci);
    }
  }

  /** 沿链取弧长 s 处的 [x,z]（与 ped.js 的 pointAt 同口径）。 */
  function at(c, s) {
    const cum = c.cum, pts = c.pts;
    if (s <= 0) return [pts[0].x, pts[0].z];
    if (s >= c.len) return [pts[pts.length - 1].x, pts[pts.length - 1].z];
    let lo = 0, hi = cum.length - 1;
    while (lo + 1 < hi) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const a = pts[lo], b = pts[lo + 1];
    const seg = Math.max(1e-6, cum[lo + 1] - cum[lo]);
    const t = clamp((s - cum[lo]) / seg, 0, 1);
    return [a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t];
  }

  /** 把 (x,z) 投到最近的可走链上，返回 {ci,s,x,z,d}。只查附近格子。 */
  function nearestOnNet(x, z) {
    const cand = new Set();
    const c0x = Math.floor(x / CELL), c0z = Math.floor(z / CELL);
    for (let ring = 0; ring <= 4; ring++) {
      for (let i = -ring; i <= ring; i++) {
        for (let j = -ring; j <= ring; j++) {
          if (ring > 0 && Math.abs(i) !== ring && Math.abs(j) !== ring) continue;
          const arr = grid.get(key(c0x + i, c0z + j));
          if (arr) for (const ci of arr) cand.add(ci);
        }
      }
      if (cand.size >= 10 && ring >= 2) break;
    }
    if (!cand.size) return null;
    let best = null, bestD2 = Infinity;
    for (const ci of cand) {
      const c = chains[ci];
      for (let k = 0; k < c.pts.length - 1; k++) {
        const a = c.pts[k], b = c.pts[k + 1];
        const vx = b.x - a.x, vz = b.z - a.z;
        const L2 = vx * vx + vz * vz;
        const t = L2 > 1e-9 ? clamp(((x - a.x) * vx + (z - a.z) * vz) / L2, 0, 1) : 0;
        const px = a.x + vx * t, pz = a.z + vz * t;
        const d2 = (px - x) ** 2 + (pz - z) ** 2;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = { ci, s: c.cum[k] + t * Math.sqrt(L2), x: px, z: pz, d: Math.sqrt(d2) };
        }
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- 边权
  // 缓存在「分钟桶 + 经验桶 + 涉水线桶」上：一次决策里多个候选共用同一批
  // 链代价，不用重复采样水深。水深是**当前帧真实流场**，不是假数据。
  let costCache = new Map(), cacheMin = -1;
  function chainCost(ci, ctx) {
    const t = Number(ctx.minute ?? minute()) || 0;
    const bucket = Math.floor(t / 5);
    if (bucket !== cacheMin) { costCache.clear(); cacheMin = bucket; }
    const exp = clamp(Number(ctx.exp ?? 0.5) || 0, 0, 1);
    const wade = clamp(Number(ctx.wade ?? 0.3) || 0.3, 0.08, 0.6);
    const mode = ctx.wetAvoid === false ? 'blind' : (ctx.preferMajor ? 'major' : 'short');
    const ck = `${ci}|${(exp * 4) | 0}|${(wade * 10) | 0}|${mode}`;
    const hit = costCache.get(ck);
    if (hit !== undefined) return hit;

    const c = chains[ci];
    let deepest = 0;
    const n = Math.min(12, Math.max(2, Math.ceil(c.len / 14)));
    for (let i = 0; i <= n; i++) {
      const [px, pz] = at(c, c.len * i / n);
      const d = depthAt(px, pz, t);
      if (Number.isFinite(d) && d > deepest) deepest = d;
    }
    // 人对「看见水」是非线性敏感：只要路面开始积水就想绕，不必等到没过脚踝。
    // 线性比值在浅水（3 cm / 30 cm 涉水线 = 0.1）时差异太小，老手和新手会
    // 算出同一条最短路，于是「经验」只停留在文案里。开 0.6 次方并放大 1.8 倍。
    const raw = clamp(deepest / wade, 0, 2.4);
    const wet = clamp(Math.pow(raw, 0.6) * 1.8, 0, 3.2);
    // 经验越好越舍得为绕开水多走路；「照原路走」偏保守再乘 1.25；
    // 「抄近道」故意把绕水权重压低 —— 于是同一个人两种想法走出两条街。
    let wetW = ctx.wetAvoid === false ? 0.12 : (0.55 + exp * 3.4);
    if (ctx.preferMajor) wetW *= 1.25;
    if (ctx.shortcut) wetW *= 0.55;
    let w = 1 + wetW * wet;
    // 老手认路：宁可沿长直主路多走几步，也不钻不熟的小碎巷；新手只按
    // 几何最短挑链。于是即使这条街上一点水都没有，经验不同的人也会
    // 在同一张地图上走出不同的街（不是只改文案）。
    if (c.len < 30) w *= 1 + exp * 0.55;
    // 实体阻挡：链中点落在楼/树里就大幅加价（不硬删，避免路网不连通）
    const m = mid[ci];
    if (m && blocked(m[0], m[1], 0.6)) w *= 9;
    // 「照原路走」偏好长直主路：小碎链加价，路线明显不同于抄近道
    if (ctx.preferMajor && c.len < 26) w *= 1.35;
    const val = c.len * w;
    costCache.set(ck, val);
    return val;
  }

  /** A*：从虚拟源（当前位置在 startCi 的投影）到虚拟汇（目标投影）。 */
  function shortest(from, to, ctx) {
    const A = nearestOnNet(from.x, from.z), B = nearestOnNet(to.x, to.z);
    if (!A || !B) return null;
    const ca = chains[A.ci], cb = chains[B.ci];
    const na = ca.ids[0], nb = ca.ids[ca.ids.length - 1];
    const ga = cb.ids[0], gb = cb.ids[cb.ids.length - 1];
    const heap = new Heap();
    const dist = new Map(), prev = new Map();
    const h = (nodeId) => {
      const n = G.nodes[nodeId];
      return n ? Math.hypot(n.x - to.x, n.z - to.z) : 0;
    };
    const seed = (nodeId, d0) => {
      if (!Number.isFinite(d0)) return;
      if (d0 < (dist.get(nodeId) ?? Infinity)) {
        dist.set(nodeId, d0);
        heap.push(nodeId, d0 + h(nodeId));
      }
    };
    // 源：沿 startCi 从投影点走到两端
    seed(na, A.s); seed(nb, ca.len - A.s);
    const goalNodes = new Set([ga, gb]);
    const srcIsA = A.s <= ca.len - A.s;       // 起点更靠近哪一端（用于同链特例）
    let expanded = 0, arrived = null;
    while (heap.size && expanded < 1400) {
      const { node } = heap.pop();
      const du = dist.get(node);
      if (du === undefined) continue;
      expanded++;
      if (goalNodes.has(node)) { arrived = node; break; }
      for (const e of nodeChains.get(node) || []) {
        // 源链已经在 seed() 里按「投影点→端点」计过距离，不能再当第一条边
        if (e.ci === A.ci) continue;
        const c = chains[e.ci];
        const other = e.end === 0 ? c.ids[c.ids.length - 1] : c.ids[0];
        const nd = du + chainCost(e.ci, ctx);
        if (nd < (dist.get(other) ?? Infinity)) {
          dist.set(other, nd);
          prev.set(other, { node, ci: e.ci });
          heap.push(other, nd + h(other));
        }
      }
    }
    if (arrived === null) return null;
    // 回溯节点链 → chain 序列；seq[k] = 「经过 ci 到达 node(k)」
    const seq = [];
    let cur = arrived;
    while (prev.has(cur)) {
      const step = prev.get(cur);
      seq.push({ ci: step.ci, node: cur });
      cur = step.node;
    }
    seq.reverse();
    return { A, B, seq, from, to, expanded, srcNode: cur, endNode: arrived, srcIsA };
  }

  /** 把 A* 结果展开成真实人行道折线（每 ~7 m 一点，全部来自 chain.pts）。 */
  function toPolyline(res, ctx) {
    const { A, B, seq, from, to, srcNode, endNode } = res;
    const pts = [[from.x, from.z]];
    let maxDepth = 0;
    const t = Number(ctx.minute ?? minute()) || 0;
    const push = (x, z) => {
      const last = pts[pts.length - 1];
      if (Math.hypot(x - last[0], z - last[1]) < 0.35) return;
      pts.push([x, z]);
      const d = depthAt(x, z, t);
      if (Number.isFinite(d) && d > maxDepth) maxDepth = d;
    };
    const sOf = (c, node) => (node === c.ids[0] ? 0 : c.len);
    const walk = (ci, s0, s1) => {
      const c = chains[ci];
      const n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / 7));
      for (let i = 1; i <= n; i++) {
        const [x, z] = at(c, s0 + (s1 - s0) * i / n);
        push(x, z);
      }
    };
    if (!seq.length) {
      // 起终点落在同一条链：沿这条链直接走过去（最常见：目标就在附近）
      if (A.ci === B.ci) walk(A.ci, A.s, B.s);
      else { push(A.x, A.z); push(B.x, B.z); }
    } else {
      // ① 起点链：从投影点走到 A* 的源端
      const ca = chains[A.ci];
      walk(A.ci, A.s, sOf(ca, srcNode));
      // ② 中间链：每条从「进入端」走到「到达端」
      let prevNode = srcNode;
      for (const e of seq) {
        const c = chains[e.ci];
        walk(e.ci, sOf(c, prevNode), sOf(c, e.node));
        prevNode = e.node;
      }
      // ③ 终点链：从 A* 到达端走到目标投影点（不拉穿楼直线）
      const cb = chains[B.ci];
      walk(B.ci, sOf(cb, endNode), B.s);
    }
    // ④ 末段：从人行道投影点走到真实目标（进楼 / 上高地的最后几米）
    push(B.x, B.z);
    push(to.x, to.z);
    let dist = 0;
    for (let i = 1; i < pts.length; i++) dist += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return { pts, dist, maxDepth,
      chains: [...new Set([res.A.ci, ...seq.map((e) => e.ci), res.B.ci])],
      expanded: res.expanded };
  }

  /**
   * 「往前走」类候选：沿真实人行道连续跨过几个街口。
   * 不是 A* 到某个点，而是沿链走到端点、再按边权挑下一条链 —— 日常通勤
   * 的形状。老手/新手因为 chainCost 里的绕水权重不同，会挑到不同的街。
   */
  function chainWalk(from, meters, ctx, kind) {
    const A = nearestOnNet(from.x, from.z);
    if (!A) return null;
    const pts = [[from.x, from.z]];
    const used = [];
    const t = Number(ctx.minute ?? minute()) || 0;
    let maxDepth = 0, total = 0;
    const push = (x, z) => {
      const last = pts[pts.length - 1];
      if (Math.hypot(x - last[0], z - last[1]) < 0.35) return;
      pts.push([x, z]);
      const d = depthAt(x, z, t);
      if (Number.isFinite(d) && d > maxDepth) maxDepth = d;
    };
    let ci = A.ci, s = A.s;
    let dir = (chains[ci].len - s >= 30) ? 1 : -1;
    for (let hop = 0; hop < 5 && total < meters; hop++) {
      const c = chains[ci];
      const toEnd = dir > 0 ? c.len - s : s;
      const want = meters - total;
      // 【按想法截断】抄近道只走 60 m，照原路走 110 m。旧版无论 meters
      // 多少都把整条链走完，于是两个候选算出完全相同的折线。
      const sEnd = want >= toEnd ? (dir > 0 ? c.len : 0)
        : (dir > 0 ? s + want : s - want);
      const n = Math.max(1, Math.ceil(Math.abs(sEnd - s) / 7));
      for (let k = 1; k <= n; k++) {
        const [x, z] = at(c, s + (sEnd - s) * k / n);
        push(x, z);
      }
      total += Math.abs(sEnd - s);
      used.push(ci);
      if (total >= meters - 0.5) break;      // 到位，不必再换链
      const node = dir > 0 ? c.ids[c.ids.length - 1] : c.ids[0];
      const opts = (nodeChains.get(node) || []).filter((e) => e.ci !== ci && !used.includes(e.ci));
      if (!opts.length) break;
      let best = null, bestScore = Infinity;
      for (const e of opts) {
        const cc = chains[e.ci];
        const cost = chainCost(e.ci, ctx);
        // 抄近道挑代价最小的短链；照原路走偏好长直主路
        const score = kind === 'shortcut' ? cost : (cost - cc.len * 0.15);
        if (score < bestScore) { bestScore = score; best = e; }
      }
      if (!best) break;
      const nc = chains[best.ci];
      ci = best.ci;
      const atHead = node === nc.ids[0];
      s = atHead ? 0 : nc.len;
      dir = atHead ? 1 : -1;
    }
    let dist = 0;
    for (let i = 1; i < pts.length; i++) dist += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return { pts, dist, maxDepth, chains: used, expanded: used.length, ok: pts.length > 1 };
  }

  // ---------------------------------------------------------------- 目标
  /** 沿真实链往前走一段：链尾不够就反向，链太短就接到相邻链，保证有位移。 */
  function ahead(from, meters) {
    const A = nearestOnNet(from.x, from.z);
    if (!A) return null;
    const c = chains[A.ci];
    let s = A.s + meters;
    if (s > c.len - 6) s = A.s - meters;
    s = clamp(s, 0, c.len);
    if (Math.abs(s - A.s) >= 25) {
      const [x, z] = at(c, s);
      return { point: { x, z }, onArrive: 'arrive', goal: { x, z, id: 'ahead', kind: 'street' } };
    }
    const node = c.ids[c.ids.length - 1];
    for (const e of nodeChains.get(node) || []) {
      if (e.ci === A.ci) continue;
      const cc = chains[e.ci], p2 = cc.pts[cc.pts.length - 1];
      return { point: { x: p2.x, z: p2.z }, onArrive: 'arrive',
        goal: { x: p2.x, z: p2.z, id: 'ahead', kind: 'street' } };
    }
    const p2 = c.pts[c.pts.length - 1];
    return { point: { x: p2.x, z: p2.z }, onArrive: 'arrive',
      goal: { x: p2.x, z: p2.z, id: 'ahead', kind: 'street' } };
  }

  function goalFor(kind, from, ctx) {
    if (kind === 'wait') return { point: null, onArrive: 'wait', goal: null };
    if (kind === 'high') {
      let R = ctx.refuge || null;
      // 经验好的人看得远、知道哪块高地更安全：在几个**真实可达**的避难所里
      // 挑更高的那块；经验不足的人只认最近的那个屋檐。两者因此走向地图上
      // 不同的终点，而不是同一条路换个说法。
      if (!R && findRefuge) {
        const pool = [];
        let avoid = null;
        for (let k = 0; k < 5; k++) {
          const rr = findRefuge(from.x, from.z, avoid, true);
          if (!rr) break;
          pool.push(rr);
          avoid = rr;
        }
        const near = pool.filter((r) => Math.hypot(r.x - from.x, r.z - from.z) <= (ctx.maxEscape || 300));
        const use = near.length ? near : pool;
        if (use.length) {
          R = (ctx.exp > 0.62 && use.length > 1)
            ? use.slice().sort((a, b) => b.y - a.y)[0] : use[0];
        }
      }
      if (R && Math.hypot(R.x - from.x, R.z - from.z) <= (ctx.maxEscape || 300)) return {
        point: { x: R.x, z: R.z }, onArrive: 'shelter',
        goal: { x: R.x, z: R.z, y: R.y, kind: R.kind, id: 'refuge', refuge: R },
      };
      // 最近真实高地在几百米外：不给一条要走十几分钟的路线。
      // 退到前方街口 / 最近门牌，仍然是地图上的真实位移。
    }
    if (kind === 'near') {
      let best = null, bd = Infinity;
      for (const d of (ctx.doors && ctx.doors.length ? ctx.doors : doors)) {
        const dd = Math.hypot(d.x - from.x, d.z - from.z);
        if (dd < bd) { bd = dd; best = d; }
      }
      if (best) {
        const far = Math.hypot(best.x - from.x, best.z - from.z) > (ctx.maxNear || 110);
        if (!far) return {
          point: { x: best.x, z: best.z }, onArrive: 'enter',
          goal: { x: best.x, z: best.z, id: best.id, kind: 'door' },
        };
      }
    }
    if (kind === 'follow' && ctx.leaderPos) {
      const L = ctx.leaderPos;
      return {
        point: { x: L.x, z: L.z }, onArrive: 'arrive',
        goal: { x: L.x, z: L.z, id: `leader_${L.i ?? 0}`, kind: 'person' },
      };
    }
    if (kind === 'scout') return ahead(from, 45) || { point: null, onArrive: 'wait', goal: null };
    // 日常「照原路走 / 慢慢沿熟路走」：目的地就是前方真实街口，且两者
    // 走过的街段数不同 —— 不是同一个门牌换两句文案。
    if (kind === 'steady') return ahead(from, 110) || { point: null, onArrive: 'wait', goal: null };
    if (kind === 'slow') return ahead(from, 80) || { point: null, onArrive: 'wait', goal: null };
    const d = ctx.dest;
    if (d && Number.isFinite(d.x) && Number.isFinite(d.z)
      && Math.hypot(d.x - from.x, d.z - from.z) <= (ctx.maxDest || 1e9)) {
      return {
        point: { x: d.x, z: d.z }, onArrive: d.onArrive || 'arrive',
        goal: { x: d.x, z: d.z, id: d.id, kind: 'door' },
      };
    }
    // 门牌在几公里外（全城多中心）：绝不给一条跨城路线让人走半小时。
    // 退化成「沿当前真实链往前 90 m 到下一个街口」——依然是有目标的真实位移。
    return ahead(from, 90) || { point: null, onArrive: 'wait', goal: null };
  }

  const recent = [];
  let planned = 0, failed = 0;

  /**
   * 规划一条真实路线。
   * @param {string} kind high/near/shortcut/steady/scout/slow/follow/wait
   * @param {{x,z}} from 当前真实位置
   * @param {object} ctx {exp,wade,dest,doors,leaderPos,refuge,minute,speed}
   */
  function plan(kind, from, ctx = {}) {
    const c = {
      exp: ctx.exp ?? 0.5, wade: ctx.wade ?? 0.3,
      minute: ctx.minute ?? minute(),
      preferMajor: kind === 'steady' || kind === 'slow',
      shortcut: kind === 'shortcut',
      wetAvoid: ctx.wetAvoid !== false,
    };
    const g = goalFor(kind, from, { ...ctx, ...c });
    if (!g.point) {
      return { kind, pts: [], dist: 0, maxDepth: 0, goal: null,
        onArrive: 'wait', chains: [], speed: 0, ok: kind === 'wait' };
    }
    // 目标就是「前方街口」：直接沿真实人行道跨几个街口，不绕 A* 的远路。
    let poly = null;
    if (g.goal && g.goal.id === 'ahead') {
      // 「抄近道」真的少走两个街口，「慢慢走」更短，「照原路」沿主路走更远。
      const meters = kind === 'shortcut' ? 60 : kind === 'slow' ? 80
        : kind === 'scout' ? 45 : 110;
      poly = chainWalk(from, meters, c, kind);
    }
    let res = null;
    if (!poly || !poly.ok) {
      res = shortest(from, g.point, c);
      if (!res) {
        failed++;
        // 路网不连通（常见于门牌在孤岛街区）：仍沿真实人行道跨几个街口，
        // 而不是凭空拉直线、更不是把人钉在原地。
        const cw = chainWalk(from, 90, c, kind);
        if (cw && cw.ok) poly = cw;
        else {
          const A = nearestOnNet(from.x, from.z);
          if (!A) return { kind, pts: [], dist: 0, maxDepth: 0, goal: g.goal, onArrive: 'wait', chains: [], speed: 0, ok: false };
          const cc = chains[A.ci];
          const toward = (g.point.x - from.x) * (cc.pts[cc.pts.length - 1].x - cc.pts[0].x)
            + (g.point.z - from.z) * (cc.pts[cc.pts.length - 1].z - cc.pts[0].z) >= 0;
          const s1 = clamp(A.s + (toward ? 60 : -60), 0, cc.len);
          const pts = [[from.x, from.z]];
          for (let i = 1; i <= 8; i++) { const [x, z] = at(cc, A.s + (s1 - A.s) * i / 8); pts.push([x, z]); }
          return { kind, pts, dist: Math.abs(s1 - A.s), maxDepth: 0, goal: g.goal,
            onArrive: 'arrive', chains: [A.ci], speed: 0, ok: pts.length > 1, fallback: true };
        }
      } else poly = toPolyline(res, c);
    }
    planned++;
    const speed = kind === 'slow' ? (ctx.speed || 1) * 0.7
      : kind === 'scout' ? (ctx.speed || 1) * 0.72
        : kind === 'high' ? (ctx.speed || 1) * 1.35
          : (ctx.speed || 1);
    const out = {
      kind, pts: poly.pts, dist: poly.dist, maxDepth: poly.maxDepth,
      chains: poly.chains, expanded: poly.expanded, goal: g.goal,
      onArrive: g.onArrive, speed, ok: poly.pts.length > 1,
      minute: c.minute,
    };
    recent.push({ kind, dist: +poly.dist.toFixed(1), maxDepth: +poly.maxDepth.toFixed(3),
      exp: +c.exp.toFixed(2), n: poly.pts.length, goal: g.goal && g.goal.id });
    if (recent.length > 120) recent.shift();
    return out;
  }

  /** 逃难用：直接规划到某个真实避难所（允许沿路网绕行较远）。 */
  function planTo(x, z, from, ctx = {}) {
    return plan('high', from, {
      ...ctx, maxEscape: ctx.maxEscape ?? 2500,
      refuge: ctx.refuge || { x, z, y: ctx.y || 0, kind: ctx.kind || 0 },
    });
  }

  /** 验收用：折线主体是否真的贴着 walknet。传 chainIds 时按这些链精确算
   *  点到线段的距离（避免网格索引漏查造成「明明在路上却报脱网」）。 */
  function onNet(pts, tol = 2.5, chainIds = null) {
    let off = 0, maxOff = 0;
    for (const [x, z] of pts) {
      let best = Infinity;
      if (chainIds && chainIds.length) {
        for (const ci of chainIds) {
          const c = chains[ci];
          if (!c) continue;
          for (let k = 0; k < c.pts.length - 1; k++) {
            const a = c.pts[k], b = c.pts[k + 1];
            const vx = b.x - a.x, vz = b.z - a.z;
            const L2 = vx * vx + vz * vz;
            const t = L2 > 1e-9 ? clamp(((x - a.x) * vx + (z - a.z) * vz) / L2, 0, 1) : 0;
            const d = Math.hypot(x - (a.x + vx * t), z - (a.z + vz * t));
            if (d < best) best = d;
          }
        }
      } else {
        const h = nearestOnNet(x, z);
        best = h ? h.d : Infinity;
      }
      if (best > tol) off++;
      if (best > maxOff) maxOff = best;
    }
    return { off, n: pts.length, maxOff: +maxOff.toFixed(2) };
  }

  return {
    plan, planTo, nearestOnNet, onNet, at,
    stats: () => ({ planned, failed, chains: useSet.size, recent: recent.slice(-30) }),
    get recent() { return recent; },
  };
}
