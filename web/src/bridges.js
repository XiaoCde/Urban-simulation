/**
 * L2 桥型 —— 沿**真实路径**扫掠出连续桥面 + 桥墩 + 上部结构。
 *
 * 为什么重写（旧版为什么"桥很离谱"）
 * ------------------------------------
 * 旧版把桥当成一条**直线轴**（cx,cz + dx,dz + len_m）：
 *   - 真实的 Memorial Bridge / 弯桥在 OSM 里是折线，直线轴一画就歪到岸边；
 *   - 桥面本身不在这里生成，而是靠 `roads.js` 的 ribbon 抬起来。可 ribbon 只在
 *     "该 way 有跨水断面" 时才抬 —— 实测 Memorial Bridge 沿 659 m 的 path 每 8 m
 *     打一条向下射线：**84 个采样点只有 29 个打到路面**，中间 55 个点根本没有
 *     路面。也就是说桥面是一段一段的，看起来就是"桥没接上"。
 *   - 桥面高程被写死成 waterY + 9 m，两岸只有 2~3 m 的路要在 40 m 内爬 7 m，
 *     于是桥头冒出一道尖坡，桥身像悬空的板。
 *
 * 现在的做法
 * ----------
 * 1. 用 `bridges.json` 的 `path`（真实跨河折线，plan 坐标）做等弧长重采样，
 *    逐点算切向/法向，形成可扫掠的坐标系；
 * 2. 逐点查地形，找出**真正的水面跨度** [s0, s1]；
 * 3. 桥面高程 = 两端引道地面高程插值 + 0.55，且至少高出水面 2.4 m，
 *    长桥中央起拱 —— 这跟真实 DC 的桥（Memorial 只比江面高 3~4 m）一致；
 * 4. 桥面 / 缘石 / 栏杆 / 桥墩 / 拱圈全部用同一条扫掠坐标系生成，
 *    所以结构之间不可能对不上；
 * 5. 引道段从"地形高程"渐变到"桥面高程"，两头接得上地面，不会断。
 *
 * 顶点一律非索引三角形（桥数量少），材质 DoubleSide，绕向写错也不穿帮。
 */

import * as THREE from 'three';

const STEP = 4.0;          // 沿桥采样间距（米）
const WALK_OVER = 1.2;     // 桥面相对水面至少高多少（米）
const BEND_RAMP = 6;       // 引道渐变段长度（米）

/** 把 plan 折线转成 three 坐标系下的等弧长采样点（z = -planY） */
function resample(path, step = STEP) {
  const pts = [];
  for (let i = 1; i < path.length; i++) {
    const [x0, y0] = path[i - 1], [x1, y1] = path[i];
    const ax = x0, az = -y0, bx = x1, bz = -y1;
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-6) continue;
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k < n; k++) {
      const u = k / n;
      pts.push([ax + (bx - ax) * u, az + (bz - az) * u]);
    }
  }
  const [lx, ly] = path[path.length - 1];
  pts.push([lx, -ly]);
  return pts;
}

/** 逐点切向 + 法向（法向 = 切向在 XZ 平面旋转 90°） */
function framesOf(pts) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const L = Math.hypot(tx, tz) || 1;
    tx /= L; tz /= L;
    out.push({ x: pts[i][0], z: pts[i][1], tx, tz, nx: -tz, nz: tx });
  }
  return out;
}

/**
 * @param {{bridges:Array, water_y:number}} doc bridges.json
 * @param {object} mats {stone, steel, deck} 材质
 * @param {(x:number,z:number)=>number|null} surf 已建路面的高度查询（可空）
 * @param {object} T 地形查询（T.sampleHeight / T.classify），用于定水面跨度与桥墩落地
 */
