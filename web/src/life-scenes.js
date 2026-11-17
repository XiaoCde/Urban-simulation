/**
 * life-scenes.js —— 按《全天剧本》补建「该是哪儿就像哪儿」的真 3D 生活场景。
 *
 * 背景 / 用户原话：「在原有的那些建筑的基础上，你看哪个地方该是哪个地方，
 * 就把那个地方重建一个 3D 模型，把那个地方的贴图删掉」——即：卧室要真有床、
 * 厨房要真有餐桌、候车亭要真有亭子，而不是靠一张立面材质 / 一张贴图糊过去。
 *
 * ★ 刻意「删掉贴图」：本模块生成的【所有】材质都是纯色 + 自发光（emissive）的
 *   MeshStandardMaterial，禁止任何 map / CanvasTexture / TextureLoader / 图片。
 *   屏幕、玻璃、灯箱一律用 color + emissive + 低 opacity 表现，不加载任何纹理，
 *   也不加载任何外部 glb / fbx；几何全部由 Box / Cylinder / Cone / Lathe / Torus
 *   等基础体程序化拼装。这是设计规范，不是遗漏。
 *
 * ★ 为什么不重复造已有的：office-building.js / home-building.js /
 *   district-buildings.js 里已经有整套楼体与相当多真 3D 室内（6F 开放办公区、
 *   公寓硬装、处置室、吧台咖啡机、三年级教室、工地围护、手术台 / 钢琴 / 脚手架
 *   等）。但它们属于【另一套建筑坐标体系与整屋装修】。本模块保持独立、不 import
 *   也不修改它们，而是按 day_full.json 的 places（真实世界坐标）与 scenes 的 id，
 *   给 17 个「生活道具缺口」场景补一个可辨认的、定位到正确楼层的道具组；对清单外、
 *   已有模块覆盖的 11 个场景，只补一个定位标记物，不重建整屋、不堆重复物件。
 *
 * 坐标系：three.js 的 x 东 / z 南、y 向上，1 单位 = 1 米；地面高程由 groundAt 提供。
 * places 字段兼容两种写法：
 *   - day_full.json 实际结构：{ name, x, z, w, d }（也兼容 cx/cz/width/depth 别名）
 *   - 旧式数组：[x, z, label, w, d]
 * 每个场景建在 (place.x + 偏移, y, place.z + 偏移) 的子 Group 里，局部原点即场景地面中心。
 */

import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 * 1) 共享材质：全模块只此一份，任何 mesh 都复用，绝不逐件 new。
 *    全部为 MeshStandardMaterial（含玻璃 / 屏幕 / 灯箱），纯色 + emissive，无 map。
 * ------------------------------------------------------------------ */
const M = {
  wall:       new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.9 }),
  floor:      new THREE.MeshStandardMaterial({ color: 0xb9b2a4, roughness: 0.85 }),
  wood:       new THREE.MeshStandardMaterial({ color: 0x9a7958, roughness: 0.72 }),
  woodDark:   new THREE.MeshStandardMaterial({ color: 0x6b4f37, roughness: 0.7 }),
  woodLight:  new THREE.MeshStandardMaterial({ color: 0xc9a878, roughness: 0.7 }),
  fabric:     new THREE.MeshStandardMaterial({ color: 0x59707a, roughness: 0.95 }),
  fabricWarm: new THREE.MeshStandardMaterial({ color: 0xb98a6a, roughness: 0.95 }),
  linen:      new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.92 }),
  white:      new THREE.MeshStandardMaterial({ color: 0xf4f2ea, roughness: 0.8 }),
  paper:      new THREE.MeshStandardMaterial({ color: 0xf7f4ea, roughness: 0.95 }),
  metal:      new THREE.MeshStandardMaterial({ color: 0x8a9296, roughness: 0.38, metalness: 0.65 }),
  metalDark:  new THREE.MeshStandardMaterial({ color: 0x333b40, roughness: 0.42, metalness: 0.55 }),
  steel:      new THREE.MeshStandardMaterial({ color: 0xbcc4c8, roughness: 0.26, metalness: 0.78 }),
  dark:       new THREE.MeshStandardMaterial({ color: 0x2a2f33, roughness: 0.6 }),
  black:      new THREE.MeshStandardMaterial({ color: 0x14181b, roughness: 0.55 }),
  concrete:   new THREE.MeshStandardMaterial({ color: 0x9a9c98, roughness: 0.92 }),
  rust:       new THREE.MeshStandardMaterial({ color: 0xa5643c, roughness: 0.82 }),
  // 玻璃：纯色 + 轻微自发光 + 半透明，无环境贴图
  glass:      new THREE.MeshStandardMaterial({ color: 0x8fb4c0, roughness: 0.15, metalness: 0.1, emissive: 0x1a2a30, emissiveIntensity: 0.28, transparent: true, opacity: 0.42, depthWrite: false }),
  // 屏幕：深色 + 自发光，不贴任何 UI 贴图
  screen:     new THREE.MeshStandardMaterial({ color: 0x101a20, emissive: 0x163a4a, emissiveIntensity: 0.55, roughness: 0.3 }),
  screenOn:   new THREE.MeshStandardMaterial({ color: 0x0a1418, emissive: 0x2f7fa0, emissiveIntensity: 0.95, roughness: 0.28 }),
  // 灯具 / 灯箱：自发光纯色
  light:      new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff0c0, emissiveIntensity: 1.25, roughness: 0.5 }),
  lampGlow:   new THREE.MeshStandardMaterial({ color: 0xffe9b0, emissive: 0xffd27a, emissiveIntensity: 1.05, roughness: 0.5 }),
  uv:         new THREE.MeshStandardMaterial({ color: 0x7b6fd0, emissive: 0x4a2fb0, emissiveIntensity: 1.1, roughness: 0.4 }),
  red:        new THREE.MeshStandardMaterial({ color: 0xd23b32, roughness: 0.7 }),
  blue:       new THREE.MeshStandardMaterial({ color: 0x2f6fb0, roughness: 0.65 }),
  green:      new THREE.MeshStandardMaterial({ color: 0x3f9a6a, roughness: 0.7 }),
  yellow:     new THREE.MeshStandardMaterial({ color: 0xe8b93a, roughness: 0.7 }),
  orange:     new THREE.MeshStandardMaterial({ color: 0xe07a2f, roughness: 0.7 }),
  marker:     new THREE.MeshStandardMaterial({ color: 0x6f7c86, emissive: 0x24333c, emissiveIntensity: 0.4, roughness: 0.7 }),
};

/* ------------------------------------------------------------------ *
 * 1b) 【2026-11-07】给不发光的生活道具补一点点自发光。
 * 白天室内只有环境光、夜里更没有灯：镜头一进楼，桌子椅子全成了黑剪影，
 * 谁也看不出这是教室还是仓库。这里按自身颜色补 22% 自发光 —— 不改变配色，
 * 只保证「无论几点进楼，家具轮廓都读得出来」，也不额外加动态光源。
 * 已有发光语义的材质（屏幕 / 灯 / 灯箱 / 玻璃 / 标记牌）跳过。
 * ------------------------------------------------------------------ */
{
  const SKIP = new Set(['glass', 'screen', 'screenOn', 'light', 'lampGlow', 'uv', 'marker']);
  for (const [k, mat] of Object.entries(M)) {
    if (SKIP.has(k) || !mat || !mat.color || !mat.emissive) continue;
    mat.emissive = mat.color.clone().multiplyScalar(0.22);
    mat.emissiveIntensity = 1;
    mat.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ *
 * 2) 共享几何：单位体，靠 mesh.scale 变尺寸，避免逐件 new geometry。
 * ------------------------------------------------------------------ */
const G = {
  box:   new THREE.BoxGeometry(1, 1, 1),
  cyl:   new THREE.CylinderGeometry(0.5, 0.5, 1, 16),   // 半径 0.5 / 高 1
  cone:  new THREE.ConeGeometry(0.5, 1, 16),              // 底半径 0.5 / 高 1
  torus: new THREE.TorusGeometry(0.5, 0.06, 8, 24),       // 孔半径 0.5 / 管 0.06，在 xy 平面
  sphere:new THREE.SphereGeometry(0.5, 12, 10),
};

/* ------------------------------------------------------------------ *
 * 3) 小工具：全部往「已定位」的子 Group 里加局部坐标物件。
 * ------------------------------------------------------------------ */

// 轴对齐/可绕 y 旋转的盒体
function B(g, mat, x, y, z, w, h, d, ry = 0) {
  const m = new THREE.Mesh(G.box, mat);
  m.position.set(x, y, z);
  m.scale.set(w, h, d);
  if (ry) m.rotation.y = ry;
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  return m;
}

// 圆柱：传半径 r 与高 h；rot 为可选 {x,y,z} 弧度（常用于横杆、轮子）
function CY(g, mat, x, y, z, r, h, rot = null) {
  const m = new THREE.Mesh(G.cyl, mat);
  m.position.set(x, y, z);
  m.scale.set(2 * r, h, 2 * r);
  if (rot) m.rotation.set(rot.x || 0, rot.y || 0, rot.z || 0);
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  return m;
}

// 圆锥：底半径 r、高 h
function CO(g, mat, x, y, z, r, h, rot = null) {
  const m = new THREE.Mesh(G.cone, mat);
  m.position.set(x, y, z);
  m.scale.set(2 * r, h, 2 * r);
  if (rot) m.rotation.set(rot.x || 0, rot.y || 0, rot.z || 0);
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  return m;
}

// 圆环：整体缩放 s（水平放置需调用方设 rot）
function TO(g, mat, x, y, z, s, rot = null) {
  const m = new THREE.Mesh(G.torus, mat);
  m.position.set(x, y, z);
  m.scale.setScalar(s);
  if (rot) m.rotation.set(rot.x || 0, rot.y || 0, rot.z || 0);
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  return m;
}

/**
 * 通用实例化：把重复小件压成 1 个 InstancedMesh。
 * list 项统一 {x,y,z,sx,sy,sz,rx,ry,rz}；box 时 sx/sy/sz=宽高深，cyl 时 sx=sz=2r、sy=长。
 */
function inst(g, geo, mat, list) {
  if (!list || !list.length) return null;
  const im = new THREE.InstancedMesh(geo, mat, list.length);
  const d = new THREE.Object3D();
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    d.position.set(it.x, it.y, it.z);
    d.scale.set(it.sx, it.sy, it.sz);
    d.rotation.set(it.rx || 0, it.ry || 0, it.rz || 0);
    d.updateMatrix();
    im.setMatrixAt(i, d.matrix);
  }
  im.instanceMatrix.needsUpdate = true;
  im.castShadow = true; im.receiveShadow = true;
  g.add(im);
  return im;
}
const boxes = (g, mat, list) => inst(g, G.box, mat, list);
const cyls  = (g, mat, list) => inst(g, G.cyl, mat, list);

// 自发光屏幕薄片（电视 / 监护仪 / 楼层显示），纯色无贴图
function SC(g, x, y, z, w, h, ry = 0) {
  B(g, M.black, x, y, z - 0.03, w + 0.08, h + 0.08, 0.05, ry);
  return B(g, M.screenOn, x, y, z, w, h, 0.02, ry);
}

// 稳定的 id → [0,1, 0,1] 哈希，用来把不同场景错开到不同象限
function hash2(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  const a = ((h >>> 0) % 1000) / 1000;
  const h2 = (Math.imul(h ^ 0x9e3779b9, 2654435761) >>> 0);
  const b = (h2 % 1000) / 1000;
  return [a, b];
}

// 楼层：优先读 id 里的「数字f」；卧室/厨房/客厅默认 9F，大堂默认 1F；可被 floorOf 覆盖
function floorFromId(id) {
  const m = id.match(/(\d+)f/);
  if (m) return parseInt(m[1], 10);
  if (/bedroom|kitchen|living/.test(id)) return 9;
  if (/lobby/.test(id)) return 1;
  return 1;
}

// places 兼容对象与数组两种写法
function parsePlace(p) {
  if (!p) return null;
  if (Array.isArray(p)) return { x: p[0], z: p[1], name: p[2], w: p[3] || 10, d: p[4] || 10 };
  const x = p.x ?? p.cx, z = p.z ?? p.cz;
  const w = p.w ?? p.width ?? 10, d = p.d ?? p.depth ?? 10;
  return { x, z, name: p.name ?? p.label ?? '', w, d };
}

function countMeshes(root) {
  let n = 0;
  root.traverse((o) => { if (o.isMesh) n++; });
  return n;
}

