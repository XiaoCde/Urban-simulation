/**
 * megakit.js — 用 Quaternius「Downtown City MegaKit」(CC0) 的构件参数化拼楼
 *
 * 为什么不用现成的整楼模型：MegaKit 只有 3 个整楼（Small_1 / Medium_2 / Large_2），
 * 全城换成同一个模子比现在更假。它真正值钱的是**可拼接的构件**——2 m 宽 × 3 m 高的
 * 墙段、带窗墙段、转角、檐口、2×2 / 4×4 的屋顶块。按 footprint 拼，才能既有细节
 * 又各不相同。
 *
 * 拼装规则（实测构件尺寸得出的，别乱改）：
 *   开间 2 m（`Brick_Plain_3` 宽 2 m）× 层高 3 m（高 3 m）
 *   沿 footprint 每条边按 2 m 分节，每 7 节开一个 2 m 宽的窗（`Brick_Window_Square_Single`）
 *   转角放 `Brick_90Angle_L/R`
 *   顶部一圈 `Cornice_Trim_Center`（2×1 m，每 4 节一段）
 *   屋顶两种：约 40% 走代码生成的坡顶（石板材质），其余平顶 + 女儿墙
 *
 * 多样性的来源（重要）：MegaKit 全包只有**一套红砖贴图**，照原样铺开整座城就是
 * 一大片同色仓库区。三层变化叠起来才像城市：
 *   ① 外墙材质组：砖 / 水泥 / 米白涂料（换 map + normal + ORM）
 *   ② 每栋楼一个 instanceColor，明度 ±35%、冷暖微偏
 *   ③ 屋顶形态（坡顶 / 平顶女儿墙）、窗密度、层高微调按楼随机
 *
 * 性能设计：不是每栋楼建一个 Group（21,943 栋 = 十几万 draw call），
 * 而是**先把所有实例矩阵收集到一个 sink 里**，最后每「构件 × 材质组」建一个 InstancedMesh。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { WINDOW_NIGHT, WINDOW_RATIO, WINDOW_COLOR } from './light-grid.js';

const PARTS = [
  'Brick_Plain_3',
  'Brick_Window_Square_Single',
  'Brick_90Angle_L',
  'Brick_90Angle_R',
  'Cornice_Trim_Center',
  'Cornice_Trim_L',
  'Cornice_Trim_R',
  'Roof_4x4',
  'Roof_2x2',
  'Roof_Slate_Center',
  // 可进入必需：门框 + 门扇 + 门口台阶
  'DoorFrame_Trim',
  'Door_2',
  'Door_1',
  'Entrance_Concrete_2x1',
];

// 构件基础尺寸（米），来自实测 gltf 包围盒
export const PART_SIZE = {
  Brick_Plain_3: [2, 3, 0.2],
  Brick_Window_Square_Single: [2, 3, 0.27],
  Brick_90Angle_L: [0.71, 3, 0.7],
  Brick_90Angle_R: [0.71, 3, 0.7],
  Cornice_Trim_Center: [2, 1, 0.63],
  Cornice_Trim_L: [2, 1, 0.63],
  Cornice_Trim_R: [2, 1, 0.63],
  Roof_4x4: [4, 0.06, 4],
  Roof_2x2: [2, 0.06, 2],
  Roof_Slate_Center: [2, 3, 2],
};

const FLOOR_H = 3.0;      // 构件层高
const BAY = 2.0;          // 开间
const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(1, 1, 1);

// 室内构件共用一份单位立方体，靠实例缩放成不同尺寸（全城只有一份 geometry）
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

// 墙体用单位立方体缩放成实心墙段。
// 【为什么不直接摆 MegaKit 的墙段】`Brick_Plain_3` 是 4 顶点的**单面片**（厚度 0）：
// 独立摆放时每段之间必然露缝、从侧面看是一张纸、转角处还能透过去看到楼里 ——
// 用户原话「墙面都是胡弄的」就是这个。改成实心盒子：连续、有厚度、转角自然，
// 而且 wall 面用 0-1 的 UV 正好对上一张 2×3 m 的砖贴图，纹理不会被拉伸。
let WALL_TEX = null;      // 砖墙+窗的贴图（全城共用一张）

const WALL_BOX = (() => {
  const g = new THREE.BoxGeometry(1, 1, 1);
  // 【必须有顶点色】MegaKit 的构件自带 COLOR_0，GLTFLoader 于是把材质的
  // `vertexColors` 打开。换成自己 new 的 Box 时没有 COLOR_0，着色器读到默认
  // (0,0,0) —— 整面墙全黑。补一份全白的顶点色即可。
  const n = g.attributes.position.count;
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));

  return g;
})();

/**
 * 四坡屋顶的几何：底面 1×1、高 1 的四棱台（`CylinderGeometry` 用 4 条边就是棱台）。
 *
 * 【为什么不用代码逐栋三角化】第一版是逐栋算三角形 Mesh，结果 21 栋坡顶一个都看不见
 * （侧面法线水平，绕向修正判不出来，被剔了），而且每栋一份 geometry，21 个 draw call。
 * 改用 4 边圆柱当棱台：几何只有一份，实例缩放适配长宽，一个 draw call 全画完。
 */
const HIP_GEO = (() => {
  const g = new THREE.CylinderGeometry(0.34, Math.SQRT2 * 0.5, 1, 4, 1);
  g.rotateY(Math.PI / 4);
  g.translate(0, 0.5, 0);        // 底面落到 y = 0，位置直接给屋面高程
  return g;
})();