export function buildBridgeStyles(doc, mats, surf = null, T = null, opt = {}) {
  const g = new THREE.Group();
  g.name = 'L2_bridge_style';
  if (!doc || !Array.isArray(doc.bridges)) return g;

  const wy = doc.water_y ?? 0.046;
  const buf = {
    deck: [], steel: [], arch_stone: [], tied_arch: [], truss: [], suspension: [], beam: [],
  };
  const stat = { arch_stone: 0, tied_arch: 0, truss: 0, suspension: 0, beam: 0 };
  const detail = [];

  for (const b of doc.bridges) {
    const kind = b.kind || 'beam';
    const path = b.path || [];
    if (path.length < 2 || b.len_m < 40) continue;

    const pts = resample(path);
    if (pts.length < 3) continue;
    const F = framesOf(pts);
    const n = F.length;
    const w = Math.max(3.0, b.width_m || 5);

    // ---- 地形高程与水面跨度
    const gh = F.map(f => (T ? T.sampleHeight(f.x, f.z) : 0));
    let best0 = -1, best1 = -1, run0 = -1;
    for (let i = 0; i <= n; i++) {
      const wet = i < n && gh[i] < wy + 0.45;
      if (wet && run0 < 0) run0 = i;
      if (!wet && run0 >= 0) {
        if (run0 > 0 || i < n) {
          if (best0 < 0 || (i - run0) > (best1 - best0)) { best0 = run0; best1 = i; }
        }
        run0 = -1;
      }
    }
    if (best0 < 0) continue;                        // 这条其实没跨水，跳过
    if (best1 - best0 < 2) continue;                // 太短，不值得画桥

    // ---- 桥面高程：两端引道地面 → 中间起拱
    // 取**桥台外面**的地面高（不能用水面跨度端点：3DEP 是 hydro-flattened 的，
    // 河道内被打平到 -0.33 m，拿那里当桥台会让整座桥沉到水面高度，像一道土堤）。
    const bankH = (i0, dir, k = 5) => {
      let best = -Infinity;
      for (let k2 = 1; k2 <= k; k2++) {
        const i = i0 + dir * k2;
        if (i < 0 || i >= n) break;
        best = Math.max(best, gh[i]);
      }
      return Number.isFinite(best) ? best : gh[i0];
    };
    const hIn = Math.max(bankH(best0, -1), surf ? (surf(F[Math.max(0, best0 - 3)].x, F[Math.max(0, best0 - 3)].z) ?? -99) : -99);
    const hOut = Math.max(bankH(best1, +1), surf ? (surf(F[Math.min(n - 1, best1 + 3)].x, F[Math.min(n - 1, best1 + 3)].z) ?? -99) : -99);
    const baseIn = hIn + 0.55;
    const baseOut = hOut + 0.55;
    // 通航净空：大河桥 4.6 m（Memorial Bridge 实测净空就是这个量级，
    // 太矮会让拱圈压成一条看不见的缝），城市宽桥 3.2 m，窄桥/人行桥 2.0 m
    // 大河桥取 6.5 m：Memorial Bridge 的实际净空就是这个量级（≈5.5~6 m），
    // 低于 5 m 时 68 m 跨的石拱被压成一条缝，桥看起来就是一堵挡土墙。
    const floor = wy + ((best1 - best0) * STEP > 200 ? 6.5 : (w >= 7 ? 3.2 : 2.0));
    const span = best1 - best0;
    const crown = Math.min(0.85, span * STEP * 0.004);
    const dy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (i < best0 - BEND_RAMP || i > best1 + BEND_RAMP) { dy[i] = gh[i]; continue; }
      if (i < best0) {                                // 进桥引道
        const u = (i - (best0 - BEND_RAMP)) / BEND_RAMP;
        dy[i] = gh[i] + (Math.max(baseIn, floor) - gh[i]) * Math.max(0, Math.min(1, u));
        continue;
      }
      if (i >= best1) {                               // 出桥引道
        const u = 1 - (i - best1) / BEND_RAMP;
        dy[i] = gh[i] + (Math.max(baseOut, floor) - gh[i]) * Math.max(0, Math.min(1, u));
        continue;
      }
      const u = (i - best0 + 0.5) / span;
      const lin = baseIn + (baseOut - baseIn) * u;
      dy[i] = Math.max(lin, floor) + crown * Math.sin(Math.PI * u);
    }

    // 【桥面归属：roads.js】桥面已经由 roadmesh.js 的 ribbon 连续铺好了（它跟两侧
    // 引道是同一套顶点，天然接得住）。这里如果再画一层桥面，两层高度差几厘米
    // 就是用户看到的「一节一节、断头」。所以 dy 直接吸到已建好的路面三角面上，
    // 并把桥面/桥面板本身关掉（默认 noDeck），只保留拱圈/桁架/桥墩/栏杆。
    if (surf) {
      for (let i = 0; i < n; i++) {
        const y = surf(F[i].x, F[i].z);
        if (y !== null && y !== undefined) dy[i] = y;
      }
    }

    // ---- 扫掠辅助
    const P = (i, off, y) => [F[i].x + F[i].nx * off, y, F[i].z + F[i].nz * off];
    const tri = (arr, p, q, r) => { arr.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]); };
    const quad = (arr, p, q, r, s) => { tri(arr, p, q, r); tri(arr, p, r, s); };

    // ---- 1) 桥面（含引道），宽 w，铺到陆地上自然接住
    const D = buf.deck;
    if (!opt.noDeck) for (let i = 0; i < n - 1; i++) {
      const a0 = P(i, -w / 2, dy[i]), a1 = P(i, w / 2, dy[i]);
      const b0 = P(i + 1, -w / 2, dy[i + 1]), b1 = P(i + 1, w / 2, dy[i + 1]);
      quad(D, a0, b0, b1, a1);
    }
    // 桥面侧边（板厚 0.55 m），只画跨水段，避免在陆地上拉出一圈围裙
    if (!opt.noDeck) for (let i = best0; i < best1 - 1; i++) {
      for (const side of [-1, 1]) {
        const off = side * w / 2;
        const p0 = P(i, off, dy[i]), p1 = P(i + 1, off, dy[i + 1]);
        const p2 = P(i + 1, off, dy[i + 1] - 0.55), p3 = P(i, off, dy[i] - 0.55);
        quad(buf[kind === 'arch_stone' ? 'arch_stone' : 'beam'], p0, p1, p2, p3);
      }
    }

    // ---- 2) 缘石 + 栏杆（跨水段）
    const railTop = 1.05, curbH = 0.22;
    for (let i = best0; i < best1 - 1; i++) {
      for (const side of [-1, 1]) {
        const off = side * (w / 2 - 0.12);
        // 缘石
        const c0 = P(i, off, dy[i] + curbH), c1 = P(i + 1, off, dy[i + 1] + curbH);
        quad(buf.beam, P(i, off, dy[i]), c1, c0, P(i + 1, off, dy[i]));
        // 栏杆板（半透明看不到内部，做成薄板即可）
        const r0 = P(i, off, dy[i] + railTop), r1 = P(i + 1, off, dy[i + 1] + railTop);
        const r2 = P(i + 1, off, dy[i + 1] + railTop - 0.16), r3 = P(i, off, dy[i] + railTop - 0.16);
        quad(buf[kind === 'arch_stone' ? 'arch_stone' : 'steel'], r0, r1, r2, r3);
      }
    }
    // 望柱（每 ~4 m）
    const postEvery = Math.max(1, Math.round(4 / STEP));
    for (let i = best0; i < best1; i += postEvery) {
      for (const side of [-1, 1]) {
        const off = side * (w / 2 - 0.12);
        const [px, , pz] = P(i, off, 0);
        const yb = dy[i] + curbH, yt = dy[i] + railTop + 0.12;
        const s = 0.17;
        const c = [[px - F[i].tx * s, pz - F[i].tz * s], [px + F[i].nx * s, pz + F[i].nz * s],
          [px + F[i].tx * s, pz + F[i].tz * s], [px - F[i].nx * s, pz - F[i].nz * s]];
        for (let k = 0; k < 4; k++) {
          const p = c[k], q = c[(k + 1) % 4];
          quad(buf[kind === 'arch_stone' ? 'arch_stone' : 'steel'],
            [p[0], yt, p[1]], [q[0], yt, q[1]], [q[0], yb, q[1]], [p[0], yb, p[1]]);
        }
      }
    }

    // ---- 3) 桥墩：跨水段等分，落到河床
    const nPier = Math.max(2, Math.min(13, Math.round(span * STEP / 72)));
    const pierIdx = [];
    for (let k = 1; k < nPier; k++) pierIdx.push(best0 + Math.round(span * k / nPier));
    const bedOf = (i) => {
      const h = gh[i];
      return Math.min(h, wy) - (T && T.classify && T.classify(F[i].x, F[i].z) === 0 ? 3.2 : 1.2);
    };
    for (const i of pierIdx) {
      const yb = bedOf(i), yt = dy[i] - 0.55;
      if (yt - yb < 0.6) continue;
      const pw = Math.min(2.6, Math.max(1.1, w * 0.20));
      const arr = kind === 'arch_stone' ? buf.arch_stone : buf.beam;
      const c = [[P(i, -pw, 0)], [P(i, pw, 0)]];
      const hx = F[i].tx * 0.9, hz = F[i].tz * 0.9;
      const corners = [
        [c[0][0][0] - hx, c[0][0][2] - hz], [c[0][0][0] + hx, c[0][0][2] + hz],
        [c[1][0][0] + hx, c[1][0][2] + hz], [c[1][0][0] - hx, c[1][0][2] - hz],
      ];
      for (let k = 0; k < 4; k++) {
        const p = corners[k], q = corners[(k + 1) % 4];
        quad(arr, [p[0], yt, p[1]], [q[0], yt, q[1]], [q[0], yb, q[1]], [p[0], yb, p[1]]);
      }
    }

    // ---- 4) 上部结构（按桥型）
    if (kind === 'arch_stone') {
      // 石拱：相邻桥墩之间一道半圆拱，拱脚落在墩顶，拱背贴桥面底
      for (let k = 0; k < pierIdx.length - 1; k++) {
        const i0 = pierIdx[k], i1 = pierIdx[k + 1];
        const ySpring = Math.max(bedOf(i0) + 1.2, wy - 0.5);  // 拱脚压到水面下，开口才从水面起
        const yCrown = Math.min(dy[i0] - 0.8, dy[i1] - 0.8);
        if (yCrown - ySpring < 0.8) continue;
        const rib = Math.max(0.7, w * 0.075);
        for (const side of [-1, 1]) {
          const off = side * (w / 2 - rib * 0.55);
          let prev = null;
          const N = 10;
          for (let i = i0; i <= i1; i += Math.max(1, Math.round((i1 - i0) / N))) {
            const u = (i - i0) / (i1 - i0) * 2 - 1;
            const yy = ySpring + (yCrown - ySpring) * (1 - u * u);
            const cur = [P(i, off, 0)[0], yy, P(i, off, 0)[2]];
            if (prev) {
              quad(buf.arch_stone, prev, cur, [cur[0], yy - rib, cur[2]], [prev[0], prev[1] - rib, prev[2]]);
              // 拱肩墙：拱背到桥面底
              quad(buf.arch_stone, [prev[0], dy[i - 1] - 0.55, prev[2]], [cur[0], dy[i] - 0.55, cur[2]],
                cur, prev);
            }
            prev = cur;
          }
        }
      }
    } else if (kind === 'tied_arch') {
      const rise = Math.min(span * STEP * 0.16, 26);
      for (const side of [-1, 1]) {
        const off = side * (w / 2 - 0.5);
        let prev = null;
        for (let i = best0; i < best1; i++) {
          const u = (i - best0) / span;
          const yy = dy[i] + 0.4 + rise * Math.sin(Math.PI * u);
          const cur = P(i, off, yy);
          if (prev) quad(buf.tied_arch, prev.p, cur, [cur[0], yy - 1.0, cur[2]], [prev.p[0], prev.y - 1.0, prev.p[2]]);
          if (i % 2 === 0) {
            const yb = dy[i], yt2 = yy;
            const s = 0.09;
            const c = [[cur[0] - F[i].tx * s, cur[2] - F[i].tz * s], [cur[0] + F[i].nx * s, cur[2] + F[i].nz * s],
              [cur[0] + F[i].tx * s, cur[2] + F[i].tz * s], [cur[0] - F[i].nx * s, cur[2] - F[i].nz * s]];
            for (let q = 0; q < 4; q++) {
              const p1 = c[q], p2 = c[(q + 1) % 4];
              quad(buf.tied_arch, [p1[0], yt2, p1[1]], [p2[0], yt2, p2[1]], [p2[0], yb, p2[1]], [p1[0], yb, p1[1]]);
            }
          }
          prev = { p: cur, y: yy };
        }
      }
      // 顶部横撑
      for (let k = 1; k < 7; k++) {
        const i = Math.round(best0 + span * k / 7);
        if (i >= best1) continue;
        const u = (i - best0) / span;
        const yy = dy[i] + 0.4 + rise * Math.sin(Math.PI * u);
        quad(buf.tied_arch, P(i, -(w / 2 - 0.5), yy), P(i, w / 2 - 0.5, yy),
          P(i, w / 2 - 0.5, yy - 0.45), P(i, -(w / 2 - 0.5), yy - 0.45));
      }
    } else if (kind === 'truss') {
      const H = Math.min(9, Math.max(4.6, w * 0.32));
      for (const side of [-1, 1]) {
        const off = side * (w / 2 - 0.3);
        for (let i = best0; i < best1; i++) {
          const s = 0.15;
          const p = P(i, off, dy[i]), q = P(i, off, dy[i] + H);
          const c = [[p[0] - F[i].tx * s, p[2] - F[i].tz * s], [p[0] + F[i].nx * s, p[2] + F[i].nz * s],
            [p[0] + F[i].tx * s, p[2] + F[i].tz * s], [p[0] - F[i].nx * s, p[2] - F[i].nz * s]];
          for (let k = 0; k < 4; k++) {
            const a = c[k], d = c[(k + 1) % 4];
            quad(buf.truss, [a[0], q[1], a[1]], [d[0], q[1], d[1]], [d[0], p[1], d[1]], [a[0], p[1], a[1]]);
          }
          if (i > best0) {
            const pPrev = P(i - 1, off, dy[i - 1] + H);
            quad(buf.truss, pPrev, q, [q[0], q[1] - 0.3, q[2]], [pPrev[0], pPrev[1] - 0.3, pPrev[2]]);
          }
        }
      }
    } else if (kind === 'suspension') {
      const H = Math.min(34, Math.max(16, span * STEP * 0.07));
      for (const t of [0.22, 0.78]) {
        const i = Math.round(best0 + span * t);
        for (const side of [-1, 1]) {
          const off = side * (w / 2 - 0.35);
          const p = P(i, off, dy[i] + H);
          const s = 0.5;
          const c = [[p[0] - F[i].tx * s, p[2] - F[i].tz * s], [p[0] + F[i].nx * s, p[2] + F[i].nz * s],
            [p[0] + F[i].tx * s, p[2] + F[i].tz * s], [p[0] - F[i].nx * s, p[2] - F[i].nz * s]];
          for (let k = 0; k < 4; k++) {
            const a = c[k], d = c[(k + 1) % 4];
            quad(buf.suspension, [a[0], dy[i] + H, a[1]], [d[0], dy[i] + H, d[1]],
              [d[0], dy[i], d[1]], [a[0], dy[i], a[1]]);
          }
        }
      }
      for (const side of [-1, 1]) {
        const off = side * (w / 2 - 0.35);
        let prev = null;
        for (let i = best0; i < best1; i++) {
          const u = Math.abs((i - best0) / span - 0.5) / 0.5;
          const yy = dy[i] + H - H * 0.84 * u * u;
          const cur = P(i, off, yy);
          if (prev) quad(buf.suspension, prev, cur, [cur[0], yy - 0.35, cur[2]], [prev[0], prev[1] - 0.35, prev[2]]);
          if (i % 2 === 0 && yy > dy[i] + 1.2) {
            const s = 0.07;
            const c = [[cur[0] - F[i].tx * s, cur[2] - F[i].tz * s], [cur[0] + F[i].nx * s, cur[2] + F[i].nz * s],
              [cur[0] + F[i].tx * s, cur[2] + F[i].tz * s], [cur[0] - F[i].nx * s, cur[2] - F[i].nz * s]];
            for (let k = 0; k < 4; k++) {
              const a = c[k], d = c[(k + 1) % 4];
              quad(buf.suspension, [a[0], yy, a[1]], [d[0], yy, d[1]], [d[0], dy[i], d[1]], [a[0], dy[i], a[1]]);
            }
          }
          prev = cur;
        }
      }
    }

    stat[kind] = (stat[kind] || 0) + 1;
    detail.push({
      name: b.name || '(无名)', kind, len: +b.len_m.toFixed(0),
      span_m: +(span * STEP).toFixed(0),
      deck_in: +baseIn.toFixed(2), deck_out: +baseOut.toFixed(2),
      water: +wy.toFixed(3),
    });
  }

  const mk = (arr, mat, name) => {
    if (!arr.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };
  const deckMat = mats.deck || mats.stone;
  const md = mk(buf.deck, deckMat, 'bridge_deck');
  if (md) g.add(md);
  const st = mk(buf.arch_stone, mats.stone, 'bridge_arch_stone');
  if (st) g.add(st);
  const bm = mk(buf.beam, mats.stone, 'bridge_beam');
  if (bm) g.add(bm);
  const bs = mk(buf.steel, mats.steel, 'bridge_rail');
  if (bs) g.add(bs);
  for (const k of ['tied_arch', 'truss', 'suspension']) {
    const m = mk(buf[k], mats.steel, 'bridge_' + k);
    if (m) g.add(m);
  }
  console.log(`[bridges] 石拱 ${stat.arch_stone || 0} / 系杆拱 ${stat.tied_arch || 0} / `
    + `桁架 ${stat.truss || 0} / 悬索 ${stat.suspension || 0} / 梁桥 ${stat.beam || 0}`);
  for (const d of detail) console.log('[bridges]', JSON.stringify(d));
  return g;
}