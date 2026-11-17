import * as THREE from 'three';

/**
 * 多人物场景里的四座附属建筑 / 场地。
 *
 * 外轮廓、位置、层数来自 `web/assets/city/buildings.json` 的实测数据；
 * 室内房间、楼梯、家具是依据体量与用途做的合理重建，不是实测图纸。
 * 四座都支持：进入、逐层显示、剖面查看、自由探索。
 *
 * 三角形绕向：本文件只用 InstancedMesh 的立方体（BoxGeometry 本身绕向正确），
 * 不用手写 BufferGeometry，避免重复“绕反了被背面剔除、整块面消失”的问题。
 */

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

/** 128×128 的细微噪点，平铺后给墙面/地面一点颗粒感，避免大片纯色像塑料。 */
function grainTexture(base, amount = 14) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 128, 128);
  const img = g.getImageData(0, 0, 128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * amount;
    img.data[i] = Math.min(255, Math.max(0, img.data[i] + n));
    img.data[i + 1] = Math.min(255, Math.max(0, img.data[i + 1] + n));
    img.data[i + 2] = Math.min(255, Math.max(0, img.data[i + 2] + n));
  }
  g.putImageData(img, 0, 0);
  // 几条极淡的分缝，暗示板材
  g.globalAlpha = 0.06;
  g.fillStyle = '#000';
  for (let i = 0; i < 128; i += 32) g.fillRect(0, i, 128, 1);
  for (let i = 0; i < 128; i += 64) g.fillRect(i, 0, 1, 128);
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const MAT = {
  brick: new THREE.MeshStandardMaterial({ color: 0xa8907c, roughness: 0.93 }),
  plaster: new THREE.MeshStandardMaterial({ color: 0xcbc5b6, roughness: 0.9, map: grainTexture('#cbc5b6', 10) }),
  stone: new THREE.MeshStandardMaterial({ color: 0xbdb6a8, roughness: 0.86 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x9a9a94, roughness: 0.9 }),
  floor: new THREE.MeshStandardMaterial({ color: 0xb5a894, roughness: 0.82, map: grainTexture('#b5a894', 12) }),
  tile: new THREE.MeshStandardMaterial({ color: 0xd9dcda, roughness: 0.55, map: grainTexture('#d9dcda', 8) }),
  terrazzo: new THREE.MeshStandardMaterial({ color: 0xbfb2a4, roughness: 0.62, map: grainTexture('#bfb2a4', 14) }),
  dirt: new THREE.MeshStandardMaterial({ color: 0x6b5b46, roughness: 1.0, map: grainTexture('#6b5b46', 26) }),
  carpet: new THREE.MeshStandardMaterial({ color: 0x5c6a62, roughness: 0.97 }),
  wall: new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.9, map: grainTexture('#d8d2c4', 10) }),
  trim: new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.7 }),
  ceiling: new THREE.MeshStandardMaterial({ color: 0xd6d2c6, roughness: 0.94, map: grainTexture('#d6d2c6', 8), emissive: 0x2a2924, emissiveIntensity: 1.0 }),
  glass: new THREE.MeshPhysicalMaterial({
    color: 0x9dbac6, roughness: 0.14, metalness: 0.05,
    transparent: true, opacity: 0.36, depthWrite: false, side: THREE.DoubleSide,
  }),
  metal: new THREE.MeshStandardMaterial({ color: 0x8d9498, roughness: 0.34, metalness: 0.75 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x2b3237, roughness: 0.5, metalness: 0.4 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x9a7850, roughness: 0.74 }),
  woodDark: new THREE.MeshStandardMaterial({ color: 0x6a5137, roughness: 0.8 }),
  fabric: new THREE.MeshStandardMaterial({ color: 0x4a5a63, roughness: 0.96 }),
  fabricRed: new THREE.MeshStandardMaterial({ color: 0x8d4b48, roughness: 0.96 }),
  white: new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.7 }),
  steelBlue: new THREE.MeshStandardMaterial({ color: 0x4a6672, roughness: 0.6, metalness: 0.4 }),
  screen: new THREE.MeshStandardMaterial({ color: 0x17262c, emissive: 0x2b5866, emissiveIntensity: 0.45, roughness: 0.3 }),
  light: new THREE.MeshStandardMaterial({ color: 0xf7f3e4, emissive: 0xfff0c8, emissiveIntensity: 1.5, roughness: 0.5 }),
  green: new THREE.MeshStandardMaterial({ color: 0x4c6b4a, roughness: 0.95 }),
  rust: new THREE.MeshStandardMaterial({ color: 0x8a5a3c, roughness: 0.95 }),
  soil: new THREE.MeshStandardMaterial({ color: 0x6b5a44, roughness: 1.0 }),
  tarp: new THREE.MeshStandardMaterial({ color: 0x3f6f95, roughness: 0.85 }),
  yellow: new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.7 }),
  red: new THREE.MeshStandardMaterial({ color: 0xa8342c, roughness: 0.7 }),
};

