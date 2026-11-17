/**
 * street.js — 街道设施：交通信号灯、路灯、路边停车。
 *
 * 【数据来源】
 *   - 信号灯/路灯模型：`data/characters/street FBX/`（只有 fbx，已用
 *     `tools/blender_export_street.py` 离线转成 glb 放在 `web/assets/street/`）
 *   - 路口坐标：`tools/street_junctions.py` 从 OSM 折线两两求交算出
 *     （`web/assets/street/junctions.json`）
 *   - 车：`data/characters/generic-passenger-car-pack/source/fab.fbx` 里是一个
 *     21.7 m 见方的「车阵」，10 种车型 + 40 个轮子；同样离线拆成单车 glb。
 *
 * 【为什么杆子要自己生成】包里给的 `TrafficLight.fbx` 只有 **0.87 m 高的灯头**
 * （实测包围盒 0.12×0.09×0.87），没有立杆。自己生成杆反而更好：高度、横臂、
 * 灯色都能调，日后要接「红灯/绿灯」状态也是改材质而不是换模型。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const POLE_H = 4.6;        // 立杆高（灯头挂在杆顶下方）
const POLE_R = 0.095;
const LAMP_Y = 4.15;

/** 串行加载 glb。并发会在本地 serve.js 上打出一批 ERR_ABORTED（之前踩过）。 */
export async function loadStreetAssets(base = '/assets/street/') {
  const loader = new GLTFLoader();
  const out = {};
  const files = {
    signal: 'TrafficLight.glb',
    signal2: 'TrafficLight_2.glb',
    light: 'Streetlight_Single.glb',
    sedan: 'car_sedan.glb',
    suv: 'car_suv.glb',
    compact: 'car_compact.glb',
  };
  for (const [k, f] of Object.entries(files)) {
    try {
      const g = await loader.loadAsync(base + f);
      g.scene.updateMatrixWorld(true);
      const parts = [];
      g.scene.traverse((o) => {
        if (!o.isMesh) return;
        const geo = o.geometry.clone();
        geo.applyMatrix4(o.matrixWorld);
        parts.push({ geo, mat: o.material });
      });
      out[k] = parts;
    } catch (e) {
      console.warn('[street] 加载失败', f, e && e.message);
      out[k] = [];
    }
  }
  console.info(`[street] ${Object.keys(out).length} 个资产，`
    + `${Object.values(out).reduce((a, p) => a + p.length, 0)} 个 mesh`);
  return out;
}

/** 合并一组 { geo, mat } 成「按材质分组」的矩阵收集器，最后建 InstancedMesh。 */
function makeSink() {
  return new Map();
}

function pushInst(sink, key, geo, mat, matrix, color) {
  let e = sink.get(key);
  if (!e) { e = { geo, mat, mats: [], cols: [] }; sink.set(key, e); }
  e.mats.push(matrix);
  e.cols.push(color || null);
}

