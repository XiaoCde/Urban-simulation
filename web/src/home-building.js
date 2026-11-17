import * as THREE from 'three';

/**
 * 565 Penn Residences（真实公寓楼，OSM id 1207911106）的可进入室内原型。
 * 外轮廓、位置和高度来自实测建筑数据；门厅、电梯、走廊与住宅户型属于
 * 依据该楼体量做的合理重建，不是实测室内图纸。
 */
export const HOME = Object.freeze({
  id: '1207911106',
  name: '565 Penn Residences',
  cx: 2642.79,
  cz: -331.65,
  width: 81.96,
  depth: 27.5,
  height: 43.32,
  floors: 12,
  floorH: 3.55,
  homeFloor: 9,
  entryX: 2610.0,
  baseY: 6.75,
});

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

const MAT = {
  brick: new THREE.MeshStandardMaterial({ color: 0xb08a72, roughness: 0.92 }),
  plinth: new THREE.MeshStandardMaterial({ color: 0x6f6a62, roughness: 0.94 }),
  stone: new THREE.MeshStandardMaterial({ color: 0xc9c2b4, roughness: 0.86 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x9b9a94, roughness: 0.9 }),
  floor: new THREE.MeshStandardMaterial({ color: 0xb7ab97, roughness: 0.8 }),
  carpet: new THREE.MeshStandardMaterial({ color: 0x5d6b63, roughness: 0.97 }),
  wall: new THREE.MeshStandardMaterial({ color: 0xe6e0d4, roughness: 0.9 }),
  glass: new THREE.MeshPhysicalMaterial({
    color: 0x93b4c0, roughness: 0.16, metalness: 0.04,
    transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide,
  }),
  metal: new THREE.MeshStandardMaterial({ color: 0x8d9498, roughness: 0.34, metalness: 0.78 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x2a3136, roughness: 0.45, metalness: 0.5 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x9c7a55, roughness: 0.72 }),
  fabric: new THREE.MeshStandardMaterial({ color: 0x4b5a63, roughness: 0.96 }),
  screen: new THREE.MeshStandardMaterial({ color: 0x18262c, emissive: 0x2a5361, emissiveIntensity: 0.4, roughness: 0.3 }),
  light: new THREE.MeshStandardMaterial({ color: 0xf6f2e2, emissive: 0xfff2cc, emissiveIntensity: 1.4, roughness: 0.5 }),
  liftDoor: new THREE.MeshStandardMaterial({ color: 0xa8adb2, roughness: 0.28, metalness: 0.85 }),
};