/**
 * 室外/半室外避让车行道：沿 4 个方向、每方向 3 圈，共最多 12 次试探。
 * 找不到可放置点返回 null，由调用方跳过该场景。
 */
function findFreeSpot(cx, cz, P, onRoad) {
  const step = Math.max(1.5, Math.min(P.w, P.d) * 0.25);
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let i = 1; i <= 12; i++) {
    const dir = dirs[(i - 1) % 4];
    const k = Math.ceil(i / 4);
    const nx = cx + dir[0] * step * k;
    const nz = cz + dir[1] * step * k;
    if (!onRoad(nx, nz)) return { x: nx, z: nz };
  }
  return null;
}

/* ================================================================== *
 * 4) 17 个「真缺」场景的 builder。
 *    每个函数：g 是已定位到该场景锚点的子 Group，局部 (0,0,0) 为地面中心；
 *    rep(n) 在 quality='lite' 时把重复件数量减半（返回 ceil(n/2)）。
 *    每段注释说明「补什么」以及「为什么不算重复造既有模块」。
 * ================================================================== */

// sc_home_bedroom：双人床（床架+床垫+双枕+床头板）、儿童床、2 床头柜、台灯。
// 既有 home-building.js 是公寓硬装（墙/地/窗/电梯），没有可辨认的床具；这里只补家具，不重造墙体。
function bBedroom(g, rep) {
  B(g, M.woodDark, 0, 0.22, 0, 2.1, 0.34, 2.2);          // 双人床架
  B(g, M.linen, 0, 0.46, 0.05, 1.98, 0.2, 2.06);          // 床垫
  B(g, M.wood, 0, 0.72, -1.12, 2.1, 0.92, 0.12);          // 床头板
  B(g, M.fabricWarm, 0, 0.6, 0.5, 1.98, 0.08, 1.3);       // 被子
  const pillows = [], cabinets = [];
  for (const sx of [-0.5, 0.5]) pillows.push({ x: sx, y: 0.62, z: -0.72, sx: 0.72, sy: 0.14, sz: 0.42 });
  boxes(g, M.linen, pillows);
  B(g, M.woodLight, -2.4, 0.18, 1.3, 1.35, 0.3, 0.78);    // 儿童床架
  B(g, M.linen, -2.4, 0.36, 1.3, 1.28, 0.12, 0.7);        // 儿童床垫
  B(g, M.woodLight, -2.4, 0.6, 1.66, 1.35, 0.5, 0.06);    // 儿童床护栏
  for (const sx of [-1.55, 1.55]) cabinets.push({ x: sx, y: 0.26, z: -0.92, sx: 0.46, sy: 0.52, sz: 0.46 });
  boxes(g, M.wood, cabinets);
  // 台灯 ×2：底座 + 灯杆 + 锥形灯罩（自发光）
  const lamps = rep(2);
  for (let i = 0; i < lamps; i++) {
    const lx = i === 0 ? -1.55 : 1.55;
    CY(g, M.metalDark, lx, 0.55, -0.92, 0.09, 0.04);
    CY(g, M.steel, lx, 0.75, -0.92, 0.018, 0.38);
    CO(g, M.lampGlow, lx, 0.98, -0.92, 0.15, 0.22);
  }
}

// sc_home_kitchen：餐桌 + 4 椅 + 冰箱（门缝+把手）+ 水槽 + 吊柜。
// 既有模块只有公寓硬装与「餐桌位置」文字，没有成套可辨认厨具，这里补齐而不重造房间。
function bKitchen(g, rep) {
  B(g, M.wood, 0, 0.76, 0, 1.7, 0.09, 0.95);              // 餐桌台面
  const legs = [], chairs = [];
  for (const sx of [-0.72, 0.72]) for (const sz of [-0.36, 0.36])
    legs.push({ x: sx, y: 0.37, z: sz, sx: 0.08, sy: 0.72, sz: 0.08 });
  boxes(g, M.woodDark, legs);
  const nc = rep(4);                                        // 椅子（lite 减半）
  for (let i = 0; i < nc; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const cz = -0.7 + Math.floor(i / 2) * 1.4;
    chairs.push({ x: side * 1.15, y: 0.46, z: cz, sx: 0.44, sy: 0.08, sz: 0.44 });       // 座
    chairs.push({ x: side * 1.36, y: 0.72, z: cz, sx: 0.08, sy: 0.5, sz: 0.44, rx: 0 }); // 靠背
  }
  boxes(g, M.wood, chairs);
  B(g, M.white, 2.4, 0.9, -1.3, 0.82, 1.8, 0.72);          // 冰箱主体
  B(g, M.metalDark, 2.4, 0.9, -0.935, 0.82, 0.015, 0.02);   // 门缝
  for (const hy of [0.62, 1.18]) B(g, M.steel, 2.7, hy, -0.91, 0.04, 0.32, 0.04); // 把手
  B(g, M.steel, -2.1, 0.86, 0, 1.7, 0.06, 0.72);            // 水槽台面
  B(g, M.dark, -2.1, 0.9, 0, 0.62, 0.1, 0.46);              // 槽盆
  CY(g, M.steel, -2.1, 1.02, -0.28, 0.02, 0.24);            // 龙头立管
  CY(g, M.steel, -2.1, 1.14, -0.18, 0.02, 0.2, { x: Math.PI / 2 }); // 龙头横管
  B(g, M.woodLight, -2.1, 1.92, -0.15, 1.7, 0.6, 0.4);      // 吊柜
  B(g, M.woodDark, -2.1, 1.92, 0.055, 0.02, 0.6, 0.02);     // 吊柜门缝
}

// sc_home_living：L 形沙发 + 茶几 + 电视柜 + 壁挂电视（屏幕用自发光深色，无贴图）。
function bLiving(g, rep) {
  B(g, M.fabric, 0.1, 0.32, 0.65, 2.5, 0.42, 0.92);        // 沙发主段座
  B(g, M.fabric, 0.1, 0.66, 1.12, 2.5, 0.6, 0.22);         // 主段靠背
  B(g, M.fabric, -1.35, 0.32, -0.15, 0.92, 0.42, 1.7);     // 转角段座（构成 L）
  B(g, M.fabric, -1.78, 0.66, -0.15, 0.2, 0.6, 1.7);       // 转角段靠背
  B(g, M.woodDark, 0, 0.24, -2.25, 2.1, 0.45, 0.42);       // 电视柜
  B(g, M.metal, 0, 0.48, -2.25, 2.1, 0.03, 0.42);          // 柜面
  // 茶几：玻璃面 + 4 腿（玻璃为纯色半透明材质，非贴图）
  B(g, M.glass, 0, 0.46, -0.7, 1.15, 0.05, 0.62);
  const tl = [];
  for (const sx of [-0.5, 0.5]) for (const sz of [-0.95, -0.45])
    tl.push({ x: sx, y: 0.23, z: sz, sx: 0.05, sy: 0.44, sz: 0.05 });
  boxes(g, M.metalDark, tl);
  // 壁挂电视：黑边框 + 自发光屏幕
  B(g, M.black, 0, 1.5, -2.44, 1.7, 1.0, 0.06);
  SC(g, 0, 1.5, -2.4, 1.56, 0.86);
}

// sc_home_lobby：信箱墙 + 前台 + 电梯门（两扇金属，带中缝）+ 楼层按钮面板。
// home-building.js 里已有「入户电梯门」但属于其公寓模型内部；这里按 lobby 场景锚点
// 补一组完整的大堂标识物（信箱墙/前台/按钮），定位到 home 的 1F，不改动既有模型。
function bLobby(g, rep) {
  B(g, M.metal, -2.6, 0.95, -2.3, 2.4, 1.7, 0.26);         // 信箱墙体
  const cells = [];
  const cols = rep(5), rows = rep(4);                        // 小格（lite 减半）
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
    cells.push({ x: -3.6 + c * (2.0 / Math.max(1, cols)), y: 0.42 + r * (1.3 / Math.max(1, rows)), z: -2.16, sx: 0.3, sy: 0.22, sz: 0.02 });
  boxes(g, M.steel, cells);
  B(g, M.woodDark, 0, 0.52, -1.0, 2.2, 1.04, 0.7);         // 前台
  B(g, M.woodLight, 0, 1.06, -1.0, 2.3, 0.06, 0.78);       // 前台台面
  B(g, M.dark, 2.6, 1.25, -2.4, 2.3, 2.5, 0.2);           // 电梯门框
  B(g, M.steel, 2.02, 1.2, -2.28, 1.02, 2.2, 0.06);       // 左扇
  B(g, M.steel, 3.18, 1.2, -2.28, 1.02, 2.2, 0.06);       // 右扇
  B(g, M.metalDark, 2.6, 1.2, -2.24, 0.02, 2.2, 0.02);    // 中缝
  SC(g, 2.6, 2.62, -2.3, 0.5, 0.22);                       // 楼层显示（自发光）
  B(g, M.metal, 3.72, 1.25, -2.2, 0.14, 0.6, 0.05);       // 按钮面板
  const btns = [];
  for (let i = 0; i < rep(6); i++) btns.push({ x: 3.72, y: 1.48 - i * 0.08, z: -2.16, sx: 0.05, sy: 0.04, sz: 0.02 });
  boxes(g, M.lampGlow, btns);
}

// sc_home_hall9f：9F 电梯厅 / 走廊。
// 【2026-11-08 补】剧本里「9F 电梯厅」「9F 主卧 → 走廊」「公寓北门 → 电梯 → 9F」
// 这些段原本被指到一层大堂（sc_home_lobby 在 1F），于是人标着 9F 却站在一楼，
// 楼层 y 与房间锚点差 28 m。现在单独给 9F 建一间电梯厅，楼层由 id 里的 9f 决定。
function bHall9f(g, rep) {
  roomFloor(g, 11, 6, { lamp: true, mat: M.floor });
  B(g, M.dark, 0, 1.25, -2.6, 2.4, 2.5, 0.2);            // 电梯门框
  B(g, M.steel, -0.58, 1.2, -2.48, 1.02, 2.2, 0.06);     // 左扇
  B(g, M.steel, 0.58, 1.2, -2.48, 1.02, 2.2, 0.06);      // 右扇
  B(g, M.metalDark, 0, 1.2, -2.44, 0.02, 2.2, 0.02);     // 中缝
  SC(g, 0, 2.62, -2.6, 0.5, 0.22);                        // 9F 楼层显示
  B(g, M.metal, 1.52, 1.25, -2.4, 0.14, 0.6, 0.05);      // 按钮面板
  const btns = [];
  for (let i = 0; i < rep(6); i++) btns.push({ x: 1.52, y: 1.48 - i * 0.08, z: -2.36, sx: 0.05, sy: 0.04, sz: 0.02 });
  boxes(g, M.lampGlow, btns);
  B(g, M.woodDark, -3.4, 0.44, 1.7, 2.4, 0.08, 0.42);    // 走廊长椅
  B(g, M.metal, -4.4, 0.22, 1.7, 0.06, 0.44, 0.38);
  B(g, M.metal, -2.4, 0.22, 1.7, 0.06, 0.44, 0.38);
  B(g, M.light, -3.4, 2.44, 0.2, 1.8, 0.08, 0.22);       // 走廊灯带
  B(g, M.red, 3.6, 1.2, 1.9, 0.36, 0.6, 0.16);           // 消防箱
  CY(g, M.metalDark, 4.6, 0.34, 1.7, 0.2, 0.68);         // 垃圾桶
}

// 【2026-11-08 全天时间轴核对】剧本里 7 个人夜里各在各的房间（主卧 / 三居
// 书房 / 一居 / 合租间 / 朝北开间 / 最小间 / 儿童房），旧版只有一间卧室，
// 结果 0 点 7 个人挤在同一张床边站成一堆。补 4 间真房间，按房间词分人。
function bStudy(g, rep) {                       // 三居书房：老板夜里伏案
  roomFloor(g, 10, 7, { lamp: true, mat: M.wood });
  B(g, M.woodDark, 0.6, 0.74, -1.2, 3.2, 0.08, 1.4);     // 书桌
  B(g, M.woodDark, -0.85, 0.37, -1.2, 0.1, 0.74, 1.3);
  B(g, M.woodDark, 2.05, 0.37, -1.2, 0.1, 0.74, 1.3);
  B(g, M.screenOn, 0.6, 1.25, -1.82, 1.5, 0.86, 0.06);   // 亮着的屏幕
  B(g, M.paper, -0.35, 0.8, -0.95, 0.7, 0.02, 0.5);      // 摊开的材料
  CY(g, M.lampGlow, -0.8, 1.04, -1.15, 0.14, 0.46);      // 台灯
  B(g, M.woodDark, -3.7, 1.1, -1.5, 0.5, 2.2, 2.6);      // 书架
  for (let i = 0; i < rep(3); i++) B(g, M.wood, -3.7, 0.35 + i * 0.65, -1.5, 0.54, 0.05, 2.5);
  B(g, M.fabricWarm, 2.9, 0.46, 1.6, 1.5, 0.9, 1.2);     // 沙发椅
  B(g, M.metal, 3.7, 0.5, -1.7, 0.8, 1.0, 0.5);          // 文件柜
}

