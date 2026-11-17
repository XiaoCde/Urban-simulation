import * as THREE from 'three';

/**
 * 办公楼前的露天停车场。
 *
 * 上一版马克“凭空”出现在一辆车里：出门直接上车，没有任何停车场地。这里补一小块
 * 真实停车场（沥青面 + 车位线 + 挡车墩 + 出入口），他先穿过场坪走到自己车边。
 *
 * 坐标：three.js（x 东、z 南）。车位朝向让车头朝北，倒车出位再上主路。
 */
export const PARKING = Object.freeze({
  cx: 2506.0,
  cz: 381.0,
  width: 74.0,     // 沿 x（东西）
  depth: 15.0,     // 沿 z（南北）
  stallW: 2.75,
  stallD: 5.4,
  markY: 0.06,
});

const MAT = {
  asphalt: new THREE.MeshStandardMaterial({ color: 0x43484e, roughness: 0.93 }),
  paint: new THREE.MeshStandardMaterial({ color: 0xd8d6c8, roughness: 0.8 }),
  curb: new THREE.MeshStandardMaterial({ color: 0xb3aea2, roughness: 0.9 }),
  stopper: new THREE.MeshStandardMaterial({ color: 0x8d8a80, roughness: 0.92 }),
};

function addStrip(arr, x0, z0, x1, z1, w, y) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 0.01) return;
  const nx = (-dz / len) * (w / 2);
  const nz = (dx / len) * (w / 2);
  const a = [x0 + nx, y, z0 + nz];
  const b = [x1 + nx, y, z1 + nz];
  const c = [x1 - nx, y, z1 - nz];
  const d = [x0 - nx, y, z0 - nz];
  arr.push(...a, ...b, ...c, ...a, ...c, ...d);
}

function addPlate(arr, cx, cz, w, d, y) {
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
  // 绕向必须让叉积朝 +Y，否则整块场坪会被背面剔除，只剩悬空的车位线。
  arr.push(x0, y, z0, x1, y, z1, x1, y, z0);
  arr.push(x0, y, z0, x0, y, z1, x1, y, z1);
}

export function buildParkingLot(groundAt) {
  const group = new THREE.Group();
  group.name = 'Office_Parking_Lot';
  const { cx, cz, width, depth, stallW, stallD, markY } = PARKING;

  // 场地取四角平均高度，做成一块微倾斜的板，避免与地形来回 z-fight。
  const corners = [
    [cx - width / 2, cz - depth / 2], [cx + width / 2, cz - depth / 2],
    [cx - width / 2, cz + depth / 2], [cx + width / 2, cz + depth / 2],
  ];
  const hs = corners.map(([x, z]) => groundAt(x, z));
  const yAvg = hs.reduce((a, b) => a + b, 0) / hs.length;
  const y = yAvg + 0.05;

  const asphalt = [];
  addPlate(asphalt, cx, cz, width, depth, y);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(asphalt, 3));
  g.computeVertexNormals();
  const slab = new THREE.Mesh(g, MAT.asphalt);
  slab.name = 'Parking_Surface';
  slab.receiveShadow = true;
  group.add(slab);

  // 车位：南北两排，中间留 5 m 车道
  const paint = [];
  const stalls = [];
  const cols = Math.floor((width - 4) / stallW);
  const rowNorth = cz - depth / 2 + stallD / 2 + 0.6;
  const rowSouth = cz + depth / 2 - stallD / 2 - 0.6;
  for (let i = 0; i <= cols; i += 1) {
    const x = cx - (cols * stallW) / 2 + i * stallW;
    for (const zc of [rowNorth, rowSouth]) {
      addStrip(paint, x, zc - stallD / 2, x, zc + stallD / 2, 0.12, y + markY);
    }
  }
  for (const zc of [rowNorth, rowSouth]) {
    for (let i = 0; i < cols; i += 1) {
      const x = cx - (cols * stallW) / 2 + (i + 0.5) * stallW;
      stalls.push({ x, z: zc, face: zc < cz ? -1 : 1 });
    }
  }

  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.Float32BufferAttribute(paint, 3));
  pg.computeVertexNormals();
  const lines = new THREE.Mesh(pg, MAT.paint);
  lines.name = 'Parking_Stall_Lines';
  group.add(lines);

  // 挡车墩：每个车位前端一个
  const stopGeo = new THREE.BoxGeometry(1.5, 0.14, 0.22);
  const stops = new THREE.InstancedMesh(stopGeo, MAT.stopper, stalls.length);
  const m = new THREE.Matrix4();
  stalls.forEach((s, i) => {
    m.makeTranslation(s.x, y + 0.09, s.z + (s.face < 0 ? -stallD / 2 + 0.5 : stallD / 2 - 0.5));
    stops.setMatrixAt(i, m);
  });
  stops.instanceMatrix.needsUpdate = true;
  stops.castShadow = true;
  stops.receiveShadow = true;
  group.add(stops);

  // 路缘：把场坪和草地分开
  const curb = [];
  addStrip(curb, cx - width / 2, cz - depth / 2, cx + width / 2, cz - depth / 2, 0.28, y + 0.12);
  addStrip(curb, cx - width / 2, cz + depth / 2, cx + width / 2, cz + depth / 2, 0.28, y + 0.12);
  addStrip(curb, cx - width / 2, cz - depth / 2, cx - width / 2, cz + depth / 2, 0.28, y + 0.12);
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.Float32BufferAttribute(curb, 3));
  cg.computeVertexNormals();
  group.add(new THREE.Mesh(cg, MAT.curb));

  group.userData.triCount = (asphalt.length + paint.length + curb.length) / 9 + stalls.length * 12;
  group.userData.stalls = stalls;
  group.userData.groundY = y;

  // 入口在场坪东侧，接办公楼南门方向
  const entry = new THREE.Vector3(cx + width / 2 - 2.0, y, cz + depth / 2 - 1.0);
  return { group, entry, stalls, groundY: y };
}
