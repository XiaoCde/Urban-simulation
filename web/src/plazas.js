/**
 * L2 广场 —— 国会山东西广场、华盛顿纪念碑场地、林肯堂前广场。
 *
 * 为什么要单独做
 * --------------
 * 这些地方在真实 DC 里是**大块花岗岩/混凝土铺装 + 立缘石 + 台阶**，
 * 是「广场」这个尺度的核心视觉；而当前场景里它们只是 landcover 的
 * class 2（硬化）顶点色 —— 一条条 6 m 栅格，没有立缘、没有铺装尺度、
 * 站在上面看不出这是个广场。
 *
 * 做法
 * ----
 * 每个广场先给一个平面多边形（以地标自身的 footprint 为锚点，避免手填坐标
 * 在大场景里漂移），然后：
 *   1. 3 m 网格裁切铺装（逐格判断四角是否都在多边形内），
 *      顶点高程 = 地形 + 0.07 —— 跟着地形起伏，不会切进坡里；
 *   2. 沿边界长一圈 **立缘石**（0.30 m 高，0.45 m 宽顶面），
 *      这是「广场/人行道」和「一片灰色地面」的唯一区别；
 *   3. UV 按世界坐标铺，花岗岩/铺装的尺度才是对的。
 *
 * 锚点用 `buildings.json` 里的 id，取它的 footprint bbox 再按米制外扩，
 * 所以地形/坐标一改，广场跟着走，不需要重新量。
 */

import * as THREE from 'three';

/** 多边形（plan 坐标 [x, y]）内点判定（射线法） */
function inside(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function rectPoly(cx, cz, w, d, rot = 0) {
  const c = Math.cos(rot), s = Math.sin(rot);
  const hw = w / 2, hd = d / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]
    .map(([x, y]) => [cx + x * c - y * s, cz + x * s + y * c]);
}

function circlePoly(cx, cz, r, seg = 40) {
  const out = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return out;
}

/**
 * 按 id 取 footprint bbox，**返回 plan 坐标**（即 y = -threeZ）；找不到返回 null。
 *
 * 为什么必须在这里翻号：
 *   buildings.json 的 verts 存的是 three 坐标（stride 4 = x, z, top, base，
 *   z 已经是 -planY）。而本文件所有多边形 / slabMesh / sampleHeight 都用
 *   **plan 坐标**。早期这里直接把 three 的 z 当 plan 的 y 传下去，slabMesh 又
 *   做了一次 `-z`，两次取负 → 广场整块镜像到南北另一侧，落到坡地上浮空
 *   10~11 m（实测 plaza_lincoln 全部 1008 个顶点都浮 10.72 m）。
 */
function bboxOf(B, id) {
  const bd = B.buildings.find((b) => String(b.id) === String(id));
  if (!bd) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < bd.vc; i++) {
    const s = (bd.v0 + i) * 4;
    const x = B.verts[s], y = -B.verts[s + 1];   // three z → plan y
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, x1, y0, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/** 一块铺装 + 一圈立缘石 */
function slabMesh(poly, T, mat, tile, name, curbH = 0.30) {
  const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const z0 = Math.min(...zs), z1 = Math.max(...zs);
  const STEP = 2.5;
  const pos = [], uv = [], idx = [];
  // 铺装分格：按 6 m 见方的网格做两档明度交替。
  // 纯资料色在大场景里会糊成一整片浅灰（远看读不出「广场」），
  // 交替色块是最省的「有铺装」信号 —— 不需要额外贴图，也不会随距离丢细节。
  const col = [];

  const nx = Math.ceil((x1 - x0) / STEP), nz = Math.ceil((z1 - z0) / STEP);
  const grid = new Map();
  const key = (i, j) => i * 10007 + j;
  const vid = (i, j, x, z) => {
    const k = key(i, j);
    if (grid.has(k)) return grid.get(k);
    // 抬 0.12 m：3 m 级的采样在 6 m 地形网格上仍会偶发压进坡里（实测最深 -0.20 m）
    // 【注意】本文件的 x/z 参数是 **plan 坐标**，而 T.sampleHeight 吃的是 three 的
    // (x, z)，两者 z 反号。这里传 -z 才对；直接传 z 会把标高采到南北对称的另一点，
    // 广场于是整块浮在 6 m 以上（实测 plaza_capitol_e 1033/2880 顶点浮 6.31 m）。
    const y = (T ? T.sampleHeight(x, -z) : 0) + 0.12;
    const v = pos.length / 3;
    pos.push(x, y, -z);
    uv.push(x / tile, z / tile);
    const odd = ((Math.floor(x / 3) + Math.floor(z / 3)) & 1) === 1;
    const k2 = odd ? 0.74 : 1.0;
    col.push(k2, k2, k2);
    grid.set(k, v);
    return v;
  };
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const ax = x0 + i * STEP, bx = Math.min(ax + STEP, x1);
      const az = z0 + j * STEP, bz = Math.min(az + STEP, z1);
      if (!(inside(poly, ax, az) && inside(poly, bx, az) && inside(poly, bx, bz) && inside(poly, ax, bz))) continue;
      const A = vid(i, j, ax, az), Bv = vid(i + 1, j, bx, az);
      const C = vid(i + 1, j + 1, bx, bz), D = vid(i, j + 1, ax, bz);
      // 绕向：three 里 z = -planY，所以按 plan 的逆时针走，法线朝下（正面朝地里，
      // 从上往下看是隐形、raycast 也打不中）。必须按 A→B→C 的顺序推。
      idx.push(A, Bv, C, A, C, D);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  m.receiveShadow = true;

  // ---- 立缘石：沿边界一圈，抬到铺装面之上 curbH
  const cp = [], cidx = [];
  const push = (x, y, z) => { cp.push(x, y, z); return cp.length / 3 - 1; };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.2) continue;
    const nb = Math.max(1, Math.round(L / 4));
    for (let k = 0; k < nb; k++) {
      const t0 = k / nb, t1 = (k + 1) / nb;
      const p0x = a[0] + (b[0] - a[0]) * t0, p0z = a[1] + (b[1] - a[1]) * t0;
      const p1x = a[0] + (b[0] - a[0]) * t1, p1z = a[1] + (b[1] - a[1]) * t1;
      const y0 = (T ? T.sampleHeight(p0x, -p0z) : 0) + 0.12;
      const y1 = (T ? T.sampleHeight(p1x, -p1z) : 0) + 0.12;
      const yc0 = y0 + curbH, yc1 = y1 + curbH;
      // 外立面（双面渲染，绕向不必纠结）
      const a0 = push(p0x, y0, -p0z), b0 = push(p1x, y1, -p1z);
      const b1 = push(p1x, yc1, -p1z), a1 = push(p0x, yc0, -p0z);
      cidx.push(a0, b0, b1, a0, b1, a1);
      cidx.push(a1, b1, b0, a1, b0, a0);
      // 顶面（向内 0.45 m）
      const nx2 = -(b[1] - a[1]) / L * 0.45, nz2 = (b[0] - a[0]) / L * 0.45;
      const c0 = push(p0x + nx2, yc0, -(p0z + nz2)), c1 = push(p1x + nx2, yc1, -(p1z + nz2));
      cidx.push(a1, b1, c1, a1, c1, c0);
      cidx.push(c0, c1, b1, c0, b1, a1);
    }
  }
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
  cg.setIndex(cidx);
  cg.computeVertexNormals();
  cg.computeBoundingSphere();
  const cm = new THREE.Mesh(cg, mat);
  cm.name = name + '_curb';
  cm.receiveShadow = true;
  cm.castShadow = true;

  const g = new THREE.Group();
  g.name = name;
  g.add(m);
  g.add(cm);
  return g;
}