function bKids(g, rep) {                        // 儿童房：女孩抱伞睡
  roomFloor(g, 8, 6.5, { lamp: true, mat: M.wood });
  B(g, M.woodLight, -1.9, 0.28, -1.2, 1.5, 0.42, 2.0);   // 儿童床
  B(g, M.linen, -1.9, 0.53, -1.2, 1.4, 0.1, 1.9);
  B(g, M.fabricWarm, -1.9, 0.62, -1.9, 0.8, 0.18, 0.4);  // 枕头
  B(g, M.woodLight, -2.6, 0.7, 0.05, 1.5, 0.7, 0.06);    // 护栏
  B(g, M.blue, 2.2, 0.55, -1.6, 1.2, 1.1, 0.5);          // 玩具柜
  B(g, M.yellow, 2.2, 0.72, 1.4, 1.3, 0.08, 0.7);        // 小书桌
  CY(g, M.orange, 3.0, 0.34, 1.8, 0.18, 0.68);            // 卡通伞（立着）
  for (let i = 0; i < 2; i++) CY(g, M.green, 0.4 + i * 0.4, 0.22, 2.1, 0.16, 0.44); // 雨靴
}

function bShared(g, rep) {                      // 合租间：钢筋工
  roomFloor(g, 10, 7, { lamp: true, mat: M.concrete });
  for (let i = 0; i < 2; i++) {
    const x = i ? 2.2 : -2.2;
    B(g, M.woodDark, x, 0.28, -1.3, 1.6, 0.42, 2.0);     // 两张单人床
    B(g, M.linen, x, 0.53, -1.3, 1.5, 0.1, 1.9);
    B(g, M.fabric, x, 0.62, -2.0, 0.8, 0.18, 0.4);
  }
  B(g, M.woodDark, 0, 0.45, 1.8, 0.9, 0.9, 0.5);         // 共用的柜
  for (let i = 0; i < 2; i++) CY(g, M.dark, -1.0 + i * 0.4, 0.18, 2.2, 0.13, 0.36); // 工靴
  B(g, M.metal, 4.0, 1.1, -1.7, 0.7, 2.2, 0.5);          // 衣柜
}

function bStudio(g, rep) {                      // 一居 / 最小间 / 朝北开间
  roomFloor(g, 9, 6.5, { lamp: true, mat: M.wood });
  B(g, M.woodDark, -2.0, 0.28, -1.4, 1.7, 0.42, 2.1);    // 单人床
  B(g, M.linen, -2.0, 0.53, -1.4, 1.6, 0.1, 2.0);
  B(g, M.fabricWarm, -2.0, 0.62, -2.1, 0.85, 0.18, 0.4);
  B(g, M.fabric, 2.0, 0.42, 1.5, 2.0, 0.84, 1.0);        // 小沙发
  B(g, M.woodLight, 1.2, 0.52, -1.2, 1.2, 0.06, 0.7);    // 小桌
  B(g, M.screen, 1.2, 1.22, -1.8, 1.0, 0.62, 0.05);      // 电视 / 屏幕
  CY(g, M.lampGlow, 0.1, 0.9, -1.2, 0.12, 0.4);           // 台灯
  B(g, M.metalDark, 3.4, 0.34, 1.9, 0.36, 0.68, 0.36);   // 充电中的电池
}

// sc_office_meeting3f：长会议桌 + 8 椅 + 白板 + 投影幕。
// 既有 office-building.js 主打 6F 开放办公区（工位/显示器），没有独立会议室家具；这里补 3F 会议道具。
function bMeeting(g, rep) {
  B(g, M.wood, 0, 0.76, 0, 4.3, 0.1, 1.45);               // 长会议桌
  B(g, M.metalDark, -1.5, 0.38, 0, 0.3, 0.72, 0.9);       // 桌腿底座
  B(g, M.metalDark, 1.5, 0.38, 0, 0.3, 0.72, 0.9);
  const chairs = [];
  const nc = rep(8);                                        // 8 椅（lite 减半）
  for (let i = 0; i < nc; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const cx = -1.7 + Math.floor(i / 2) * 1.15;
    chairs.push({ x: cx, y: 0.46, z: side * 1.15, sx: 0.46, sy: 0.09, sz: 0.46 });
    chairs.push({ x: cx, y: 0.72, z: side * 1.38, sx: 0.46, sy: 0.5, sz: 0.08 });
  }
  boxes(g, M.fabric, chairs);
  B(g, M.paper, -2.9, 1.6, -2.7, 2.4, 1.3, 0.05);         // 白板
  B(g, M.metal, -2.9, 0.92, -2.68, 2.4, 0.06, 0.12);      // 白板笔槽
  B(g, M.metal, 2.9, 1.85, -2.72, 2.7, 1.6, 0.04);        // 投影幕
  CY(g, M.metalDark, 2.9, 2.68, -2.72, 0.09, 2.8, { z: Math.PI / 2 }); // 卷轴外壳
  B(g, M.dark, 2.9, 1.03, -2.72, 2.7, 0.05, 0.06);        // 幕布下沿杆
}

// sc_clinic_treatment：处置床 + 清创车（带轮）+ 输液架 + 消毒灯。
// district-buildings.js 有处置室的墙体/柜体，这里按 treatment 场景补可辨认的床/车/架/灯细节。
function bTreatment(g, rep) {
  B(g, M.white, 0, 0.78, 0, 2.05, 0.12, 0.78);            // 处置床
  B(g, M.fabric, 0, 0.88, 0, 1.98, 0.08, 0.72);           // 软垫
  B(g, M.linen, 0.78, 0.94, 0, 0.34, 0.1, 0.5);           // 枕头
  const bl = [];
  for (const sx of [-0.88, 0.88]) for (const sz of [-0.3, 0.3])
    bl.push({ x: sx, y: 0.39, z: sz, sx: 0.06, sy: 0.72, sz: 0.06 });
  boxes(g, M.steel, bl);
  B(g, M.steel, 1.95, 0.52, 0.7, 0.62, 0.9, 0.46);        // 清创车
  B(g, M.metal, 1.95, 1.0, 0.7, 0.66, 0.04, 0.5);         // 车台面
  const wheels = [];                                        // 4 个轮子（圆柱横放）
  for (const sx of [1.72, 2.18]) for (const sz of [0.52, 0.88])
    wheels.push({ x: sx, y: 0.09, z: sz, sx: 0.14, sy: 0.06, sz: 0.14, rz: Math.PI / 2 });
  cyls(g, M.dark, wheels);
  CY(g, M.steel, -1.75, 0.05, 0.5, 0.18, 0.05);           // 输液架底座
  CY(g, M.steel, -1.75, 1.0, 0.5, 0.02, 1.9);             // 立杆
  CY(g, M.steel, -1.75, 1.94, 0.5, 0.02, 0.42, { z: Math.PI / 2 }); // 顶横杆
  for (const hx of [-1.92, -1.58]) { B(g, M.metal, hx, 1.86, 0.5, 0.02, 0.14, 0.02); B(g, M.glass, hx, 1.68, 0.5, 0.1, 0.22, 0.02); }
  // 消毒灯：立杆 + 灯罩 + 紫外灯管（自发光）
  CY(g, M.metalDark, 1.3, 0.05, -1.5, 0.16, 0.05);
  CY(g, M.steel, 1.3, 1.05, -1.5, 0.02, 2.0);
  B(g, M.metal, 1.3, 2.02, -1.2, 0.5, 0.1, 0.34);         // 悬臂/灯罩
  CY(g, M.uv, 1.3, 1.94, -1.16, 0.03, 0.42, { z: Math.PI / 2 }); // 紫外灯管
}

// sc_clinic_or2f：手术台 + 无影灯（多灯头环绕）+ 器械台 + 监护仪（带屏幕）。
// district-buildings.js 的手术台/无影灯在其诊所整屋内；这里按 or2f 锚点补「多灯头环绕」的可辨认灯组与器械/监护仪。
function bOR(g, rep) {
  CY(g, M.steel, 0, 0.45, 0, 0.2, 0.8);                   // 手术台柱
  B(g, M.steel, 0, 0.88, 0, 2.1, 0.14, 0.68);            // 手术台面
  B(g, M.fabric, 0, 0.98, 0, 2.02, 0.08, 0.62);          // 台垫
  CY(g, M.metalDark, 0, 2.28, 0, 0.03, 0.64);            // 无影灯吊杆
  TO(g, M.steel, 0, 1.98, 0, 1.1, { x: Math.PI / 2 });   // 灯环（水平）
  const heads = [];
  const nh = rep(6);                                        // 环绕小灯头（lite 减半）
  for (let i = 0; i < nh; i++) {
    const a = (i / nh) * Math.PI * 2;
    heads.push({ x: Math.cos(a) * 0.55, y: 1.92, z: Math.sin(a) * 0.55, sx: 0.14, sy: 0.09, sz: 0.14 });
  }
  cyls(g, M.light, heads);
  CY(g, M.light, 0, 1.92, 0, 0.09, 0.08);                // 中心灯头
  B(g, M.steel, 2.0, 0.86, 0.5, 0.9, 0.06, 0.5);        // 器械台
  const il = [], tools = [];
  for (const sx of [1.65, 2.35]) for (const sz of [0.32, 0.68])
    il.push({ x: sx, y: 0.43, z: sz, sx: 0.05, sy: 0.82, sz: 0.05 });
  boxes(g, M.metalDark, il);
  for (let i = 0; i < rep(4); i++) tools.push({ x: 1.8 + i * 0.13, y: 0.92, z: 0.5, sx: 0.03, sy: 0.03, sz: 0.26 });
  boxes(g, M.steel, tools);
  CY(g, M.metalDark, -2.0, 0.6, 0.3, 0.12, 1.1);         // 监护仪支架
  B(g, M.dark, -2.0, 1.28, 0.3, 0.55, 0.44, 0.3);       // 监护仪机身
  SC(g, -2.0, 1.3, 0.46, 0.44, 0.3);                     // 屏幕（自发光）
  const knobs = [];
  for (let i = 0; i < rep(3); i++) knobs.push({ x: -2.18 + i * 0.18, y: 1.04, z: 0.46, sx: 0.05, sy: 0.05, sz: 0.02 });
  boxes(g, M.lampGlow, knobs);
}

// sc_clinic_recovery：2 张病床 + 床头柜 + 屏风。
function bRecovery(g, rep) {
  const beds = [], rails = [];
  for (const bz of [-1.25, 1.25]) {
    beds.push({ x: 0, y: 0.6, z: bz, sx: 2.05, sy: 0.12, sz: 0.82 });  // 床板
    beds.push({ x: 0, y: 0.7, z: bz, sx: 1.98, sy: 0.08, sz: 0.76 });  // 垫
    beds.push({ x: 0.78, y: 0.76, z: bz, sx: 0.34, sy: 0.1, sz: 0.5 });// 枕
    for (const sx of [-0.88, 0.88]) for (const sz of [bz - 0.3, bz + 0.3])
      rails.push({ x: sx, y: 0.3, z: sz, sx: 0.06, sy: 0.55, sz: 0.06 }); // 床腿
    rails.push({ x: -0.95, y: 0.92, z: bz, sx: 0.04, sy: 0.04, sz: 0.82, rz: 0 }); // 侧护栏(横杆占位)
  }
  boxes(g, M.white, beds);
  boxes(g, M.steel, rails);
  B(g, M.wood, 1.35, 0.26, 0, 0.46, 0.52, 0.46);        // 床头柜
  B(g, M.woodLight, 1.35, 0.54, 0, 0.48, 0.04, 0.48);
  // 屏风：3 扇折线布帘 + 立杆
  const screens = [], posts = [];
  const panels = rep(3);
  for (let i = 0; i < panels; i++) {
    const px = -2.3 + i * 0.62;
    screens.push({ x: px, y: 0.95, z: 1.9 + (i % 2) * 0.18, sx: 0.6, sy: 1.6, sz: 0.04, ry: (i % 2 ? 0.35 : -0.35) });
    posts.push({ x: px - 0.3, y: 0.9, z: 1.9, sx: 0.04, sy: 1.8, sz: 0.04 });
  }
  boxes(g, M.fabricWarm, screens);
  boxes(g, M.steel, posts);
}

