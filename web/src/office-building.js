import * as THREE from 'three';

export const OFFICE = Object.freeze({
  id: '48037641',
  name: 'Federal Aviation Administration',
  cx: 2501.37,
  cz: 354.69,
  width: 131.86,
  depth: 30.10,
  baseY: 7.19,
  height: 31.13,
  floors: 6,
  floorH: 5.0,
});

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

// Materials and geometry are shared by every instance produced by this module.
const MAT = {
  stone: new THREE.MeshStandardMaterial({ color: 0xb7b0a2, roughness: 0.82 }),
  plinth: new THREE.MeshStandardMaterial({ color: 0x6f6a62, roughness: 0.94 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x8f9290, roughness: 0.9 }),
  floor: new THREE.MeshStandardMaterial({ color: 0xa9a49a, roughness: 0.76 }),
  carpet: new THREE.MeshStandardMaterial({ color: 0x59666b, roughness: 0.96 }),
  wall: new THREE.MeshStandardMaterial({ color: 0xe0ddd4, roughness: 0.88 }),
  glass: new THREE.MeshPhysicalMaterial({
    color: 0x8db0bd,
    roughness: 0.18,
    metalness: 0.05,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
    side: THREE.DoubleSide,
  }),
  metal: new THREE.MeshStandardMaterial({ color: 0x737c80, roughness: 0.38, metalness: 0.72 }),
  darkMetal: new THREE.MeshStandardMaterial({ color: 0x293238, roughness: 0.42, metalness: 0.58 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x9a7958, roughness: 0.7 }),
  fabric: new THREE.MeshStandardMaterial({ color: 0x3f555d, roughness: 0.94 }),
  screen: new THREE.MeshStandardMaterial({
    color: 0x17252d,
    emissive: 0x254b5a,
    emissiveIntensity: 0.42,
    roughness: 0.3,
  }),
  light: new THREE.MeshStandardMaterial({
    color: 0xf4f1df,
    emissive: 0xfff3cf,
    emissiveIntensity: 1.35,
    roughness: 0.5,
  }),
};

class BoxBatch {
  constructor(parent, name, material, shadows = true) {
    this.parent = parent;
    this.name = name;
    this.material = material;
    this.shadows = shadows;
    this.matrices = [];
  }

  add(x, y, z, sx, sy, sz, rotation = 0) {
    if (sx <= 0 || sy <= 0 || sz <= 0) return;
    const quaternion = typeof rotation === 'number'
      ? new THREE.Quaternion().setFromAxisAngle(Y_AXIS, rotation)
      : rotation;
    const matrix = new THREE.Matrix4();
    matrix.compose(
      new THREE.Vector3(x, y, z),
      quaternion,
      new THREE.Vector3(sx, sy, sz),
    );
    this.matrices.push(matrix);
  }