/**
 * 室内材质。
 *
 * 【为什么要给天花加 emissive】楼是空壳，门厅里没有任何光源，从街上往里看是
 * 一个黑洞。真给每栋楼加一盏 PointLight 是 150 个光源，渲染器直接崩；
 * 用微自发光的天花板把室内"点亮"，成本为零，远看就是有人在里面开了灯。
 */
const MATS = {
  floor: new THREE.MeshStandardMaterial({ color: 0x8b8882, roughness: 0.93 }),
  wall: new THREE.MeshStandardMaterial({ color: 0xd8d3c8, roughness: 0.9 }),
  ceil: new THREE.MeshStandardMaterial({
    color: 0xf2eee4, roughness: 0.95,
    emissive: 0x3a3428, emissiveIntensity: 1.0,
  }),
  // 平屋顶：沥青/砾石灰，不挂贴图
  flatRoof: new THREE.MeshStandardMaterial({ color: 0x6f6d68, roughness: 0.97, side: THREE.DoubleSide }),
  // 坡屋顶：石板深灰
  hip: new THREE.MeshStandardMaterial({ color: 0x5c5f66, roughness: 0.93, side: THREE.DoubleSide }),
  // 楼脚铺装（人行道/场地）：比路面浅一档的混凝土
  walk: new THREE.MeshStandardMaterial({ color: 0x9a978f, roughness: 0.96, side: THREE.DoubleSide }),
  // 窗玻璃：深蓝灰 + 一点金属感，压暗才不像白点
  win: new THREE.MeshStandardMaterial({
    color: 0x1a2430, roughness: 0.18, metalness: 0.55,
    emissive: 0x0a1219, emissiveIntensity: 1.0, side: THREE.DoubleSide,
  }),
  // 窗台/窗套：米白石材
  sill: new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.85, side: THREE.DoubleSide }),
};

/**
 * 外墙材质组。MegaKit 一个物件被按材质拆成多个 primitive，我们只换「基础贴图」，
 * 保留原本的贴图坐标 —— 三种材质的 uv 尺度恰好一致（都是 2×3 m 一段），
 * 所以换 map 不会拉伸。
 */
const WALL_GROUPS = {
  brick: null,            // 原样（红砖）
  concrete: 'Concrete',   // 水泥
  painted: 'Trim',        // 米白涂料
};

/** instanceColor 的候选：明度 + 冷暖。乘在贴图上，所以数值围绕 1.0 摆。 */
// 【范围必须窄】之前放到 0.50~1.55，中远距离看整片街区是一块块深浅花斑，
// 像墙面没贴好（用户原话「墙面都是胡弄的」）。真实街区的同色砖楼差异在 ±15% 以内，
// 差异主要来自材质（砖/水泥/涂料）而不是明暗。
const WALL_TINTS = [
  [1.00, 1.00, 1.00],
  [1.12, 1.09, 1.03],
  [0.88, 0.89, 0.93],
  [0.96, 0.90, 0.84],
  [1.18, 1.16, 1.11],
  [0.82, 0.82, 0.85],
];

/** 加载全部构件。每个 mesh 的局部变换烘进 geometry，后面只关心「几何 + 材质」。 */
export async function loadMegakit(base = '/assets/megakit/') {
  const loader = new GLTFLoader();
  const out = {};
  const t0 = performance.now();
  // 【必须串行】10 个构件各自带一个 .bin（已内嵌，但首次仍要解码），Promise.all
  // 一起发会在本地 serve.js 上打出一批 ERR_ABORTED，结果一个构件都拼不出来。
  for (const name of PARTS) {
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const g = await loader.loadAsync(base + name + '.gltf');
        g.scene.updateMatrixWorld(true);
        const subs = [];
        g.scene.traverse((o) => {
          if (!o.isMesh) return;
          const geo = o.geometry.clone();
          geo.applyMatrix4(o.matrixWorld);   // 把「构件的摆放」烘进顶点
          subs.push({ geo, mat: solidMat(o.material) });
        });
        out[name] = subs;
        ok = true;
      } catch (e) {
        if (attempt === 1) {
          console.warn('[megakit] 构件加载失败', name, e && e.message);
          out[name] = [];
        } else {
          await new Promise((r) => setTimeout(r, 120));
        }
      }
    }
  }

  // 额外加载替换用的外墙贴图（不挂到 PARTS 上，只给材质组用）
  out.__mats = await loadWallMats(out.Brick_Plain_3, base);

  // 屋顶石板贴图：平屋顶原图接近纯黑，必须换图
  try {
    const t = await new THREE.TextureLoader().loadAsync(base + 'T_RoofSlate_BaseColor.png');
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    MATS.roofMap = t;
  } catch (e) { /* 没有就退回纯色 */ }

  const n = Object.values(out).reduce((a, s) => a + (Array.isArray(s) ? s.length : 0), 0);
  console.info(`[megakit] ${PARTS.length} 个构件 / ${n} 个 mesh，${Math.round(performance.now() - t0)} ms`);
  return out;
}