// sc_school_music5f：钢琴（琴身 + 黑白键两排小 box）+ 合唱台阶 + 谱架 ×3 + 乐器柜。
// district-buildings.js 的 5F 音乐教室是整屋装修；这里补可辨认的琴键、台阶、谱架细节。
function bMusic(g, rep) {
  B(g, M.woodDark, -1.9, 0.5, -0.6, 1.6, 0.92, 0.68);    // 立式琴身
  B(g, M.wood, -1.9, 0.98, -0.2, 1.6, 0.06, 0.9);        // 键盘台
  const whites = [], blacks = [];
  const nk = rep(14);                                       // 白键（lite 减半）
  for (let i = 0; i < nk; i++) whites.push({ x: -2.6 + i * (1.4 / nk), y: 1.03, z: 0.02, sx: (1.4 / nk) * 0.9, sy: 0.04, sz: 0.3 });
  const nb = rep(10);                                       // 黑键（略高、略短）
  for (let i = 0; i < nb; i++) blacks.push({ x: -2.53 + i * (1.4 / nb), y: 1.07, z: -0.06, sx: 0.05, sy: 0.06, sz: 0.18 });
  boxes(g, M.paper, whites);
  boxes(g, M.black, blacks);
  B(g, M.woodDark, -1.9, 1.12, -0.62, 1.6, 0.05, 0.62, -0.12); // 琴盖（略掀）
  CY(g, M.woodDark, -2.55, 0.22, -0.6, 0.06, 0.44);
  CY(g, M.woodDark, -1.25, 0.22, -0.6, 0.06, 0.44);
  // 合唱台阶：2~3 级逐级升高
  const steps = [];
  const ns = rep(3);
  for (let i = 0; i < ns; i++) steps.push({ x: 1.3, y: 0.13 + i * 0.26, z: 0.4 + i * 0.5, sx: 2.2, sy: 0.26, sz: 0.5 });
  boxes(g, M.woodLight, steps);
  // 谱架 ×3：底盘 + 立杆 + 斜谱板
  const bases = [], rods = [], plates = [];
  const nStand = rep(3);
  for (let i = 0; i < nStand; i++) {
    const sx = -0.4 + i * 1.0;
    bases.push({ x: sx, y: 0.04, z: 1.9, sx: 0.32, sy: 0.06, sz: 0.32 });
    rods.push({ x: sx, y: 0.62, z: 1.9, sx: 0.03, sy: 1.16, sz: 0.03 });
    plates.push({ x: sx, y: 1.24, z: 1.9, sx: 0.42, sy: 0.32, sz: 0.03, rx: -0.3 });
  }
  boxes(g, M.metalDark, bases);
  cyls(g, M.steel, rods);
  boxes(g, M.metal, plates);
  B(g, M.wood, 2.9, 0.85, -1.4, 1.2, 1.7, 0.42);        // 乐器柜
  B(g, M.woodDark, 2.9, 0.85, -1.18, 0.02, 1.7, 0.02);  // 柜门缝
  const instr = [];                                        // 柜内几件竖立乐器轮廓
  for (let i = 0; i < rep(3); i++) instr.push({ x: 2.55 + i * 0.33, y: 1.05, z: -1.14, sx: 0.08, sy: 0.9, sz: 0.08 });
  cyls(g, M.green, instr);
}

// sc_site_pit：钢筋网（多根细圆柱交叉）+ 绑扎台 + 模板 + 脚手架（立杆+横杆+斜撑）。
// 既有 district-buildings.js 有工地围护/脚手架，这里按 pit 场景锚点补「基坑钢筋网」这套可辨认道具。
function bPit(g, rep) {
  const rebars = [];
  const nx = rep(10), nz = rep(8);                         // 钢筋网（lite 减半）
  for (let i = 0; i < nx; i++) rebars.push({ x: 0, y: 0.3, z: -1.5 + i * (3 / nx), sx: 2 * 0.014, sy: 3.2, sz: 2 * 0.014, rz: Math.PI / 2 });
  for (let j = 0; j < nz; j++) rebars.push({ x: -1.5 + j * (3 / nz), y: 0.32, z: 0, sx: 2 * 0.014, sy: 3.2, sz: 2 * 0.014, rx: Math.PI / 2 });
  cyls(g, M.steel, rebars);
  B(g, M.wood, 0, 0.76, 1.9, 1.6, 0.08, 0.8);            // 绑扎台
  const tl = [];
  for (const sx of [-0.7, 0.7]) for (const sz of [1.6, 2.2])
    tl.push({ x: sx, y: 0.38, z: sz, sx: 0.08, sy: 0.72, sz: 0.08 });
  boxes(g, M.woodDark, tl);
  B(g, M.woodLight, -2.3, 0.55, -1.6, 1.9, 1.1, 0.06);   // 竖立模板
  const braces = [];
  for (const bx of [-2.9, -1.7]) braces.push({ x: bx, y: 0.3, z: -1.9, sx: 0.06, sy: 0.9, sz: 0.06, rx: 0.4 });
  boxes(g, M.woodDark, braces);
  // 脚手架：4 立杆 + 上下横杆 + 斜撑
  const uprights = [], bars = [], diag = [];
  for (const sx of [-1.9, 1.9]) for (const sz of [-1.3, 1.3])
    uprights.push({ x: sx, y: 1.3, z: sz, sx: 2 * 0.045, sy: 2.6, sz: 2 * 0.045 });
  cyls(g, M.metal, uprights);
  for (const hy of [0.7, 1.9]) {
    bars.push({ x: 0, y: hy, z: -1.3, sx: 2 * 0.035, sy: 3.8, sz: 2 * 0.035, rz: Math.PI / 2 });
    bars.push({ x: -1.9, y: hy, z: 0, sx: 2 * 0.035, sy: 2.6, sz: 2 * 0.035, rx: Math.PI / 2 });
  }
  cyls(g, M.metal, bars);
  diag.push({ x: -1.9, y: 1.3, z: 0, sx: 2 * 0.03, sy: 3.0, sz: 2 * 0.03, rx: Math.PI / 2, ry: 0, rz: 0.7 });
  cyls(g, M.metalDark, diag);
}

// sc_site_container：集装箱房（瓦楞竖条纹 + 门 + 窗）+ 折叠桌 + 工牌板。
function bContainer(g, rep) {
  B(g, M.rust, 0, 1.3, 0, 5.0, 2.6, 2.4);               // 箱体
  const ribs = [];                                         // 瓦楞竖条纹（长边两面）
  const nr = rep(24);
  for (let i = 0; i < nr; i++) {
    const x = -2.4 + i * (4.8 / nr);
    ribs.push({ x, y: 1.3, z: 1.22, sx: 0.04, sy: 2.5, sz: 0.03 });
    ribs.push({ x, y: 1.3, z: -1.22, sx: 0.04, sy: 2.5, sz: 0.03 });
  }
  boxes(g, M.metalDark, ribs);
  B(g, M.metalDark, 1.7, 1.05, 1.24, 0.95, 2.05, 0.06); // 门
  B(g, M.steel, 2.05, 1.05, 1.28, 0.04, 0.22, 0.04);   // 门把手
  B(g, M.glass, -1.2, 1.6, 1.24, 1.0, 0.8, 0.04);      // 窗（纯色玻璃）
  B(g, M.metalDark, -1.2, 1.6, 1.23, 1.08, 0.88, 0.02);// 窗框
  B(g, M.wood, 0.3, 0.75, 2.0, 1.2, 0.06, 0.6);        // 折叠桌
  const dl = [];
  for (const sx of [-0.2, 0.8]) for (const sz of [1.75, 2.25])
    dl.push({ x: sx, y: 0.37, z: sz, sx: 0.05, sy: 0.72, sz: 0.05 });
  boxes(g, M.metalDark, dl);
  B(g, M.paper, -2.0, 1.55, 1.24, 1.0, 0.72, 0.04);    // 工牌板
  const cards = [];
  for (let i = 0; i < rep(4); i++) cards.push({ x: -2.35 + (i % 2) * 0.44, y: 1.72 - Math.floor(i / 2) * 0.3, z: 1.27, sx: 0.3, sy: 0.22, sz: 0.02 });
  boxes(g, M.yellow, cards);
}

// sc_site_shed：波纹钢棚顶 + 4 立柱 + 成捆钢筋 + 水泥袋堆。
function bShed(g, rep) {
  B(g, M.steel, 0, 3.0, 0, 6.0, 0.08, 4.0, 0).rotation.x = 0.06; // 棚顶（略坡）
  const waves = [];                                        // 波纹钢条纹
  const nw = rep(20);
  for (let i = 0; i < nw; i++) waves.push({ x: -2.9 + i * (5.8 / nw), y: 3.06, z: 0, sx: 0.05, sy: 0.06, sz: 4.0, rx: 0.06 });
  boxes(g, M.metal, waves);
  const posts = [];
  for (const sx of [-2.7, 2.7]) for (const sz of [-1.7, 1.7])
    posts.push({ x: sx, y: 1.5, z: sz, sx: 2 * 0.07, sy: 3.0, sz: 2 * 0.07 });
  cyls(g, M.metalDark, posts);
  const bundles = [];                                      // 成捆钢筋（横放两层）
  for (let i = 0; i < rep(6); i++) bundles.push({ x: -1.4 + (i % 3) * 0.14, y: 0.12 + Math.floor(i / 3) * 0.14, z: 0.4, sx: 2 * 0.02, sy: 3.6, sz: 2 * 0.02, rx: Math.PI / 2 });
  cyls(g, M.steel, bundles);
  B(g, M.woodDark, -0.4, 0.36, 0.4, 0.06, 0.5, 0.5);   // 捆扎带
  const bags = [];                                         // 水泥袋金字塔
  const nb = rep(6);
  for (let i = 0; i < nb; i++) bags.push({ x: 1.4 + (i % 2) * 0.55, y: 0.1 + Math.floor(i / 2) * 0.2, z: -0.6 + (i % 2) * 0.1, sx: 0.5, sy: 0.16, sz: 0.36 });
  boxes(g, M.paper, bags);
}

// sc_street_shelter：候车亭顶棚 + 4 立柱 + 长椅 + 广告灯箱 + 垃圾桶。
function bShelter(g, rep) {
  B(g, M.metal, 0, 2.6, 0, 4.0, 0.12, 1.8).rotation.x = 0.05; // 顶棚
  B(g, M.metalDark, 0, 2.56, -0.9, 4.0, 0.1, 0.06);     // 后沿
  const posts = [];
  for (const sx of [-1.8, 1.8]) for (const sz of [-0.75, 0.75])
    posts.push({ x: sx, y: 1.3, z: sz, sx: 2 * 0.05, sy: 2.6, sz: 2 * 0.05 });
  cyls(g, M.steel, posts);
  B(g, M.wood, 0, 0.46, 0.3, 2.4, 0.08, 0.44);         // 长椅座
  B(g, M.wood, 0, 0.72, 0.54, 2.4, 0.42, 0.06);        // 长椅靠背
  const bl = [];
  for (const sx of [-1.05, 1.05]) bl.push({ x: sx, y: 0.23, z: 0.3, sx: 0.08, sy: 0.46, sz: 0.4 });
  boxes(g, M.metalDark, bl);
  B(g, M.metalDark, -1.55, 1.1, -0.6, 1.2, 1.6, 0.12); // 广告灯箱框
  B(g, M.lampGlow, -1.55, 1.1, -0.53, 1.08, 1.48, 0.02); // 灯箱发光面（纯色自发光，无贴图）
  CY(g, M.metalDark, -1.55, 0.15, -0.6, 0.05, 0.3);    // 灯箱立杆
  CY(g, M.dark, 1.65, 0.36, 0.2, 0.22, 0.7);           // 垃圾桶
  CY(g, M.metalDark, 1.65, 0.73, 0.2, 0.24, 0.06);     // 桶盖
  B(g, M.black, 1.65, 0.6, 0.41, 0.18, 0.12, 0.02);   // 投放口
}