class Batch {
  constructor(parent, name, material, shadows = true) {
    this.parent = parent; this.name = name; this.material = material;
    this.shadows = shadows; this.list = [];
  }
  add(x, y, z, sx, sy, sz) {
    if (sx <= 0 || sy <= 0 || sz <= 0) return;
    this.list.push(new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz),
    ));
  }
  build() {
    if (!this.list.length) return null;
    const mesh = new THREE.InstancedMesh(UNIT_BOX, this.material, this.list.length);
    mesh.name = this.name;
    for (let i = 0; i < this.list.length; i += 1) mesh.setMatrixAt(i, this.list[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = this.shadows;
    mesh.receiveShadow = this.shadows;
    mesh.computeBoundingSphere();
    this.parent.add(mesh);
    return mesh;
  }
}

function batches(group) {
  const b = {};
  for (const key of Object.keys(MAT)) {
    b[key] = new Batch(group, `Batch_${key}`, MAT[key],
      !['glass', 'light', 'screen'].includes(key));
  }
  return b;
}

function flush(b) {
  let tris = 0;
  for (const key of Object.keys(b)) {
    const mesh = b[key].build();
    if (mesh) tris += mesh.count * 12;
  }
  return tris;
}

/** 楼板 + 饰面；hole 指定挖洞（楼梯井 / 电梯井），用四块板围出来。 */
function slab(b, rect, y, hole) {
  const { x0, x1, z0, z1 } = rect;
  const put = (ax0, ax1, az0, az1) => {
    if (ax1 - ax0 < 0.05 || az1 - az0 < 0.05) return;
    b.concrete.add((ax0 + ax1) / 2, y - 0.09, (az0 + az1) / 2, ax1 - ax0, 0.18, az1 - az0);
    b.floor.add((ax0 + ax1) / 2, y + 0.012, (az0 + az1) / 2, ax1 - ax0 - 0.06, 0.014, az1 - az0 - 0.06);
  };
  if (!hole) { put(x0, x1, z0, z1); return; }
  put(x0, x1, z0, hole.z0);
  put(x0, x1, hole.z1, z1);
  put(x0, hole.x0, hole.z0, hole.z1);
  put(hole.x1, x1, hole.z0, hole.z1);
}

/** 外墙按 3.4–4.2 m 开间开窗，窗洞是真开出来的，不是贴在墙上。 */
function facade(b, rect, y, floorH, { bayW = 3.8, winW = 2.5, winH = 1.8, sill = 1.05, wall = MAT ? null : null, mat = 'brick', skip = null } = {}) {
  const { x0, x1, z0, z1 } = rect;
  const t = 0.34;
  const B = b[mat];
  const pier = (bayW - winW) / 2;
  const above = Math.max(0.2, floorH - sill - winH);

  const along = (faceZ, sign, fromX, toX) => {
    for (let x = fromX + bayW / 2; x < toX - 0.2; x += bayW) {
      if (skip && skip(x, faceZ)) continue;
      B.add(x, y + floorH / 2, faceZ + sign * t / 2, pier, floorH, t);
      B.add(x - (winW + pier) / 2, y + floorH / 2, faceZ + sign * t / 2, pier, floorH, t);
      B.add(x + (winW + pier) / 2, y + floorH / 2, faceZ + sign * t / 2, pier, floorH, t);
      B.add(x, y + sill / 2, faceZ + sign * t / 2, winW, sill, t);
      B.add(x, y + sill + winH + above / 2, faceZ + sign * t / 2, winW, above, t);
      const wz = faceZ + sign * (t + 0.04);
      // 只做窗框四根细料，中间必须是透的
      b.dark.add(x, y + sill + 0.05, wz, winW + 0.1, 0.1, 0.05);
      b.dark.add(x, y + sill + winH - 0.05, wz, winW + 0.1, 0.1, 0.05);
      for (const sx of [-1, 1]) {
        b.dark.add(x + sx * (winW / 2), y + sill + winH / 2, wz, 0.09, winH, 0.05);
      }
      b.glass.add(x, y + sill + winH / 2, wz + sign * 0.035, winW, winH, 0.03);
      b.stone.add(x, y + sill - 0.06, faceZ + sign * (t + 0.09), winW + 0.3, 0.12, 0.16);
    }
  };
  const across = (faceX, sign, fromZ, toZ) => {
    for (let z = fromZ + bayW / 2; z < toZ - 0.2; z += bayW) {
      if (skip && skip(faceX, z)) continue;
      B.add(faceX + sign * t / 2, y + floorH / 2, z, t, floorH, pier);
      B.add(faceX + sign * t / 2, y + floorH / 2, z - (winW + pier) / 2, t, floorH, pier);
      B.add(faceX + sign * t / 2, y + floorH / 2, z + (winW + pier) / 2, t, floorH, pier);
      B.add(faceX + sign * t / 2, y + sill / 2, z, t, sill, winW);
      B.add(faceX + sign * t / 2, y + sill + winH + above / 2, z, t, above, winW);
      const wx = faceX + sign * (t + 0.04);
      b.dark.add(wx, y + sill + 0.05, z, 0.05, 0.1, winW + 0.1);
      b.dark.add(wx, y + sill + winH - 0.05, z, 0.05, 0.1, winW + 0.1);
      for (const sz of [-1, 1]) b.dark.add(wx, y + sill + winH / 2, z + sz * (winW / 2), 0.05, winH, 0.09);
      b.glass.add(wx + sign * 0.035, y + sill + winH / 2, z, 0.03, winH, winW);
      b.stone.add(faceX + sign * (t + 0.09), y + sill - 0.06, z, 0.16, 0.12, winW + 0.3);
    }
  };
  along(z0, -1, x0, x1);
  along(z1, 1, x0, x1);
  across(x0, -1, z0, z1);
  across(x1, 1, z0, z1);
}

/** 双跑楼梯：两段各 8 级，中间平台，几何与路径点严格对应。 */
function stairCore(b, core, yFrom, floorH) {
  const { x, z } = core;
  const halfW = 1.05;
  const runZ = 2.0;
  const stepH = floorH / 16;
  for (let i = 0; i < 8; i += 1) {
    const t = (i + 0.5) / 8;
    // A 段：由南向北上行
    b.concrete.add(x + halfW, yFrom + stepH * (i + 0.5), z + runZ - t * runZ,
      halfW * 2, 0.16, runZ / 8 + 0.02);
    b.stone.add(x + halfW, yFrom + stepH * (i + 1), z + runZ - t * runZ,
      halfW * 2 - 0.06, 0.05, runZ / 8);
    // B 段：由北向南继续上行
    b.concrete.add(x - halfW, yFrom + floorH / 2 + stepH * (i + 0.5), z - runZ + t * runZ,
      halfW * 2, 0.16, runZ / 8 + 0.02);
    b.stone.add(x - halfW, yFrom + floorH / 2 + stepH * (i + 1), z - runZ + t * runZ,
      halfW * 2 - 0.06, 0.05, runZ / 8);
  }
  // 中间平台 + 扶手
  b.concrete.add(x, yFrom + floorH / 2 - 0.08, z - runZ - 0.5, halfW * 4, 0.16, 1.0);
  for (const s of [-1, 1]) {
    b.metal.add(x + s * halfW * 2, yFrom + floorH / 4 + 0.55, z, 0.06, 1.1, runZ * 2);
    b.metal.add(x - s * halfW * 2, yFrom + floorH * 0.75 + 0.55, z, 0.06, 1.1, runZ * 2);
  }
  b.metal.add(x, yFrom + 0.55, z + runZ + 0.05, halfW * 4, 1.1, 0.06);
}

/** 楼梯路径：和 stairCore 的踏步一一对应，人物不会浮在台阶上或陷进去。 */
function stairPath(core, yFrom, yTo, fromSide = 'south') {
  const { x, z } = core;
  const halfW = 1.05;
  const runZ = 2.0;
  const up = yTo > yFrom;
  const pts = [];
  const n = 6;
  // A 段
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    pts.push({
      p: new THREE.Vector3(x + halfW, yFrom + (yTo - yFrom) * 0.5 * t,
        z + (fromSide === 'south' ? runZ - t * runZ : -runZ + t * runZ)),
      kind: 'stairs',
    });
  }
  // 平台
  pts.push({ p: new THREE.Vector3(x + halfW, yFrom + (yTo - yFrom) * 0.5, z - runZ - 0.4), kind: 'stairs' });
  pts.push({ p: new THREE.Vector3(x - halfW, yFrom + (yTo - yFrom) * 0.5, z - runZ - 0.4), kind: 'stairs' });
  // B 段
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    pts.push({
      p: new THREE.Vector3(x - halfW, yFrom + (yTo - yFrom) * (0.5 + 0.5 * t),
        z - runZ + t * runZ),
      kind: 'stairs',
    });
  }
  void up;
  return pts;
}

function makeGroup(name) {
  const g = new THREE.Group();
  g.name = name;
  return g;
}

function floorVisible(group, activeFloor) {
  if (!group.userData.stories) return;
  for (const [f, node] of group.userData.stories) {
    node.visible = activeFloor === null ? true : f <= activeFloor;
  }
  if (group.userData.roof) group.userData.roof.visible = activeFloor === null;
}

/* ------------------------------------------------------------------ 诊所 */

export const CLINIC = {
  id: '48041424',
  name: '社区医疗中心（OSM 未标注用途，室内为合理重建）',
  cx: 2481.5,
  cz: -380.63,
  width: 33.68,
  depth: 23.65,
  floors: 5,
  floorH: 4.0,
  height: 20.0,
  doorX: 2481.5,
};