class BoxBatch {
  constructor(parent, name, material, shadows = true) {
    this.parent = parent; this.name = name; this.material = material;
    this.shadows = shadows; this.matrices = [];
  }
  add(x, y, z, sx, sy, sz) {
    if (sx <= 0 || sy <= 0 || sz <= 0) return;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz),
    );
    this.matrices.push(m);
  }
  build() {
    if (!this.matrices.length) return null;
    const mesh = new THREE.InstancedMesh(UNIT_BOX, this.material, this.matrices.length);
    mesh.name = this.name;
    for (let i = 0; i < this.matrices.length; i += 1) mesh.setMatrixAt(i, this.matrices[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = this.shadows; mesh.receiveShadow = this.shadows;
    mesh.computeBoundingSphere();
    this.parent.add(mesh);
    return mesh;
  }
}

function batchSet(group) {
  const b = {};
  b.slab = new BoxBatch(group, 'Slabs', MAT.concrete);
  b.floor = new BoxBatch(group, 'Floor_Finish', MAT.floor);
  b.carpet = new BoxBatch(group, 'Corridor_Carpet', MAT.carpet);
  b.wall = new BoxBatch(group, 'Walls', MAT.wall);
  b.brick = new BoxBatch(group, 'Facade_Brick', MAT.brick);
  b.stone = new BoxBatch(group, 'Facade_Stone', MAT.stone);
  b.glass = new BoxBatch(group, 'Windows', MAT.glass, false);
  b.metal = new BoxBatch(group, 'Metal', MAT.metal);
  b.dark = new BoxBatch(group, 'Dark_Trim', MAT.dark);
  b.wood = new BoxBatch(group, 'Wood', MAT.wood);
  b.fabric = new BoxBatch(group, 'Fabric', MAT.fabric);
  b.screen = new BoxBatch(group, 'Screens', MAT.screen, false);
  b.light = new BoxBatch(group, 'Ceiling_Lights', MAT.light, false);
  b.lift = new BoxBatch(group, 'Lift_Doors', MAT.liftDoor);
  return b;
}

function buildAll(b) {
  for (const key of Object.keys(b)) b[key].build();
}

/** 每层楼板：南侧一条完整板，北侧在电梯厅和楼梯处留洞。 */
function addSlab(b, bounds, y, liftHole, stairHole) {
  const { xmin, xmax, zmin, zmax } = bounds;
  b.slab.add((xmin + xmax) / 2, y - 0.11, (zmax + zmin) / 2, xmax - xmin, 0.22, zmax - zmin);
  b.floor.add((xmin + xmax) / 2, y + 0.005, (zmax + zmin) / 2, xmax - xmin - 0.2, 0.01, zmax - zmin - 0.2);
  // 电梯井与楼梯井：用深色井道壁表示，不做成能看穿的空洞。
  for (const hole of [liftHole, stairHole]) {
    if (!hole) continue;
    b.dark.add((hole.x1 + hole.x2) / 2, y - 0.11, (hole.z1 + hole.z2) / 2, hole.x2 - hole.x1, 0.24, hole.z2 - hole.z1);
  }
}

/**
 * 立面按“开间”拼：窗间墙垛 + 窗上墙 + 窗下墙围出真正的窗洞，玻璃放在洞外表面。
 * 上一版把整面墙铺满再贴玻璃，玻璃被 0.3 m 厚的墙整个包住，所以看上去就是个盒子。
 */
function addFacade(b, bounds, y, floorH, floor, homeFloor) {
  const { xmin, xmax, zmin, zmax } = bounds;
  const t = 0.36;
  const bayW = 3.7;
  const winW = 2.35;
  const winH = 1.80;
  const sill = 1.10;
  const pierW = (bayW - winW) / 2;
  const aboveH = floorH - sill - winH;

  const bay = (cx0, faceCoord, sign, isLong) => {
    // sign: 墙面法线方向（-1 = 朝 z 负 / x 负）
    const wall = (w, h, offDown, offFace) => {
      const cy = y + offDown + h / 2;
      if (isLong) b.brick.add(cx0, cy, faceCoord + sign * offFace, w, h, t);
      else b.brick.add(faceCoord + sign * offFace, cy, cx0, t, h, w);
    };
    wall(pierW, floorH, 0, t / 2);
    // 左右各一垛
    for (const s2 of [-1, 1]) {
      const cc = cx0 + s2 * (winW + pierW) / 2;
      if (isLong) b.brick.add(cc, y + floorH / 2, faceCoord + sign * t / 2, pierW, floorH, t);
      else b.brick.add(faceCoord + sign * t / 2, y + floorH / 2, cc, t, floorH, pierW);
    }
    // 窗下墙
    if (isLong) b.brick.add(cx0, y + sill / 2, faceCoord + sign * t / 2, winW, sill, t);
    else b.brick.add(faceCoord + sign * t / 2, y + sill / 2, cx0, t, sill, winW);
    // 窗上墙
    if (isLong) b.brick.add(cx0, y + sill + winH + aboveH / 2, faceCoord + sign * t / 2, winW, aboveH, t);
    else b.brick.add(faceCoord + sign * t / 2, y + sill + winH + aboveH / 2, cx0, t, aboveH, winW);

    // 窗：深色框 + 玻璃 + 窗台石
    const wy = y + sill + winH / 2;
    const fx = faceCoord + sign * (t + 0.03);
    if (isLong) {
      b.dark.add(cx0, wy, fx, winW + 0.12, winH + 0.12, 0.06);
      b.glass.add(cx0, wy, fx + sign * 0.045, winW, winH, 0.03);
      b.stone.add(cx0, y + sill - 0.07, faceCoord + sign * (t + 0.10), winW + 0.34, 0.14, 0.18);
      b.stone.add(cx0, y + sill + winH + 0.08, faceCoord + sign * (t + 0.06), winW + 0.3, 0.1, 0.12);
    } else {
      b.dark.add(fx, wy, cx0, 0.06, winH + 0.12, winW + 0.12);
      b.glass.add(fx + sign * 0.045, wy, cx0, 0.03, winH, winW);
      b.stone.add(faceCoord + sign * (t + 0.10), y + sill - 0.07, cx0, 0.18, 0.14, winW + 0.34);
      b.stone.add(faceCoord + sign * (t + 0.06), y + sill + winH + 0.08, cx0, 0.12, 0.1, winW + 0.3);
    }
  };

  const baysX = [];
  for (let x = xmin + bayW / 2; x < xmax - 0.2; x += bayW) baysX.push(x);
  const baysZ = [];
  for (let z = zmin + bayW / 2; z < zmax - 0.2; z += bayW) baysZ.push(z);

  for (const x of baysX) {
    // 底层入口那一跨不开墙，否则玻璃门会被外墙整个封死，人物只能穿墙进楼。
    if (floor === 1 && Math.abs(x - HOME.entryX) < 2.3) {
      // 只在洞口上方补过梁
      b.brick.add(x, y + 2.95, zmin - t / 2 + 0.02, winW + 1.2, floorH - 2.9, t);
    } else {
      bay(x, zmin, -1, true);
    }
    bay(x, zmax, 1, true);
  }
  for (const z of baysZ) {
    bay(z, xmin, -1, false);
    bay(z, xmax, 1, false);
  }

  // 南侧阳台：隔一个开间挑出一个，公寓楼最常见的识别特征。
  if (floor !== 1) {
    baysX.forEach((x, i) => {
      if (i % 2 !== 0) return;
      b.slab.add(x, y + 0.02, zmax + 0.85, winW + 0.9, 0.18, 1.5);
      b.metal.add(x, y + 0.55, zmax + 1.58, winW + 0.9, 1.0, 0.06);
      for (const s2 of [-1, 1]) {
        b.metal.add(x + s2 * (winW + 0.9) / 2, y + 0.55, zmax + 0.85, 0.05, 1.0, 1.5);
      }
    });
  }

  // 楼层线（浅色石材腰线），让 12 层有节奏，不是一整块砖。
  b.stone.add((xmin + xmax) / 2, y + floorH - 0.06, zmin - 0.02, xmax - xmin, 0.16, 0.22);
  b.stone.add((xmin + xmax) / 2, y + floorH - 0.06, zmax + 0.02, xmax - xmin, 0.16, 0.22);
  b.stone.add(xmin - 0.02, y + floorH - 0.06, (zmin + zmax) / 2, 0.22, 0.16, zmax - zmin);
  b.stone.add(xmax + 0.02, y + floorH - 0.06, (zmin + zmax) / 2, 0.22, 0.16, zmax - zmin);

  // 底层：临街玻璃与入口雨棚
  if (floor === 1) {
    for (const x of baysX) {
      b.glass.add(x, y + 1.55, zmin - (t + 0.08), winW, 2.6, 0.04);
      b.dark.add(x, y + 1.55, zmin - (t + 0.05), winW + 0.14, 2.72, 0.05);
    }
    // 雨棚 + 台阶
    b.stone.add(HOME.entryX, y + 3.15, zmin - 1.55, 7.6, 0.22, 3.4);
    b.stone.add(HOME.entryX, y + 0.09, zmin - 1.2, 8.2, 0.18, 2.6);
    b.stone.add(HOME.entryX, y + 0.26, zmin - 0.55, 7.4, 0.18, 1.5);
    b.light.add(HOME.entryX, y + 3.02, zmin - 1.6, 5.4, 0.1, 0.5);
  }

  // 马克家夜里亮灯
  if (floor === homeFloor) {
    b.light.add(HOME.cx + 6.4, y + 2.62, zmax + 0.06, 5.4, 0.12, 0.2);
  }
}

function addElevatorCore(b, cx, cz, y, floorH, liftHole, doorsOpen) {
  const { x1, x2, z1, z2 } = liftHole;
  // 井道壁：四面封闭，轿厢在中间。门洞开在北侧面向电梯厅。
  b.wall.add(x1 - 0.1, y + floorH / 2, (z1 + z2) / 2, 0.2, floorH, z2 - z1);
  b.wall.add(x2 + 0.1, y + floorH / 2, (z1 + z2) / 2, 0.2, floorH, z2 - z1);
  b.wall.add((x1 + x2) / 2, y + floorH / 2, z2 + 0.1, x2 - x1 + 0.4, floorH, 0.2);
  const doorW = 1.1;
  const mid = (x1 + x2) / 2;
  if (doorsOpen) {
    b.wall.add(mid - doorW, y + floorH / 2, z1 - 0.1, (x2 - x1) - doorW * 2 + 0.2, floorH, 0.2);
  } else {
    b.lift.add(mid, y + 1.15, z1 - 0.09, doorW * 2, 2.3, 0.09);
  }
  b.dark.add(mid, y + 2.34, z1 - 0.14, doorW * 2 + 0.3, 0.13, 0.16);
  // 楼层按钮与小屏
  b.screen.add(x2 + 0.24, y + 1.42, z1 + 0.12, 0.05, 0.28, 0.42);
  // 轿厢内饰：金属壁板 + 顶部灯带 + 扶手，避免电梯里是一片灰墙。
  b.metal.add(x1 + 0.07, y + 1.2, (z1 + z2) / 2, 0.05, 2.4, z2 - z1 - 0.1);
  b.metal.add(x2 - 0.07, y + 1.2, (z1 + z2) / 2, 0.05, 2.4, z2 - z1 - 0.1);
  b.metal.add((x1 + x2) / 2, y + 1.2, z2 - 0.06, x2 - x1 - 0.1, 2.4, 0.05);
  b.light.add((x1 + x2) / 2, y + 2.38, (z1 + z2) / 2, x2 - x1 - 0.5, 0.06, 0.7);
  b.metal.add((x1 + x2) / 2, y + 0.95, z2 - 0.12, x2 - x1 - 0.3, 0.06, 0.06);
  b.dark.add((x1 + x2) / 2, y + 2.18, z2 - 0.1, 0.62, 0.22, 0.04);
}

function addCorridor(b, bounds, y, floorH, homeFloor, floor, coreX) {
  const { xmin, xmax, zmin, zmax } = bounds;
  const corridorZ2 = zmin + 4.6;
  b.carpet.add((xmin + xmax) / 2, y + 0.014, corridorZ2, xmax - xmin - 1.2, 0.02, 2.4);
  for (let x = xmin + 4; x < xmax - 3; x += 7.6) {
    b.light.add(x, y + floorH - 0.16, corridorZ2, 1.5, 0.09, 0.34);
  }
  // 南侧入户门，每 9 m 一户；9F 那户是马克家。
  let n = 0;
  for (let x = xmin + 6.0; x < xmax - 5.0; x += 9.0) {
    const isHome = floor === homeFloor && Math.abs(x - (HOME.cx - 19.0)) < 3.2;
    b.wall.add(x, y + 1.15, corridorZ2 + 1.2, 1.5, 2.3, 0.12);
    b.dark.add(x, y + 1.15, corridorZ2 + 1.14, 0.95, 2.16, 0.04);
    b.metal.add(x + 0.66, y + 1.0, corridorZ2 + 1.08, 0.05, 0.05, 0.1);
    if (isHome) {
      b.light.add(x, y + 2.42, corridorZ2 + 1.2, 1.7, 0.1, 0.12);
      b.stone.add(x, y + 1.28, corridorZ2 + 1.22, 1.0, 0.05, 0.02);
    }
    n += 1;
  }
  // 走廊端头楼梯间（真实楼梯，用于停电时步行；本场景人物走电梯）。
  const stairX = coreX + 16.0;
  b.wall.add(stairX - 2.0, y + floorH / 2, corridorZ2 + 1.2, 0.16, floorH, 2.4);
  b.wall.add(stairX + 2.0, y + floorH / 2, corridorZ2 + 1.2, 0.16, floorH, 2.4);
  for (let i = 0; i < 8; i += 1) {
    b.slab.add(stairX, y + 0.09 + i * 0.06, corridorZ2 + 1.9, 3.6, 0.18, 0.28 + i * 0.02);
  }
}

function addApartment(b, cx, y, floorH, zmin, zmax) {
  // 9F 马克家：入户门在北侧走廊，进门是玄关，往南是客厅（落地窗），东侧餐桌与厨房。
  const x0 = cx - 24.6, x1 = cx - 13.4;
  const z0 = zmin + 5.0, z1 = zmax - 0.9;
  const midX = (x0 + x1) / 2, midZ = (z0 + z1) / 2;
  b.floor.add(midX, y + 0.02, midZ, x1 - x0, 0.02, z1 - z0);
  b.carpet.add(midX - 0.4, y + 0.035, midZ + 0.6, x1 - x0 - 1.6, 0.02, z1 - z0 - 2.4);

  // 沙发靠西墙，面向东侧电视。
  b.fabric.add(x0 + 1.1, y + 0.42, midZ, 0.92, 0.72, 2.4);
  b.fabric.add(x0 + 1.1, y + 0.70, midZ - 1.2, 0.92, 0.4, 0.3);
  b.fabric.add(x0 + 1.1, y + 0.70, midZ + 1.2, 0.92, 0.4, 0.3);
  b.wood.add(x0 + 3.1, y + 0.33, midZ, 1.15, 0.06, 0.72);
  b.dark.add(x0 + 3.1, y + 0.16, midZ, 0.1, 0.32, 0.1);
  b.screen.add(x1 - 0.95, y + 1.05, midZ, 0.09, 0.86, 1.5);
  b.wood.add(x1 - 0.8, y + 0.34, midZ, 0.45, 0.62, 1.8);
  b.light.add(midX, y + floorH - 0.22, midZ + 0.4, 2.6, 0.09, 0.44);

  // 餐桌与厨房在北侧
  b.wood.add(x1 - 3.0, y + 0.74, z0 + 2.0, 1.9, 0.08, 1.3);
  for (const dx of [-0.75, 0.75]) {
    for (const dz of [-0.42, 0.42]) {
      b.dark.add(x1 - 3.0 + dx, y + 0.36, z0 + 2.0 + dz, 0.07, 0.72, 0.07);
    }
  }
  b.stone.add(x0 + 2.6, y + 0.92, z0 + 0.55, 3.4, 0.08, 0.62);
  b.wood.add(x0 + 2.6, y + 0.46, z0 + 0.55, 3.4, 0.86, 0.58);
  b.wood.add(x0 + 2.6, y + 2.05, z0 + 0.3, 3.4, 0.7, 0.34);
  b.light.add(x0 + 2.6, y + floorH - 0.22, z0 + 1.4, 1.9, 0.09, 0.36);

  // 玄关：进门鞋柜与挂衣钩
  b.wood.add(x0 + 0.9, y + 0.55, z0 + 0.35, 1.4, 1.1, 0.35);
  b.metal.add(x0 + 2.2, y + 1.65, z0 + 0.3, 0.05, 0.05, 0.12);

  // 与走廊之间的隔墙（入户门开在北墙）
  // 入户门洞：北墙分两段，中间留 1.15 m 门，人物从这里进屋而不是穿墙。
  const doorX = cx - 19.0;
  const dw = 0.62;
  const leftW = Math.max(0.2, (doorX - dw) - (x0 - 0.1));
  const rightW = Math.max(0.2, (x1 + 0.1) - (doorX + dw));
  b.wall.add((x0 - 0.1 + doorX - dw) / 2, y + 1.4, z0, leftW, 2.8, 0.12);
  b.wall.add((doorX + dw + x1 + 0.1) / 2, y + 1.4, z0, rightW, 2.8, 0.12);
  b.wall.add(doorX, y + 2.52, z0, dw * 2 + 0.2, 0.56, 0.14);
  b.dark.add(doorX, y + 1.12, z0, 1.05, 2.2, 0.06);
  b.wall.add(x0 - 0.1, y + 1.4, midZ, 0.12, 2.8, z1 - z0);
  b.wall.add(x1 + 0.1, y + 1.4, midZ, 0.12, 2.8, z1 - z0);
}

function addLobby(b, bounds, y, floorH, entryX, cx, cz) {
  const { xmin, xmax, zmin, zmax } = bounds;
  const H = floorH;
  const midZ = (zmin + zmax) / 2;
  b.floor.add((xmin + xmax) / 2, y + 0.02, midZ, xmax - xmin - 0.4, 0.02, zmax - zmin - 0.4);
  // 门厅地砖：深色石材拼边，避免一整块白地。
  b.stone.add((xmin + xmax) / 2, y + 0.028, midZ, xmax - xmin - 2.2, 0.012, zmax - zmin - 2.2);
  b.dark.add(entryX, y + 0.03, zmin + 4.6, 3.4, 0.014, 7.6);

  // 柱廊：把大开间切成有尺度感的门厅。
  for (const px of [cx - 20, cx - 8, cx + 6, cx + 20]) {
    b.stone.add(px, y + H / 2, zmin + 8.6, 0.72, H, 0.72);
    b.stone.add(px, y + H / 2, zmax - 4.2, 0.72, H, 0.72);
  }
  // 天花灯带
  for (let x = xmin + 9; x < xmax - 5; x += 8.2) {
    b.light.add(x, y + H - 0.16, midZ, 2.6, 0.1, 0.5);
    b.light.add(x, y + H - 0.16, zmin + 3.4, 1.8, 0.1, 0.42);
  }

  // 信报箱与前台
  b.wood.add(entryX - 7.2, y + 0.85, zmin + 2.6, 3.4, 1.7, 0.5);
  for (let i = 0; i < 8; i += 1) {
    b.dark.add(entryX - 8.6 + i * 0.4, y + 1.05, zmin + 2.32, 0.3, 0.3, 0.03);
  }
  b.stone.add(entryX + 2.4, y + 0.6, zmin + 3.2, 2.8, 1.2, 0.7);
  b.screen.add(entryX + 2.4, y + 1.34, zmin + 3.0, 0.5, 0.3, 0.05);

  // 靠墙的休息区
  b.fabric.add(cx + 22.0, y + 0.42, zmax - 6.4, 2.6, 0.72, 0.9);
  b.wood.add(cx + 22.0, y + 0.32, zmax - 8.0, 1.4, 0.06, 0.8);

  // 外墙内侧的浅色墙板：砖只属于室外立面，室内不该是褐色砖墙。
  const t = 0.16;
  b.wall.add(cx, y + H / 2, zmax - 0.4, xmax - xmin - 0.8, H, t);
  b.wall.add(xmin + 0.4, y + H / 2, cz, t, H, zmax - zmin - 0.8);
  b.wall.add(xmax - 0.4, y + H / 2, cz, t, H, zmax - zmin - 0.8);
  const dw = 2.7;
  b.wall.add((xmin + entryX - dw) / 2, y + H / 2, zmin + 0.4,
    Math.max(0.2, entryX - dw - xmin), H, t);
  b.wall.add((entryX + dw + xmax) / 2, y + H / 2, zmin + 0.4,
    Math.max(0.2, xmax - entryX - dw), H, t);
  b.dark.add(entryX, y + 2.32, zmin + 0.42, dw * 2 + 0.4, 0.16, 0.22);
  b.light.add(entryX, y + 1.9, zmin + 0.55, 1.9, 0.12, 0.18);

  // 吊顶 + 筒灯：没有顶的空间会像车库，不像公寓门厅。
  b.stone.add(cx, y + H - 0.07, midZ, xmax - xmin - 1.1, 0.14, zmax - zmin - 1.1);
  for (let x = xmin + 6; x < xmax - 4; x += 5.4) {
    for (const z of [zmin + 4.6, midZ, zmax - 4.6]) {
      b.light.add(x, y + H - 0.16, z, 0.5, 0.04, 0.5);
    }
  }

  // 入口双开玻璃门 + 门框 + 雨棚下的地灯
  for (const s2 of [-1, 1]) {
    b.glass.add(entryX + s2 * 0.92, y + 1.45, zmin + 0.34, 1.7, 2.8, 0.05);
    b.dark.add(entryX + s2 * 1.82, y + 1.45, zmin + 0.32, 0.1, 2.86, 0.09);
  }
  b.dark.add(entryX, y + 1.45, zmin + 0.33, 0.07, 2.8, 0.07);
  b.dark.add(entryX, y + 2.9, zmin + 0.33, 3.9, 0.14, 0.1);
  b.metal.add(entryX - 0.18, y + 1.05, zmin + 0.28, 0.05, 0.5, 0.05);

  // 前台背景墙
  b.stone.add(entryX + 2.4, y + 1.6, zmin + 0.55, 4.6, 3.2, 0.18);
  b.wood.add(entryX + 2.4, y + 1.7, zmin + 0.62, 3.6, 1.2, 0.06);

  // 电梯厅与门厅之间的一小段隔断，留出 4 m 通道。
  b.wall.add(cx + 4.6, y + H / 2, zmin + 4.0, 0.18, H, 5.0);
  b.wall.add(cx + 4.6, y + H / 2, zmin + 10.4, 0.18, H, 1.6);
  b.light.add(cx + 9.0, y + H - 0.16, cz + 2.4, 2.2, 0.1, 0.5);
  b.screen.add(cx + 9.0, y + 2.05, cz + 3.4, 1.1, 0.42, 0.05);
}

function addRoof(group, bounds, floors, floorH, baseY) {
  const { xmin, xmax, zmin, zmax } = bounds;
  const roofY = baseY + floors * floorH;
  const b = {
    slab: new BoxBatch(group, 'Roof_Slab', MAT.concrete),
    stone: new BoxBatch(group, 'Roof_Parapet', MAT.stone),
    dark: new BoxBatch(group, 'Roof_Units', MAT.dark),
  };
  b.slab.add((xmin + xmax) / 2, roofY + 0.15, (zmin + zmax) / 2, xmax - xmin, 0.3, zmax - zmin);
  b.stone.add((xmin + xmax) / 2, roofY + 0.75, zmin, xmax - xmin, 0.9, 0.26);
  b.stone.add((xmin + xmax) / 2, roofY + 0.75, zmax, xmax - xmin, 0.9, 0.26);
  b.stone.add(xmin, roofY + 0.75, (zmin + zmax) / 2, 0.26, 0.9, zmax - zmin);
  b.stone.add(xmax, roofY + 0.75, (zmin + zmax) / 2, 0.26, 0.9, zmax - zmin);
  for (const x of [xmin + 12, xmin + 34, xmin + 58]) {
    b.dark.add(x, roofY + 0.95, (zmin + zmax) / 2, 3.4, 1.0, 2.0);
  }
  buildAll(b);
}

function countTriangles(group) {
  let n = 0;
  group.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    const per = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    n += per * (o.isInstancedMesh ? o.count : 1);
  });
  return Math.round(n);
}