// sc_street_ride：简易电动车（两轮 + 车架 + 车把）+ 后座保温外卖箱（盖子 + 标志色块）。
function bRide(g, rep) {
  // 两轮：圆柱竖立（轴沿 x），前后分布
  CY(g, M.black, 0, 0.32, 0.72, 0.32, 0.12, { z: Math.PI / 2 });
  CY(g, M.black, 0, 0.32, -0.72, 0.32, 0.12, { z: Math.PI / 2 });
  CY(g, M.steel, 0, 0.32, 0.72, 0.12, 0.13, { z: Math.PI / 2 });
  CY(g, M.steel, 0, 0.32, -0.72, 0.12, 0.13, { z: Math.PI / 2 });
  B(g, M.dark, 0, 0.36, 0, 0.5, 0.08, 1.2);            // 踏板车架
  CY(g, M.metal, 0, 0.66, 0.5, 0.03, 0.75, { x: 0.35 }); // 斜梁
  B(g, M.black, 0, 0.78, -0.3, 0.42, 0.12, 0.42);     // 车座
  CY(g, M.metal, 0, 1.0, 0.72, 0.02, 0.5);            // 前叉立管
  CY(g, M.metalDark, 0, 1.24, 0.72, 0.02, 0.62, { z: Math.PI / 2 }); // 车把横杆
  // 后座保温外卖箱
  B(g, M.blue, 0, 1.12, -0.72, 0.56, 0.56, 0.5);      // 箱体
  B(g, M.blue, 0, 1.42, -0.72, 0.6, 0.08, 0.54);      // 箱盖
  B(g, M.yellow, 0, 1.14, -0.46, 0.32, 0.3, 0.02);    // 标志色块（纯色）
  B(g, M.orange, 0, 1.14, -0.97, 0.4, 0.08, 0.02);    // 背面反光条
}

// sc_cafe_backdoor：后门 + 遮雨棚 + 垃圾桶 ×2。
function bBackdoor(g, rep) {
  B(g, M.woodDark, 0, 1.05, 0, 1.0, 2.1, 0.08);        // 后门
  B(g, M.metalDark, 0, 1.05, -0.05, 1.14, 2.22, 0.06); // 门框
  B(g, M.metalDark, 0.34, 1.05, 0.05, 0.04, 0.22, 0.04); // 门把手
  B(g, M.steel, 0, 1.05, 0.05, 0.02, 2.1, 0.02);      // 门缝
  B(g, M.metal, 0, 2.35, 0.5, 1.9, 0.08, 0.95).rotation.x = -0.12; // 遮雨棚
  CY(g, M.metalDark, -0.85, 1.7, 0.9, 0.03, 1.3);     // 棚撑
  CY(g, M.metalDark, 0.85, 1.7, 0.9, 0.03, 1.3);
  for (const tx of [-1.4, 1.4]) {                        // 垃圾桶 ×2
    CY(g, M.dark, tx, 0.34, 0.5, 0.22, 0.68);
    CY(g, M.metalDark, tx, 0.7, 0.5, 0.24, 0.06);
  }
}

// sc_school_gate：校门柱 ×2 + 遮雨棚（门楣）+ 警戒线（细杆 + 绳 + 小旗）。
function bGate(g, rep) {
  for (const gx of [-2.2, 2.2]) {
    B(g, M.concrete, gx, 1.6, 0, 0.6, 3.2, 0.6);       // 门柱
    B(g, M.metalDark, gx, 3.28, 0, 0.72, 0.16, 0.72);  // 柱顶帽
  }
  B(g, M.metalDark, 0, 3.1, 0, 5.0, 0.3, 0.8);        // 门楣/遮雨棚
  B(g, M.paper, 0, 3.1, 0.42, 2.4, 0.22, 0.03);       // 校牌（纯色）
  B(g, M.blue, 0, 2.98, 0.42, 2.4, 0.04, 0.02);       // 校牌色条
  // 警戒线：两细杆 + 一根略下垂的绳 + 三角小旗
  CY(g, M.metal, -1.2, 0.5, 1.6, 0.03, 1.0);
  CY(g, M.metal, 1.2, 0.5, 1.6, 0.03, 1.0);
  B(g, M.yellow, 0, 0.92, 1.6, 2.4, 0.03, 0.03);      // 警戒绳
  const flags = [];
  const nf = rep(6);
  for (let i = 0; i < nf; i++) flags.push({ x: -1.0 + i * (2.0 / nf), y: 0.82, z: 1.6, sx: 0.12, sy: 0.16, sz: 0.02 });
  boxes(g, M.red, flags);
}

// sc_route_cafe_market：门廊雨棚 + 台阶 ×3 + 窄人行道地砖。
function bRoute(g, rep) {
  B(g, M.metal, 0, 2.6, 0.6, 2.4, 0.1, 1.2).rotation.x = -0.1; // 门廊雨棚
  const posts = [];
  for (const sx of [-1.05, 1.05]) posts.push({ x: sx, y: 1.3, z: 1.05, sx: 2 * 0.05, sy: 2.6, sz: 2 * 0.05 });
  cyls(g, M.metalDark, posts);
  const steps = [];                                       // 台阶 ×3（向外逐级降低）
  for (let i = 0; i < 3; i++) steps.push({ x: 0, y: 0.42 - i * 0.14, z: 1.35 + i * 0.45, sx: 1.9, sy: 0.14, sz: 0.45 });
  boxes(g, M.concrete, steps);
  const tiles = [];                                       // 窄人行道地砖（lite 减半）
  const nt = rep(15);
  for (let i = 0; i < nt; i++) tiles.push({ x: -1.2 + (i % 5) * 0.6, y: 0.02, z: 2.9 + Math.floor(i / 5) * 0.6, sx: 0.56, sy: 0.04, sz: 0.56 });
  boxes(g, M.floor, tiles);
}

/* ------------------------------------------------------------------ *
 * 4b) 【2026-11-07 修正】按每栋楼的真实层高算楼面高度。
 *
 * 旧版把所有室内场景一律按 floorH=3.6、baseY=地面 抬高，但实际建筑是：
 *   公寓 565 Penn  floorH 3.55   baseY = 6.75(实测地形)
 *   办公楼 FAA     floorH 5.00   baseY = 7.19
 *   诊所           floorH 4.00
 *   学校           floorH 5.00
 *   咖啡馆         floorH 3.30（夹层 2F 在 3.3 m）
 * 于是办公楼 6F 的东西被摆在 6F 楼板下方 7 米（1F/2F 的墙里），公寓 9F
 * 高 1.7 米浮在空中 —— 用户看到的「场景离谱 / 人站在楼板里」就是这个。
 * 现在 main.js 会把每栋楼真实 baseY 传进来（placeFit），这里只留兜底值。
 * ------------------------------------------------------------------ */
const DEFAULT_FIT = {
  home:   { floorH: 3.55, baseY: 6.75 },
  office: { floorH: 5.00, baseY: 7.19 },
  clinic: { floorH: 4.00 },
  school: { floorH: 5.00 },
  cafe:   { floorH: 3.30 },
  site:   { floorH: 3.60 },
  street: { floorH: 3.60 },
};

/* ------------------------------------------------------------------ *
 * 4c) 房间壳：一块地板 + 一盏吸顶灯。
 * 旧版家具直接摆在大楼空壳里，镜头进去是一片虚空里飘着几张桌子。
 * 加上房间地板与灯之后，家具「落在地上」、屋子「有顶灯」，一眼看得懂。
 * 地板放在 y=-0.06，避免与大楼自带的楼面 z-fighting。
 * ------------------------------------------------------------------ */
function roomFloor(g, w, d, { lamp = true, mat = M.wood, tiles = 0, walls = true } = {}) {
  g.userData.hasRoom = true;
  B(g, mat, 0, -0.06, 0, w, 0.12, d);
  // 两面墙：镜头进楼时整栋楼会被隐藏，只留家具就像「家具飘在空中」。
  // 加一面后墙 + 一面侧墙，立刻读成「一个房间的角落」。墙高 2.8 m。
  if (walls) {
    // 【2026-11-08 实拍修正】后墙原来是一整块 0xe8e4da 白板，镜头进楼
    // 像摄影棚，夜里室内灯一打还整面过曝。改成带窗洞的剖面墙（两侧墙垛
    // + 窗台 + 窗楣），中间留空看得见窗外城市；墙色中灰、地板暖木。
    const ww = Math.min(4.4, w * 0.42);
    const side = Math.max(1.0, (w - ww) / 2);
    const wy = -d / 2;
    // 所有剖面墙统一打 tag：相机进楼时 main.js 会整体收起它们。
    // 【实测两难】全收起 → 整层连成一整片大平台；只留 1.1 m 矮墙 →
    // 跟拍机位贴着墙走时，矮墙在近景透视里仍会占满整屏（00:20 实拍）。
    // 结论：墙一律收起，房间边界改用绝不挡镜头的「扁平地毯」划分（见下）。
    const W = (mat, x, y, z, bw, bh, bd) => {
      const mesh = B(g, mat, x, y, z, bw, bh, bd);
      mesh.userData.tag = 'roomWall';
      return mesh;
    };
    // 墙高只到 1.1 m：跟拍机位在人物身后 4.6 m / 高 2.3 m，整面 2.8 m
    // 的墙会正好怼在镜头前。矮墙 + 几根细窗框柱既划出房间边界，又通透。
    W(M.concrete, -(ww / 2 + side / 2), 0.55, wy, side, 1.1, 0.16);
    W(M.concrete, (ww / 2 + side / 2), 0.55, wy, side, 1.1, 0.16);
    W(M.concrete, 0, 0.52, wy, ww, 1.04, 0.16);
    W(M.concrete, 0, 2.66, wy + 0.02, ww, 0.14, 0.16);   // 窗楣细梁
    W(M.metalDark, -ww / 2, 1.85, wy + 0.09, 0.07, 1.6, 0.05);
    W(M.metalDark, ww / 2, 1.85, wy + 0.09, 0.07, 1.6, 0.05);
    W(M.metalDark, 0, 2.60, wy + 0.09, ww, 0.07, 0.05);
    W(M.concrete, -w / 2, 0.55, 0, 0.16, 1.1, d);          // 左矮墙
    B(g, M.woodDark, 0, 0.16, wy + 0.09, w, 0.32, 0.04);     // 踢脚线
  }
  // 【房间边界】镜头进楼时剖面墙会被全部收起，整层就成了一整片木地板。
  // 铺一块 2 cm 厚的扁平地毯划出边界：任何机位都不可能挡镜头，俯视却
  // 一眼能分出几间房（00:20 卧室实拍 5 个人散在同一块地板上的修正）。
  B(g, M.woodDark, 0, 0.011, 0, w * 0.88, 0.022, d * 0.88);
  if (lamp) {
    B(g, M.light, 0, 2.72, 0, Math.min(1.5, w * 0.28), 0.06, 0.34);   // 吸顶灯管
    B(g, M.metalDark, 0, 2.78, 0, Math.min(1.56, w * 0.3), 0.04, 0.4); // 灯槽
  }
  if (tiles > 0) {
    const t = [];
    const n = Math.max(4, tiles);
    for (let i = 0; i < n; i++) {
      t.push({ x: -w / 2 + 0.6 + (i % 6) * 0.9, y: -0.02, z: -d / 2 + 0.6 + Math.floor(i / 6) * 0.9,
        sx: 0.84, sy: 0.03, sz: 0.84 });
    }
    boxes(g, M.concrete, t);
  }
}

// 一把办公椅：座 + 靠背 + 气杆 + 五星脚（五角用 3 根短杆近似）
function chairAt(g, x, z, ry = 0) {
  B(g, M.dark, x, 0.44, z, 0.46, 0.07, 0.44, ry);
  B(g, M.dark, x + Math.sin(ry) * 0.21, 0.72, z + Math.cos(ry) * 0.21, 0.44, 0.46, 0.06, ry);
  CY(g, M.metalDark, x, 0.24, z, 0.03, 0.34);
  const legs = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + ry;
    legs.push({ x: x + Math.cos(a) * 0.15, y: 0.09, z: z + Math.sin(a) * 0.15,
      sx: 0.03, sy: 0.02, sz: 0.3, ry: -a + Math.PI / 2 });
  }
  boxes(g, M.metalDark, legs);
}

// 一张工位：桌面 + 桌腿 + 显示器 + 键盘 + 隔断
function deskAt(g, x, z, rep, ry = 0) {
  B(g, M.wood, x, 0.74, z, 1.5, 0.06, 0.72, ry);
  B(g, M.metalDark, x - 0.66, 0.37, z, 0.06, 0.72, 0.06);
  B(g, M.metalDark, x + 0.66, 0.37, z, 0.06, 0.72, 0.06);
  // 显示器：机背 + 发光屏 + 支架
  B(g, M.black, x, 1.14, z - 0.2, 0.58, 0.36, 0.04);
  B(g, M.screenOn, x, 1.14, z - 0.175, 0.52, 0.3, 0.01);
  B(g, M.metalDark, x, 0.92, z - 0.2, 0.05, 0.2, 0.05);
  B(g, M.metalDark, x, 0.79, z - 0.2, 0.24, 0.02, 0.14);
  B(g, M.metalDark, x, 0.78, z + 0.1, 0.44, 0.03, 0.14);   // 键盘
  B(g, M.dark, x + 0.5, 0.78, z + 0.12, 0.1, 0.03, 0.12);  // 鼠标位
  chairAt(g, x, z + 0.62, Math.PI);
}