export function buildClinic(baseY) {
  const group = makeGroup('Clinic_Interior');
  const { cx, cz, width, depth, floors, floorH } = CLINIC;
  const x0 = cx - width / 2; const x1 = cx + width / 2;
  const z0 = cz - depth / 2; const z1 = cz + depth / 2;
  CLINIC.baseY = baseY;

  const stair = { x: x0 + 4.4, z: cz - 1.2 };
  const lift = { x: x1 - 4.2, z: cz };
  const hole = { x0: stair.x - 2.3, x1: stair.x + 2.3, z0: stair.z - 3.4, z1: stair.z + 2.4 };

  let tris = 0;
  // 站位在手术台北侧（台面 x cx+7.2..cx+9.2、z cz-6.76..cz-6.04），不能站进台里
  const start = new THREE.Vector3(cx + 8.2, baseY + floorH, cz - 7.2);
  const exit = new THREE.Vector3(cx, baseY, z1 + 2.2);
  const route = [];

  for (let f = 1; f <= floors; f += 1) {
    const y = baseY + (f - 1) * floorH;
    const story = makeGroup(`Clinic_${f}F`);
    const b = batches(story);

    slab(b, { x0, x1, z0, z1 }, y, f === 1 ? null : hole);
    // 楼层顶板（同时也是上一层的底面）
    if (f === floors) b.ceiling.add(cx, y + floorH - 0.1, cz, width, 0.2, depth);

    // 中央走廊：南北两侧各一排房间，走廊宽 2.6 m
    b.tile.add(cx, y + 0.02, cz, width - 1.0, 0.02, 2.6);
    for (let x = x0 + 3.0; x < x1 - 2.0; x += 5.2) {
      b.light.add(x, y + floorH - 0.22, cz, 1.5, 0.06, 0.5);
    }

    facade(b, { x0, x1, z0, z1 }, y, floorH, {
      mat: 'brick',
      skip: f === 1 ? (wx) => Math.abs(wx - CLINIC.doorX) < 3.0 : null,
    });

    // 房间隔墙（南北两侧），中间留走廊
    for (let x = x0 + 1.0; x < x1 - 1.0; x += 5.6) {
      b.wall.add(x, y + floorH / 2, cz - 3.1, 0.16, floorH, 3.6);
      b.wall.add(x, y + floorH / 2, cz + 3.1, 0.16, floorH, 3.6);
    }
    b.wall.add(cx, y + floorH / 2, z0 + 0.17, width, floorH, 0.16);
    b.wall.add(cx, y + floorH / 2, z1 - 0.17, width, floorH, 0.16);

    // 吊顶：没有它房间会一直“开着顶”，从任何角度都像布景
    b.ceiling.add(cx, y + floorH - 0.13, cz, width - 0.9, 0.22, depth - 0.9);
    // 踢脚线：一条 10 cm 的浅色带，房间立刻有“装修过”的感觉
    b.trim.add(cx, y + 0.09, z0 + 0.28, width - 0.8, 0.18, 0.05);
    b.trim.add(cx, y + 0.09, z1 - 0.28, width - 0.8, 0.18, 0.05);
    for (let x = x0 + 1.4; x < x1 - 1.0; x += 5.6) {
      b.trim.add(x, y + 0.09, cz - 1.42, 0.05, 0.18, 2.7);
      b.trim.add(x, y + 0.09, cz + 1.42, 0.05, 0.18, 2.7);
    }

    if (f === 1) {
      // 一层：入口、挂号台、候诊、药房
      b.glass.add(CLINIC.doorX, y + 1.35, z1, 3.4, 2.7, 0.06);
      b.dark.add(CLINIC.doorX, y + 2.78, z1 - 0.03, 3.9, 0.16, 0.14);
      b.stone.add(CLINIC.doorX, y + 3.1, z1 + 1.6, 7.0, 0.22, 3.2);
      b.stone.add(CLINIC.doorX, y + 0.13, z1 + 1.4, 7.4, 0.26, 2.8);

      b.wood.add(cx - 6.0, y + 0.55, z1 - 3.4, 5.2, 1.1, 0.9);
      b.screen.add(cx - 6.0, y + 1.2, z1 - 3.9, 0.5, 0.32, 0.05);
      for (let i = 0; i < 9; i += 1) {
        const rowZ = z1 - 6.4 - Math.floor(i / 3) * 1.4;
        const x = cx + 2.0 + (i % 3) * 1.15;
        b.fabric.add(x, y + 0.42, rowZ, 0.62, 0.1, 0.6);
        b.metal.add(x, y + 0.22, rowZ, 0.5, 0.44, 0.08);
        b.metal.add(x + 0.34, y + 0.62, rowZ, 0.07, 0.5, 0.58);
      }
      b.stone.add(cx + 10.0, y + 0.9, cz - 6.0, 6.0, 0.12, 1.2);
      for (let i = 0; i < 6; i += 1) b.white.add(cx + 8.0 + i * 0.8, y + 1.4, cz - 8.2, 0.7, 0.9, 0.35);
      b.screen.add(cx + 10.0, y + 1.9, cz - 6.6, 1.6, 0.5, 0.06);
      // 导视：科室牌 + 楼层索引 + 排队叫号屏
      b.dark.add(cx - 6.0, y + 2.5, cz - 1.52, 1.1, 0.3, 0.05);
      b.white.add(cx - 6.0, y + 2.5, cz - 1.56, 1.0, 0.2, 0.03);
      b.dark.add(cx + 3.0, y + 2.45, cz - 1.52, 1.6, 0.34, 0.05);
      b.screen.add(cx + 3.0, y + 2.45, cz - 1.56, 1.45, 0.26, 0.03);
      // 绿植与轮椅
      for (const px of [cx - 10.4, cx + 10.6]) {
        b.rust.add(px, y + 0.24, z1 - 2.0, 0.42, 0.48, 0.42);
        b.green.add(px, y + 0.86, z1 - 2.0, 0.78, 0.8, 0.78);
      }
      b.metal.add(cx + 11.5, y + 0.55, cz - 3.4, 0.6, 1.1, 0.9);
      b.dark.add(cx + 11.5, y + 0.16, cz - 3.4, 0.55, 0.3, 0.5);
    } else if (f === 2) {
      // 二层：手术室（东）、准备间、恢复区（南）
      const ox = cx + 8.2; const oz = cz - 6.4;
      b.tile.add(ox, y + 0.025, oz, 11.2, 0.02, 9.4);
      // 手术台
      b.metal.add(ox, y + 0.86, oz, 2.0, 0.16, 0.72);
      b.metal.add(ox, y + 0.44, oz, 0.35, 0.72, 0.5);
      b.white.add(ox, y + 0.98, oz, 1.9, 0.08, 0.64);
      // 无影灯
      b.metal.add(ox, y + 2.5, oz, 0.12, 1.4, 0.12);
      for (const dx of [-0.34, 0, 0.34]) {
        b.white.add(ox + dx, y + 3.05, oz, 0.3, 0.1, 0.3);
        b.light.add(ox + dx, y + 2.98, oz, 0.26, 0.05, 0.26);
      }
      // 器械台、麻醉机、监护仪
      b.metal.add(ox - 2.2, y + 0.5, oz - 1.6, 1.5, 0.9, 0.6);
      b.screen.add(ox - 2.2, y + 1.0, oz - 1.6, 0.7, 0.45, 0.05);
      b.steelBlue.add(ox + 2.4, y + 0.8, oz - 1.4, 0.65, 1.4, 0.6);
      b.screen.add(ox + 2.4, y + 1.62, oz - 1.4, 0.5, 0.34, 0.05);
      b.steelBlue.add(ox - 4.6, y + 0.45, oz + 2.4, 0.9, 0.85, 1.9);
      // 洗手池
      b.white.add(ox - 5.4, y + 0.9, oz - 3.2, 1.8, 0.2, 0.6);
      b.metal.add(ox - 5.4, y + 1.5, oz - 3.2, 0.1, 0.5, 0.1);
      // 器械柜、输液架、推床
      b.metal.add(ox + 4.6, y + 1.0, oz + 3.2, 1.2, 2.0, 0.5);
      for (const [ix, iz] of [[ox - 3.0, oz - 2.6], [ox - 3.0, oz + 1.2], [ox + 1.0, oz + 3.6]]) {
        b.metal.add(ix, y + 0.9, iz, 0.05, 1.8, 0.05);
        b.metal.add(ix, y + 1.78, iz, 0.34, 0.05, 0.05);
        b.white.add(ix + 0.16, y + 1.6, iz, 0.16, 0.28, 0.12);
      }
      b.metal.add(ox - 6.4, y + 0.55, oz + 1.0, 0.9, 0.16, 2.0);
      b.metal.add(ox - 6.4, y + 0.3, oz + 1.0, 0.7, 0.44, 1.8);

      // 墙面瓷砖带：手术室下半墙是浅色瓷砖，上半墙刷漆，这是最直观的“医院感”
      const bandH = 1.5;
      b.tile.add(ox, y + bandH / 2, oz - 4.64, 10.9, bandH, 0.07);
      b.tile.add(ox, y + bandH / 2, oz + 4.64, 10.9, bandH, 0.07);
      b.tile.add(ox - 5.44, y + bandH / 2, oz, 0.07, bandH, 9.3);
      b.tile.add(ox + 5.44, y + bandH / 2, oz, 0.07, bandH, 9.3);
      // 吊柜与层板
      b.metal.add(ox - 3.2, y + 1.95, oz - 4.5, 3.0, 0.9, 0.38);
      for (let i = 0; i < 4; i += 1) b.metal.add(ox - 4.4 + i * 0.8, y + 1.95, oz - 4.68, 0.03, 0.86, 0.05);
      b.metal.add(ox + 3.6, y + 1.95, oz - 4.5, 2.2, 0.9, 0.38);
      // 麻醉机：机身 + 两个气瓶 + 屏幕
      b.steelBlue.add(ox + 2.2, y + 0.62, oz - 2.6, 0.62, 1.24, 0.55);
      for (const dx of [-0.16, 0.16]) {
        b.metal.add(ox + 2.2 + dx, y + 0.36, oz - 2.95, 0.14, 0.72, 0.14);
      }
      b.screen.add(ox + 2.2, y + 1.4, oz - 2.75, 0.52, 0.36, 0.05);
      b.metal.add(ox + 2.2, y + 1.58, oz - 2.72, 0.05, 0.28, 0.05);
      // 器械推车（Mayo）与托盘
      b.metal.add(ox + 3.4, y + 0.95, oz - 0.6, 0.62, 0.06, 0.46);
      b.metal.add(ox + 3.4, y + 0.48, oz - 0.6, 0.05, 0.95, 0.05);
      b.metal.add(ox + 3.4, y + 0.12, oz - 0.6, 0.44, 0.05, 0.34);
      b.metal.add(ox + 3.25, y + 1.02, oz - 0.62, 0.3, 0.04, 0.2);
      // 脚踏凳、污物桶、吸引器
      b.metal.add(ox - 3.4, y + 0.14, oz + 0.9, 0.5, 0.26, 0.36);
      b.metal.add(ox - 3.4, y + 0.4, oz + 0.9, 0.34, 0.26, 0.24);
      b.red.add(ox + 4.6, y + 0.28, oz - 2.2, 0.34, 0.54, 0.34);
      b.metal.add(ox - 4.4, y + 0.55, oz + 2.0, 0.28, 1.1, 0.28);
      b.screen.add(ox - 4.4, y + 1.16, oz + 2.0, 0.22, 0.14, 0.04);
      // 墙钟与氧气终端
      b.white.add(ox + 4.9, y + 2.45, oz - 4.55, 0.42, 0.42, 0.05);
      b.dark.add(ox + 4.9, y + 2.45, oz - 4.58, 0.32, 0.32, 0.02);
      for (let i = 0; i < 3; i += 1) b.metal.add(ox - 1.6 + i * 0.5, y + 1.6, oz - 4.6, 0.18, 0.18, 0.06);
      // 顶面灯盘
      b.light.add(ox, y + 3.9, oz, 2.4, 0.06, 2.4);

      // 恢复区病床
      for (let i = 0; i < 3; i += 1) {
        const bx = cx - 10.0 + i * 3.2;
        b.white.add(bx, y + 0.62, cz + 6.6, 0.95, 0.14, 2.1);
        b.metal.add(bx, y + 0.36, cz + 6.6, 0.85, 0.5, 1.9);
        b.light.add(bx, y + 0.72, cz + 6.6, 0.8, 0.03, 1.8);
      }
    } else {
      // 三、四、五层：病房与护士站
      for (let i = 0; i < 4; i += 1) {
        const bx = x0 + 6.5 + i * 6.4;
        b.white.add(bx, y + 0.62, cz - 6.2, 0.95, 0.14, 2.1);
        b.metal.add(bx, y + 0.36, cz - 6.2, 0.85, 0.5, 1.9);
        b.wood.add(bx + 1.6, y + 0.38, cz - 6.2, 0.5, 0.72, 0.5);
        b.metal.add(bx - 1.5, y + 1.55, cz - 8.0, 0.06, 0.9, 0.06);
        b.light.add(bx - 1.5, y + 1.98, cz - 8.0, 0.22, 0.06, 0.22);
      }
      b.wood.add(cx + 6.0, y + 0.5, cz + 5.6, 4.0, 1.0, 0.8);
      b.screen.add(cx + 6.0, y + 1.15, cz + 5.2, 0.9, 0.5, 0.05);
      // 护士站背后的药品柜与白板
      b.white.add(cx + 6.0, y + 1.9, cz + 6.1, 3.6, 1.3, 0.32);
      for (let i = 0; i < 5; i += 1) b.metal.add(cx + 4.6 + i * 0.7, y + 1.9, cz + 6.0, 0.5, 1.1, 0.06);
      b.white.add(cx - 7.0, y + 1.85, cz + 1.55, 2.2, 1.1, 0.05);
      for (let i = 0; i < 3; i += 1) b.dark.add(cx - 7.6 + i * 0.7, y + 2.0, cz + 1.52, 0.5, 0.06, 0.02);
    }

    if (f > 1) {
      // 电梯厅：门是打开的，人物能真的走进去
      b.dark.add(lift.x, y + 1.15, cz + 1.35, 2.4, 2.3, 0.16);
      b.metal.add(lift.x, y + 1.15, cz + 1.5, 0.9, 2.3, 0.06);
      b.metal.add(lift.x + 1.2, y + 1.15, cz + 1.5, 0.9, 2.3, 0.06);
      b.screen.add(lift.x + 1.9, y + 1.3, cz + 1.5, 0.16, 0.4, 0.05);
    }
    if (f !== 1) stairCore(b, stair, y, floorH);

    tris += flush(b);
    group.add(story);
    group.userData.stories = group.userData.stories || new Map();
    group.userData.stories.set(f, story);
  }

  // 屋顶女儿墙
  const roof = makeGroup('Clinic_Roof');
  const br = batches(roof);
  br.concrete.add(cx, baseY + floors * floorH - 0.12, cz, width, 0.24, depth);
  for (const [dx, dz, sx, sz] of [
    [0, -depth / 2 + 0.25, width, 0.5], [0, depth / 2 - 0.25, width, 0.5],
    [-width / 2 + 0.25, 0, 0.5, depth], [width / 2 - 0.25, 0, 0.5, depth],
  ]) {
    br.plaster.add(cx + dx, baseY + floors * floorH + 0.6, cz + dz, sx, 1.2, sz);
  }
  br.metal.add(cx + 6, baseY + floors * floorH + 0.6, cz + 2, 2.2, 1.0, 1.4);
  tris += flush(br);
  group.add(roof);
  group.userData.roof = roof;

  // 入口雨棚与台阶
  const shell = makeGroup('Clinic_Entry');
  const bs = batches(shell);
  bs.stone.add(cx, baseY + 3.3, z1 + 1.8, 8.0, 0.24, 3.6);
  bs.stone.add(cx, baseY + 0.14, z1 + 1.6, 8.6, 0.28, 3.2);
  for (const s of [-1, 1]) bs.metal.add(cx + s * 3.6, baseY + 1.7, z1 + 3.3, 0.16, 3.2, 0.16);
  tris += flush(bs);
  group.add(shell);

  // 医生动线：2F 手术室 → 走廊 → 楼梯 → 1F 大堂 → 观察 → 返回 2F 恢复区
  const y2 = baseY + floorH;
  const y1 = baseY;
  const p = (x, y, z, kind, label, floor) => route.push({ p: new THREE.Vector3(x, y, z), kind, label, floor });
  p(cx + 8.2, y2, cz - 7.2, 'walk', '手术台旁', 2);
  p(cx + 8.2, y2, cz - 1.5, 'walk', '准备间', 2);
  p(cx + 8.2, y2, cz, 'walk', '二层走廊', 2);
  p(stair.x + 2.6, y2, cz, 'walk', '走向楼梯间', 2);
  p(stair.x + 1.05, y2, cz + 2.2, 'walk', '楼梯口', 2);
  for (const w of stairPath(stair, y2, y1, 'south')) {
    route.push({ p: w.p, kind: 'stairs', label: '下楼梯到一层', floor: 1 });
  }
  p(stair.x + 1.05, y1, cz + 2.4, 'walk', '一层楼梯口', 1);
  p(cx - 2.0, y1, cz + 1.0, 'walk', '一层走廊', 1);
  p(cx, y1, z1 - 2.6, 'walk', '一层大堂', 1);
  p(cx, y1, z1 + 1.2, 'walk', '走到门口看水情', 1);
  // 返回
  p(cx, y1, z1 - 2.6, 'walk', '退回大堂', 1);
  p(cx - 2.0, y1, cz + 1.0, 'walk', '回走廊', 1);
  p(stair.x + 1.05, y1, cz + 2.4, 'walk', '回到楼梯口', 1);
  for (const w of stairPath(stair, y1, y2, 'south')) {
    route.push({ p: w.p, kind: 'stairs', label: '上楼梯回二层', floor: 2 });
  }
  p(cx - 6.0, y2, cz + 6.6, 'walk', '回到恢复区', 2);

  group.userData.triCount = tris;
  return {
    group, start, exit, route, stair, lift, tris,
    setActiveFloor: (f) => floorVisible(group, f),
    setCutaway: (on) => {
      group.userData.cutaway = on;
      for (const [, node] of group.userData.stories) {
        node.traverse((o) => { if (o.isMesh && o.material === MAT.brick) o.visible = !on; });
      }
    },
  };
}