/** 用砖墙材质做底，换成水泥 / 涂料贴图，得到三套外墙材质。 */
async function loadWallMats(brickSubs, base) {
  const sets = { brick: [], concrete: [], painted: [] };
  const tex = new THREE.TextureLoader();
  const load = (f) => tex.loadAsync(base + f).catch(() => null);

  const baseMat = brickSubs && brickSubs[0] ? brickSubs[0].mat : null;
  if (!baseMat) return sets;

  for (const [key, name] of Object.entries(WALL_GROUPS)) {
    if (!name) continue;
    const [map, normalMap, orm] = await Promise.all([
      load('T_' + name + '_BaseColor.png'),
      load('T_' + name + '_Normal.png'),
      load('T_' + name + '_ORM.png'),
    ]);
    if (map) { map.colorSpace = THREE.SRGBColorSpace; map.wrapS = map.wrapT = THREE.RepeatWrapping; }
    const m = baseMat.clone();
    m.side = THREE.DoubleSide;
    if (map) m.map = map;
    m.normalMap = normalMap || null;
    if (orm) {
      // ORM 打包图：G=AO, B=roughness, R=metal —— 与 MegaKit 原始接法一致
      m.roughnessMap = orm;
      m.metalnessMap = orm;
    }
    m.needsUpdate = true;
    sets[key] = [m];
  }
  return sets;
}

/**
 * 把半透明材质改成实心。
 *
 * MegaKit 的窗玻璃是 transparent 的，叠加在原楼外面时会把后面的原立面透出来 ——
 * 远看整面墙都是玻璃格栅。这里强制 opacity=1 并把颜色压深（读成深色玻璃），
 * 砖墙本来就不透明，不受影响。
 */
function solidMat(m) {
  if (!m) return m;
  // 【必须每次 clone 并设 DoubleSide】MegaKit 的墙段 `Brick_Plain_3` 是一张 4 顶点
  // 的单面片（不是盒子，0.2 m 只是包围盒厚度）。它的几何法线朝 -Z，而我们按
  // 「X=-d, Y=up, Z=外法线」摆位 → 从街上看到的是背面，被背面剔除，整面墙消失。
  // 近看只剩转角柱和檐口；俯视时看到的是对面那层墙的正面，所以一直以为墙在。
  // 双面渲染同时解决「从门洞往里看」时的内墙面消失。
  const c = m.clone();
  c.side = THREE.DoubleSide;
  const transparent = m.transparent || (m.opacity !== undefined && m.opacity < 0.99);
  if (transparent) {
    c.transparent = false;
    c.opacity = 1;
    c.depthWrite = true;
    if (c.color) c.color.multiplyScalar(0.45);
  }
  return c;
}

/** 多边形有符号面积（x-z 平面，逆时针为正）。 */
function signedArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

/** 点在多边形内（射线法）。给屋顶铺块用。 */
function inPoly(poly, x, z) {
  let inside = false;
  for (let i = 0, n = poly.length, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0], zi = poly[i][1];
    const xj = poly[j][0], zj = poly[j][1];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}


/**
 * 把一栋楼拆成「构件实例矩阵」塞进 sink。
 *
 * @param {object} mk     loadMegakit() 的返回
 * @param {number[][]} poly  footprint 顶点 [[x,z],...]（米，首尾不重复）
 * @param {number} height   楼高（米，相对 baseY）
 * @param {number} baseY    楼底高程
 * @param {Map} sink    key = 'Part#sub@group' -> { geo, mat, mats: Matrix4[], cols: Color[] }
 * @param {object} o    { seed, windowEvery, wall, roof, floorH }
 */