// 盆栽：盆 + 双球叶
function plantAt(g, x, z, s = 1) {
  CY(g, M.rust, x, 0.22 * s, z, 0.22 * s, 0.44 * s);
  const sp = new THREE.Mesh(G.sphere, M.green);
  sp.position.set(x, 0.72 * s, z);
  sp.scale.setScalar(0.62 * s);
  sp.castShadow = true; g.add(sp);
  const sp2 = new THREE.Mesh(G.sphere, M.green);
  sp2.position.set(x + 0.14 * s, 0.98 * s, z - 0.1 * s);
  sp2.scale.setScalar(0.4 * s);
  g.add(sp2);
}

/* ------------------------------------------------------------------ *
 * 4d) 11 个原本只有「一块小立牌」的场景，补成真正看得懂的房间。
 * ------------------------------------------------------------------ */

// sc_office_6f：6 个工位（桌面/显示器/键盘/椅/隔断）+ 白板 + 打印机 + 绿植。
function bOpenOffice(g, rep) {
  roomFloor(g, 13, 9, { lamp: true });
  B(g, M.floor, 0, 0.01, 0, 12.4, 0.02, 8.4);           // 地毯
  const n = rep(6);
  for (let i = 0; i < n; i++) {
    const col = i % 3, row = Math.floor(i / 3);
    deskAt(g, -4.2 + col * 4.2, -2.0 + row * 4.0, rep);
  }
  // 每个工位自带一小块隔断就够了；旧版拉了一条 12 m 长的通板横穿整间办公室，
  // 跟拍时正好挡在镜头前（整屏一条青色板）。
  for (let i = 0; i < n; i++) {
    const col = i % 3, row = Math.floor(i / 3);
    B(g, M.fabric, -4.2 + col * 4.2, 1.02, -2.0 + row * 4.0 - 0.42, 1.45, 0.5, 0.06);
  }
  // 白板
  B(g, M.paper, 0, 1.62, -4.28, 3.4, 1.2, 0.05);
  B(g, M.metal, 0, 2.24, -4.28, 3.5, 0.06, 0.08);
  // 打印机柜
  B(g, M.white, 4.6, 0.44, 3.4, 1.0, 0.88, 0.7);
  B(g, M.black, 4.6, 0.95, 3.4, 0.8, 0.14, 0.5);
  B(g, M.screenOn, 4.6, 1.05, 3.15, 0.4, 0.06, 0.02);
  plantAt(g, -5.6, 3.5, 1.1);
  plantAt(g, 5.6, -3.6, 1.0);
  // 饮水机
  B(g, M.white, -6.0, 0.62, -3.6, 0.42, 1.24, 0.42);
  CY(g, M.blue, -6.0, 1.36, -3.6, 0.14, 0.34);
}

// sc_office_lobby：前台（L 形）+ 背景墙 + 沙发 + 茶几 + 电梯门 ×2 + 绿植。
function bOfficeLobby(g, rep) {
  roomFloor(g, 14, 10, { lamp: true, mat: M.concrete });
  // 前台
  B(g, M.woodDark, 0, 0.54, 0, 4.2, 1.08, 0.9);
  B(g, M.steel, 0, 1.11, 0, 4.4, 0.06, 1.0);
  B(g, M.white, 0, 0.1, 0.62, 4.0, 0.2, 0.5);          // 前台底座
  B(g, M.metalDark, 3.4, 0.54, -1.6, 0.9, 1.08, 2.6);  // 侧翼
  B(g, M.light, 0, 2.5, -0.5, 5.0, 0.1, 0.3);           // 背景墙灯带
  B(g, M.paper, 0, 1.8, -3.9, 6.0, 1.4, 0.1);           // 背景墙
  B(g, M.blue, -1.2, 2.0, -3.83, 2.2, 0.5, 0.04);       // 标识色块
  // 沙发 + 茶几
  B(g, M.fabric, -4.4, 0.32, 2.4, 0.9, 0.42, 2.4);
  B(g, M.fabric, -4.85, 0.66, 2.4, 0.2, 0.6, 2.4);
  B(g, M.glass, -3.2, 0.42, 2.4, 1.1, 0.05, 0.8);
  CY(g, M.steel, -3.2, 0.21, 2.4, 0.14, 0.42);
  // 电梯门 ×2
  for (const ex of [5.2, 7.6]) {
    B(g, M.steel, ex, 1.15, -4.4, 1.9, 2.3, 0.12);
    B(g, M.metalDark, ex, 1.15, -4.33, 0.04, 2.3, 0.02);
    B(g, M.light, ex, 2.36, -4.3, 0.5, 0.12, 0.04);
  }
  plantAt(g, -6.2, -3.7, 1.3);
  plantAt(g, 6.6, 3.6, 1.1);
  B(g, M.paper, 4.6, 1.5, 4.6, 1.6, 1.0, 0.06);         // 楼层导视
}

// sc_office_stairs：8 级踏步 + 休息平台 + 双侧扶手。
function bOfficeStairs(g, rep) {
  const n = rep(8);
  const steps = [];
  for (let i = 0; i < n; i++) {
    steps.push({ x: 0, y: 0.09 + i * 0.17, z: -1.6 + i * 0.34, sx: 3.0, sy: 0.17, sz: 0.34 });
  }
  boxes(g, M.concrete, steps);
  B(g, M.concrete, 0, 0.09 + n * 0.17, -1.6 + n * 0.34 + 0.9, 3.0, 0.18, 1.8); // 平台
  // 扶手：立杆 + 斜扶手
  const posts = [];
  for (let i = 0; i <= n; i += 2) {
    for (const sx of [-1.45, 1.45]) {
      posts.push({ x: sx, y: 0.09 + i * 0.17 + 0.5, z: -1.6 + i * 0.34, sx: 0.06, sy: 1.0, sz: 0.06 });
    }
  }
  boxes(g, M.metalDark, posts);
  const rail = new THREE.Mesh(G.box, M.steel);
  rail.position.set(-1.45, 0.09 + n * 0.17 * 0.5 + 1.0, -1.6 + n * 0.17);
  rail.scale.set(0.06, 0.06, n * 0.42);
  rail.rotation.x = -Math.atan2(n * 0.17, n * 0.34);
  g.add(rail);
  const rail2 = rail.clone();
  rail2.position.x = 1.45; g.add(rail2);
  // 楼层指示
  B(g, M.light, 0, 2.3, -2.4, 1.2, 0.34, 0.06);
}

// sc_cafe_counter：吧台 + 咖啡机 + 杯架 + 甜品柜 + 菜单板 + 3 张高脚凳。
function bCafeCounter(g, rep) {
  roomFloor(g, 9, 7, { lamp: true, mat: M.wood });
  // 吧台：正面木饰 + 台面 + 脚踢
  B(g, M.woodDark, 0, 0.52, 0, 5.4, 1.04, 0.8);
  B(g, M.wood, 0, 1.06, 0, 5.6, 0.08, 0.94);
  B(g, M.metalDark, 0, 0.06, 0.36, 5.4, 0.12, 0.06);
  // 咖啡机：机体 + 顶盖 + 双冲煮头 + 滴水盘 + 蒸汽杆
  B(g, M.steel, -1.5, 1.42, -0.1, 0.86, 0.66, 0.62);
  B(g, M.metalDark, -1.5, 1.78, -0.1, 0.9, 0.1, 0.66);
  B(g, M.black, -1.72, 1.24, 0.24, 0.16, 0.2, 0.1);
  B(g, M.black, -1.28, 1.24, 0.24, 0.16, 0.2, 0.1);
  B(g, M.steel, -1.5, 1.13, 0.26, 0.8, 0.04, 0.24);
  CY(g, M.steel, -1.02, 1.3, 0.22, 0.02, 0.3);
  // 杯堆 + 磨豆机 + 收银
  const cups = [], nc = rep(6);
  for (let i = 0; i < nc; i++) {
    cups.push({ x: 0.2 + (i % 3) * 0.16, y: 1.14 + Math.floor(i / 3) * 0.12, z: -0.15, sx: 0.1, sy: 0.12, sz: 0.1 });
  }
  cyls(g, M.linen, cups);
  B(g, M.metalDark, 1.4, 1.4, -0.1, 0.34, 0.6, 0.34);
  CY(g, M.glass, 1.4, 1.74, -0.1, 0.14, 0.22);
  B(g, M.black, 2.3, 1.3, -0.05, 0.44, 0.18, 0.36);
  B(g, M.screenOn, 2.3, 1.3, 0.14, 0.34, 0.12, 0.02);
  // 甜品柜：玻璃罩 + 两层点心
  B(g, M.glass, 0.4, 1.42, 0.28, 1.4, 0.34, 0.42);
  B(g, M.linen, 0.4, 1.28, 0.28, 1.36, 0.06, 0.38);
  const cakes = [];
  for (let i = 0; i < rep(6); i++) {
    cakes.push({ x: -0.16 + i * 0.22, y: 1.36, z: 0.28, sx: 0.16, sy: 0.1, sz: 0.16 });
  }
  boxes(g, M.fabricWarm, cakes);
  // 菜单板（自发光，无贴图）
  B(g, M.black, 0, 2.3, -0.5, 3.6, 0.9, 0.08);
  for (let i = 0; i < 3; i++) B(g, M.paper, -0.9 + i * 0.9, 2.3, -0.44, 0.66, 0.5, 0.02);
  // 3 张高脚凳
  for (let i = 0; i < rep(3); i++) {
    const sx = -1.6 + i * 1.6;
    CY(g, M.metal, sx, 0.36, 0.95, 0.05, 0.72);
    B(g, M.woodDark, sx, 0.74, 0.95, 0.42, 0.08, 0.42);
    CY(g, M.steel, sx, 0.16, 0.95, 0.2, 0.03);
  }
}

// sc_cafe_tables：3 张圆桌 + 每桌 2 椅 + 3 盏吊灯 + 窗边吧台。
function bCafeTables(g, rep) {
  roomFloor(g, 10, 8, { lamp: false, mat: M.wood });
  const n = rep(3);
  for (let i = 0; i < n; i++) {
    const tx = -3.0 + i * 3.0, tz = 0.6;
    CY(g, M.woodDark, tx, 0.72, tz, 0.52, 0.06);        // 桌面
    CY(g, M.metalDark, tx, 0.36, tz, 0.06, 0.7);        // 腿
    CY(g, M.metalDark, tx, 0.02, tz, 0.28, 0.04);       // 底盘
    // 桌上小物
    B(g, M.linen, tx + 0.14, 0.78, tz - 0.08, 0.1, 0.1, 0.1);
    B(g, M.glass, tx - 0.16, 0.8, tz + 0.1, 0.08, 0.14, 0.08);
    // 两把椅子
    for (const s of [-1, 1]) {
      B(g, M.wood, tx + s * 0.92, 0.44, tz, 0.42, 0.06, 0.42);
      B(g, M.wood, tx + s * 1.12, 0.68, tz, 0.06, 0.48, 0.42);
      for (const dx of [-0.16, 0.16]) {
        for (const dz of [-0.16, 0.16]) {
          B(g, M.woodDark, tx + s * 0.92 + dx, 0.22, tz + dz, 0.05, 0.44, 0.05);
        }
      }
    }
    // 吊灯：细杆 + 锥罩 + 发光盘
    CY(g, M.metalDark, tx, 2.32, tz, 0.014, 0.8);
    CO(g, M.metalDark, tx, 1.94, tz, 0.24, 0.22);
    CY(g, M.lampGlow, tx, 1.84, tz, 0.16, 0.04);
  }
  // 窗边吧台 + 高脚凳
  B(g, M.woodDark, 0, 1.02, -3.6, 8.6, 0.08, 0.6);
  B(g, M.metalDark, 0, 0.5, -3.6, 8.6, 0.04, 0.5);
  for (let i = 0; i < rep(4); i++) {
    const sx = -2.7 + i * 1.8;
    CY(g, M.metal, sx, 0.34, -3.0, 0.05, 0.68);
    B(g, M.wood, sx, 0.7, -3.0, 0.4, 0.07, 0.4);
  }
  plantAt(g, 4.4, 3.4, 1.1);
}