/* ------------------------------------------------------------------ 咖啡馆 */

export const CAFE = {
  id: '574897355',
  name: 'Pavilion Café（真实店铺，OSM 建筑轮廓）',
  cx: 2273.38,
  cz: -102.32,
  width: 12.87,
  depth: 38.04,
  floorH: 3.3,
  mezzY: 3.3,
  height: 5.45,
  doorZ: -84.6,
};

export function buildCafe(baseY) {
  const group = makeGroup('Cafe_Interior');
  const { cx, cz, width, depth, floorH } = CAFE;
  const x0 = cx - width / 2; const x1 = cx + width / 2;
  const z0 = cz - depth / 2; const z1 = cz + depth / 2;
  CAFE.baseY = baseY;

  let tris = 0;
  const b = batches(group);
  const y = baseY;

  b.concrete.add(cx, y - 0.09, cz, width, 0.18, depth);
  // 咖啡店地面用暖色水磨石，冷白瓷砖会让整个店像诊所
  b.terrazzo.add(cx, y + 0.015, cz + 6, width - 0.4, 0.02, 20.0);
  b.trim.add(cx, y + 0.03, cz + 6, width - 1.6, 0.012, 0.12);
  b.woodDark.add(cx, y + 0.012, cz - 10, width - 0.4, 0.02, 17.6);

  // 立面：南侧整面玻璃店面，其余砖墙开窗
  const t = 0.32;
  b.glass.add(cx - 0.6, y + 1.9, z1, width - 1.2, 2.9, 0.06);
  for (let x = x0 + 1.0; x < x1; x += 2.6) b.dark.add(x, y + 1.9, z1 - 0.04, 0.09, 2.9, 0.1);
  b.dark.add(cx, y + 3.42, z1 - 0.05, width, 0.18, 0.16);
  facade(b, { x0, x1, z0, z1 }, y, 4.4, { bayW: 3.6, winW: 2.3, winH: 1.6, sill: 1.0, mat: 'brick', skip: (wx, wz) => wz > z1 - 0.5 });

  // 吧台
  const barZ = cz + 7.0;
  b.wood.add(cx + 1.0, y + 0.52, barZ, 6.2, 1.04, 0.85);
  b.stone.add(cx + 1.0, y + 1.06, barZ, 6.3, 0.07, 0.9);
  b.metal.add(cx - 2.1, y + 0.5, barZ - 0.55, 0.5, 0.98, 0.5);
  b.metal.add(cx - 2.3, y + 1.14, barZ - 0.5, 0.55, 0.14, 0.45);
  // 咖啡机、磨豆机、收银
  b.dark.add(cx + 3.2, y + 1.32, barZ - 0.2, 0.85, 0.52, 0.55);
  b.metal.add(cx + 3.2, y + 1.14, barZ + 0.28, 0.5, 0.1, 0.2);
  b.dark.add(cx + 4.1, y + 1.3, barZ - 0.2, 0.4, 0.48, 0.4);
  b.screen.add(cx + 0.2, y + 1.2, barZ - 0.3, 0.45, 0.32, 0.06);
  // 后吧台货架与杯架
  b.wood.add(cx + 1.0, y + 2.1, cz + 9.4, 6.4, 0.09, 0.42);
  b.wood.add(cx + 1.0, y + 1.6, cz + 9.4, 6.4, 0.09, 0.42);
  for (let i = 0; i < 16; i += 1) {
    b.white.add(cx - 1.8 + (i % 8) * 0.78, y + 1.2, cz + 9.35, 0.16, 0.2, 0.16);
  }
  // 吊灯
  for (let i = 0; i < 5; i += 1) {
    b.metal.add(cx + 1.0, y + 2.9, barZ - 4.6 + i * 1.9, 0.05, 0.7, 0.05);
    b.light.add(cx + 1.0, y + 2.5, barZ - 4.6 + i * 1.9, 0.26, 0.14, 0.26);
  }

  // 座位：靠窗高脚桌、卡座、散座
  for (let i = 0; i < 5; i += 1) {
    const z = cz + 13.0 - i * 3.0;
    b.wood.add(x0 + 2.0, y + 0.76, z, 0.8, 0.06, 0.8);
    b.metal.add(x0 + 2.0, y + 0.38, z, 0.1, 0.76, 0.1);
    for (const s of [-1, 1]) {
      b.wood.add(x0 + 2.0 + s * 0.85, y + 0.46, z, 0.4, 0.06, 0.4);
      b.wood.add(x0 + 2.0 + s * 1.08, y + 0.72, z, 0.07, 0.5, 0.4);
    }
  }
  for (let i = 0; i < 3; i += 1) {
    const z = cz + 12.0 - i * 4.2;
    b.fabricRed.add(x1 - 2.2, y + 0.44, z, 1.0, 0.7, 0.9);
    b.fabricRed.add(x1 - 1.75, y + 0.78, z, 0.16, 0.6, 0.9);
    b.wood.add(x1 - 3.6, y + 0.42, z, 0.7, 0.06, 0.7);
    b.wood.add(x1 - 3.6, y + 0.21, z, 0.1, 0.42, 0.1);
  }
  // 门口立式菜单与绿植
  b.dark.add(cx - 4.4, y + 0.9, z1 - 2.0, 0.6, 1.6, 0.08);
  b.white.add(cx - 4.4, y + 1.25, z1 - 1.94, 0.46, 0.9, 0.02);
  b.rust.add(cx + 4.8, y + 0.3, z1 - 1.6, 0.5, 0.6, 0.5);
  b.green.add(cx + 4.8, y + 1.05, z1 - 1.6, 0.9, 0.9, 0.9);

  // 后厨：操作台、灶、冰箱、排烟罩
  b.stone.add(cx, y + 0.9, cz - 12.0, 8.0, 0.08, 1.1);
  b.metal.add(cx, y + 0.45, cz - 12.0, 8.0, 0.9, 1.0);
  b.metal.add(cx - 2.2, y + 1.0, cz - 12.0, 0.9, 0.12, 0.9);
  b.dark.add(cx + 1.6, y + 1.0, cz - 12.0, 1.6, 0.1, 0.8);
  b.metal.add(cx + 1.6, y + 2.35, cz - 12.0, 3.0, 0.5, 1.2);
  b.metal.add(cx - 4.6, y + 1.05, cz - 15.6, 0.9, 2.1, 0.8);
  b.metal.add(cx + 4.4, y + 1.05, cz - 15.6, 0.9, 2.1, 0.8);
  b.stone.add(cx, y + 0.9, cz - 16.4, 6.0, 0.08, 0.9);
  b.metal.add(cx, y + 0.45, cz - 16.4, 6.0, 0.9, 0.85);
  // 后门
  b.dark.add(cx, y + 1.1, z0 + 0.2, 1.1, 2.2, 0.1);

  // 前厅吊顶与筒灯：没有顶会像棚子
  b.ceiling.add(cx, y + 3.95, cz + 11.0, width - 0.6, 0.14, 14.0);
  for (let i = 0; i < 4; i += 1) {
    for (const dz of [4.0, 10.0, 15.0]) {
      b.light.add(cx - 3.0 + i * 2.0, y + 3.84, cz + dz - 2.0, 0.28, 0.06, 0.28);
    }
  }
  // 内墙饰面：砖墙只属于外立面，室内是浅色抹灰
  const tw = 0.14;
  b.wall.add(x0 + 0.2, y + 2.0, cz + 6, tw, 4.0, 20.0);
  b.wall.add(x1 - 0.2, y + 2.0, cz + 6, tw, 4.0, 20.0);
  b.wall.add(cx, y + 2.0, z1 - 0.5, width, 4.0, tw);
  // 菜单黑板与甜品柜
  b.dark.add(cx + 4.4, y + 2.2, cz + 9.3, 3.4, 1.2, 0.06);
  for (let i = 0; i < 5; i += 1) b.white.add(cx + 3.2 + (i % 2) * 1.6, y + 2.5 - Math.floor(i / 2) * 0.34, cz + 9.26, 0.9, 0.05, 0.02);
  b.glass.add(cx + 0.2, y + 1.35, barZ + 0.9, 2.2, 0.5, 0.7);
  b.metal.add(cx + 0.2, y + 1.06, barZ + 0.9, 2.2, 0.06, 0.72);
  for (let i = 0; i < 4; i += 1) b.white.add(cx - 0.6 + i * 0.55, y + 1.12, barZ + 0.9, 0.3, 0.14, 0.3);
  // 门内侧的雨伞架与外卖取餐台
  b.metal.add(cx + 4.2, y + 0.35, z1 - 1.4, 0.5, 0.7, 0.5);
  b.wood.add(cx - 3.6, y + 0.5, z1 - 2.6, 3.0, 1.0, 0.7);
  b.screen.add(cx - 3.6, y + 1.25, z1 - 2.7, 0.6, 0.4, 0.05);

  // 夹层：储藏与办公室
  const my = baseY + 3.3;
  b.concrete.add(cx, my - 0.08, cz - 10.0, width - 0.8, 0.16, 17.0);
  b.wood.add(cx, my + 0.01, cz - 10.0, width - 1.0, 0.02, 16.8);
  b.metal.add(cx, my + 0.5, cz - 18.0, width - 1.0, 1.0, 0.06);
  for (let i = 0; i < 6; i += 1) {
    b.wood.add(x0 + 2.4, my + 0.6, cz - 17.8 + i * 2.4, 1.2, 1.2, 0.8);
  }
  b.wood.add(cx + 2.0, my + 0.78, cz - 6.0, 1.6, 0.08, 0.8);
  b.wood.add(cx + 2.0, my + 0.4, cz - 6.0, 0.1, 0.76, 0.1);
  b.screen.add(cx + 2.0, my + 1.05, cz - 6.3, 0.5, 0.34, 0.05);
  // 夹层楼梯（靠东墙，从吧台后上行）
  for (let i = 0; i < 11; i += 1) {
    const st = i / 11;
    b.metal.add(x1 - 1.6, y + 0.16 + st * 3.2, cz + 3.4 - st * 3.4, 1.2, 0.12, 0.34);
  }
  b.metal.add(x1 - 1.05, y + 1.7, cz + 1.7, 0.06, 1.0, 3.6);

  tris += flush(b);

  // 屋顶
  const roof = makeGroup('Cafe_Roof');
  const br = batches(roof);
  br.concrete.add(cx, baseY + 5.3, cz, width, 0.2, depth);
  br.plaster.add(cx, baseY + 5.7, cz, width - 0.4, 0.6, depth - 0.4);
  br.metal.add(cx + 3.4, baseY + 6.2, cz - 12, 1.6, 0.9, 1.2);
  for (let i = 0; i < 4; i += 1) br.metal.add(cx - 4.0 + i * 2.4, baseY + 6.0, cz + 6, 1.0, 0.7, 0.95);
  tris += flush(br);
  group.add(roof);
  group.userData.roof = roof;

  group.add(b ? makeGroup('noop') : null);
  group.remove(group.getObjectByName('noop'));

  // 站位必须在吧台内侧（吧台 x 2271.9–2278.0、z -95.7–-94.85），不能站进台面里
  const start = new THREE.Vector3(cx + 2.6, baseY, cz + 5.3);
  const exit = new THREE.Vector3(cx - 0.6, baseY, z1 + 1.6);

  const route = [];
  const p = (x, yy, z, kind, label, floor) => route.push({ p: new THREE.Vector3(x, yy, z), kind, label, floor });
  p(cx + 2.6, baseY, cz + 5.3, 'walk', '吧台后', 1);
  p(cx + 3.9, baseY, cz + 2.4, 'walk', '关咖啡机和磨豆机', 1);
  p(cx + 4.9, baseY, cz - 3.0, 'walk', '绕出吧台', 1);
  p(cx + 2.0, baseY, cz - 9.0, 'walk', '进后厨', 1);
  p(cx, baseY, cz - 14.0, 'walk', '检查后门', 1);
  p(cx - 4.6, baseY, cz - 10.0, 'walk', '从后厨出来', 1);
  p(cx - 4.2, baseY, cz + 2.0, 'walk', '回前厅收银', 1);
  p(cx - 0.6, baseY, z1 - 1.0, 'walk', '走到门口', 1);

  group.userData.triCount = tris;
  return {
    group, start, exit, route, tris,
    setActiveFloor: () => {},
    setCutaway: () => {},
  };
}