  between(a, b, thickness) {
    const direction = new THREE.Vector3().subVectors(b, a);
    const length = direction.length();
    if (length < 1e-6) return;
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      Y_AXIS,
      direction.multiplyScalar(1 / length),
    );
    const midpoint = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    this.add(midpoint.x, midpoint.y, midpoint.z, thickness, length, thickness, quaternion);
  }

  build() {
    if (this.matrices.length === 0) return null;
    const mesh = new THREE.InstancedMesh(UNIT_BOX, this.material, this.matrices.length);
    mesh.name = this.name;
    for (let i = 0; i < this.matrices.length; i += 1) {
      mesh.setMatrixAt(i, this.matrices[i]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = this.shadows;
    mesh.receiveShadow = this.shadows;
    mesh.computeBoundingSphere();
    this.parent.add(mesh);
    return mesh;
  }
}

function makeGroup(parent, name) {
  const group = new THREE.Group();
  group.name = name;
  parent.add(group);
  return group;
}

function makeBatches(story, exterior) {
  const architecture = makeGroup(story, 'Architecture');
  const interior = makeGroup(story, 'Interior');
  const batch = (parent, name, material, shadows = true) => (
    new BoxBatch(parent, name, material, shadows)
  );
  return {
    slab: batch(architecture, 'Floor_Slabs', MAT.concrete),
    floor: batch(architecture, 'Floor_Finishes', MAT.floor),
    carpet: batch(architecture, 'Corridor_Carpet', MAT.carpet),
    stone: batch(exterior, 'Stone_Facade', MAT.stone),
    glass: batch(exterior, 'Glazing', MAT.glass, false),
    trim: batch(exterior, 'Facade_Frames', MAT.darkMetal),
    wall: batch(interior, 'Partitions_And_Core', MAT.wall),
    stair: batch(interior, 'Stair_Treads_And_Landings', MAT.concrete),
    metal: batch(interior, 'Metalwork', MAT.metal),
    dark: batch(interior, 'Dark_Metalwork', MAT.darkMetal),
    wood: batch(interior, 'Desks_And_Tables', MAT.wood),
    fabric: batch(interior, 'Chairs', MAT.fabric),
    screen: batch(interior, 'Monitors', MAT.screen, false),
    light: batch(interior, 'Ceiling_Luminaires', MAT.light, false),
  };
}

function buildBatches(batches) {
  for (const batch of Object.values(batches)) batch.build();
}

function addSlabPiece(b, x1, x2, z1, z2, y) {
  if (x2 - x1 < 0.001 || z2 - z1 < 0.001) return;
  const x = (x1 + x2) * 0.5;
  const z = (z1 + z2) * 0.5;
  const width = x2 - x1;
  const depth = z2 - z1;
  b.slab.add(x, y - 0.15, z, width, 0.22, depth);
  b.floor.add(x, y - 0.02, z, width, 0.04, depth);
}

function addLongGlass(b, x1, x2, z, y) {
  if (x2 - x1 < 0.16) return;
  const x = (x1 + x2) * 0.5;
  const width = x2 - x1;
  b.glass.add(x, y + 2.60, z, width, 3.30, 0.055);
  b.trim.add(x, y + 0.96, z + 0.01, width, 0.07, 0.09);
  b.trim.add(x, y + 4.24, z + 0.01, width, 0.07, 0.09);
  if (width > 1.2) b.trim.add(x, y + 2.60, z + 0.015, 0.065, 3.30, 0.085);
}

function buildLongFacade(b, bounds, y, floor, south, entranceX) {
  const { xmin, xmax, zmin, zmax } = bounds;
  const z = south ? zmax : zmin;
  const doorHalf = 1.75;
  const isEntrance = south && floor === 1;

  if (isEntrance) {
    const leftEnd = entranceX - doorHalf;
    const rightStart = entranceX + doorHalf;
    b.stone.add((xmin + leftEnd) * 0.5, y + 0.425, z, leftEnd - xmin, 0.85, 0.24);
    b.stone.add((rightStart + xmax) * 0.5, y + 0.425, z, xmax - rightStart, 0.85, 0.24);
  } else {
    b.stone.add((xmin + xmax) * 0.5, y + 0.425, z, xmax - xmin, 0.85, 0.24);
  }
  b.stone.add((xmin + xmax) * 0.5, y + 4.675, z, xmax - xmin, 0.65, 0.24);

  const bays = 24;
  const bayWidth = (xmax - xmin) / bays;
  for (let i = 0; i <= bays; i += 1) {
    const x = xmin + i * bayWidth;
    if (!isEntrance || Math.abs(x - entranceX) > doorHalf + 0.18) {
      b.stone.add(x, y + 2.60, z, 0.30, 3.50, 0.26);
    }
  }

  for (let i = 0; i < bays; i += 1) {
    let segments = [[xmin + i * bayWidth + 0.18, xmin + (i + 1) * bayWidth - 0.18]];
    if (isEntrance) {
      const next = [];
      for (const [a, c] of segments) {
        if (c <= entranceX - doorHalf || a >= entranceX + doorHalf) {
          next.push([a, c]);
        } else {
          if (a < entranceX - doorHalf) next.push([a, entranceX - doorHalf]);
          if (c > entranceX + doorHalf) next.push([entranceX + doorHalf, c]);
        }
      }
      segments = next;
    }
    for (const [a, c] of segments) addLongGlass(b, a, c, z, y);
  }

  if (isEntrance) {
    b.stone.add(entranceX, y + 3.88, z, 3.50, 1.06, 0.26);
    b.trim.add(entranceX - 1.72, y + 1.62, z + 0.04, 0.11, 3.24, 0.16);
    b.trim.add(entranceX + 1.72, y + 1.62, z + 0.04, 0.11, 3.24, 0.16);
    b.trim.add(entranceX, y + 3.22, z + 0.04, 3.55, 0.11, 0.16);
    // Both leaves are held open, leaving a real unobstructed entrance.
    b.glass.add(entranceX - 1.46, y + 1.53, z + 0.66, 1.42, 3.02, 0.065, -0.98);
    b.glass.add(entranceX + 1.46, y + 1.53, z + 0.66, 1.42, 3.02, 0.065, 0.98);
    b.trim.add(entranceX - 1.46, y + 1.53, z + 0.66, 0.055, 3.02, 0.10, -0.98);
    b.trim.add(entranceX + 1.46, y + 1.53, z + 0.66, 0.055, 3.02, 0.10, 0.98);
    b.stone.add(entranceX, y + 3.57, z + 1.02, 5.40, 0.16, 2.20);
    b.trim.add(entranceX - 2.38, y + 1.74, z + 1.72, 0.12, 3.48, 0.12);
    b.trim.add(entranceX + 2.38, y + 1.74, z + 1.72, 0.12, 3.48, 0.12);
    b.floor.add(entranceX, y - 0.025, z + 0.32, 4.20, 0.05, 1.30);
  }
}

function buildEndFacade(b, bounds, y, east) {
  const { xmin, xmax, zmin, zmax } = bounds;
  const x = east ? xmax : xmin;
  const depth = zmax - zmin;
  b.stone.add(x, y + 0.425, (zmin + zmax) * 0.5, 0.24, 0.85, depth);
  b.stone.add(x, y + 4.675, (zmin + zmax) * 0.5, 0.24, 0.65, depth);
  const bays = 6;
  const bayWidth = depth / bays;
  for (let i = 0; i <= bays; i += 1) {
    b.stone.add(x, y + 2.60, zmin + i * bayWidth, 0.26, 3.50, 0.30);
  }
  for (let i = 0; i < bays; i += 1) {
    const z = zmin + (i + 0.5) * bayWidth;
    const width = bayWidth - 0.36;
    b.glass.add(x, y + 2.60, z, 0.055, 3.30, width);
    b.trim.add(x, y + 0.96, z, 0.09, 0.07, width);
    b.trim.add(x, y + 4.24, z, 0.09, 0.07, width);
    b.trim.add(x, y + 2.60, z, 0.085, 3.30, 0.065);
  }
}

function addWallWithDoors(b, x1, x2, z, y, doors) {
  const sorted = doors.filter((x) => x > x1 + 0.8 && x < x2 - 0.8).sort((a, c) => a - c);
  let cursor = x1;
  for (const door of sorted) {
    const left = door - 0.68;
    const right = door + 0.68;
    if (left > cursor) b.wall.add((cursor + left) * 0.5, y + 2.25, z, left - cursor, 4.50, 0.13);
    b.wall.add(door, y + 3.47, z, 1.36, 2.06, 0.13);
    b.dark.add(door - 0.68, y + 1.22, z, 0.055, 2.44, 0.17);
    b.dark.add(door + 0.68, y + 1.22, z, 0.055, 2.44, 0.17);
    b.dark.add(door, y + 2.43, z, 1.40, 0.055, 0.17);
    cursor = right;
  }
  if (cursor < x2) b.wall.add((cursor + x2) * 0.5, y + 2.25, z, x2 - cursor, 4.50, 0.13);
}

function addChair(b, x, y, z, rotation = 0) {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const part = (batch, dx, dy, dz, sx, sy, sz) => {
    batch.add(x + dx * cos + dz * sin, y + dy, z - dx * sin + dz * cos, sx, sy, sz, rotation);
  };
  part(b.fabric, 0, 0.47, 0, 0.54, 0.11, 0.54);
  part(b.fabric, 0, 0.82, 0.25, 0.54, 0.62, 0.10);
  for (const dx of [-0.21, 0.21]) {
    for (const dz of [-0.20, 0.20]) part(b.dark, dx, 0.225, dz, 0.045, 0.45, 0.045);
  }
}

function addDesk(b, x, y, z, rotation = 0) {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const part = (batch, dx, dy, dz, sx, sy, sz) => {
    batch.add(x + dx * cos + dz * sin, y + dy, z - dx * sin + dz * cos, sx, sy, sz, rotation);
  };
  part(b.wood, 0, 0.77, 0, 1.85, 0.085, 0.82);
  for (const dx of [-0.82, 0.82]) {
    for (const dz of [-0.31, 0.31]) part(b.dark, dx, 0.375, dz, 0.055, 0.75, 0.055);
  }
  part(b.dark, 0, 0.94, -0.20, 0.075, 0.30, 0.075);
  part(b.dark, 0, 0.825, -0.20, 0.32, 0.035, 0.22);
  part(b.screen, 0, 1.19, -0.20, 0.70, 0.43, 0.055);
  part(b.dark, 0, 0.832, 0.16, 0.53, 0.025, 0.17);
  part(b.dark, 0.55, 0.835, 0.17, 0.10, 0.03, 0.15);
  const chairX = x + 0.95 * sin;
  const chairZ = z + 0.95 * cos;
  addChair(b, chairX, y, chairZ, rotation);
}

function addMeetingTable(b, x, y, z) {
  b.wood.add(x, y + 0.76, z, 3.40, 0.10, 1.30);
  b.dark.add(x - 1.35, y + 0.37, z, 0.10, 0.74, 0.90);
  b.dark.add(x + 1.35, y + 0.37, z, 0.10, 0.74, 0.90);
  for (const dx of [-1.10, 0, 1.10]) {
    addChair(b, x + dx, y, z - 1.02, 0);
    addChair(b, x + dx, y, z + 1.02, Math.PI);
  }
}

function addCoreAndStairs(b, floor, coreX, cz, baseY, floorH, hole) {
  const y = baseY + (floor - 1) * floorH;
  const westWall = coreX - 4.30;
  const eastWall = coreX + 4.20;
  const sideZ = 3.02;

  // Core walls have a 2.4 m clear opening at the west corridor entrance.
  b.wall.add(coreX - 0.05, y + 2.30, cz - sideZ, 8.50, 4.60, 0.16);
  b.wall.add(coreX - 0.05, y + 2.30, cz + sideZ, 8.50, 4.60, 0.16);
  b.wall.add(eastWall, y + 2.30, cz, 0.16, 4.60, 6.20);
  b.wall.add(westWall, y + 2.30, cz - 2.12, 0.16, 4.60, 1.80);
  b.wall.add(westWall, y + 2.30, cz + 2.12, 0.16, 4.60, 1.80);
  b.wall.add(westWall, y + 3.52, cz, 0.16, 2.16, 2.44);
  b.dark.add(westWall - 0.01, y + 1.22, cz - 1.22, 0.20, 2.44, 0.06);
  b.dark.add(westWall - 0.01, y + 1.22, cz + 1.22, 0.20, 2.44, 0.06);

  // Guard rails at the exposed west edge of the opening; the doorway stays clear.
  for (const z of [cz - 2.62, cz + 2.62]) {
    b.metal.add(coreX - 2.60, y + 0.55, z, 0.07, 1.10, 0.07);
  }

  if (floor === 1) return;

  // This stair connects the floor below to this floor. It belongs to the upper
  // story so setActiveFloor(f) always retains its usable descending stair.
  const lower = y - floorH;
  const mid = lower + floorH * 0.5;
  const west = coreX - 2.40;
  const east = coreX + 2.40;
  const northZ = cz - 1.35;
  const southZ = cz + 1.35;
  const rise = 2.5 / 16;
  const tread = 4.8 / 16;
  const width = 2.4;

  for (let i = 0; i < 16; i += 1) {
    const topA = lower + (i + 1) * rise;
    const xA = west + (i + 0.5) * tread;
    const heightA = topA - (lower - 0.16);
    b.stair.add(xA, lower - 0.16 + heightA * 0.5, northZ, tread + 0.008, heightA, width);

    const topB = mid + (i + 1) * rise;
    const xB = east - (i + 0.5) * tread;
    const heightB = topB - (mid - 0.16);
    b.stair.add(xB, mid - 0.16 + heightB * 0.5, southZ, tread + 0.008, heightB, width);

    if (i % 4 === 0 || i === 15) {
      for (const z of [northZ - 1.12, northZ + 1.12]) {
        b.metal.add(xA, topA + 0.48, z, 0.055, 0.96, 0.055);
      }
      for (const z of [southZ - 1.12, southZ + 1.12]) {
        b.metal.add(xB, topB + 0.48, z, 0.055, 0.96, 0.055);
      }
    }
  }

  b.stair.add(east + 0.60, mid - 0.09, cz, 1.20, 0.18, 5.10);
  for (const z of [northZ - 1.12, northZ + 1.12]) {
    b.metal.between(
      new THREE.Vector3(west, lower + 1.0, z),
      new THREE.Vector3(east, mid + 1.0, z),
      0.065,
    );
  }
  for (const z of [southZ - 1.12, southZ + 1.12]) {
    b.metal.between(
      new THREE.Vector3(east, mid + 1.0, z),
      new THREE.Vector3(west, y + 1.0, z),
      0.065,
    );
  }

  // Half-landing edge rails and upper-floor opening protection.
  b.metal.add(east + 1.10, mid + 0.53, cz, 0.07, 1.06, 5.10);
  for (const z of [hole.z1, hole.z2]) {
    b.metal.add(coreX + 0.60, y + 0.53, z, 6.20, 0.07, 0.07);
    for (const x of [west, coreX, east + 1.10]) {
      b.metal.add(x, y + 0.53, z, 0.06, 1.06, 0.06);
    }
  }
}

function addLobby(b, cx, cz, y, entranceX, zmax) {
  // Reception is west of the entrance axis; the route to the doors stays clear.
  b.wood.add(cx + 32.5, y + 0.58, cz + 8.8, 5.20, 1.16, 0.72);
  b.wood.add(cx + 30.15, y + 0.58, cz + 7.55, 0.50, 1.16, 2.50);
  b.screen.add(cx + 32.0, y + 1.48, cz + 8.55, 0.72, 0.45, 0.06);
  b.dark.add(cx + 32.0, y + 1.16, cz + 8.55, 0.08, 0.30, 0.08);
  addChair(b, cx + 32.0, y, cz + 7.65, Math.PI);

  for (const x of [cx + 48.0, cx + 50.0, cx + 52.0]) {
    addChair(b, x, y, cz + 9.8, Math.PI);
  }
  b.wood.add(cx + 50.0, y + 0.40, cz + 11.0, 1.50, 0.08, 0.70);
  b.dark.add(cx + 50.0, y + 0.20, cz + 11.0, 0.10, 0.40, 0.10);

  b.carpet.add(entranceX, y + 0.008, (cz + zmax) * 0.5, 3.0, 0.016, zmax - cz - 0.5);
  b.light.add(entranceX, y + 4.55, cz + 8.5, 3.0, 0.10, 0.55);
  b.light.add(cx + 50.0, y + 4.55, cz + 10.0, 2.2, 0.10, 0.55);
}

function addInterior(floor, b, office, bounds, coreX, entranceX, hole) {
  const { cx, cz, baseY, floorH } = office;
  const { xmin, xmax, zmin, zmax } = bounds;
  const y = baseY + (floor - 1) * floorH;
  const corridorEnd = floor === 1 ? cx + 25 : coreX - 4.35;
  const roomPitch = 11;
  const roomCenters = [];
  for (let x = xmin + 6.2; x < corridorEnd - 2.0; x += roomPitch) roomCenters.push(x);

  b.carpet.add((xmin + 0.45 + coreX - 4.35) * 0.5, y + 0.008, cz,
    coreX - 4.35 - xmin - 0.45, 0.016, 3.20);

  addWallWithDoors(b, xmin + 0.35, corridorEnd, cz + 1.80, y, roomCenters);
  if (floor !== 6) addWallWithDoors(b, xmin + 0.35, corridorEnd, cz - 1.80, y, roomCenters);

  if (floor !== 6) {
    for (let x = xmin + 0.70; x < corridorEnd; x += roomPitch) {
      b.wall.add(x, y + 2.25, (zmin + cz - 1.80) * 0.5,
        0.13, 4.50, cz - 1.80 - zmin);
      b.wall.add(x, y + 2.25, (cz + 1.80 + zmax) * 0.5,
        0.13, 4.50, zmax - cz - 1.80);
    }
  }

  addCoreAndStairs(b, floor, coreX, cz, baseY, floorH, hole);

  for (let x = xmin + 5; x < coreX - 5; x += 9.5) {
    b.light.add(x, y + 4.55, cz, 1.90, 0.10, 0.42);
  }
  for (const x of roomCenters) {
    b.light.add(x, y + 4.55, cz + 7.6, 1.70, 0.10, 0.45);
    if (floor !== 6) b.light.add(x, y + 4.55, cz - 7.6, 1.70, 0.10, 0.45);
  }

  if (floor === 6) {
    // Open-plan north office. One grid position is the avatar's start desk.
    for (let i = 0; i < 11; i += 1) {
      const x = cx - 48 + i * 9;
      addDesk(b, x, y, cz - 10.0);
      addDesk(b, x, y, cz - 5.7);
      b.light.add(x, y + 4.55, cz - 7.85, 2.20, 0.10, 0.48);
    }
    for (let i = 0; i < roomCenters.length; i += 2) {
      addMeetingTable(b, roomCenters[i], y, cz + 7.5);
    }
    // Low storage defines the open office without blocking the exit route.
    for (const x of [cx - 44, cx - 17, cx + 10, cx + 37]) {
      b.wood.add(x, y + 0.48, cz - 13.35, 2.40, 0.96, 0.48);
      b.dark.add(x, y + 0.49, cz - 13.10, 0.04, 0.70, 0.025);
    }
  } else if (floor > 1) {
    for (const x of roomCenters) {
      addDesk(b, x, y, cz + 8.0, Math.PI);
      addDesk(b, x, y, cz - 8.0);
    }
  } else {
    for (const x of roomCenters) {
      addDesk(b, x, y, cz + 8.0, Math.PI);
      addDesk(b, x, y, cz - 8.0);
    }
    addLobby(b, cx, cz, y, entranceX, zmax);
  }
}

function addRoof(group, bounds, office) {
  const b = {
    slab: new BoxBatch(group, 'Roof_Slab', MAT.concrete),
    stone: new BoxBatch(group, 'Roof_Parapet', MAT.stone),
    dark: new BoxBatch(group, 'Roof_Equipment', MAT.darkMetal),
  };
  const { xmin, xmax, zmin, zmax } = bounds;
  const { cx, cz, width, depth, baseY, floors, floorH, height } = office;
  const roofY = baseY + floors * floorH;
  b.slab.add(cx, roofY + 0.14, cz, width, 0.28, depth);
  const parapetY = roofY + 0.28 + (height - floors * floorH - 0.28) * 0.5;
  const parapetH = height - floors * floorH - 0.28;
  b.stone.add(cx, parapetY, zmin, width, parapetH, 0.24);
  b.stone.add(cx, parapetY, zmax, width, parapetH, 0.24);
  b.stone.add(xmin, parapetY, cz, 0.24, parapetH, depth);
  b.stone.add(xmax, parapetY, cz, 0.24, parapetH, depth);
  // Small, plausible rooftop ventilation curbs rather than oversized equipment.
  for (const x of [cx - 31, cx - 10, cx + 12]) {
    b.dark.add(x, roofY + 0.65, cz, 3.20, 0.75, 1.80);
    b.slab.add(x, roofY + 1.06, cz, 3.35, 0.08, 1.95);
  }
  buildBatches(b);
}

function countTriangles(group) {
  let triangles = 0;
  group.traverse((object) => {
    if (!object.isMesh) return;
    const geometry = object.geometry;
    const perMesh = geometry.index
      ? geometry.index.count / 3
      : geometry.attributes.position.count / 3;
    triangles += perMesh * (object.isInstancedMesh ? object.count : 1);
  });
  return Math.round(triangles);
}

export function buildOfficeBuilding() {
  const group = new THREE.Group();
  group.name = 'FAA_Office_Interior';

  const { cx, cz, width, depth, baseY, floors, floorH } = OFFICE;
  const bounds = {
    xmin: cx - width * 0.5,
    xmax: cx + width * 0.5,
    zmin: cz - depth * 0.5,
    zmax: cz + depth * 0.5,
  };
  const coreX = cx + 49;
  const entranceX = cx + 43;
  const hole = {
    x1: coreX - 2.55,
    x2: coreX + 3.75,
    z1: cz - 2.70,
    z2: cz + 2.70,
  };

  const stories = new Map();
  const exteriors = new Map();

  for (let floor = 1; floor <= floors; floor += 1) {
    const story = makeGroup(group, `Floor_${floor}`);
    const exterior = makeGroup(story, `Floor_${floor}_Exterior`);
    story.userData.floor = floor;
    stories.set(floor, story);
    exteriors.set(floor, exterior);
    const b = makeBatches(story, exterior);
    const y = baseY + (floor - 1) * floorH;

    if (floor === 1) {
      addSlabPiece(b, bounds.xmin, bounds.xmax, bounds.zmin, bounds.zmax, y);
    } else {
      // Four disjoint pieces leave an actual stairwell opening in every slab.
      addSlabPiece(b, bounds.xmin, hole.x1, bounds.zmin, bounds.zmax, y);
      addSlabPiece(b, hole.x2, bounds.xmax, bounds.zmin, bounds.zmax, y);
      addSlabPiece(b, hole.x1, hole.x2, bounds.zmin, hole.z1, y);
      addSlabPiece(b, hole.x1, hole.x2, hole.z2, bounds.zmax, y);
    }

    buildLongFacade(b, bounds, y, floor, false, entranceX);
    buildLongFacade(b, bounds, y, floor, true, entranceX);
    buildEndFacade(b, bounds, y, false);
    buildEndFacade(b, bounds, y, true);
    addInterior(floor, b, OFFICE, bounds, coreX, entranceX, hole);
    buildBatches(b);
  }

  const roof = makeGroup(group, 'Roof');
  addRoof(roof, bounds, OFFICE);

  // 台基：实测地形在 footprint 内有起伏，不补一圈实心基座，楼底会悬空或埋进土里。
  const plinth = new BoxBatch(group, 'Plinth', MAT.plinth);
  plinth.add(cx, baseY - 5.0, cz, width + 0.7, 10.0, depth + 0.7);
  plinth.build();

  const floor6Y = baseY + 5 * floorH;
  const startDeskX = cx - 39;
  // 起点就是他自己的椅子（桌面在 cz-10.0，椅子在 cz-9.05，面朝北侧桌子）。
  const start = new THREE.Vector3(startDeskX, floor6Y, cz - 9.05);
  const exit = new THREE.Vector3(entranceX, baseY, bounds.zmax + 2.0);
  const indoorRoute = [];
  const point = (x, y, z, kind, label, floor) => {
    indoorRoute.push({ p: new THREE.Vector3(x, y, z), kind, label, floor });
  };

  point(start.x, start.y, start.z, 'walk', '6F 工位（坐在椅子上）', 6);
  point(startDeskX, floor6Y, cz - 8.05, 'walk', '起身离开座位', 6);
  point(startDeskX + 1.30, floor6Y, cz - 6.6, 'walk', '绕出工位', 6);
  point(startDeskX + 1.30, floor6Y, cz - 3.0, 'walk', '前往6F走廊', 6);
  point(startDeskX + 1.30, floor6Y, cz, 'walk', '进入6F走廊', 6);
  point(coreX - 6.0, floor6Y, cz, 'walk', '沿走廊向东端楼梯', 6);
  point(coreX - 3.55, floor6Y, cz, 'walk', '进入6F楼梯前室', 6);

  const west = coreX - 2.40;
  const east = coreX + 2.40;
  const northZ = cz - 1.35;
  const southZ = cz + 1.35;
  const rise = 2.5 / 16;
  const tread = 4.8 / 16;

  for (let floor = 6; floor >= 2; floor -= 1) {
    const upper = baseY + (floor - 1) * floorH;
    const lower = upper - floorH;
    const mid = lower + 2.5;
    const label = `${floor}F至${floor - 1}F`;

    point(coreX - 3.10, upper, southZ, 'walk', `${label} 南跑入口`, floor);
    point(west, upper, southZ, 'walk', `${label} 第二跑上端`, floor);
    for (let i = 15; i >= 0; i -= 1) {
      point(
        east - (i + 0.5) * tread,
        mid + (i + 1) * rise,
        southZ,
        'stairs',
        `${label} 第二跑 ${16 - i}/16级`,
        floor,
      );
    }
    point(east + 0.60, mid, southZ, 'stairs', `${label} 半层平台`, floor);
    point(east + 0.60, mid, northZ, 'stairs', `${label} 半层转身`, floor);
    point(east, mid, northZ, 'stairs', `${label} 第一跑上端`, floor);
    for (let i = 15; i >= 0; i -= 1) {
      point(
        west + (i + 0.5) * tread,
        lower + (i + 1) * rise,
        northZ,
        'stairs',
        `${label} 第一跑 ${16 - i}/16级`,
        floor,
      );
    }
    point(west - 0.55, lower, northZ, 'walk', `${floor - 1}F 楼梯出口`, floor - 1);
    point(coreX - 3.55, lower, cz, 'walk', `${floor - 1}F 楼梯前室`, floor - 1);
  }

  point(entranceX, baseY, cz, 'walk', '1F 大堂入口轴', 1);
  point(entranceX, baseY, cz + 6.5, 'walk', '穿过大堂', 1);
  point(entranceX, baseY, bounds.zmax - 0.8, 'walk', '前往南主入口', 1);
  point(entranceX, baseY, bounds.zmax + 0.8, 'walk', '通过敞开的南主入口', 1);
  point(exit.x, exit.y, exit.z, 'walk', '南主入口外2米', 1);

  let cutaway = false;
  let activeFloor = null;
  /**
   * 剖切时把外壳变成「半透明玻璃盒子」，而不是直接 hidden。
   *
   * 【为什么改】旧版 `roof.visible = activeFloor===null && !cutaway`、
   * 外立面也只在没剖切时显示。于是跟着马克进 6F 的时候，整栋楼的外墙和屋顶
   * 全消失，从街上抬头看就是「一栋没有顶、没有墙的楼骨架」——用户 2026-11-06
   * 的原话「马克周围这些办公楼顶好像没封上」，说的就是这个。
   *
   * 现在外壳始终在，只是 opacity 0.16：里面的人照样看得清，楼又是完整的。
   * 材质按 mesh 缓存两份（实心 / 幽灵），来回切只换引用，不重建材质。
   */
  const ghostize = (g, on) => {
    g.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.userData._solidMat) {
        o.userData._solidMat = o.material;
        const gm = o.material.clone();
        gm.transparent = true;
        gm.opacity = 0.16;
        gm.depthWrite = false;
        gm.side = THREE.DoubleSide;
        o.userData._ghostMat = gm;
      }
      o.material = on ? o.userData._ghostMat : o.userData._solidMat;
      o.renderOrder = on ? 3 : 0;
    });
  };

  const applyVisibility = () => {
    for (let floor = 1; floor <= floors; floor += 1) {
      // 跟随室内时保留当前层及其以下各层，否则站在楼梯口往下看会是一片虚空。
      const storyVisible = activeFloor === null
        ? (!cutaway || floor === 1)
        : floor <= activeFloor;
      stories.get(floor).visible = storyVisible;
      // 外立面永远在（剖切时转为半透明），只有「非当前层且未剖切」才藏
      const ext = exteriors.get(floor);
      ext.visible = activeFloor === null ? !cutaway : floor === activeFloor || cutaway;
      ghostize(ext, cutaway);
    }
    // 屋顶永远保留：从外面看必须是封顶的楼
    roof.visible = true;
    ghostize(roof, cutaway);
  };

  const setCutaway = (enabled) => {
    cutaway = Boolean(enabled);
    applyVisibility();
  };

  const setActiveFloor = (floor) => {
    if (floor !== null && (!Number.isInteger(floor) || floor < 1 || floor > floors)) {
      throw new RangeError(`floor must be null or an integer from 1 to ${floors}`);
    }
    activeFloor = floor;
    applyVisibility();
  };

  group.userData.triCount = countTriangles(group);
  group.userData.officeId = OFFICE.id;
  group.userData.interiorReconstruction = true;

  return { group, start, exit, indoorRoute, setCutaway, setActiveFloor };
}