// sc_clinic_lobby1f：导诊台 + 候诊椅 ×4 + 叫号屏 + 饮水机 + 绿植。
function bClinicLobby(g, rep) {
  roomFloor(g, 11, 8, { lamp: true, mat: M.white });
  B(g, M.white, 0, 0.52, -3.2, 4.0, 1.04, 0.8);         // 导诊台
  B(g, M.steel, 0, 1.07, -3.2, 4.2, 0.06, 0.9);
  B(g, M.blue, 0, 0.6, -3.58, 2.0, 0.3, 0.04);          // 台前色条
  SC(g, 0, 1.9, -3.55, 1.6, 0.62);                       // 叫号屏
  const n = rep(4);
  for (let i = 0; i < n; i++) {
    const sx = -2.4 + i * 1.6;
    B(g, M.blue, sx, 0.42, 0.6, 1.3, 0.08, 0.5);         // 候诊长椅座
    B(g, M.blue, sx, 0.68, 0.84, 1.3, 0.5, 0.08);        // 靠背
    B(g, M.metal, sx - 0.6, 0.2, 0.6, 0.06, 0.4, 0.42);
    B(g, M.metal, sx + 0.6, 0.2, 0.6, 0.06, 0.4, 0.42);
    B(g, M.metal, sx, 0.84, 0.6, 1.3, 0.04, 0.04);       // 扶手
  }
  B(g, M.white, 4.6, 0.62, -2.0, 0.44, 1.24, 0.44);      // 饮水机
  CY(g, M.blue, 4.6, 1.38, -2.0, 0.15, 0.34);
  B(g, M.paper, -3.6, 1.7, -3.5, 1.4, 1.0, 0.06);        // 就诊流程板
  plantAt(g, -4.6, 3.2, 1.2);
}

// sc_school_class3f：黑板 + 讲台 + 12 套课桌 + 挂钟 + 书架。
function bClassroom(g, rep) {
  roomFloor(g, 12, 9, { lamp: true, mat: M.woodLight });
  B(g, M.dark, 0, 1.6, -4.28, 5.2, 1.4, 0.08);           // 黑板
  B(g, M.woodDark, 0, 0.88, -4.28, 5.4, 0.08, 0.2);      // 粉笔槽
  B(g, M.paper, 2.6, 1.78, -4.28, 1.1, 0.8, 0.05);       // 通知纸
  B(g, M.wood, 0, 0.4, -3.4, 1.8, 0.8, 0.7);             // 讲台
  B(g, M.woodDark, 0, 0.82, -3.4, 1.9, 0.06, 0.8);
  CY(g, M.white, 0, 1.02, -3.4, 0.18, 0.06);             // 地球仪底座
  const sp = new THREE.Mesh(G.sphere, M.blue);
  sp.position.set(0, 1.2, -3.4); sp.scale.setScalar(0.3); g.add(sp);
  // 12 套课桌：3 排 × 4 列
  const cols = 4, rows = 3;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r * cols + c >= rep(12)) break;
      const dx = -3.6 + c * 2.4, dz = -1.6 + r * 2.2;
      B(g, M.woodLight, dx, 0.68, dz, 1.1, 0.06, 0.5);        // 桌面
      B(g, M.metal, dx, 0.34, dz, 0.06, 0.68, 0.06);          // 桌腿
      B(g, M.woodDark, dx, 0.42, dz + 0.5, 0.44, 0.06, 0.42); // 椅子
      B(g, M.woodDark, dx, 0.66, dz + 0.7, 0.44, 0.44, 0.05);
      B(g, M.paper, dx, 0.72, dz - 0.02, 0.3, 0.02, 0.22);    // 书本
    }
  }
  // 挂钟
  CY(g, M.white, 3.6, 2.2, -4.26, 0.24, 0.04, { x: Math.PI / 2 });
  CY(g, M.black, 3.6, 2.2, -4.22, 0.235, 0.01, { x: Math.PI / 2 });
  // 书架
  B(g, M.woodDark, -4.6, 0.9, -1.2, 0.5, 1.8, 2.2);
  for (let i = 0; i < 3; i++) B(g, M.wood, -4.6, 0.4 + i * 0.55, -1.2, 0.56, 0.04, 2.1);
}

// sc_school_corridor：储物柜 ×10 + 公告栏 + 长椅 + 消防箱 + 垃圾桶。
function bCorridor(g, rep) {
  roomFloor(g, 14, 4.2, { lamp: true, mat: M.concrete });
  const n = rep(10);
  for (let i = 0; i < n; i++) {
    const x = -5.4 + i * 1.1;
    B(g, M.blue, x, 0.9, -1.75, 1.0, 1.8, 0.5);            // 柜体
    B(g, M.metalDark, x, 0.9, -1.49, 0.9, 0.03, 0.02);     // 门缝
    B(g, M.steel, x + 0.32, 0.9, -1.46, 0.06, 0.16, 0.03); // 把手
    B(g, M.light, x, 1.74, -1.49, 0.5, 0.06, 0.02);        // 柜号灯条
  }
  B(g, M.paper, 0, 1.7, 1.9, 3.2, 1.1, 0.06);              // 公告栏
  for (let i = 0; i < rep(4); i++) {
    B(g, M.red, -1.2 + (i % 2) * 0.7, 1.9 - Math.floor(i / 2) * 0.42, 1.86, 0.5, 0.34, 0.02);
  }
  B(g, M.wood, 3.4, 0.44, 1.7, 2.4, 0.08, 0.42);           // 长椅
  B(g, M.metal, 2.6, 0.22, 1.7, 0.06, 0.44, 0.38);
  B(g, M.metal, 4.2, 0.22, 1.7, 0.06, 0.44, 0.38);
  B(g, M.red, -4.2, 1.2, 1.9, 0.36, 0.6, 0.16);            // 消防箱
  CY(g, M.metalDark, 5.4, 0.34, 1.7, 0.2, 0.68);           // 垃圾桶
}

// sc_garage_office：地下/地面车库 —— 立柱 + 划线车位 + 坡道 + 标识 + 两辆车。
function bGarage(g, rep) {
  roomFloor(g, 18, 12, { lamp: false, mat: M.concrete });
  // 顶灯
  for (const lx of [-6, 0, 6]) {
    B(g, M.light, lx, 2.5, 0, 1.6, 0.08, 0.3);
  }
  // 立柱
  for (const cxp of [-6, 0, 6]) for (const czp of [-4.4, 4.4]) {
    B(g, M.concrete, cxp, 1.4, czp, 0.5, 2.8, 0.5);
    B(g, M.yellow, cxp, 0.5, czp, 0.54, 0.16, 0.54);
  }
  // 车位划线：3 个位，两侧白线 + 后挡
  for (let i = 0; i < 3; i++) {
    const bx = -6.4 + i * 3.4;
    B(g, M.paper, bx, 0.01, 0, 0.12, 0.02, 5.0);
    B(g, M.paper, bx + 3.4, 0.01, 0, 0.12, 0.02, 5.0);
    B(g, M.paper, bx + 1.7, 0.01, -2.5, 3.4, 0.02, 0.12);
  }
  // 两辆简化车（车头朝 +Z，与地面划线垂直）
  for (const [i, cx] of [[0, -4.7], [1, -1.3]]) {
    B(g, M.dark, cx, 0.62, 0.1, 1.7, 0.5, 4.0);
    B(g, M.black, cx, 1.0, -0.2, 1.5, 0.6, 2.0);
    B(g, M.glass, cx, 1.02, 0.82, 1.42, 0.5, 0.06);
    B(g, M.glass, cx, 1.02, -1.2, 1.42, 0.5, 0.06);
    for (const wx of [-0.85, 0.85]) for (const wz of [-1.4, 1.4]) {
      CY(g, M.black, cx + wx, 0.32, wz, 0.32, 0.22, { z: Math.PI / 2 });
    }
    B(g, M.light, cx - 0.55, 0.66, 2.02, 0.28, 0.14, 0.05);
    B(g, M.light, cx + 0.55, 0.66, 2.02, 0.28, 0.14, 0.05);
  }
  // 坡道 + 出口标识
  B(g, M.concrete, 6.6, 0.06, 4.0, 4.0, 0.12, 3.0).rotation.x = 0.08;
  B(g, M.yellow, 6.6, 1.9, 5.4, 2.0, 0.4, 0.06);
}

// sc_street_corner：路口 —— 信号灯杆 + 路名牌 + 消防栓 + 长椅 + 垃圾桶 + 斑马线。
function bStreetCorner(g, rep) {
  // 不再铺 10×10 的整块铺装：它悬在路口上方，比四周路面高，看起来像一块
  // 漂在街上水泥板。街道本身有路面与人行道，这里只放路口该有的东西。
  B(g, M.concrete, 0, 0.02, 0, 6.4, 0.08, 6.4);          // 与路面齐平的路口铺装
  // 信号灯杆
  CY(g, M.metalDark, 0, 2.1, 0, 0.09, 4.2);
  CY(g, M.metalDark, 1.2, 4.0, 0, 0.05, 2.4, { z: Math.PI / 2 });
  B(g, M.black, 2.2, 3.7, 0, 0.34, 0.9, 0.3);
  B(g, M.red, 2.2, 3.98, 0.16, 0.2, 0.2, 0.03);
  B(g, M.yellow, 2.2, 3.7, 0.16, 0.2, 0.2, 0.03);
  B(g, M.green, 2.2, 3.42, 0.16, 0.2, 0.2, 0.03);
  // 路名牌
  CY(g, M.steel, -3.2, 1.6, 0, 0.05, 3.2);
  B(g, M.green, -3.2, 3.1, 0, 1.8, 0.34, 0.05);
  B(g, M.paper, -3.2, 3.1, 0.03, 1.6, 0.2, 0.02);
  // 消防栓 + 长椅 + 垃圾桶
  CY(g, M.red, 2.0, 0.34, 2.4, 0.14, 0.68);
  B(g, M.red, 2.0, 0.72, 2.4, 0.34, 0.12, 0.34);
  B(g, M.wood, -1.6, 0.44, 2.6, 2.2, 0.08, 0.5);
  B(g, M.metalDark, -2.4, 0.22, 2.6, 0.06, 0.44, 0.44);
  B(g, M.metalDark, -0.8, 0.22, 2.6, 0.06, 0.44, 0.44);
  CY(g, M.metalDark, 0.4, 0.36, 3.4, 0.22, 0.72);
  // 路口的斑马线由路网自己画，这里不再重复画一条（会被铺装盖住、且位置对不齐）
  plantAt(g, -4.2, 3.6, 0.9);
}

// sc_road_commute：通勤路段 —— 公交站牌 + 站台缘石 + 候车护栏 + 自行车架。
function bCommute(g, rep) {
  B(g, M.concrete, 0, 0.02, 1.4, 9, 0.06, 1.6);         // 站台（靠人行道一侧，齐平）
  CY(g, M.steel, 0, 1.7, 0, 0.06, 3.4);                 // 站牌杆
  B(g, M.blue, 0, 3.0, 0, 0.9, 0.9, 0.05);              // 站牌
  B(g, M.paper, 0, 3.05, 0.04, 0.7, 0.5, 0.02);
  B(g, M.paper, 0, 2.25, 0.04, 1.5, 0.5, 0.03);         // 线路表
  // 护栏
  for (let i = 0; i < rep(4); i++) {
    const x = -3.0 + i * 2.0;
    CY(g, M.steel, x, 0.5, -1.2, 0.04, 1.0);
  }
  B(g, M.steel, -2.0, 1.0, -1.2, 6.0, 0.05, 0.05);
  B(g, M.steel, -2.0, 0.6, -1.2, 6.0, 0.04, 0.04);
  // 自行车架
  for (let i = 0; i < rep(3); i++) {
    const x = 2.6 + i * 0.9;
    TO(g, M.steel, x, 0.4, 1.2, 0.7, { x: 0 });
  }
}

/* ------------------------------------------------------------------ *
 * 5) 清单外场景：既有模块（或日程/街景层）已覆盖精细内容，只补一个定位标记物，
 *    不重复造整屋、不堆重复物件。
 * ------------------------------------------------------------------ */
function buildMarker(g) {
  B(g, M.marker, 0, 0.45, 0, 0.5, 0.9, 0.05);          // 一块小立牌，标示该场景锚点
  B(g, M.yellow, 0, 0.82, 0.04, 0.34, 0.08, 0.02);     // 顶端色条
}

/* ------------------------------------------------------------------ *
 * 6) 按 scene.id 分派。kind 用于室内/室外判定（影响 y 与 onRoad 避让）。
 * ------------------------------------------------------------------ */