/* ------------------------------------------------------------------ 学校 */

export const SCHOOL = {
  id: '48041308',
  name: 'Hospitality Public Charter School（真实学校，OSM 建筑轮廓）',
  cx: 2298.2,
  cz: -517.94,
  width: 20.41,
  depth: 30.73,
  floors: 8,
  floorH: 5.0,
  height: 42.83,
  doorZ: -503.2,
};

export function buildSchool(baseY) {
  const group = makeGroup('School_Interior');
  const { cx, cz, width, depth, floors, floorH } = SCHOOL;
  const x0 = cx - width / 2; const x1 = cx + width / 2;
  const z0 = cz - depth / 2; const z1 = cz + depth / 2;
  SCHOOL.baseY = baseY;

  const stair = { x: cx + 6.2, z: z0 + 5.2 };
  const hole = { x0: stair.x - 2.3, x1: stair.x + 2.3, z0: stair.z - 3.4, z1: stair.z + 2.4 };

  let tris = 0;
  for (let f = 1; f <= floors; f += 1) {
    const y = baseY + (f - 1) * floorH;
    const story = makeGroup(`School_${f}F`);
    const b = batches(story);

    slab(b, { x0, x1, z0, z1 }, y, f === 1 ? null : hole);
    b.ceiling.add(cx, y + floorH - 0.15, cz, width - 0.9, 0.24, depth - 0.9);
    b.tile.add(cx, y + 0.02, cz, 2.8, 0.02, depth - 2.0);
    // 走廊两侧的隔墙（留门洞），让教室真的是房间而不是一块大平台
    for (const side of [-1, 1]) {
      const wx = cx + side * 1.6;
      let z = z0 + 1.2;
      while (z < z1 - 1.2) {
        // 每 8 m 留 1.1 m 门洞
        const seg = Math.min(6.9, z1 - 1.2 - z);
        if (seg > 0.4) b.wall.add(wx, y + floorH / 2, z + seg / 2, 0.16, floorH, seg);
        z += seg + 1.1;
      }
      // 门套
      for (let dz = z0 + 8.1; dz < z1 - 2.0; dz += 8.0) {
        b.trim.add(wx, y + 1.05, dz + 0.55, 0.19, 2.1, 0.08);
        b.trim.add(wx, y + 1.05, dz - 0.55, 0.19, 2.1, 0.08);
      }
      // 教室之间的隔墙
      for (let dz = z0 + 8.0; dz < z1 - 2.0; dz += 8.0) {
        if (side > 0) b.wall.add((cx + 1.6 + x1) / 2, y + floorH / 2, dz, x1 - (cx + 1.6), floorH, 0.16);
        else b.wall.add((x0 + cx - 1.6) / 2, y + floorH / 2, dz, (cx - 1.6) - x0, floorH, 0.16);
      }
    }
    // 走廊储物柜（贴着走廊墙，不再落到教室里）
    for (const side of [-1, 1]) {
      for (let z = z0 + 9.4; z < z1 - 3.0; z += 1.2) {
        b.steelBlue.add(cx + side * 1.22, y + 0.6, z, 0.36, 1.2, 1.05);
        b.metal.add(cx + side * 1.03, y + 0.85, z, 0.03, 0.12, 0.3);
      }
    }
    for (let z = z0 + 3.0; z < z1 - 2.0; z += 5.4) {
      b.light.add(cx, y + floorH - 0.22, z, 0.5, 0.06, 1.4);
    }
    facade(b, { x0, x1, z0, z1 }, y, floorH, {
      bayW: 4.4, winW: 3.0, winH: 2.0, sill: 1.1, mat: 'plaster',
      skip: f === 1 ? (wx, wz) => wz > z1 - 0.5 && Math.abs(wx - cx) < 3.2 : null,
    });

    if (f === 1) {
      b.glass.add(cx, y + 1.45, z1, 3.2, 2.9, 0.06);
      b.dark.add(cx, y + 2.95, z1 - 0.04, 3.8, 0.16, 0.16);
      b.stone.add(cx, y + 3.3, z1 + 1.8, 6.4, 0.24, 3.4);
      b.wood.add(cx - 6.0, y + 0.55, z1 - 3.6, 3.6, 1.1, 0.8);
      b.screen.add(cx - 6.0, y + 1.25, z1 - 4.0, 1.4, 0.5, 0.05);
      for (let i = 0; i < 4; i += 1) b.fabric.add(cx + 2.4 + i * 1.1, y + 0.45, z1 - 4.4, 0.7, 0.5, 0.7);
    } else if (f === 3) {
      // 三年级教室：课桌成排、黑板、书架、衣帽钩
      for (let r = 0; r < 4; r += 1) {
        for (let c = 0; c < 3; c += 1) {
          const dx = x0 + 3.2 + c * 2.4;
          const dz = cz - 7.0 + r * 2.3;
          b.wood.add(dx, y + 0.62, dz, 1.2, 0.06, 0.6);
          b.metal.add(dx, y + 0.32, dz, 0.08, 0.6, 0.08);
          b.fabric.add(dx, y + 0.42, dz + 0.55, 0.5, 0.06, 0.5);
          b.metal.add(dx, y + 0.62, dz + 0.55, 0.5, 0.42, 0.06);
        }
      }
      b.dark.add(x0 + 1.4, y + 1.7, cz + 2.0, 0.1, 1.3, 6.2);
      b.wood.add(x1 - 1.2, y + 0.9, cz + 2.0, 0.5, 1.8, 5.0);
      for (let i = 0; i < 5; i += 1) b.white.add(x1 - 1.0, y + 0.6 + i * 0.32, cz - 3.6 + i * 0.5, 0.36, 0.26, 0.5);
      b.wood.add(cx - 2.0, y + 0.85, z1 - 6.4, 2.6, 0.07, 0.9);
      b.screen.add(cx - 2.0, y + 1.5, z1 - 6.6, 1.1, 0.7, 0.06);
      // 讲台、老师椅、挂钟、作品墙
      b.wood.add(x0 + 2.6, y + 0.55, cz + 2.2, 1.1, 1.1, 0.6);
      b.fabric.add(x0 + 3.6, y + 0.45, cz + 2.2, 0.5, 0.5, 0.5);
      b.white.add(x1 - 1.1, y + 2.7, cz + 2.0, 0.5, 0.5, 0.06);
      b.dark.add(x1 - 1.1, y + 2.7, cz + 1.96, 0.4, 0.4, 0.02);
      for (let i = 0; i < 6; i += 1) {
        b.white.add(x0 + 2.2 + i * 1.5, y + 1.9, cz - 1.55, 0.6, 0.75, 0.04);
        b.fabricRed.add(x0 + 2.2 + i * 1.5, y + 1.55, cz - 1.57, 0.45, 0.25, 0.02);
      }
    } else if (f === 5) {
      // 五层音乐教室：钢琴、谱架、折叠椅、地垫
      b.carpet.add(cx + 4.0, y + 0.02, cz + 2.0, 10.0, 0.02, 12.0);
      b.dark.add(cx + 5.4, y + 0.75, cz + 5.0, 1.5, 0.14, 0.9);
      b.dark.add(cx + 5.4, y + 1.1, cz + 4.55, 1.4, 0.7, 0.16);
      b.white.add(cx + 5.4, y + 0.86, cz + 4.9, 1.3, 0.06, 0.5);
      for (const dx of [-0.5, -0.15, 0.2, 0.55]) b.white.add(cx + 5.4 + dx, y + 0.8, cz + 5.0, 0.18, 0.1, 0.4);
      for (let i = 0; i < 10; i += 1) {
        const dx = cx + 1.0 + (i % 5) * 1.7;
        const dz = cz - 2.0 + Math.floor(i / 5) * 2.4;
        b.metal.add(dx, y + 0.42, dz, 0.42, 0.05, 0.42);
        b.metal.add(dx, y + 0.7, dz - 0.2, 0.42, 0.5, 0.05);
        b.metal.add(dx, y + 0.22, dz, 0.08, 0.44, 0.08);
      }
      b.wood.add(cx + 7.4, y + 1.1, cz - 4.0, 1.6, 0.5, 0.4);
    } else {
      // 其他楼层：教室 / 办公室的通用布置
      for (let i = 0; i < 3; i += 1) {
        const dx = x0 + 3.4 + i * 3.0;
        b.wood.add(dx, y + 0.62, cz - 4.0, 1.4, 0.06, 0.66);
        b.metal.add(dx, y + 0.32, cz - 4.0, 0.08, 0.6, 0.08);
        b.fabric.add(dx, y + 0.42, cz - 3.4, 0.56, 0.06, 0.5);
        b.metal.add(dx, y + 0.62, cz - 3.4, 0.56, 0.42, 0.06);
      }
      b.dark.add(x0 + 1.6, y + 1.7, cz, 0.1, 1.3, 5.0);
    }

    // 室内墙面：外立面是浅色石材，室内再贴一层浅色板，避免直接看到窗洞的黑边
    b.wall.add(x0 + 0.2, y + 2.5, cz, 0.14, 5.0, depth - 1.2);
    b.wall.add(x1 - 0.2, y + 2.5, cz, 0.14, 5.0, depth - 1.2);
    if (f > 1) stairCore(b, stair, y, floorH);
    // 楼梯间与走廊的防火门
    b.dark.add(stair.x - 2.3, y + 1.05, cz - 1.4, 0.1, 2.1, 1.2);

    tris += flush(b);
    group.add(story);
    group.userData.stories = group.userData.stories || new Map();
    group.userData.stories.set(f, story);
  }

  const roof = makeGroup('School_Roof');
  const br = batches(roof);
  br.concrete.add(cx, baseY + floors * floorH - 0.12, cz, width, 0.24, depth);
  for (const [dx, dz, sx, sz] of [
    [0, -depth / 2 + 0.25, width, 0.5], [0, depth / 2 - 0.25, width, 0.5],
    [-width / 2 + 0.25, 0, 0.5, depth], [width / 2 - 0.25, 0, 0.5, depth],
  ]) {
    br.plaster.add(cx + dx, baseY + floors * floorH + 0.7, cz + dz, sx, 1.4, sz);
  }
  br.metal.add(cx - 4, baseY + floors * floorH + 0.7, cz, 3.0, 1.2, 2.4);
  tris += flush(br);
  group.add(roof);
  group.userData.roof = roof;

  const start = new THREE.Vector3(cx - 4.6, baseY + 2 * floorH, cz + 1.0);
  const exit = new THREE.Vector3(cx, baseY, z1 + 2.0);

  const route = [];
  const p = (x, y, z, kind, label, floor) => route.push({ p: new THREE.Vector3(x, y, z), kind, label, floor });
  const y3 = baseY + 2 * floorH;
  const y5 = baseY + 4 * floorH;
  p(cx - 4.6, y3, cz + 1.0, 'walk', '三年级教室', 3);
  p(cx - 1.2, y3, cz + 0.6, 'walk', '走到教室门口', 3);
  p(cx - 0.6, y3, cz, 'walk', '三层走廊', 3);
  p(cx + 1.2, y3, z0 + 6.0, 'walk', '沿走廊向北', 3);
  p(stair.x + 1.05, y3, z0 + 5.2, 'walk', '楼梯口排队', 3);
  for (const w of stairPath(stair, y3, baseY + 3 * floorH, 'north')) {
    route.push({ p: w.p, kind: 'stairs', label: '上一层（4F）', floor: 4 });
  }
  p(stair.x + 1.05, baseY + 3 * floorH, z0 + 5.4, 'walk', '四层楼梯口', 4);
  p(stair.x + 1.05, baseY + 3 * floorH, z0 + 5.2, 'walk', '继续上楼', 4);
  for (const w of stairPath(stair, baseY + 3 * floorH, y5, 'north')) {
    route.push({ p: w.p, kind: 'stairs', label: '上一层（5F）', floor: 5 });
  }
  p(stair.x + 1.05, y5, z0 + 5.4, 'walk', '五层楼梯口', 5);
  p(cx + 0.4, y5, z0 + 5.6, 'walk', '五层走廊', 5);
  p(cx + 3.6, y5, cz + 2.0, 'walk', '进音乐教室', 5);

  group.userData.triCount = tris;
  return {
    group, start, exit, route, stair, tris,
    setActiveFloor: (f) => floorVisible(group, f),
    setCutaway: () => {},
  };
}

