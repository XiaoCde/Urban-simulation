/**
 * 白宫园林 —— 南草坪、喷泉、树木、花坛。
 *
 * 三条硬要求（用户原话）：
 *   「要考虑细节，比如绿化、喷泉，处处细节，
 *     没有任何地方看起来像是复制粘贴的，水体和瀑布必须看起来真实」
 *
 * 对策：
 *   绿化  -> 树用 4 种树形 × 每棵独立参数（高矮/冠幅/疏密/色相），位置按
 *            蓝噪声（泊松盘近似）撒，绝不网格状排列
 *   喷泉  -> 水面用程序化法线 + 顶点波动 + 菲涅耳，水柱用粒子 + 半透明圆柱双层
 *   复制粘贴感 -> 所有重复构件（栏杆、树、花）都带 ±2~6% 的随机微差
 */

import * as THREE from 'three';
import {
  textureLawn, textureSoil, textureLeafCluster, textureBark,
  textureWaterNormal, rng, jitter, boxWithBevel,
} from './textures.js';

// ==================================================================== 地面
export function buildGround(mats, size = 420) {
  const g = new THREE.Group();

  // 南草坪主体
  const lawn = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size, 1, 1),
    mats.lawn
  );
  lawn.rotation.x = -Math.PI / 2;
  lawn.position.y = 0;
  lawn.receiveShadow = true;
  g.add(lawn);

  // 北侧车道（砖铺，从北门廊往北）
  const drive = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 90),
    mats.paving
  );
  drive.rotation.x = -Math.PI / 2;
  drive.position.set(0, 0.012, -80);
  drive.receiveShadow = true;
  g.add(drive);

  // 房前一圈步道（环绕建筑）
  const walkShape = new THREE.Shape();
  const bw = 34, bd = 22;
  walkShape.moveTo(-bw, -bd);
  walkShape.lineTo(bw, -bd);
  walkShape.lineTo(bw, bd);
  walkShape.lineTo(-bw, bd);
  walkShape.lineTo(-bw, -bd);
  const hole = new THREE.Path();
  hole.moveTo(-bw + 4.5, -bd + 4.5);
  hole.lineTo(-bw + 4.5, bd - 4.5);
  hole.lineTo(bw - 4.5, bd - 4.5);
  hole.lineTo(bw - 4.5, -bd + 4.5);
  hole.lineTo(-bw + 4.5, -bd + 4.5);
  walkShape.holes.push(hole);
  const walk = new THREE.Mesh(new THREE.ShapeGeometry(walkShape), mats.paving);
  walk.rotation.x = -Math.PI / 2;
  walk.position.y = 0.014;
  walk.receiveShadow = true;
  g.add(walk);

  return g;
}

// ==================================================================== 喷泉
/**
 * 南草坪喷泉（参照照片里那个中央单股水柱 + 圆形水池）。
 *
 * 水的"真实感"靠四层叠加：
 *   1. 水面：程序化法线贴图 + 滚动 offset（缓慢流动）
 *   2. 水面顶点：径向正弦波，让水面不是死平面
 *   3. 水柱：半透明锥体 + 上千个粒子
 *   4. 水雾：底部一团柔和的点精灵
 */