const BUILDERS = {
  sc_home_bedroom:      { fn: bBedroom,    kind: 'indoor'  },
  sc_home_kitchen:      { fn: bKitchen,    kind: 'indoor'  },
  sc_home_living:       { fn: bLiving,     kind: 'indoor'  },
  sc_home_lobby:        { fn: bLobby,      kind: 'indoor'  },
  sc_home_hall9f:       { fn: bHall9f,     kind: 'indoor'  },
  sc_home_study9f:      { fn: bStudy,      kind: 'indoor'  },
  sc_home_kids9f:       { fn: bKids,       kind: 'indoor'  },
  sc_home_shared9f:     { fn: bShared,     kind: 'indoor'  },
  sc_home_studio9f:     { fn: bStudio,     kind: 'indoor'  },
  // 【2026-11-07】这 11 个原本只有一块 0.5 m 小立牌，现在都是真房间
  sc_office_6f:         { fn: bOpenOffice, kind: 'indoor'  },
  sc_office_lobby:      { fn: bOfficeLobby, kind: 'indoor' },
  sc_office_stairs:     { fn: bOfficeStairs, kind: 'indoor' },
  sc_cafe_counter:      { fn: bCafeCounter, kind: 'indoor' },
  sc_cafe_tables:       { fn: bCafeTables,  kind: 'indoor' },
  sc_clinic_lobby1f:    { fn: bClinicLobby, kind: 'indoor' },
  sc_school_class3f:    { fn: bClassroom,  kind: 'indoor'  },
  sc_school_corridor:   { fn: bCorridor,   kind: 'indoor'  },
  sc_garage_office:     { fn: bGarage,     kind: 'indoor'  },
  sc_street_corner:     { fn: bStreetCorner, kind: 'outdoor' },
  sc_road_commute:      { fn: bCommute,    kind: 'outdoor' },
  sc_office_meeting3f:  { fn: bMeeting,    kind: 'indoor'  },
  sc_clinic_treatment:  { fn: bTreatment,  kind: 'indoor'  },
  sc_clinic_or2f:       { fn: bOR,         kind: 'indoor'  },
  sc_clinic_recovery:   { fn: bRecovery,   kind: 'indoor'  },
  sc_school_music5f:    { fn: bMusic,      kind: 'indoor'  },
  sc_site_pit:          { fn: bPit,        kind: 'outdoor' },
  sc_site_container:    { fn: bContainer,  kind: 'semi'    },
  sc_site_shed:         { fn: bShed,       kind: 'semi'    },
  sc_street_shelter:    { fn: bShelter,    kind: 'semi'    },
  sc_street_ride:       { fn: bRide,       kind: 'outdoor' },
  sc_cafe_backdoor:     { fn: bBackdoor,   kind: 'semi'    },
  sc_school_gate:       { fn: bGate,       kind: 'semi'    },
  sc_route_cafe_market: { fn: bRoute,      kind: 'outdoor' },
};

/* ------------------------------------------------------------------ *
 * 7) 主入口：遍历 scenes，按 id 建景、定位、避让、统计。
 * ------------------------------------------------------------------ */
export async function buildLifeScenes({
  world,            // THREE.Group / Scene：把生成的 group add 进去
  places = {},      // day_full.json 的 places 对象
  scenes = [],      // day_full.json 的 scenes 数组
  groundAt,         // (x,z)=>y 地面高程
  baseY = {},       // 可选：{ office, home, ... } 每栋楼室内首层基准高
  placeFit = {},    // 可选：{ home:{baseY,floorH}, office:{...} } 每栋楼真实层高
  floorH = 3.6,     // 兜底层高（有 placeFit 时按楼取值）
  floorOf = null,   // 可选 (sceneId)=>楼层数字
  onRoad = null,    // 可选 (x,z)=>bool：true 表示在车行道上
  quality = 'full', // 'full' | 'lite'
} = {}) {
  const group = new THREE.Group();
  group.name = 'life-scenes';
  if (world && typeof world.add === 'function') world.add(group);

  const lite = quality === 'lite';
  // 重复件数量减半（椅子、课桌、钢筋、谱架、琴键、地砖、信箱格等）
  const rep = (n) => (lite ? Math.max(1, Math.ceil(n / 2)) : n);
  const gy = typeof groundAt === 'function' ? groundAt : () => 0;
  const safeY = (x, z) => { const v = gy(x, z); return Number.isFinite(v) ? v : 0; };

  const stats = { built: 0, skipped: 0, meshes: 0, markers: 0, relocated: 0, byPlace: {} };
  const placedOutdoor = {};   // placeKey → 已放置的室外场景坐标（防互相穿插）
  const placedIndoor = {};    // `${placeKey}|${楼层y}` → 同层已排的房间数
  const floorGroups = new Map(); // 同层房间 → 补一整块连通楼板
  const sceneIds = [];

  for (const sc of scenes) {
    const id = sc && sc.id;
    if (!id) { stats.skipped++; continue; }
    const placeKey = sc.place;
    const P = parsePlace(places[placeKey]);
    if (!P) { stats.skipped++; continue; }

    // lite：跳过 P3（priority >= 3）场景
    if (lite && (sc.priority || 1) >= 3) { stats.skipped++; continue; }

    const def = BUILDERS[id];
    const kind = sc.kind || (def && def.kind) || 'indoor';
    const needRoad = kind !== 'indoor' && typeof onRoad === 'function';

    // 用 scene.id 的稳定哈希把不同场景错开到 footprint 内不同象限，避免道具堆一起
    const [ha, hb] = hash2(id);
    let cx = P.x + (ha * 2 - 1) * P.w * 0.2;
    let cz = P.z + (hb * 2 - 1) * P.d * 0.2;

    // 室外/半室外道具避开压车行道：沿 4 方向最多 12 次试探
    if (needRoad && onRoad(cx, cz)) {
      const spot = findFreeSpot(cx, cz, P, onRoad);
      if (!spot) { stats.skipped++; continue; }
      cx = spot.x; cz = spot.z; stats.relocated++;
    }

    // 【2026-11-07】室外场景互相穿插是真问题：street 这个地点有街角、电动车、
    // 候车亭、通勤路段 4 个场景，哈希把它们全撒在同一个 16×16 人行道上，
    // 结果候车亭的顶棚直接盖在街角长椅和信号灯上方 —— 一眼就是「场景离谱」。
    // 这里给同一地点的室外场景强制一个最小间距，按确定性顺序沿人行道排开。
    if (kind !== 'indoor') {
      const list = placedOutdoor[placeKey] || (placedOutdoor[placeKey] = []);
      const MIN_SEP = 7.5;
      for (let guard = 0; guard < 8; guard++) {
        let hit = null;
        for (const q of list) {
          const dd = Math.hypot(cx - q.x, cz - q.z);
          if (dd < MIN_SEP) { hit = { q, dd }; break; }
        }
        if (!hit) break;
        // 沿 x 方向推开到刚好 MIN_SEP，方向取离楼心更远的一侧
        const sign = (cx >= P.x ? 1 : -1) * (guard % 2 === 0 ? 1 : -1);
        const need = Math.sqrt(Math.max(0, MIN_SEP * MIN_SEP - (cz - hit.q.z) ** 2)) + 0.2;
        cx = hit.q.x + sign * need;
        cz = hit.q.z + (cz - hit.q.z) * 0.35;
        if (onRoad && onRoad(cx, cz)) {
          const spot = findFreeSpot(cx, cz, P, onRoad);
          if (!spot) break;
          cx = spot.x; cz = spot.z;
        }
        stats.relocated++;
      }
      list.push({ x: cx, z: cz, id });
    }

    // 楼层：floorOf 覆盖 > id 推断；室内按【该栋楼真实层高】抬高，室外落地面
    const floor = (typeof floorOf === 'function' && Number.isFinite(floorOf(id)))
      ? floorOf(id) : floorFromId(id);
    const fit = placeFit[placeKey] || DEFAULT_FIT[placeKey] || null;
    const fh = (fit && Number.isFinite(fit.floorH)) ? fit.floorH : floorH;
    const base = Number.isFinite(baseY[placeKey]) ? baseY[placeKey]
      : (fit && Number.isFinite(fit.baseY)) ? fit.baseY : safeY(P.x, P.z);
    const y = kind === 'indoor' ? base + (floor - 1) * fh : safeY(cx, cz);

    // 【2026-11-08 实拍修正】室内场景原来只按 id 哈希撒点、互不避让，
    // 补了 4 间 9F 卧室后有两间的后墙直接压在跟拍机位前（整屏一堵灰墙）。
    // 同一栋楼同一层的房间改成确定性网格排布：横向 13 m 一档、纵向错两排，
    // 全部落在 footprint 内，既不重叠也不会挡住别的房间。
    if (kind === 'indoor') {
      const gkey = `${placeKey}|${Math.round(y)}`;
      const idx = placedIndoor[gkey] || 0;
      placedIndoor[gkey] = idx + 1;
      const cols = Math.max(2, Math.floor((P.w || 20) / 13));
      const col = idx % cols, row = Math.floor(idx / cols);
      // 系数 0.62 / 0.24 保证小 footprint（咖啡馆只有 12.87 m 宽）也排得下，
      // 房间锚点不会落到楼外 —— 否则跟拍机位跟着出楼，cameraInsideBuilding
      // 判定失败，整栋楼不剖切，镜头前就是一堵外墙。
      const stepX = Math.min(13, (P.w || 20) * 0.62 / Math.max(1, cols - 1));
      const stepZ = Math.min(9, (P.d || 20) * 0.24);
      cx = P.x + (col - (cols - 1) / 2) * stepX;
      cz = P.z + (row % 3 - 1) * stepZ;
      const fkey = `${placeKey}|${Math.round(y)}`;
      let fg = floorGroups.get(fkey);
      if (!fg) { fg = { placeKey, y, P, n: 0 }; floorGroups.set(fkey, fg); }
      fg.n++;
      stats.relocated++;
    }

    const anchor = new THREE.Group();
    anchor.name = id;
    anchor.position.set(cx, y, cz);
    group.add(anchor);

    if (def) def.fn(anchor, rep);
    else { buildMarker(anchor); stats.markers++; }

    // 【房间壳】老 builder（床 / 厨房 / 客厅 / 会议室 / 处置室 / 教室…）只摆家具，
    // 没有地板没有墙。镜头进楼时整栋楼会被隐藏，于是「一间家具悬在马路上」。
    // 这里按家具的实际包围盒补一间封闭房间：地板 + 四面墙 + 顶棚 + 吸顶灯。
    if (kind === 'indoor' && !anchor.userData.hasRoom) {
      const bb = new THREE.Box3().setFromObject(anchor);
      const w = Math.max(5.0, bb.max.x - bb.min.x + 2.4);
      const d = Math.max(5.0, bb.max.z - bb.min.z + 2.4);
      const ox = (bb.min.x + bb.max.x) / 2 - cx;
      const oz = (bb.min.z + bb.max.z) / 2 - cz;
      const shell = new THREE.Group();
      shell.position.set(ox, 0, oz);
      anchor.add(shell);
      roomFloor(shell, w, d, { lamp: true });
      stats.shells = (stats.shells || 0) + 1;
    }

    const cnt = countMeshes(anchor);
    stats.built++;
    sceneIds.push(id);
    const bp = stats.byPlace[placeKey] || (stats.byPlace[placeKey] = { scenes: 0, meshes: 0, floorH: fh, baseY: base });
    bp.scenes++; bp.meshes += cnt;
  }

  // 【同层连通楼板】镜头进楼时整栋楼被隐藏，若只留各自孤立的房间地板，
  // 9F 读起来就是几块漂浮的平台。按 (楼, 楼层) 补一整块楼板，房间之间
  // 连成一层；楼板略低于房间地板，不会 z-fighting，也不进碰撞层。
  for (const fg of floorGroups.values()) {
    if (fg.n < 2) continue;
    const P = fg.P;
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry((P.w || 20) * 0.9, 0.12, (P.d || 20) * 0.86),
      M.wood,
    );
    plate.position.set(P.x, fg.y - 0.14, P.z);
    plate.userData.tag = 'floor';
    plate.receiveShadow = true;
    group.add(plate);
    stats.plates = (stats.plates || 0) + 1;
  }

  stats.meshes = countMeshes(group);
  group.visible = true;

  // 只此一条汇总日志，不刷屏
  console.info(`[life-scenes] quality=${quality} built=${stats.built} skipped=${stats.skipped} markers=${stats.markers} relocated=${stats.relocated} meshes=${stats.meshes}`);

  return {
    group,
    stats,
    setVisible(v) { group.visible = !!v; },
    sceneIds,
  };
}