export function collectBuilding(mk, poly, height, baseY, sink, o = {}) {
  if (!poly || poly.length < 3 || !(height > 0)) return 0;
  const seed = o.seed || 0;
  const rnd = mulberry(seed * 2654435761 + 12345);

  // 【同质化三层】① 外墙材质组 ② 明度 tint ③ 屋顶形态
  const wall = o.wall || (['brick', 'brick', 'concrete', 'painted'][Math.floor(rnd() * 4)]);
  const tintArr = WALL_TINTS[Math.floor(rnd() * WALL_TINTS.length)];
  const jitter = 0.96 + rnd() * 0.08;
  const tint = new THREE.Color(
    tintArr[0] * jitter, tintArr[1] * jitter, tintArr[2] * jitter);
  const roofStyle = o.roof || (rnd() < 0.44 ? 'hip' : 'flat');
  const windowEvery = o.windowEvery || 4;
  // 只有前 N 层开窗（远处楼按 LOD 缩小 N，省下 60% 以上的面）
  const winFloors = o.winFloors || 999;

  // 【朝向不能靠绕向判】OSM 的 footprint 绕向不统一，同一批数据里顺时针逆时针混着来。
  // 按有符号面积判外法线时，绕向反的那批楼整面墙朝内、被背面剔除，于是露出后面的
  // 原楼 —— 表现就是「只有屋顶和顶上一层是砖，下面全是玻璃」。
  // 改成拿楼心判：边中点减去中心的方向，才是真的朝外。
  let pcx = 0, pcz = 0;
  for (const p of poly) { pcx += p[0]; pcz += p[1]; }
  pcx /= poly.length; pcz /= poly.length;

  const floors = Math.max(1, Math.round(height / FLOOR_H));
  const layerH = height / floors;
  const syLayer = layerH / FLOOR_H;            // 层高微调时的竖向缩放

  let placed = 0;
  // 【一个构件 = 多个 primitive】MegaKit 的每个 gltf 里同一个物件被按材质拆成
  // 2~5 个 mesh（砖 / 灰浆 / 装饰 / 玻璃）。第一版只用了第 0 个，结果墙只剩一条
  // 上半截，玻璃幕墙从下面透出来。这里对构件的**全部 sub** 都加一份同样的变换。
  const add = (part, pos, quat, sx, sy, sz) => {
    const arr = mk[part];
    if (!arr || !arr.length) return;
    for (let si = 0; si < arr.length; si++) {
      const s = arr[si];
      const key = part + '#' + si + '@' + wall;
      let e = sink.get(key);
      if (!e) { e = { geo: s.geo, mat: s.mat, mats: [], cols: [] }; sink.set(key, e); }
      e.mats.push(new THREE.Matrix4().compose(
        pos, quat, new THREE.Vector3(sx, sy, sz)));
      e.cols.push(tint);
      placed++;
    }
  };

  // 实心墙段：几何共用，材质按外墙组（砖/水泥/涂料）分
  const addWall = (pos, quat, sx, sy, sz) => {
    const key = 'WALLBOX#0@' + wall;
    let e = sink.get(key);
    if (!e) {
      const srcm = mk.Brick_Plain_3 && mk.Brick_Plain_3[0];
      e = { geo: WALL_BOX, mat: srcm ? srcm.mat : MATS.wall, mats: [], cols: [] };
      sink.set(key, e);
    }
    e.mats.push(new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(sx, sy, sz)));
    e.cols.push(tint);
    placed++;
  };

  // 室内构件（地面 / 内墙 / 天花）用单位立方体 + 缩放，几何全城共用一份
  const addBox = (kind, pos, quat, size) => {
    const key = kind + '#0@interior';
    let e = sink.get(key);
    if (!e) {
      const mat = kind === 'IN_floor' ? MATS.floor
        : kind === 'IN_ceil' ? MATS.ceil
          : kind === 'IN_walk' ? MATS.walk
            : kind === 'IN_win' ? MATS.win
              : kind === 'IN_sill' ? MATS.sill : MATS.wall;
      e = { geo: UNIT_BOX, mat, mats: [], cols: [] };
      sink.set(key, e);
    }
    e.mats.push(new THREE.Matrix4().compose(pos, quat, size));
    e.cols.push(WHITE);
    placed++;
  };

  // ---------- 0) 先找临街面 ----------
  // 用「最长边」当临街面：DC 的联排/街屋绝大多数正面朝街且是最长可达边，
  // 比起反查路网（要额外依赖 roadribbon 的中心线数据）稳得多。
  let doorEdge = -1, doorLen = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L > doorLen) { doorLen = L; doorEdge = i; }
  }
  // 边太短就开不了门（< 9 m 基本是附楼、车库、棚子）
  const doorBayable = doorLen >= 9;
  let doorInfo = null;

  // ---------- 1) 墙 + 窗 + 转角 ----------
  for (let i = 0, n = poly.length; i < n; i++) {
    const ax = poly[i][0], az = poly[i][1];
    const bx = poly[(i + 1) % n][0], bz = poly[(i + 1) % n][1];
    let dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz);
    if (L < 0.6) continue;
    dx /= L; dz /= L;

    // 两个候选法线里，指离楼心的那个才是朝外
    const mx = (ax + bx) * 0.5 - pcx;
    const mz = (az + bz) * 0.5 - pcz;
    let nx = dz, nz = -dx;
    if (nx * mx + nz * mz < 0) { nx = -dz; nz = dx; }

    // 【X 必须从 Z 推出来，不能写死 -d】
    // 实测 21943 栋 / 87772 条边，**每一条**的外法线都要从 (dz,-dx) 翻成 (-dz,dx)
    // （数据里的 footprint 绕向与我们的约定相反）。旧代码把 Z 翻了、X 却固定
    // `(-dx,0,-dz)`，于是 makeBasis(X, UP, Z) 是左手系（det = -1）。
    // Quaternion.setFromRotationMatrix 只接受纯旋转矩阵，对 det=-1 的镜像矩阵会
    // 解出退化四元数（归一化后就是恒等旋转）—— 墙盒的局部轴被钉死在世界 X/Y/Z：
    // 沿 X 的边碰巧对，沿 Z 的边（侧墙）长边和厚度整整错 90°，侧墙等于没盖。
    // 右手系要求 X × Y == Z，即 X = Y × Z = (nz, 0, -nx)。这样任意绕向都成立。
    const X = new THREE.Vector3(nz, 0, -nx);
    const Z = new THREE.Vector3(nx, 0, nz);
    const m = new THREE.Matrix4().makeBasis(X, UP, Z);
    const quat = new THREE.Quaternion().setFromRotationMatrix(m);

    // 沿边分节
    const nb = Math.max(1, Math.round(L / BAY));
    const w = L / nb;                     // 实际节宽

    // 门洞落在临街面中间那一节（宽一个开间 = 2 m，正好塞下 DoorFrame_Trim）
    const doorBay = (i === doorEdge && doorBayable && nb >= 5)
      ? Math.round(nb / 2) - 1 : -1;
    if (doorBay >= 0) {
      const mid = nb - (doorBay + 0.5);
      doorInfo = {
        px: bx - dx * (mid * w) + nx * 0.3,
        pz: bz - dz * (mid * w) + nz * 0.3,
        dx, dz, nx, nz, quat, w,
        // 门厅进深受楼进深限制，避免穿出后墙
        depth: Math.min(5.2, Math.max(2.4, Math.hypot(mx, mz) * 0.85)),
      };
    }

    // 【不再摆 90° 转角构件】`Brick_90Angle_L/R` 和墙段一样是 4 顶点的单面片（零厚度），
    // 摆在角上就是一张斜插的纸：正面看还行，从侧面斜看是一条能透过去的缝。
    // 现在墙是实心 Box 且两端互相咬合（见下面 L + 0.54），转角本身是实心的，不需要它。

    // 【不再用 w 卡窗】原来 `w > 1.2` 这个条件会整面墙一个窗都不开（w = L/nb，
    // 楼一长 nb 就大、w 变小，实测有整面 40 m 的墙因为 w 差一点被判「不能开窗」）。
    // 现在窗在贴图里，只看层高。
    // 门洞中心距边起点 a 的距离
    const doorC = doorBay >= 0 ? (nb - (doorBay + 0.5)) * w : -1;

    // ---------- 墙：每条边每层**一整条**，两端各伸出半个墙厚 ----------
    // 【为什么不再按 2 m 分节拼】分节拼出来的一栋楼有几百个盒子，接缝处任何一点
    // 浮点误差都会露缝 —— 几十段叠起来就是「栅格板」（用户 2026-11-04 指出的）。
    // 一条边一层只有一个盒子，物理上不可能有竖缝，面数也从几百降到几十。
    //
    // 【为什么是 L + 0.54 而不是 L + 0.06】墙厚 0.26、盒心压在外法线上 0.13，
    // 一条只到边端点的盒子，在转角外侧必然留一个 0.26 × 0.26 的方形缺口 ——
    // 竖着贯通整栋楼，从斜角看就是「墙的侧边是空的」，能一眼看穿楼内。
    // 两端各伸出 0.27（> 半厚 0.13 + 半个厚度），相邻两条墙在角部整块重叠，
    // 外角由两条墙叠出来，实心、齐平、不留缝。
    const WALL_OVER = 0.54;
    for (let f = 0; f < floors; f++) {
      const y = baseY + f * layerH;
      if (f === 0 && doorBay >= 0 && doorC > 0.8 && doorC < L - 0.8) {
        // 有门洞：拆成左右两段，中间留一个开间（2 m）的洞
        const half = w * 0.5;
        const L1 = Math.max(0.4, doorC - half);
        const L2 = Math.max(0.4, L - doorC - half);
        // 靠外的端头外延 0.27 咬住转角，靠门洞的端头不外延（否则会吃掉门洞）
        const c1 = (L1 - 0.27) * 0.5;
        const c2 = (doorC + half + L2 + 0.27) * 0.5;
        addWall(new THREE.Vector3(
          ax + dx * c1 + nx * 0.13, y, az + dz * c1 + nz * 0.13),
          quat, L1 + 0.27, layerH, 0.26);
        addWall(new THREE.Vector3(
          ax + dx * c2 + nx * 0.13, y, az + dz * c2 + nz * 0.13),
          quat, L2 + 0.27, layerH, 0.26);
      } else {
        addWall(new THREE.Vector3(
          (ax + bx) * 0.5 + nx * 0.13, y, (az + bz) * 0.5 + nz * 0.13),
          quat, L + WALL_OVER, layerH, 0.26);
      }
    }

    // ---------- 窗已经画在墙贴图里，这里不再挂几何窗 ----------
    // 【踩过的坑：两套窗叠在一起】上一版既把窗画进贴图（世界坐标 UV，相位由 wall
    // 起点决定），又在这里按 GAP 摆深色玻璃盒子（相位由楼自己算）。两套相位对不上，
    // 屏幕上就是贴图窗旁边贴着一块块黑玻璃 + 白窗台，越靠边越乱 ——
    // 用户看到的「墙面乱七八糟」有一半是这个。窗现在只有一套：贴图。

    // ---------- 2) 檐口（顶部一圈，每 4 节一段以省面数）----------
    const cy = baseY + height;             // 檐口高 1 m，底面落在墙顶
    let kc = 0;
    while (kc < nb) {
      const span = Math.min(4, nb - kc);
      const mid = nb - (kc + span * 0.5);
      add('Cornice_Trim_Center',
        new THREE.Vector3(bx - dx * (mid * w) + nx * 0.3, cy, bz - dz * (mid * w) + nz * 0.3),
        quat, (span * w) / 2, 1, 1);
      kc += span;
    }
  }

  // ---------- 2.5) 入口：门框 + 门扇 + 台阶 + 门厅 ----------
  // 这一段是「能不能走进去」的全部。没有它，楼只是外壳；
  // 有了门洞和门厅，从街上就能看见里面、人也能往里走。
  const STEP_H = 0.4;                    // 门口台阶高（室内地面比街面高一级）
  if (doorInfo) {
    const { px, pz, dx, dz, nx, nz, quat, depth } = doorInfo;
    const V = (a, b, c) => new THREE.Vector3(a, b, c);
    // 沿门洞局部轴的偏移工具：u 沿 X（墙面横向），v 沿 Z（法线朝外）
    // 【Xv 必须和 quat 的 X 轴一致】quat 现在由 (nz,0,-nx) 构造；这里若还写
    // 死 -d，门扇/门厅的左右会跟门框的局部 +X 反向，斜边上的门会整个镜像。
    const Xv = V(nz, 0, -nx);
    const Zv = V(nx, 0, nz);
    const at = (u, y, v) => V(px + Xv.x * u + Zv.x * v, y, pz + Xv.z * u + Zv.z * v);

    // 门框（2×3×0.23，正好一个开间）
    add('DoorFrame_Trim', at(0, baseY + 1.5, 0), quat, 1, 1, 1);
    // 两扇 1 m 宽的门，微微内凹，读成"关着的双开门"
    add('Door_2', at(-0.5, baseY + 1.1, -0.05), quat, 1, 1, 1);
    add('Door_1', at(0.5, baseY + 1.1, -0.05), quat, 1, 1, 1);
    // 门口台阶（2×1.01×1 的构件压到 0.4 m 高）
    add('Entrance_Concrete_2x1', at(0, baseY + STEP_H * 0.5, 0.75), quat, 1, STEP_H / 1.01, 1);

    // ---- 门厅：地面 + 天花 + 左右内墙 + 后墙 ----
    // 没了这四样，从门洞看进去是空的（背面剔除后连对面的墙都看不见）。
    const qI = new THREE.Quaternion();
    const cU = 0, cV = -depth * 0.5;               // 门厅中心（往里 half depth）
    const c = at(cU, 0, cV);
    // 地面（0 → STEP_H 的台）
    addBox('IN_floor', V(c.x, baseY + STEP_H * 0.5, c.z), qI, V(3.0, STEP_H, depth));
    // 天花（一层顶）
    addBox('IN_ceil', V(c.x, baseY + layerH - 0.12, c.z), qI, V(3.0, 0.24, depth));
    // 左右内墙
    addBox('IN_wall', at(-1.5, baseY + layerH * 0.5, cV), qI, V(0.2, layerH, depth));
    addBox('IN_wall', at(1.5, baseY + layerH * 0.5, cV), qI, V(0.2, layerH, depth));
    // 后墙
    addBox('IN_wall', at(0, baseY + layerH * 0.5, -depth), qI, V(3.0, layerH, 0.2));
    placed += 6;
  }

  // ---------- 2.7) 楼脚铺装带 ----------
  // 【为什么要这一圈】只有楼和地面时，从街上看是「一个盒子插在一片灰色/绿色里」，
  // 没有路缘、没有铺装边界，读不出街道。围一圈 2.6 m 的浅灰硬质带（比地面高 4 cm），
  // 相当于把「楼前硬化」补上 —— 这是城市感最便宜的一笔。
  {
    const qI0 = new THREE.Quaternion();
    for (let i = 0, n = poly.length; i < n; i++) {
      const ax = poly[i][0], az = poly[i][1];
      const bx = poly[(i + 1) % n][0], bz = poly[(i + 1) % n][1];
      let dx = bx - ax, dz = bz - az;
      const L = Math.hypot(dx, dz);
      if (L < 0.6) continue;
      dx /= L; dz /= L;
      const mx = (ax + bx) * 0.5 - pcx, mz = (az + bz) * 0.5 - pcz;
      let nx = dz, nz = -dx;
      if (nx * mx + nz * mz < 0) { nx = -dz; nz = dx; }
      // 一条 2.6 m 宽、比地面高 4 cm 的带子，沿墙外侧铺
      const cxp = (ax + bx) * 0.5 + nx * 1.3;
      const czp = (az + bz) * 0.5 + nz * 1.3;
      // 长边（局部 Z）必须沿墙 d。Ry(θ) 下局部 Z → (sinθ, 0, cosθ)，
      // 所以 θ = atan2(dx, dz) 才对；旧代码多加了 π/2，长边被转到法线方向，
      // 变成一条从楼里横穿出去的 L 米大板，而墙脚反而只盖住 2.6 m。
      const qy = new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(dx, dz));
      addBox('IN_walk', new THREE.Vector3(cxp, baseY + 0.04, czp), qy,
        new THREE.Vector3(2.6, 0.08, L + 0.6));
    }
  }

  // ---------- 3) 屋顶 ----------
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const p of poly) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
  }
  const ry = baseY + height + 1.0;        // 檐口顶

  if (roofStyle === 'hip') {
    // 四坡顶：底面对齐 footprint 外包框，高按楼宽定（最宽 2.6 m，小平房减半）
    const wSpan = Math.max(2, maxX - minX);
    const dSpan = Math.max(2, maxZ - minZ);
    const rise = Math.max(1.4, Math.min(5.0, Math.min(wSpan, dSpan) * 0.22));
    let e = sink.get('HIP#0@roof');
    if (!e) {
      e = { geo: HIP_GEO, mat: MATS.hip, mats: [], cols: [] };
      sink.set('HIP#0@roof', e);
    }
    e.mats.push(new THREE.Matrix4().compose(
      new THREE.Vector3((minX + maxX) * 0.5, ry, (minZ + maxZ) * 0.5),
      new THREE.Quaternion(),
      new THREE.Vector3(wSpan, rise, dSpan)));
    // 石板色微差，免得一片屋顶同一个色
    const shade = 0.82 + rnd() * 0.3;
    e.cols.push(new THREE.Color(shade, shade, shade * 1.03));
    placed += 1;
  } else {
    // 平顶：铺板 + 女儿墙（0.9 m 高，沿 footprint 内侧一圈）
    const qI = new THREE.Quaternion();
    for (let x = minX + 2; x <= maxX - 2 + 1e-6; x += 4) {
      for (let z = minZ + 2; z <= maxZ - 2 + 1e-6; z += 4) {
        if (!inPoly(poly, x, z)) continue;
        add('Roof_4x4', new THREE.Vector3(x, ry, z), qI, 1, 1, 1);
      }
    }
    for (let x = minX + 1; x <= maxX - 1 + 1e-6; x += 2) {
      for (let z = minZ + 1; z <= maxZ - 1 + 1e-6; z += 2) {
        if (!inPoly(poly, x, z)) continue;
        const gx = (x - (minX + 2)) % 4, gz = (z - (minZ + 2)) % 4;
        if (gx > 1 || gz > 1) {
          add('Roof_2x2', new THREE.Vector3(x, ry - 0.01, z), qI, 1, 1, 1);
        }
      }
    }
    // 女儿墙：墙体构件竖着缩到 0.9 m，厚缩到 0.55，贴着屋檐立一圈。
    // 没有它，从上往下看平屋顶就是一块深色平板。
    const parapetH = 0.9;
    for (let i = 0, n = poly.length; i < n; i++) {
      const ax = poly[i][0], az = poly[i][1];
      const bx = poly[(i + 1) % n][0], bz = poly[(i + 1) % n][1];
      let dx = bx - ax, dz = bz - az;
      const L = Math.hypot(dx, dz);
      if (L < 0.6) continue;
      dx /= L; dz /= L;
      const mx = (ax + bx) * 0.5 - pcx, mz = (az + bz) * 0.5 - pcz;
      let nx = dz, nz = -dx;
      if (nx * mx + nz * mz < 0) { nx = -dz; nz = dx; }
      const X = new THREE.Vector3(-dx, 0, -dz);
      const Z = new THREE.Vector3(nx, 0, nz);
      const quat = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(X, UP, Z));
      const nb = Math.max(1, Math.round(L / BAY));
      const w = L / nb;
      for (let k = 0; k < nb; k++) {
        const mid = nb - (k + 0.5);
        add('Brick_Plain_3',
          new THREE.Vector3(bx - dx * (mid * w) + nx * 0.3, ry + parapetH * 0.5,
            bz - dz * (mid * w) + nz * 0.3),
          quat, w / 2, parapetH / FLOOR_H, 0.55);
      }
    }
  }

  return placed;
}

