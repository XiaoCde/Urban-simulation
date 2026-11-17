/**
 * roadprops.js — 路灯 / 红绿灯 / 路边停车，全部按 roadnet 的精确节点摆。
 *
 * 【为什么旧的全错】旧 street.js 用「未吸附的 OSM 求交表 + 固定 ±6 m 对角偏移」
 * 摆信号灯，杆脚 y 取原始 DTM（路面用的是带下切的另一套基准），于是灯在路中间、
 * 悬空或埋进路里；路灯模型加载了却一次都没摆过。
 *
 * 现在统一：
 *   - 路口坐标 = roadnet 的图节点（瓦片格心），不是另一份 json；
 *   - y 基准 = net.surfaceY（与新瓦片同一高度场）；
 *   - 路灯在**路段两侧的人行道外缘**（垂直偏 TILE*0.42），不在车道里；
 *   - 红绿灯在**路口四角**、朝向来车，杆/横臂自建、灯箱用用户给的真模型；
 *   - 落在建筑 footprint 里的杆位直接丢弃（canPlace 回调）。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TILE } from './roadnet.js';
import { CAR_YAW } from './traffic.js';   // 停放车与行驶车用同一套 glb，车头补偿必须一致

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function loadModel(url) {
  const loader = new GLTFLoader();
  const g = await loader.loadAsync(url);
  g.scene.updateMatrixWorld(true);
  const parts = [];
  g.scene.traverse((o) => {
    if (!o.isMesh) return;
    const geo = o.geometry.clone();
    geo.applyMatrix4(o.matrixWorld);
    // 【FBX→glb 的 alpha 坑】和道路瓦片同源：Blender 读进来的材质
    // opacity=0，灯杆/灯箱/灯罩全都不画（街景里只剩几根黑杆）。
    let mat = o.material;
    if (Array.isArray(mat)) mat = mat[0];
    if (mat) {
      mat = mat.clone();
      mat.opacity = 1;
      mat.transparent = false;
      mat.depthWrite = true;
      mat.colorWrite = true;
      mat.visible = true;
      mat.side = THREE.DoubleSide;
      // 【按材质名上色】原 FBX 的 Glass/Light 是给透明渲染用的浅白片，
      // 强制成不透明后就变成一根白柱子插在街上（用户：「位置全铺错了」）。
      // 杆子要深、灯罩要暖、红黄绿要自发光，远看才认得出是路灯/信号灯。
      const nm = (mat.name || '').toLowerCase();
      let c = null, emis = null;
      if (nm.startsWith('green') || nm.startsWith('pole')) c = 0x39433c;
      else if (nm.startsWith('glass') || nm.startsWith('light')) { c = 0xffe9b0; emis = 0xffcf72; }
      else if (nm.startsWith('red')) { c = 0x7e1a12; emis = 0xd0231a; }
      else if (nm.startsWith('yellow')) { c = 0x6b4a10; emis = 0xb08020; }
      else if (nm.startsWith('darkgrey')) c = 0x24282b;
      else if (nm.startsWith('grey')) c = 0x4a5054;
      else if (nm.startsWith('white')) c = 0xe9e7dc;
      else if (nm.startsWith('black')) c = 0x22262a;
      if (c !== null) mat.color = new THREE.Color(c);
      if (emis !== null && mat.emissive) {
        mat.emissive = new THREE.Color(emis);
        // 夜间要靠灯罩自己发亮（场景里没有点光源，加几百个 PointLight 会直接卡死）
        mat.emissiveIntensity = 1.7;
      }
      mat.roughness = 0.72;
      mat.needsUpdate = true;
    }
    parts.push({ geo, mat });
  });
  return parts;
}

function sinkAdd(sink, key, geo, mat, M) {
  let e = sink.get(key);
  if (!e) { e = { geo, mat, mats: [] }; sink.set(key, e); }
  e.mats.push(M.clone());
}

function sinkBuild(sink, name) {
  const g = new THREE.Group();
  g.name = name;
  for (const [key, e] of sink) {
    const im = new THREE.InstancedMesh(e.geo, e.mat, e.mats.length);
    for (let i = 0; i < e.mats.length; i++) im.setMatrixAt(i, e.mats[i]);
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = true;
    im.receiveShadow = true;
    im.frustumCulled = false;
    im.name = key;
    g.add(im);
  }
  return g;
}

function put(sink, key, geo, mat, x, y, z, q, s) {
  sinkAdd(sink, key, geo, mat, new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z), q || new THREE.Quaternion(), s || ONE));
}

/**
 * @param {object} o { net, world, canPlace:(x,z)=>bool, lampsPerEdge=2, parkCount }
 */