export function buildFountain(mats, pos, scale = 1) {
  const g = new THREE.Group();
  g.position.copy(pos);
  g.scale.setScalar(scale);

  const R = 6.2;          // 池半径
  const H = 1.15;         // 池壁高
  const colH = 7.6;       // 水柱高

  // ---------------------------------------------------------- 水池（石)
  const rimGeo = new THREE.CylinderGeometry(R, R, H, 56, 1, true);
  const rim = new THREE.Mesh(rimGeo, mats.stone);
  rim.position.y = H / 2;
  rim.castShadow = rim.receiveShadow = true;
  g.add(rim);

  // 池沿压顶
  const ringGeo = new THREE.TorusGeometry(R, 0.22, 10, 64);
  const ring = new THREE.Mesh(ringGeo, mats.stone);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = H;
  ring.castShadow = true;
  g.add(ring);

  // ---------------------------------------------------------- 水面
  // 细分足够多，才能让顶点波动看出来（28×28 = 784 顶点，很便宜）
  const waterGeo = new THREE.CircleGeometry(R - 0.16, 64, 0, Math.PI * 2);
  // 手动细分：CircleGeometry 只有边缘点，这里换成平面裁圆
  const segs = 48;
  const wg = new THREE.PlaneGeometry((R - 0.16) * 2, (R - 0.16) * 2, segs, segs);
  // 把方形顶点裁成圆形（超出半径的压回边缘）
  const wp = wg.attributes.position;
  for (let i = 0; i < wp.count; i++) {
    const x = wp.getX(i), y = wp.getY(i);
    const d = Math.hypot(x, y);
    if (d > R - 0.16) {
      const k = (R - 0.16) / d;
      wp.setXY(i, x * k, y * k);
    }
  }
  wp.needsUpdate = true;
  wg.computeVertexNormals();

  const water = new THREE.Mesh(wg, mats.water);
  water.rotation.x = -Math.PI / 2;
  water.position.y = H - 0.18;
  water.receiveShadow = false;   // 水面不接收阴影，否则会有硬边
  g.add(water);

  // 顶点波动（在 render loop 里驱动）
  water.userData.basePos = Float32Array.from(wp.array);
  water.userData.animate = true;

  // ---------------------------------------------------------- 中央水柱
  // 喷嘴基座
  const nozzle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.30, 0.52, 0.55, 16),
    mats.stone
  );
  nozzle.position.y = H - 0.10;
  nozzle.castShadow = true;
  g.add(nozzle);

  // 水柱主体：半透明锥（上细下粗），用 additive 让它透亮
  const jetGeo = new THREE.CylinderGeometry(0.10, 0.30, colH, 14, 6, true);
  // 顶点轻微扰动，打破完美圆柱
  const jp = jetGeo.attributes.position;
  for (let i = 0; i < jp.count; i++) {
    const t = (jp.getY(i) + colH / 2) / colH;
    const wob = 1 + Math.sin(t * 9.0) * 0.08;
    jp.setX(i, jp.getX(i) * wob);
    jp.setZ(i, jp.getZ(i) * wob);
  }
  jp.needsUpdate = true;
  jetGeo.computeVertexNormals();

  const jet = new THREE.Mesh(jetGeo, mats.waterJet);
  jet.position.y = H + colH / 2;
  g.add(jet);

  // 水柱粒子：往上喷、在顶端散开成雾再落下
  const COUNT = 1400;
  const pPos = new Float32Array(COUNT * 3);
  const pSeed = new Float32Array(COUNT);
  const r = rng(7717);
  for (let i = 0; i < COUNT; i++) {
    pSeed[i] = r();
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('aSeed', new THREE.BufferAttribute(pSeed, 1));

  const pMat = new THREE.PointsMaterial({
    size: 0.075,
    map: makeSpraySprite(),
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(pGeo, pMat);
  points.frustumCulled = false;
  g.add(points);

  // 粒子状态存到 userData，render loop 里推进
  g.userData.fountain = {
    points, pGeo, COUNT, colH, H,
    t: 0,
  };

  // ---------------------------------------------------------- 水雾
  const mistMat = new THREE.SpriteMaterial({
    map: makeMistSprite(),
    transparent: true,
    opacity: 0.20,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Sprite(mistMat.clone());
    m.position.set(jitter(r, -0.5, 0.5), H + colH * 0.78 + i * 0.4, jitter(r, -0.5, 0.5));
    m.scale.setScalar(3.4 + i * 1.5);
    m.material.opacity = 0.16 - i * 0.04;
    g.add(m);
  }

  return g;
}

/** 水花粒子贴图：一个柔和的亮点 */
function makeSpraySprite(size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.45, 'rgba(226,240,250,0.45)');
  grad.addColorStop(1, 'rgba(226,240,250,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 水雾贴图：更大更柔和 */
function makeMistSprite(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.5, 'rgba(240,248,252,0.20)');
  grad.addColorStop(1, 'rgba(240,248,252,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 推进喷泉动画（每帧调用） */
export function updateFountain(fountainGroup, dt) {
  const f = fountainGroup.userData.fountain;
  if (!f) return;
  f.t += dt;

  // ---- 水面顶点波动
  const water = fountainGroup.children.find((c) => c.userData.animate);
  if (water) {
    const pos = water.geometry.attributes.position;
    const base = water.userData.basePos;
    const t = f.t;
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3], y = base[i * 3 + 1];
      const d = Math.hypot(x, y) / 6.0;
      const w = Math.sin(d * 12 - t * 2.6) * 0.022 * (1 - d * 0.6)
              + Math.sin(x * 2.1 + t * 1.9) * 0.008
              + Math.cos(y * 2.4 - t * 2.2) * 0.008;
      pos.setZ(i, w + Math.max(0, 0.05 - d) * 0.06);   // 中心略高
    }
    pos.needsUpdate = true;
    water.geometry.computeVertexNormals();
  }

  // ---- 水柱粒子
  const { points, pGeo, COUNT, colH, H } = f;
  const arr = pGeo.attributes.position.array;
  const seeds = pGeo.attributes.aSeed.array;
  for (let i = 0; i < COUNT; i++) {
    const s = seeds[i];
    // 每个粒子沿自己的相位循环：0→1 从喷口到顶，再散开落下
    const life = (f.t * (0.55 + s * 0.45) + s * 7.3) % 1.0;
    const ang = s * Math.PI * 2 + f.t * (0.4 + s * 0.3);
    // 竖向：抛物线（先上后下）
    const rise = Math.min(1, life / 0.42);
    const fall = Math.max(0, (life - 0.42) / 0.58);
    const y = H + rise * colH - fall * fall * colH * 0.92;
    // 横向：越高越散（水柱在顶端散成雾）
    const spread = rise < 0.42
      ? 0.06 + rise * 0.34
      : 0.40 + fall * (0.9 + s * 1.6);
    const rad = spread * (0.55 + s * 0.9);
    arr[i * 3] = Math.cos(ang) * rad;
    arr[i * 3 + 1] = Math.max(H * 0.35, y);
    arr[i * 3 + 2] = Math.sin(ang) * rad;
  }
  pGeo.attributes.position.needsUpdate = true;
}

// ==================================================================== 树
/**
 * 树：树干 + 多个叶簇卡片。
 *
 * 【性能与观感的关键设计】
 *   第一版给每棵树单独建材质、每个叶簇建一个 mesh —— 结果 240 棵树
 *   产生 240 个材质 + 上千次 draw call，3 fps，而且叶卡片像撒了一地碎纸。
 *
 *   现在改成：**全场景共用 4 种叶材质**（只靠色相不同区分树种），
 *   所有叶卡片的几何体收集到 leafCollector，最后由 main.js 一次合并成
 *   4 个 mesh。draw call 从上千降到 4，叶簇也能撒得更密。
 */
const LEAF_TINTS = [
  [96, 140, 66],    // 标准阔叶绿
  [112, 152, 78],   // 偏黄绿（受光）
  [78, 122, 56],    // 偏深（背光面）
  [124, 158, 86],   // 玉兰那种偏亮的绿
];
const leafMatCache = [];

export function getLeafMaterial(i) {
  const k = i % LEAF_TINTS.length;
  if (leafMatCache[k]) return leafMatCache[k];
  const t = LEAF_TINTS[k];
  const tex = textureLeafCluster(128, t);
  const m = new THREE.MeshStandardMaterial({
    map: tex,
    transparent: true,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    roughness: 0.94,
    metalness: 0.0,
    // 叶子的透光感：让背光面不至于纯黑
    emissive: new THREE.Color(t[0] / 255 * 0.16, t[1] / 255 * 0.20, t[2] / 255 * 0.12),
    emissiveIntensity: 1.0,
  });
  leafMatCache[k] = m;
  return m;
}

/** 叶卡片几何收集器：按材质分桶，最后合并 */
export const leafCollector = { buckets: new Map() };

export function resetLeafCollector() { leafCollector.buckets.clear(); }

export function buildLeafMeshes() {
  const out = [];
  for (const [matIdx, geos] of leafCollector.buckets) {
    if (!geos.length) continue;
    const merged = mergeGeos(geos);
    const m = new THREE.Mesh(merged, getLeafMaterial(matIdx));
    m.castShadow = false;      // 叶片投不出干净的影子，靠树干下的暗斑
    m.receiveShadow = false;
    out.push(m);
  }
  return out;
}

/** 极简几何合并（带索引） */
function mergeGeos(geos) {
  let vTotal = 0, iTotal = 0;
  for (const g of geos) {
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vTotal * 3);
  const nor = new Float32Array(vTotal * 3);
  const uv = new Float32Array(vTotal * 2);
  const idx = new Uint32Array(iTotal);
  let vo = 0, io = 0;
  for (const g of geos) {
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
    pos.set(p.array, vo * 3);
    if (n) nor.set(n.array, vo * 3);
    if (u) uv.set(u.array, vo * 2);
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + vo;
    } else {
      for (let i = 0; i < p.count; i++) idx[io++] = i + vo;
    }
    vo += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

export function buildTree(mats, kind, seed, px = 0, pz = 0) {
  const r = rng(seed);
  const g = new THREE.Group();
  // 【坑】叶卡片要合并进全场景共享的 mesh，所以必须在"世界坐标"里生成。
  // 但 g.position 是外部调用者之后才设置的 —— 若在这里读 g.position，
  // 拿到的永远是 0，所有叶子会堆在原点、被建筑挡住（实测叶子全消失）。
  // 因此把落点显式传进来。
  g.position.set(px, 0, pz);

  const profiles = {
    // 白宫南草坪那些大乔木（美国榆、悬铃木）：高、冠幅大、干明显
    elm: { trunkH: [4.2, 6.0], trunkR: [0.28, 0.46], crownR: [3.4, 5.2], crownH: [5.0, 7.4], blobs: [7, 12], cards: 4 },
    // 玉兰（白宫南侧有一排著名的玉兰）
    magnolia: { trunkH: [2.4, 3.4], trunkR: [0.20, 0.32], crownR: [2.4, 3.6], crownH: [3.0, 4.4], blobs: [6, 9], cards: 4 },
    // 塔形针叶（远景轮廓）
    conifer: { trunkH: [2.0, 3.0], trunkR: [0.18, 0.28], crownR: [1.6, 2.4], crownH: [7.0, 11.0], blobs: [5, 8], cards: 3 },
    // 灌木（贴地）
    shrub: { trunkH: [0.15, 0.30], trunkR: [0.10, 0.16], crownR: [0.9, 1.7], crownH: [0.8, 1.4], blobs: [4, 7], cards: 3 },
  };
  const p = profiles[kind] || profiles.elm;

  const trunkH = jitter(r, p.trunkH[0], p.trunkH[1]);
  const trunkR = jitter(r, p.trunkR[0], p.trunkR[1]);

  // 树干（略锥形，带一点弯曲）
  if (kind !== 'shrub') {
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(trunkR * 0.68, trunkR, trunkH, 7, 2),
      mats.bark
    );
    trunk.position.y = trunkH / 2;
    // 极轻的弯曲，避免每根树干都是直线
    const tp = trunk.geometry.attributes.position;
    const bend = jitter(r, -0.28, 0.28);
    for (let i = 0; i < tp.count; i++) {
      const t = (tp.getY(i) + trunkH / 2) / trunkH;
      tp.setX(i, tp.getX(i) + bend * t * t);
    }
    tp.needsUpdate = true;
    trunk.geometry.computeVertexNormals();
    trunk.castShadow = true;
    g.add(trunk);
  }

  // ---- 树冠：多个椭球叶簇，全部塞进共享收集器
  const blobCount = Math.round(jitter(r, p.blobs[0], p.blobs[1] + 0.99));
  const crownR = jitter(r, p.crownR[0], p.crownR[1]);
  const crownH = jitter(r, p.crownH[0], p.crownH[1]);
  const matIdx = kind === 'magnolia' ? 3 : (r() > 0.5 ? 0 : 1);

  const baseX = px, baseZ = pz;

  for (let i = 0; i < blobCount; i++) {
    const a = (i / blobCount) * Math.PI * 2 + jitter(r, -0.6, 0.6);
    const dist = (i === 0 ? 0 : jitter(r, 0.30, 0.92)) * crownR;
    const bx = Math.cos(a) * dist;
    const bz = Math.sin(a) * dist;
    const by = trunkH + crownH * 0.40 + jitter(r, -0.34, 0.34) * crownH;
    const sx = crownR * jitter(r, 0.50, 0.86);
    const sy = crownH * jitter(r, 0.34, 0.56);
    const sz = crownR * jitter(r, 0.50, 0.86);

    for (let c = 0; c < p.cards; c++) {
      const card = new THREE.PlaneGeometry(sx * 2, sy * 2);
      // 让卡片略微弯曲（顶宽底窄），叶簇才有体积感而不是平板
      const cp = card.attributes.position;
      for (let v = 0; v < cp.count; v++) {
        const yy = cp.getY(v) / (sy);
        cp.setX(v, cp.getX(v) * (0.72 + 0.28 * (1 - yy * yy)));
      }
      cp.needsUpdate = true;
      card.computeVertexNormals();

      const mtx = new THREE.Matrix4();
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        jitter(r, -0.14, 0.14),
        (c / p.cards) * Math.PI + jitter(r, -0.22, 0.22),
        jitter(r, -0.10, 0.10)
      ));
      mtx.compose(
        new THREE.Vector3(baseX + bx, by, baseZ + bz),
        q,
        new THREE.Vector3(1, 1, 1)
      );
      card.applyMatrix4(mtx);

      const key = matIdx;
      if (!leafCollector.buckets.has(key)) leafCollector.buckets.set(key, []);
      leafCollector.buckets.get(key).push(card);
    }
  }

  // 树干投影的地面暗斑（省 shadow map，但近看很有效）
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(crownR * 0.72, 14),
    new THREE.MeshBasicMaterial({
      color: 0x1c2c16, transparent: true, opacity: 0.13, depthWrite: false,
    })
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.025;
  g.add(blob);

  return g;
}

/** 树已改为共享材质的静态几何，不再需要每帧摆动（省 CPU） */
export function updateTrees() { /* 保留接口：后续要做风摆再在这里加 */ }

// ==================================================================== 花坛
/**
 * 花坛：红郁金香 + 蓝葡萄风信子（照片里那条花带）。
 * 每花一个十字卡片，数量可控（这里约 600 株），位置带抖动。
 */
export function buildFlowerBed(mats, center, width, depth, seed) {
  const g = new THREE.Group();
  g.position.copy(center);
  const r = rng(seed);

  // 土床
  const soil = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), mats.soil);
  soil.rotation.x = -Math.PI / 2;
  soil.position.y = 0.015;
  soil.receiveShadow = true;
  g.add(soil);

  // 花：两色，按 z 分带（前红后蓝，跟照片一致）
  const mkFlowerMat = (col) => new THREE.MeshStandardMaterial({
    color: col, roughness: 0.72, metalness: 0.0, side: THREE.DoubleSide,
  });
  const redMat = mkFlowerMat(0xd2242c);
  const blueMat = mkFlowerMat(0x4a4fc4);
  const greenMat = mkFlowerMat(0x3f6b2a);

  const rows = 14, cols = 90;
  for (let iz = 0; iz < rows; iz++) {
    for (let ix = 0; ix < cols; ix++) {
      const t = iz / (rows - 1);
      const x = (ix / (cols - 1) - 0.5) * width + jitter(r, -0.045, 0.045);
      const z = (t - 0.5) * depth + jitter(r, -0.03, 0.03);
      const h = jitter(r, 0.20, 0.42);

      // 叶片（细长三角）
      const leaf = new THREE.Mesh(new THREE.PlaneGeometry(0.045, h * 0.9), greenMat);
      leaf.position.set(x, h * 0.45, z);
      leaf.rotation.y = jitter(r, 0, Math.PI);
      leaf.rotation.z = jitter(r, -0.18, 0.18);
      g.add(leaf);

      // 花头（小十字）
      const isBlue = t < 0.45;
      const fm = isBlue ? blueMat : redMat;
      const fr = jitter(r, 0.035, 0.062);
      for (let c = 0; c < 2; c++) {
        const petal = new THREE.Mesh(new THREE.PlaneGeometry(fr * 2.4, fr * 2.0), fm);
        petal.position.set(x, h, z);
        petal.rotation.y = (c * Math.PI) / 2 + jitter(r, -0.3, 0.3);
        petal.rotation.z = jitter(r, -0.25, 0.25);
        g.add(petal);
      }
    }
  }
  return g;
}