/**
 * 生成「一层楼一扇窗」的砖墙贴图。
 *
 * 【为什么把窗画进贴图，而不是摆几何】几何窗试了三轮都不可靠：按节铺 → 白点阵；
 * 自建 Box → 有整面墙因为 canWin/w 判据一个窗都不开；按距离 LOD → 部分立面直接无窗。
 * 贴图方案绕开全部几何问题：墙是一整条 Box，窗长在贴图里，**任何长度、任何朝向
 * 都不可能缺窗**，而且零额外面数。
 *
 * 一张图 = 3.6 m（横）× 3.0 m（竖，一层高），窗占中间 46%。
 */
function makeWallTexture(baseColor = '#6d5041') {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  // 砖底
  g.fillStyle = baseColor;
  g.fillRect(0, 0, S, S);
  // 砖纹：每 26 px 一条横向灰缝，再叠竖向错缝
  g.strokeStyle = 'rgba(0,0,0,0.10)';
  g.lineWidth = 2;
  for (let y = 0; y < S; y += 26) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(S, y); g.stroke();
    const off = (y / 26) % 2 ? 32 : 0;
    for (let x = off; x < S; x += 64) {
      g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 26); g.stroke();
    }
  }
  // 随机砖块明暗（少量，避免死板）
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 160; i++) {
    const x = Math.floor(rnd() * 8) * 64, y = Math.floor(rnd() * 20) * 26;
    g.fillStyle = `rgba(255,240,220,${0.02 + rnd() * 0.05})`;
    g.fillRect(x + 2, y + 2, 60, 22);
  }
  // 窗：深色玻璃 + 浅色窗套 + 十字窗棂
  const wx = 138, wy = 96, ww = 236, wh = 306;
  g.fillStyle = '#cfc7b6';                       // 窗套
  g.fillRect(wx - 14, wy - 14, ww + 28, wh + 28);
  const grd = g.createLinearGradient(wx, wy, wx + ww, wy + wh);
  grd.addColorStop(0, '#2b3a46');
  grd.addColorStop(0.45, '#3f5566');
  grd.addColorStop(1, '#1b2733');
  g.fillStyle = grd;
  g.fillRect(wx, wy, ww, wh);
  g.strokeStyle = '#cfc7b6';
  g.lineWidth = 8;
  g.beginPath();
  g.moveTo(wx + ww / 2, wy); g.lineTo(wx + ww / 2, wy + wh);
  g.moveTo(wx, wy + wh * 0.52); g.lineTo(wx + ww, wy + wh * 0.52);
  g.stroke();
  // 窗台外挑的阴影
  g.fillStyle = 'rgba(0,0,0,0.22)';
  g.fillRect(wx - 14, wy + wh + 14, ww + 28, 10);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** 确定性随机（同一 seed 每次拼出同一栋楼，便于对比与复现）。 */