function buildFromSink(sink, name) {
  const g = new THREE.Group();
  g.name = name;
  for (const [key, e] of sink) {
    if (!e.mats.length) continue;
    const im = new THREE.InstancedMesh(e.geo, e.mat, e.mats.length);
    for (let i = 0; i < e.mats.length; i++) {
      im.setMatrixAt(i, e.mats[i]);
      if (e.cols[i]) im.setColorAt(i, e.cols[i]);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = true;
    im.receiveShadow = true;
    im.frustumCulled = false;
    im.name = key;
    g.add(im);
  }
  return g;
}

/**
 * 摆交通信号灯。
 *
 * 【为什么灯箱自己画】包里给的 `TrafficLight.fbx` 只有 0.87 m 高的一点细节
 * （实测包围盒 0.12×0.09×0.87），放大到杆顶就是一个小黑点，远看完全看不出是灯。
 * 这里用「自建杆 + 伸向路口的横臂 + 灯箱 + 三个自发光灯点」重做 ——
 * 尺寸可控、远看能认出是红绿灯，日后接「红/绿状态」也只是改材质颜色。
 *
 * @param {Array} junctions  junctions.json
 * @param {Function} groundAt (x,z) => y
 * @param {object} opts  { radius, maxCount, center:[x,z] }
 */
export function buildTrafficSignals(assets, junctions, groundAt, opts = {}) {
  const R = opts.radius || 400;
  const CX = opts.center ? opts.center[0] : 0;
  const CZ = opts.center ? opts.center[1] : 0;
  const MAX = opts.maxCount || 28;

  const POLE_H = 5.6;
  const POLE_GEO = new THREE.CylinderGeometry(0.085, 0.11, POLE_H, 8, 1);
  const POLE_MAT = new THREE.MeshStandardMaterial({ color: 0x2f3437, roughness: 0.6, metalness: 0.45 });
  // 横臂：水平圆杆，长度 1，靠实例 scale.x 拉长
  const ARM_GEO = new THREE.CylinderGeometry(0.06, 0.06, 1, 6, 1);
  ARM_GEO.rotateZ(Math.PI / 2);           // 让长度方向沿 +X
  ARM_GEO.translate(0.5, 0, 0);           // 起点落在原点，向右伸
  const ARM_MAT = POLE_MAT;
  // 灯箱
  const BOX_GEO = new THREE.BoxGeometry(0.4, 1.02, 0.3);
  const BOX_MAT = new THREE.MeshStandardMaterial({ color: 0x1d2022, roughness: 0.85 });
  // 灯点：圆片，朝 +Z
  const LAMP_GEO = new THREE.CircleGeometry(0.115, 12);
  const LAMP_MAT = {
    red: new THREE.MeshStandardMaterial({ color: 0x8c1a12, emissive: 0xd0231a, emissiveIntensity: 1.6, side: THREE.DoubleSide }),
    amber: new THREE.MeshStandardMaterial({ color: 0x6b4a10, emissive: 0x8a6410, emissiveIntensity: 0.35, side: THREE.DoubleSide }),
    green: new THREE.MeshStandardMaterial({ color: 0x0e3a1c, emissive: 0x1c6b31, emissiveIntensity: 0.9, side: THREE.DoubleSide }),
  };

  const sink = makeSink();
  let placed = 0;
  const qI = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const yAxis = new THREE.Vector3(0, 1, 0);

  for (const j of junctions) {
    if (j.major !== 1) continue;
    const d = Math.hypot(j.x - CX, j.z - CZ);
    if (d > R) continue;
    if (placed >= MAX) break;

    // 一个路口摆对角两根杆（真实路口也是对角布灯），偏移 6 m
    let side = 0;
    for (const [ox, oz] of [[-6, -6], [6, 6]]) {
      const px = j.x + ox, pz = j.z + oz;
      const py = groundAt(px, pz);
      if (!isFinite(py)) continue;
      const rotY = Math.atan2(j.x - px, j.z - pz);      // 朝向路口中心
      const qy = new THREE.Quaternion().setFromAxisAngle(yAxis, rotY);

      // 杆
      pushInst(sink, 'pole', POLE_GEO, POLE_MAT,
        new THREE.Matrix4().compose(new THREE.Vector3(px, py + POLE_H / 2, pz), qI, one));
      // 横臂：从杆顶朝路口方向伸 2.4 m（局部 +Z 是朝向，先转到局部 +X 再整体转）
      const armQ = qy.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, -Math.PI / 2));
      pushInst(sink, 'arm', ARM_GEO, ARM_MAT,
        new THREE.Matrix4().compose(new THREE.Vector3(px, py + POLE_H - 0.28, pz), armQ,
          new THREE.Vector3(2.4, 1, 1)));
      // 灯箱挂在横臂末端
      const bx = px + Math.sin(rotY) * 2.4;
      const bz = pz + Math.cos(rotY) * 2.4;
      pushInst(sink, 'box', BOX_GEO, BOX_MAT,
        new THREE.Matrix4().compose(new THREE.Vector3(bx, py + POLE_H - 1.05, bz), qy, one));
      // 三个灯点（红上 / 黄中 / 绿下），朝 +Z（即面向路口）
      const cols = ['red', 'amber', 'green'];
      for (let i = 0; i < 3; i++) {
        const yy = py + POLE_H - 0.72 - i * 0.33;
        const lq = qy.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0));
        const off = new THREE.Vector3(0, 0, 0.16).applyQuaternion(qy);
        pushInst(sink, 'lamp_' + cols[i], LAMP_GEO, LAMP_MAT[cols[i]],
          new THREE.Matrix4().compose(new THREE.Vector3(bx + off.x, yy, bz + off.z), lq, one));
      }
      side++;
    }
    if (side) placed++;
  }

  const g = buildFromSink(sink, 'traffic-signals');
  console.info(`[street] 信号灯 ${placed} 个路口 / ${placed * 2} 根`);
  return { group: g, junctions: placed };
}

/**
 * 路边停车：沿一栋楼的临街面外侧摆车。
 * @param {Array} spots [{x,z,rotY}] 由 main.js 按楼的门面算好
 */
export function buildParkedCars(assets, spots, groundAt) {
  const sink = makeSink();
  const carKeys = ['sedan', 'suv', 'compact'].filter((k) => assets[k] && assets[k].length);
  if (!carKeys.length) return { group: new THREE.Group(), count: 0 };

  let n = 0;
  for (const s of spots) {
    const k = carKeys[n % carKeys.length];
    const parts = assets[k];
    const gy = groundAt(s.x, s.z);
    const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.rotY || 0);
    for (let i = 0; i < parts.length; i++) {
      pushInst(sink, k + i, parts[i].geo, parts[i].mat,
        new THREE.Matrix4().compose(new THREE.Vector3(s.x, gy, s.z), qy, new THREE.Vector3(1, 1, 1)));
    }
    n++;
  }
  const g = buildFromSink(sink, 'parked-cars');
  console.info(`[street] 路边停车 ${n} 辆`);
  return { group: g, count: n };
}

/** 读路口表。 */
export async function loadJunctions(base = '/assets/street/') {
  try {
    const r = await fetch(base + 'junctions.json');
    if (!r.ok) return [];
    return await r.json();
  } catch (e) {
    return [];
  }
}