// ==================================================================== 绿篱
/** 修剪的方形绿篱（照片里喷泉前那道深绿矮墙） */
export function buildHedge(mats, center, w, h, d, seed) {
  const r = rng(seed);
  const g = new THREE.Group();
  g.position.copy(center);

  // 主体：多个盒子拼，表面做出起伏。
  // 【坑】第一版在盒子顶上撒叶卡片，结果卡片远看是一堆白点（alpha 边缘没压住）。
  // 现在去掉浮空卡片，改成盒子本身带极轻微的尺寸抖动 + 一个叶色贴图，
  // 靠明暗和轮廓线表现，不再用浮空卡片。
  const segs = Math.max(3, Math.round(w / 1.5));
  for (let i = 0; i < segs; i++) {
    const t = (i + 0.5) / segs;
    const x = (t - 0.5) * w;
    const hh = h * jitter(r, 0.97, 1.03);
    const dd = d * jitter(r, 0.97, 1.03);
    const seg = new THREE.Mesh(
      boxWithBevel(w / segs + 0.10, hh, dd, 0.04),
      mats.hedge
    );
    seg.position.set(x, hh / 2, jitter(r, -0.03, 0.03));
    seg.castShadow = seg.receiveShadow = true;
    g.add(seg);
  }
  return g;
}