/* ------------------------------------------------------------------ 工地 */

export const SITE = {
  name: '10th St 在建工地（基坑作业区，依据街区空地设定）',
  cx: 2350.0,
  cz: -360.0,
  width: 26.0,
  depth: 16.0,
  wallH: 3.2,
};

export function buildSite(baseY) {
  const group = makeGroup('Construction_Site');
  const { cx, cz, width, depth, wallH } = SITE;
  SITE.baseY = baseY;
  const x0 = cx - width / 2; const x1 = cx + width / 2;
  const z0 = cz - depth / 2; const z1 = cz + depth / 2;

  const b = batches(group);
  const dirt = MAT.dirt;
  // 【别和路面同色】旧版 60×48 m 的深灰沥青场坪和新路瓦片一个颜色，
  // 又没进路网禁铺区，用户看到的就是「工地和路面重合」。改成偏土褐的
  // 临时场坪 + 收到围挡内，视觉上一眼能分出工地边界。
  const asph = new THREE.MeshStandardMaterial({ color: 0x6b5f4e, roughness: 0.98 });
  b.soil = new Batch(group, 'Site_Soil', dirt);
  b.asphalt = new Batch(group, 'Site_Apron', asph);

  // 场坪：只铺围挡内的作业区，坑内是开挖的土面（视觉上比场坪暗很多）
  const PAD_W = 34; const PAD_D = 24;
  // 地块有 1.5 m 高差：做成一块 2 m 厚的填方平台，边缘露出一圈混凝土，
  // 不能只铺一层 10 cm 沥青——那样南侧会悬空、北侧被地形顶穿。
  b.asphalt.add(cx, baseY - 0.06, cz, PAD_W, 0.12, PAD_D);
  b.concrete.add(cx, baseY - 1.05, cz, PAD_W - 0.6, 1.9, PAD_D - 0.6);
  b.soil.add(cx, baseY + 0.07, cz, width - 0.8, 0.04, depth - 0.8);

  // 工地围挡：2.4 m 高的蓝色硬质围挡绕地块一圈，南侧留大门
  const HX = PAD_W / 2; const HZ = PAD_D / 2;
  const wallH2 = 2.4;
  const hoard = (x, z, sx, sz) => {
    b.steelBlue.add(x, baseY + wallH2 / 2, z, sx, wallH2, sz);
    b.white.add(x, baseY + wallH2 - 0.08, z, sx + 0.06, 0.16, sz + 0.06);
    b.white.add(x, baseY + 0.16, z, sx + 0.06, 0.12, sz + 0.06);
  };
  hoard(cx, cz - HZ, PAD_W, 0.16);
  hoard(cx - HX, cz, 0.16, PAD_D);
  hoard(cx + HX, cz, 0.16, PAD_D);
  hoard(cx - 16, cz + HZ, PAD_W - 32, 0.16);
  hoard(cx + 16, cz + HZ, PAD_W - 32, 0.16);
  // 大门门柱与门头
  for (const sx of [-6.4, 6.4]) {
    b.metal.add(cx + sx, baseY + 1.8, cz + HZ, 0.34, 3.6, 0.34);
  }
  b.yellow.add(cx, baseY + 3.5, cz + HZ, 13.4, 0.5, 0.22);
  // 门内的人行通道与停车位标线
  for (let i = 0; i < 4; i += 1) {
    b.white.add(cx - 10 + i * 6.4, baseY + 0.1, cz + HZ - 7, 0.12, 0.02, 5.0);
  }
  // 大门外的坡道（三级台阶式，补平台与街面的高差）
  for (let i = 0; i < 4; i += 1) {
    const t = (i + 1) / 4;
    b.concrete.add(cx, baseY - 0.2 - t * 1.2, cz + HZ + 1.4 + i * 0.7, 12.6, 0.18, 1.4);
  }

  // 钢板桩围护：南侧留 12 m 出入口
  b.rust.add(cx, baseY + wallH / 2, z0 - 0.15, width + 0.6, wallH, 0.3);
  b.rust.add(cx - width / 2 - 0.15, baseY + wallH / 2, cz, 0.3, wallH, depth + 0.6);
  b.rust.add(cx + width / 2 + 0.15, baseY + wallH / 2, cz, 0.3, wallH, depth + 0.6);
  b.rust.add(cx - 9.0, baseY + wallH / 2, z1 + 0.15, width - 18.0, wallH, 0.3);
  b.rust.add(cx + 9.0, baseY + wallH / 2, z1 + 0.15, width - 18.0, wallH, 0.3);
  for (let x = x0; x <= x1; x += 1.6) {
    b.metal.add(x, baseY + wallH / 2 + 0.1, z0 - 0.32, 0.14, wallH + 0.2, 0.08);
    if (Math.abs(x - cx) > 6.4) b.metal.add(x, baseY + wallH / 2 + 0.1, z1 + 0.32, 0.14, wallH + 0.2, 0.08);
  }
  for (const z of [z0 + 0.45, z1 - 0.45]) {
    b.yellow.add(cx, baseY + 1.02, z, width, 0.07, 0.07);
    b.yellow.add(cx, baseY + 0.55, z, width, 0.07, 0.07);
    for (let x = x0 + 1; x < x1; x += 3.0) b.metal.add(x, baseY + 0.55, z, 0.06, 1.03, 0.06);
  }

  // 钢筋：成捆平放在垫木上（不是竖着插在土里）
  for (let pile = 0; pile < 3; pile += 1) {
    const px = x0 + 4.2 + pile * 1.5;
    const pz = cz - 4.0;
    for (const dz of [-1.4, 1.4]) b.wood.add(px, baseY + 0.12, pz + dz, 0.9, 0.16, 0.22);
    for (let i = 0; i < 5; i += 1) {
      b.rust.add(px, baseY + 0.22 + i * 0.05, pz, 0.055, 0.05, 7.2);
      b.rust.add(px + 0.12, baseY + 0.24 + i * 0.05, pz, 0.055, 0.05, 7.2);
    }
  }
  // 模板成摞码放
  for (let i = 0; i < 6; i += 1) {
    b.wood.add(x0 + 9.4, baseY + 0.09 + i * 0.17, cz - 4.4, 2.6, 0.15, 1.3);
  }
  // 钢管脚手架：立柱 + 横杆 + 跳板
  const sx0 = x1 - 4.2;
  for (const dz of [-2.2, 2.2]) {
    for (const dx of [0, 2.4]) {
      b.steelBlue.add(sx0 + dx, baseY + 1.9, cz + dz, 0.08, 3.8, 0.08);
    }
    b.steelBlue.add(sx0 + 1.2, baseY + 1.2, cz + dz, 2.5, 0.07, 0.07);
    b.steelBlue.add(sx0 + 1.2, baseY + 2.4, cz + dz, 2.5, 0.07, 0.07);
  }
  b.wood.add(sx0 + 1.2, baseY + 2.45, cz, 2.6, 0.06, 4.2);
  b.wood.add(sx0 + 1.2, baseY + 3.85, cz, 2.6, 0.06, 4.2);

  // 土堆（分层堆出坡度感）
  b.soil.add(x1 - 3.4, baseY + 0.35, cz + 4.2, 5.4, 0.7, 4.6);
  b.soil.add(x1 - 3.0, baseY + 0.85, cz + 4.0, 4.0, 0.6, 3.4);
  b.soil.add(x1 - 2.6, baseY + 1.25, cz + 3.8, 2.4, 0.5, 2.2);

  // 材料堆 + 盖布（盖布压在料堆上，不是悬空的布）
  b.wood.add(cx - 2.4, baseY + 0.42, z0 + 3.4, 5.4, 0.8, 3.2);
  b.wood.add(cx - 2.4, baseY + 0.96, z0 + 3.4, 4.6, 0.3, 2.6);
  b.tarp.add(cx - 2.4, baseY + 1.16, z0 + 3.4, 5.0, 0.1, 2.9);

  // 集装箱办公室（在围护区外侧）
  const bx = cx + 18.0; const bz = cz - 2.0;
  b.asphalt.add(bx, baseY + 0.05, bz, 9.0, 0.08, 6.4);
  b.steelBlue.add(bx, baseY + 1.35, bz, 6.0, 2.7, 2.5);
  b.white.add(bx, baseY + 2.74, bz, 6.2, 0.1, 2.7);
  b.dark.add(bx - 1.4, baseY + 1.5, bz + 1.28, 0.92, 2.0, 0.06);
  b.glass.add(bx + 1.2, baseY + 1.7, bz + 1.28, 1.4, 0.9, 0.05);
  b.dark.add(bx + 1.2, baseY + 1.7, bz + 1.31, 1.5, 1.0, 0.04);
  b.yellow.add(bx, baseY + 3.0, bz + 1.2, 5.4, 0.32, 0.08);
  b.asphalt.add(bx - 1.4, baseY + 0.18, bz + 1.75, 1.2, 0.36, 0.7);

  // 塔吊
  const tx = x0 + 3.0; const tz = z0 + 3.0;
  b.concrete.add(tx, baseY + 0.35, tz, 3.2, 0.7, 3.2);
  b.yellow.add(tx, baseY + 9.0, tz, 1.4, 17.0, 1.4);
  b.yellow.add(tx + 9.0, baseY + 17.0, tz, 20.0, 0.7, 0.7);
  b.concrete.add(tx - 3.0, baseY + 16.3, tz, 1.6, 1.4, 1.4);
  for (let i = 0; i < 8; i += 1) b.metal.add(tx, baseY + 2.0 + i * 2.1, tz, 1.0, 0.1, 1.0);

  // 警示牌
  b.yellow.add(cx - 9.0, baseY + 1.7, z1 - 0.95, 1.3, 0.95, 0.06);
  b.red.add(cx - 9.0, baseY + 2.3, z1 - 0.95, 1.3, 0.34, 0.06);
  b.metal.add(cx - 9.0, baseY + 0.7, z1 - 0.95, 0.08, 1.4, 0.08);

  // 散料与工具：锥桶、钢管、油桶、木板、斗车，让基坑四周不空
  for (let i = 0; i < 7; i += 1) {
    const cx2 = x0 + 3.0 + i * 3.4;
    b.red.add(cx2, baseY + 0.35, cz - 5.6, 0.34, 0.7, 0.34);
    b.white.add(cx2, baseY + 0.52, cz - 5.6, 0.36, 0.12, 0.36);
    b.dark.add(cx2, baseY + 0.08, cz - 5.6, 0.5, 0.08, 0.5);
  }
  for (let i = 0; i < 4; i += 1) {
    b.rust.add(x0 + 2.2 + i * 0.34, baseY + 0.2, cz + 6.4, 0.28, 0.28, 4.0);
  }
  for (const [dx, dz] of [[8.0, 6.0], [9.0, 6.0], [8.0, 7.0]]) {
    b.steelBlue.add(x0 + dx, baseY + 0.45, cz + dz, 0.58, 0.9, 0.58);
    b.white.add(x0 + dx, baseY + 0.9, cz + dz, 0.6, 0.05, 0.6);
  }
  for (let i = 0; i < 5; i += 1) {
    b.wood.add(x0 + 5.4, baseY + 0.08 + i * 0.12, cz + 3.2, 3.6, 0.08, 0.34);
    b.wood.add(x0 + 5.4, baseY + 0.08 + i * 0.12, cz + 3.9, 3.6, 0.08, 0.34);
  }
  b.metal.add(x0 + 12.0, baseY + 0.4, cz + 2.2, 0.9, 0.5, 0.6);
  b.dark.add(x0 + 12.4, baseY + 0.7, cz + 2.2, 0.4, 0.2, 0.5);
  b.metal.add(x0 + 11.4, baseY + 0.3, cz + 2.2, 0.1, 0.6, 0.1);
  b.rust.add(x0 + 16.0, baseY + 0.3, cz - 2.4, 1.4, 0.28, 1.0);
  b.rust.add(x0 + 16.0, baseY + 0.56, cz - 2.4, 1.1, 0.24, 0.8);

  const tris = flush(b);

  // 挖掘机：几块会旋转的网格（不放进实例化批次）
  const machine = new THREE.Group();
  machine.name = 'Site_Excavator';
  const yellow = new THREE.MeshStandardMaterial({ color: 0xd8a41c, roughness: 0.62, metalness: 0.2 });
  const track = new THREE.MeshStandardMaterial({ color: 0x26292b, roughness: 0.9 });
  const glassM = new THREE.MeshPhysicalMaterial({ color: 0x93b4c0, roughness: 0.15, transparent: true, opacity: 0.5 });
  const mx = cx + 5.0; const mz = cz + 4.6;
  for (const dz of [-1.0, 1.0]) {
    const tr = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.62, 0.6), track);
    tr.position.set(mx, baseY + 0.32, mz + dz);
    machine.add(tr);
  }
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.1, 1.9), yellow);
  body.position.set(mx, baseY + 1.15, mz);
  machine.add(body);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), yellow);
  cab.position.set(mx - 0.5, baseY + 2.2, mz + 0.3);
  machine.add(cab);
  const cabGlass = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.8, 0.9), glassM);
  cabGlass.position.set(mx - 0.5, baseY + 2.3, mz + 0.3);
  machine.add(cabGlass);
  const boom = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.34, 0.34), yellow);
  boom.position.set(mx + 1.4, baseY + 1.9, mz);
  boom.rotation.z = 0.42;
  machine.add(boom);
  const stick = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.26, 0.26), yellow);
  stick.position.set(mx + 2.9, baseY + 1.6, mz);
  stick.rotation.z = -0.75;
  machine.add(stick);
  const bucket = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.9), track);
  bucket.position.set(mx + 3.5, baseY + 0.55, mz);
  machine.add(bucket);
  machine.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  group.add(machine);

  // 作业区内的积水盘：基坑汇水，水面按时间上升
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(width - 4.0, depth - 4.0),
    new THREE.MeshPhysicalMaterial({
      color: 0x5a6b6e, roughness: 0.16, metalness: 0.08,
      transparent: true, opacity: 0.62, side: THREE.DoubleSide,
    }),
  );
  water.name = 'Site_Pit_Water';
  water.rotation.x = -Math.PI / 2;
  water.position.set(cx, baseY + 0.09, cz);
  water.visible = false;
  group.add(water);

  const start = new THREE.Vector3(cx - 3.0, baseY, cz + 2.0);
  const exit = new THREE.Vector3(cx, baseY, z1 + 3.0);

  const route = [];
  const p = (x, y, z, kind, label, floor) => route.push({ p: new THREE.Vector3(x, y, z), kind, label, floor });
  p(cx - 3.0, baseY, cz + 2.0, 'walk', '基坑底绑钢筋', 1);
  p(cx - 3.2, baseY, cz - 2.0, 'walk', '收工具', 1);
  p(cx - 6.0, baseY, cz + 4.0, 'walk', '往出入口走', 1);
  p(cx, baseY, z1 + 1.5, 'walk', '走出围护区', 1);
  p(cx, baseY, z1 + 5.0, 'walk', '场坪上', 1);
  p(bx - 1.4, baseY, z1 + 5.0, 'walk', '沿围护墙往东', 1);
  p(bx - 1.4, baseY, bz + 2.6, 'walk', '走到集装箱门口', 1);

  group.userData.triCount = tris;
  return {
    group, start, exit, route, water, tris,
    setActiveFloor: () => {},
    setCutaway: () => {},
  };
}

export { stairPath };