function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 把收集到的矩阵建成 InstancedMesh 列表。一次建好，全城共享。
 *
 * @param {Map} sink
 * @param {object} opts  { castShadow, receiveShadow, wallMats }
 */
export function buildInstancedMeshes(sink, opts = {}) {
  const group = new THREE.Group();
  group.name = 'megakit-buildings';
  const wallMats = opts.wallMats || {};
  let total = 0;

  for (const [key, e] of sink) {
    const n = e.mats.length;
    if (!n) continue;

    const [part, si, grp] = key.split(/[#@]/);
    let mat = e.mat;
    // 调试：把指定构件染成纯色，用来确认它到底被摆在什么位置、什么朝向

    // 外墙换成材质组里的对应材质（水泥 / 涂料）；屋顶与檐口不换
    // 【窗不能被换材质】窗构件的 key 也带 @wall 后缀，早先被一起换成水泥贴图，
    // 于是窗和墙同色 —— 整面墙看着「没有窗」。窗必须永远保留自己的砖框 + 玻璃材质。
    const isWinPart = part.includes('Window');
    if (!isWinPart && grp && grp !== 'brick' && wallMats[grp] && wallMats[grp][0]
        && (part.startsWith('Brick_') || part === 'WALLBOX')) {
      mat = wallMats[grp][0];
    } else if (key.includes('Roof_')) {
      // 平屋顶原图接近纯黑。**只改 color 没用**（color 是乘数，黑贴图乘出来还是黑），
      // 换石板贴图也不稳（uv 落在暗部）。这里直接换成不带贴图的纯色材质，
      // 颜色完全可控 —— 从上往下看是沥青/砾石屋面的灰。
      mat = MATS.flatRoof;
    }

    if (opts.xray && part === opts.xray) {
      mat = new THREE.MeshBasicMaterial({ color: 0xff2200, side: THREE.DoubleSide });
    }
    // 【墙用实例局部坐标 UV，不用世界坐标】一条墙长 30 m，Box 的 0-1 UV 会把 2 m 的
    // 砖贴图拉成 30 m 的长条（斜纹）。InstancedMesh 又没法逐实例改 UV，所以在顶点
    // 着色器里按实例的**局部分辨率**算：
    //   lx = (position.x + 0.5) * |instanceMatrix 的 X 轴|（= 墙长）
    //   ly = (position.y + 0.5) * |instanceMatrix 的 Y 轴|（= 层高）
    // 墙 Box 是「一层一个实例」，所以 ly / 3.0 永远正好铺满一层，窗永远在层中间 ——
    // 早先用世界高度 wp4.y / 3.0，baseY 或层高不是 3 m 的楼会整栋窗都错半层。
    if (part === 'WALLBOX') {
      mat = mat.clone();
      // 【窗画进贴图】一张图 = 3.6 m 宽 × 3.0 m 高（一层），重复铺满整面墙。
      // 几何窗不可靠（试过按节铺→白点阵、自建 Box→整面墙无窗），贴图方案不可能缺窗。
      if (!WALL_TEX) WALL_TEX = makeWallTexture();
      mat.map = WALL_TEX;
      if (mat.color) mat.color.setRGB(1, 1, 1);
      mat.roughness = 0.9;
      mat.metalness = 0.0;
      mat.onBeforeCompile = (shader) => {
        // 【夜间窗光】和全城立面共用 light-grid.js 的时刻表：vWallUv 已经是
        // 「3.6 m 一开间 × 3.0 m 一层」的单位，fract 正好落在窗格内。
        shader.uniforms.uWNight = WINDOW_NIGHT;
        shader.uniforms.uWRatio = WINDOW_RATIO;
        shader.uniforms.uWColor = { value: WINDOW_COLOR };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec2 vWallUv;\nvarying float vWinSeed;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            float wallLx = (position.x + 0.5) * length(instanceMatrix[0].xyz);
            float wallLy = (position.y + 0.5) * length(instanceMatrix[1].xyz);
            // 3.6 m 一开间（含一扇窗）；3.0 m 一层
            vWallUv = vec2(wallLx / 3.6, wallLy / 3.0);
            vWinSeed = instanceMatrix[3][0] * 0.017 + instanceMatrix[3][2] * 0.013;`);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>
            varying vec2 vWallUv;
            varying float vWinSeed;
            uniform float uWNight;
            uniform float uWRatio;
            uniform vec3 uWColor;
            float vWin = 0.0;`)
          .replace('#include <emissivemap_fragment>', `
            #include <emissivemap_fragment>
            totalEmissiveRadiance += vWin * uWColor;
          `)
          .replace('#include <map_fragment>', `
            vec4 wallTex = texture2D(map, vWallUv);
            diffuseColor *= wallTex;
            // 贴图里窗套在 (0.27..0.73, 0.19..0.78)，逐格 hash 决定这户亮不亮
            vec2 wCell = floor(vWallUv);
            vec2 wUv = fract(vWallUv);
            float wRect = step(0.28, wUv.x) * step(wUv.x, 0.72)
                        * step(0.20, wUv.y) * step(wUv.y, 0.78);
            float wRnd = fract(sin(dot(wCell + vec2(vWinSeed, vWinSeed * 0.7),
                                      vec2(12.9898, 78.233))) * 43758.5453);
            vWin = wRect * step(1.0 - uWRatio, wRnd) * uWNight;
          `);
      };
      mat.needsUpdate = true;
    }

    const im = new THREE.InstancedMesh(e.geo, mat, n);
    im.name = key;
    for (let i = 0; i < n; i++) {
      im.setMatrixAt(i, e.mats[i]);
      // instanceColor 会乘到贴图上 → 一批楼里出现深浅冷暖差异
      if (e.cols && e.cols[i] && grp !== 'skipTint') im.setColorAt(i, e.cols[i]);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = !!opts.castShadow;
    im.receiveShadow = opts.receiveShadow !== false;
    im.frustumCulled = false;     // 实例散布全城，包围球没意义
    group.add(im);
    total += n;
  }

  console.info(`[megakit] ${group.children.length} 个 mesh / ${total} 个实例`);
  return group;
}

/** 估算一栋楼的构件数（不实际拼，给 LOD 预算用）。 */
export function estimateCost(poly, height) {
  const floors = Math.max(1, Math.round(height / FLOOR_H));
  let bays = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L >= 0.6) bays += Math.max(1, Math.round(L / BAY));
  }
  return bays * floors + bays * 2 + 4;    // 墙+窗 + 转角 + 檐口 + 屋顶
}
