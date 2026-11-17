import * as THREE from 'three';

/**
 * 运行时铺路：按道路中心线挤出连续的带（不是一段段拼 quad），
 * 内部拐点用斜接法线，路口补一块圆盘，再叠路缘石与人行道。
 *
 * 两条硬规矩（都踩过坑）：
 * 1) 三角形绕向反了会被背面剔除，整条路直接“消失”。这里统一 side=DoubleSide，
 *    并把法线强制朝上，彻底绕开这个坑——路面本来就是水平面。
 * 2) 路面高度必须和积涝水面同基准（调用方传 T.sampleHeight），
 *    否则路面会浮在水面之上，积水整片看不见。
 */

/** 沥青贴图：骨料颗粒 + 轮迹 + 白边线；宽路再加车道分隔虚线。 */
function makeRoadTexture(wide = false) {
  const W = 512;
  const H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');

  g.fillStyle = '#41464c';
  g.fillRect(0, 0, W, H);

  // 骨料：两种粒径的颗粒，近看才不是一片糊
  for (let i = 0; i < 5600; i += 1) {
    const v = 52 + Math.random() * 34;
    g.fillStyle = `rgba(${v},${v + 2},${v + 5},0.55)`;
    const r = Math.random() < 0.75 ? 1.6 : 3.2;
    g.fillRect(Math.random() * W, Math.random() * H, r, r);
  }

  // 轮迹：两条略深的带
  g.fillStyle = 'rgba(26,29,32,0.15)';
  for (const u of [0.30, 0.70]) g.fillRect(W * u - 26, 0, 22, H);

  // 两侧白边线
  g.fillStyle = 'rgba(228,226,214,0.92)';
  g.fillRect(9, 0, 7, H);
  g.fillRect(W - 16, 0, 7, H);

  // 宽路的车道分隔虚线（窄路不画，否则一条小路会被切成两条）
  if (wide) {
    g.fillStyle = 'rgba(222,220,208,0.7)';
    for (const u of [0.27, 0.73]) {
      for (let y = 0; y < H; y += 128) g.fillRect(Math.round(W * u) - 2, y, 4, 64);
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const MARK = {
  surface: null,
  surfaceWide: null,
  walk: new THREE.MeshStandardMaterial({ color: 0x9d9a92, roughness: 0.95, side: THREE.DoubleSide }),
  curb: new THREE.MeshStandardMaterial({ color: 0xb9b4a8, roughness: 0.9, side: THREE.DoubleSide }),
  line: new THREE.MeshStandardMaterial({
    color: 0xd8bb63, roughness: 0.72, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }),
  junction: new THREE.MeshStandardMaterial({ color: 0x454a50, roughness: 0.92, side: THREE.DoubleSide }),
};

/** 每个点的斜接法线（左手侧），拐角处按夹角放大以保持路宽。 */
function miterNormals(pts) {
  const n = pts.length;
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(n - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dz = next[1] - prev[1];
    let len = Math.hypot(dx, dz);
    if (len < 1e-6) { dx = 1; dz = 0; len = 1; }
    // 左法线 = 切线逆时针旋转 90°
    const nx = -dz / len;
    const nz = dx / len;
    if (i > 0 && i < n - 1) {
      const a = pts[i - 1]; const b = pts[i]; const c = pts[i + 1];
      const d1x = b[0] - a[0]; const d1z = b[1] - a[1];
      const d2x = c[0] - b[0]; const d2z = c[1] - b[1];
      const l1 = Math.hypot(d1x, d1z) || 1;
      const l2 = Math.hypot(d2x, d2z) || 1;
      const n1x = -d1z / l1; const n1z = d1x / l1;
      const n2x = -d2z / l2; const n2z = d2x / l2;
      const mx = n1x + n2x; const mz = n1z + n2z;
      const ml = Math.hypot(mx, mz);
      if (ml > 1e-4) {
        const scale = 1 / Math.max(0.55, (mx * n1x + mz * n1z) / ml);
        out[i] = [(mx / ml) * scale, (mz / ml) * scale];
        continue;
      }
    }
    out[i] = [nx, nz];
  }
  return out;
}

/** 一条带宽的带子：uv 沿路按米数累积，横向 0→1。 */
function stripe(out, pts, normals, offset, halfWidth, y0, uvScale = 9) {
  const L = [];
  const R = [];
  let run = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const [px, pz] = pts[i];
    const [nx, nz] = normals[i];
    if (i > 0) run += Math.hypot(px - pts[i - 1][0], pz - pts[i - 1][1]);
    const cx = px + nx * offset;
    const cz = pz + nz * offset;
    const y = y0(i) + (out.lift || 0);
    L.push([cx + nx * halfWidth, y, cz + nz * halfWidth, run / uvScale]);
    R.push([cx - nx * halfWidth, y, cz - nz * halfWidth, run / uvScale]);
  }
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = L[i]; const b = L[i + 1]; const c = R[i + 1]; const d = R[i];
    out.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    out.pos.push(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    if (out.uv) {
      out.uv.push(0, a[3], 0, b[3], 1, c[3]);
      out.uv.push(0, a[3], 1, c[3], 1, d[3]);
    }
  }
}

/** 虚线：沿弧长 3 m 画、6 m 空。 */
function dashedStripe(out, pts, normals, offset, halfWidth, y0, dash = 3, gap = 6) {
  let acc = 0;
  let on = true;
  let span = [pts[0]];

  const emit = () => {
    if (span.length >= 2) {
      const ns = miterNormals(span);
      stripe(out, span, ns, offset, halfWidth, y0);
    }
  };

  for (let i = 1; i < pts.length; i += 1) {
    const segLen = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    acc += segLen;
    const limit = on ? dash : gap;
    if (acc >= limit) {
      span.push(pts[i]);
      if (on) emit();
      span = on ? [] : [pts[i]];
      if (on) span = [pts[i]];
      on = !on;
      acc = 0;
    } else {
      span.push(pts[i]);
    }
  }
  if (on) emit();
}

function pushDisk(arr, cx, cz, r, y, seg = 20) {
  for (let i = 0; i < seg; i += 1) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    arr.push(cx, y, cz);
    arr.push(cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r);
    arr.push(cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r);
  }
}

export function buildLocalRoads(data, groundAt) {
  const group = new THREE.Group();
  group.name = 'LocalRoads';

  const layers = {
    // 路面必须低于积涝水面（地形 +0.12 m），否则整片水会被埋掉
    surface: { pos: [], uv: [], lift: 0.045 },
    surfaceWide: { pos: [], uv: [], lift: 0.046 },
    walk: { pos: [], lift: 0.16 },
    curb: { pos: [], lift: 0.10 },
    line: { pos: [], lift: 0.075 },
    junction: { pos: [], lift: 0.05 },
  };

  const isPath = (h) => ['footway', 'path', 'steps', 'cycleway', 'pedestrian'].includes(h);

  // 路口附近不铺人行道：两三条人行道带在路口叠在一起，会糊出一大块浅灰三角，
  // 看起来像地面上贴了一张纸。按“距最近路口 8 m 以外”把折线切成若干段。
  const juncs = data.junctions || [];
  const runsOutsideJunctions = (pts, radius = 8) => {
    const runs = [];
    let cur = [];
    for (const p of pts) {
      const near = juncs.some((j) => Math.hypot(p[0] - j.x, p[1] - j.z) < radius);
      if (near) {
        if (cur.length >= 2) runs.push(cur);
        cur = [];
      } else {
        cur.push(p);
      }
    }
    if (cur.length >= 2) runs.push(cur);
    return runs;
  };

  for (const w of data.ways || []) {
    const pts = w.pts;
    if (!pts || pts.length < 2) continue;
    const hw = Math.max(1.0, (w.w || 7) / 2);
    const normals = miterNormals(pts);
    const gy = (i) => groundAt(pts[i][0], pts[i][1]);

    // 车行道：超过 11 m 宽用带车道线的贴图
    stripe(hw > 5.4 ? layers.surfaceWide : layers.surface, pts, normals, 0, hw, gy);

    if (!isPath(w.h)) {
      for (const run of runsOutsideJunctions(pts)) {
        const ns = miterNormals(run);
        const ry = (i) => groundAt(run[i][0], run[i][1]);
        stripe(layers.walk, run, ns, hw + 1.15, 1.15, ry);
        stripe(layers.walk, run, ns, -(hw + 1.15), 1.15, ry);
        stripe(layers.curb, run, ns, hw + 0.09, 0.09, ry);
        stripe(layers.curb, run, ns, -(hw + 0.09), 0.09, ry);
      }
      // 中心黄线：3 m 实线 + 6 m 空
      if (hw >= 4.6) dashedStripe(layers.line, pts, normals, 0, 0.075, gy);
    }
  }

  for (const j of data.junctions || []) {
    const y = groundAt(j.x, j.z) + layers.junction.lift;
    pushDisk(layers.junction.pos, j.x, j.z, Math.min(6.2, Math.max(2.2, (j.w || 9) * 0.34)), y);
  }

  MARK.surface = new THREE.MeshStandardMaterial({
    map: makeRoadTexture(false), roughness: 0.9, metalness: 0.02, side: THREE.DoubleSide,
  });
  MARK.surfaceWide = new THREE.MeshStandardMaterial({
    map: makeRoadTexture(true), roughness: 0.9, metalness: 0.02, side: THREE.DoubleSide,
  });

  let tris = 0;
  for (const [key, layer] of Object.entries(layers)) {
    if (!layer.pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(layer.pos, 3));
    if (layer.uv && layer.uv.length === (layer.pos.length / 3) * 2) {
      g.setAttribute('uv', new THREE.Float32BufferAttribute(layer.uv, 2));
    }
    // 路面是水平面，法线直接朝上：绕向写错也不会变黑
    const nrm = new Float32Array(layer.pos.length);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    const mesh = new THREE.Mesh(g, MARK[key]);
    mesh.name = `Road_${key}`;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    tris += layer.pos.length / 9;
    group.add(mesh);
  }

  group.userData.triCount = Math.round(tris);
  return group;
}