export async function buildRoadProps(o) {
  const { net, world, canPlace = () => true } = o;
  const rand = mulberry32(88117);
  const sink = new Map();
  const P = new THREE.Vector3();
  let lamps = 0, signals = 0, parked = 0;

  // ---------- 1) 路灯：路段两侧，人行道外缘 ----------
  // 【密度】一条 24 m 的边两侧各 2 根 = 574×4 = 2296 根，俯视就是一片黑色
  // 点阵（用户说的「路灯位置全铺错了」）。真实街路灯间距约 40~60 m：
  // 隔一条边摆、每边只在 midpoint 两侧各一根 → ~570 根仍然偏多，再按
  // 路口度数稀疏到每 2 条边一组，最终 ~280 根，画面里能看出是沿路的灯列。
  let lampParts = null;
  try { lampParts = await loadModel('/assets/roads/mod_Streetlight_Double.glb'); }
  catch (e) { console.warn('[roadprops] 路灯模型未加载', e && e.message); }
  const LAMP_H = 7.2;
  const lampScale = new THREE.Vector3(3.0, LAMP_H / 1.1, 3.0);
  // 【2026-11-07】夜里原本只有不发光的灯杆，用户「半夜看不清在干什么」。
  // 给每根杆加两个自发光灯头，并把灯头坐标交给 main.js 挑最近的几盏做
  // 真实 PointLight（280 根全开灯会拖垮帧率，只点相机附近 8 盏）。
  const BULB_GEO = new THREE.SphereGeometry(0.34, 8, 6);
  const BULB_MAT = new THREE.MeshStandardMaterial({
    color: 0xffe0b0, emissive: 0xffc878, emissiveIntensity: 1.9, roughness: 0.45,
  });
  const lampPositions = [];
  for (let ei = 0; ei < net.edges.length; ei += 2) {
    const e = net.edges[ei];
    const dx = e.b.x - e.a.x, dz = e.b.z - e.a.z;
    const L = Math.hypot(dx, dz) || 1;
    const ex = dx / L, ez = dz / L;
    const nx = -ez, nz = ex;                    // 右法线
    // 灯臂沿模型 Z 轴；让它垂直指向路面 → 绕 Y 转到与边垂直
    const qy = new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(nx, nz));
    for (const side of [-1, 1]) {
      const off = TILE * 0.42 * side;
      const x = e.a.x + dx * 0.5 + nx * off;
      const z = e.a.z + dz * 0.5 + nz * off;
      if (!canPlace(x, z)) continue;
      const y = net.surfaceY(x, z);
      const bulbY = y + LAMP_H * 0.92;
      lampPositions.push({ x, y: bulbY, z });
      for (const s2 of [-1, 1]) {
        put(sink, 'lamp_bulb', BULB_GEO, BULB_MAT,
          x + nx * s2 * 1.15, bulbY, z + nz * s2 * 1.15);
      }
      if (lampParts) {
        for (let p = 0; p < lampParts.length; p++) {
          put(sink, 'lamp' + p, lampParts[p].geo, lampParts[p].mat,
            x, y + 0.02, z, qy, lampScale);
        }
      } else {
        put(sink, 'lamp_pole', new THREE.CylinderGeometry(0.09, 0.12, LAMP_H, 6),
          new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.7 }),
          x, y + LAMP_H / 2, z);
      }
      lamps++;
    }
  }

  // ---------- 2) 红绿灯：路口四角，杆 + 横臂 + 真模型灯箱 ----------
  const POLE_H = 5.8;
  const POLE_GEO = new THREE.CylinderGeometry(0.085, 0.11, POLE_H, 8);
  POLE_GEO.translate(0, POLE_H / 2, 0);
  const ARM_GEO = new THREE.CylinderGeometry(0.06, 0.06, 1, 6);
  ARM_GEO.rotateZ(Math.PI / 2); ARM_GEO.translate(0.5, 0, 0);
  const POLE_MAT = new THREE.MeshStandardMaterial({ color: 0x2f3437, roughness: 0.62, metalness: 0.4 });
  let tlParts = null;
  try { tlParts = await loadModel('/assets/roads/mod_TrafficLight.glb'); }
  catch (e) { console.warn('[roadprops] 信号灯模型未加载', e && e.message); }
  const tlScale = new THREE.Vector3(2.4, 1.9, 2.4);

  // 只在四向路口摆灯（三向 T 字口一般是停牌，不是红绿灯）；
  // 每个路口对角两根，最多 60 个路口，避免全城 242 个路口全插杆。
  const onRoadTest = o.onRoadTest || null;   // 主线传进来的路面走廊测试
  const fourWay = net.junctions.filter((j) => (j.deg ?? 3) >= 4);
  const sigStep = Math.max(1, Math.ceil(fourWay.length / 60));
  for (let ji = 0; ji < fourWay.length; ji += sigStep) {
    const j = fourWay[ji];
    // 两个对角，每个朝向路口中心（即朝向来车）。
    // 【偏移量为什么是 0.42 而不是 0.30】0.30*TILE = 7.2 m 落在**斑马线白条
    // 正中间**（用户 2026-11-06「红绿灯立在斑马线上」）。瓦片半宽 12 m、
    // 车行道半宽 4 m、斑马线画到约 8 m，所以杆脚必须推到 9~11 m 的人行道
    // 外缘：0.42*24 = 10.1 m，两边都留出余量。
    for (const [sx, sz] of [[-1, -1], [1, 1]]) {
      const ox = TILE * 0.42 * sx, oz = TILE * 0.42 * sz;
      const x = j.x + ox, z = j.z + oz;
      if (!canPlace(x, z)) continue;
      // 再兜一道：距离任何路段中线 5 m 以内的一律不摆（防止对角恰好落在
      // 路口的斜向切角里）
      if (onRoadTest && onRoadTest(x, z)) continue;
      const y = net.surfaceY(x, z);
      const rotY = Math.atan2(j.x - x, j.z - z);
      const qy = new THREE.Quaternion().setFromAxisAngle(UP, rotY);
      put(sink, 'sig_pole', POLE_GEO, POLE_MAT, x, y, z, qy);
      // 横臂朝路口中心伸 2.2 m（局部 +X → 世界朝向由 qy 决定）
      const armQ = qy.clone().multiply(new THREE.Quaternion().setFromAxisAngle(UP, -Math.PI / 2));
      put(sink, 'sig_arm', ARM_GEO, POLE_MAT, x, y + POLE_H - 0.25, z,
        armQ, new THREE.Vector3(2.2, 1, 1));
      const bx = x + Math.sin(rotY) * 2.0;
      const bz = z + Math.cos(rotY) * 2.0;
      if (tlParts) {
        for (let p = 0; p < tlParts.length; p++) {
          put(sink, 'sig_head' + p, tlParts[p].geo, tlParts[p].mat,
            bx, y + POLE_H - 1.55, bz, qy, tlScale);
        }
      } else {
        put(sink, 'sig_box', new THREE.BoxGeometry(0.42, 1.1, 0.32),
          new THREE.MeshStandardMaterial({ color: 0x1d2022 }),
          bx, y + POLE_H - 1.05, bz, qy);
      }
      signals++;
    }
  }

  // ---------- 3) 路边停车：静止车，路缘外侧 ----------
  const carFiles = {
    sedan: '/assets/street/car_sedan.glb',
    suv: '/assets/street/car_suv.glb',
    compact: '/assets/street/car_compact.glb',
  };
  const carParts = {};
  for (const [k, u] of Object.entries(carFiles)) {
    try { carParts[k] = await loadModel(u); } catch (e) { /* 跳过 */ }
  }
  const carKinds = Object.keys(carParts).filter((k) => carParts[k] && carParts[k].length);
  const wantPark = o.parkCount ?? 70;
  // 【车位不能落在别的路段的车行道里】8.16 m 的横向偏移在 24 m 网格的
  // 路口附近会伸进**垂直方向那条路**，于是车横着停在十字路口正中
  // （实测 70 辆里 4 辆夹角 90°、离最近路中线只有 3.8~7.3 m）。
  // 用 7.5 m 走廊把这类车位直接淘汰：正常车位距自己那条边 8.16 m > 7.5，
  // 一旦距任何边 < 7.5 m 就说明压到别的路了。
  const parkAvoid = o.parkAvoid || null;
  let tries = 0;
  while (parked < wantPark && tries++ < wantPark * 20 && net.edges.length) {
    const e = net.edges[Math.floor(rand() * net.edges.length)];
    const t = 0.12 + rand() * 0.76;
    const dir = rand() < 0.5 ? 1 : -1;
    const k = carKinds[parked % carKinds.length];
    if (!k) break;
    // 停车位要的是「路缘外固定偏移」，不能做路口渐变，否则车位会往路中心缩
    net.lanePoint(e, t, dir, TILE * 0.34, P, false);
    if (!canPlace(P.x, P.z)) continue;
    if (parkAvoid && parkAvoid(P.x, P.z)) continue;
    const y = net.surfaceY(P.x, P.z) + 0.02;
    const a = dir > 0 ? e.a : e.b, b = dir > 0 ? e.b : e.a;
    const qy = new THREE.Quaternion().setFromAxisAngle(UP,
      Math.atan2(b.x - a.x, b.z - a.z) + (CAR_YAW[k] || 0));
    for (let p = 0; p < carParts[k].length; p++) {
      put(sink, 'park_' + k + p, carParts[k][p].geo, carParts[k][p].mat,
        P.x, y, P.z, qy);
    }
    parked++;
  }

  const group = sinkBuild(sink, 'L2_road_props');
  world.add(group);
  console.info(`[roadprops] 路灯 ${lamps} 根 / 红绿灯 ${signals} 根 / 路边停车 ${parked} 辆`);
  return { group, stats: { lamps, signals, parked }, lampPositions };
}