/**
 * @param {object} T terrain
 * @param {object} B loadBuildings() 的返回（用来取地标 footprint 当锚点）
 */
export function buildPlazas(T, B, matOverride = null) {
  const g = new THREE.Group();
  g.name = 'L2_plaza';
  if (!B) return g;

  // 花岗岩铺装：本身是冷调浅灰，用 pave 贴图做骨料
  const granite = matOverride || new THREE.MeshStandardMaterial({
    color: 0xc3c0b8, roughness: 0.93, metalness: 0.0,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
  const TILE = 5.4;   // 一张花岗岩贴图 = 6 块 0.9 m 石板

  const cap = bboxOf(B, '66418809');   // United States Capitol
  const mon = bboxOf(B, '766761337');  // Washington Monument
  const lin = bboxOf(B, '398769543');  // Lincoln Memorial

  // ---- 国会山西广场（West Front Terrace）
  // 真实尺寸约 180 × 100 m 的平台，正对国家广场轴线。
  if (cap) {
    const w = 100, d = Math.min(190, (cap.x1 - cap.x0) * 1.1);
    g.add(slabMesh(rectPoly(cap.x0 - w / 2 - 6, cap.cy, w, d), T, granite, TILE, 'plaza_capitol_w'));
    // ---- 国会山东广场（East Front Plaza，2022 年建成的大铺装）
    g.add(slabMesh(rectPoly(cap.x1 + 78, cap.cy, 150, 120), T, granite, TILE, 'plaza_capitol_e'));
  }

  // ---- 华盛顿纪念碑场地：环状铺装（真实是草坡 + 50 面旗 + 碎石环道）
  if (mon) {
    const ring = [];
    const rOut = 96, rIn = 62, seg = 48;
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      ring.push([mon.cx + Math.cos(a) * rOut, mon.cy + Math.sin(a) * rOut]);
    }
    g.add(slabMesh(ring, T, granite, TILE, 'plaza_monument'));
    // 内圈是一块抬高的圆台（纪念碑立在上面）
    g.add(slabMesh(circlePoly(mon.cx, mon.cy, rIn, 40), T, granite, TILE, 'plaza_monument_core'));
  }

  // ---- 林肯堂前广场（东侧，面向倒影池）
  if (lin) {
    g.add(slabMesh(rectPoly(lin.cx + 62, lin.cy, 90, 70), T, granite, TILE, 'plaza_lincoln'));
  }

  let tris = 0;
  g.traverse((o) => { if (o.isMesh && o.geometry.index) tris += o.geometry.index.count / 3; });
  console.log(`[plaza] ${g.children.length} 个广场构件, ${Math.round(tris)} 三角`);
  return g;
}