export function buildHomeBuilding(baseYArg = HOME.baseY) {
  const baseY = baseYArg;
  const group = new THREE.Group();
  group.name = 'HOME_565_Penn_Interior';

  const { cx, cz, width, depth, floors, floorH, homeFloor, entryX } = HOME;
  const bounds = {
    xmin: cx - width / 2, xmax: cx + width / 2,
    zmin: cz - depth / 2, zmax: cz + depth / 2,
  };
  const coreX = cx + 14;
  const liftHole = { x1: cx + 11.6, x2: cx + 14.4, z1: cz - 1.4, z2: cz + 1.6 };
  const stairHole = { x1: coreX + 14.2, x2: coreX + 17.8, z1: cz - 1.2, z2: cz + 1.6 };

  const stories = new Map();
  const exteriors = new Map();

  for (let floor = 1; floor <= floors; floor += 1) {
    const story = new THREE.Group();
    story.name = `HOME_Floor_${floor}`;
    group.add(story);
    stories.set(floor, story);
    const ext = new THREE.Group();
    ext.name = `HOME_Floor_${floor}_Exterior`;
    story.add(ext);
    exteriors.set(floor, ext);

    const b = batchSet(story);
    const y = baseY + (floor - 1) * floorH;
    addSlab(b, bounds, y, floor === 1 ? null : liftHole, floor === 1 ? null : stairHole);
    addFacade(b, bounds, y, floorH, floor, homeFloor);
    if (floor !== 1) addCorridor(b, bounds, y, floorH, homeFloor, floor, coreX);
    addElevatorCore(b, cx, cz, y, floorH, liftHole, floor === 1 || floor === homeFloor);
    if (floor === 1) addLobby(b, bounds, y, floorH, entryX, cx, cz);
    if (floor === homeFloor) addApartment(b, cx, y, floorH, bounds.zmin, bounds.zmax);
    buildAll(b);
  }

  addRoof(group, bounds, floors, floorH, baseY);

  // 台基：北侧地面比南侧高 3 m 多，基座把整栋楼垫起来，避免一半悬空一半埋土。
  const plinth = new BoxBatch(group, 'Plinth', MAT.plinth);
  plinth.add(cx, baseY - 6.0, cz, width + 0.8, 12.0, depth + 0.8);
  plinth.build();

  // 大堂入口：北面，6th Street 一侧。
  const entry = new THREE.Vector3(entryX, baseY, bounds.zmin - 1.2);
  const homeDoor = new THREE.Vector3(cx - 19.0, baseY + (homeFloor - 1) * floorH, bounds.zmin + 6.2);
  const liftY = (f) => baseY + (f - 1) * floorH;
  const route = [];
  const point = (x, y, z, kind, label, floor) => route.push({
    p: new THREE.Vector3(x, y, z), kind, label, floor,
  });

  point(entryX, baseY, bounds.zmin - 1.2, 'walk', '公寓北门外', 1);
  point(entryX, baseY, bounds.zmin + 0.4, 'walk', '进入公寓大堂', 1);
  point(entryX + 1.0, baseY, bounds.zmin + 3.4, 'walk', '穿过大堂', 1);
  // 电梯门开在北侧（z1 一侧），必须从电梯厅由北向南进轿厢，不能从南墙穿进去。
  point(cx + 8.0, baseY, bounds.zmin + 6.0, 'walk', '走向电梯厅', 1);
  point(cx + 13.0, baseY, cz - 3.2, 'walk', '进入电梯厅', 1);
  point(cx + 13.0, baseY, cz - 1.9, 'walk', '等电梯', 1);
  point(cx + 13.0, baseY, cz, 'lift', '进入电梯', 1);
  point(cx + 13.0, liftY(homeFloor), cz, 'lift', `乘电梯至${homeFloor}F`, homeFloor);
  // 电梯门在北侧，出轿厢要向北进电梯厅，再拐进走廊；原先往南走会直接穿墙。
  point(cx + 13.0, liftY(homeFloor), cz - 2.2, 'walk', `出电梯`, homeFloor);
  point(cx + 13.0, liftY(homeFloor), bounds.zmin + 4.6, 'walk', '进入9F走廊', homeFloor);
  point(cx + 4.0, liftY(homeFloor), bounds.zmin + 4.6, 'walk', '沿9F走廊向西', homeFloor);
  point(cx - 19.0, liftY(homeFloor), bounds.zmin + 4.6, 'walk', '走到自家门口', homeFloor);
  point(cx - 19.0, liftY(homeFloor), bounds.zmin + 6.6, 'walk', '到家', homeFloor);

  let activeFloor = null;
  let cutaway = false;
  const applyVisibility = () => {
    for (let floor = 1; floor <= floors; floor += 1) {
      const on = activeFloor === null
        ? (!cutaway || floor === 1)
        : floor === activeFloor || floor === activeFloor - 1;
      stories.get(floor).visible = on;
      exteriors.get(floor).visible = on && !cutaway;
    }
  };
  const setCutaway = (v) => { cutaway = Boolean(v); applyVisibility(); };
  const setActiveFloor = (f) => {
    if (f !== null && (!Number.isInteger(f) || f < 1 || f > floors)) {
      throw new RangeError(`floor must be null or 1..${floors}`);
    }
    activeFloor = f; applyVisibility();
  };

  group.userData.triCount = countTriangles(group);
  group.userData.homeId = HOME.id;
  group.userData.interiorReconstruction = true;

  return {
    group, entry, homeDoor, route, bounds, baseY, setActiveFloor, setCutaway,
    liftCab: { x: cx + 13.0, z: cz },
  };
}
