// 水体与岸线（任务书 §5.3 / §9 第 6 条）
//
// 数据来自 tools/terrain/build_water.py：
//   assets/water/water.json  bodies[]：outline / holes / bed_elevation_m /
//                            design_water_level_m / normal_water_level_m /
//                            flow_direction / surface_mode / tidal / fringe_outer
//   assets/water/bed.i16     996×853 Int16 厘米，与 terrain 网格逐像素对齐
//
// 三件事：
//   1) excavateTerrain() —— 把 terrain 网格在河道内挖到 bed.i16，做出真正的河槽。
//      不挖的话地形在河里是一块 -0.33 m 的平台，水面浮在上面，看不出是河，
//      内涝仿真也没有容积。
//   2) buildWaterMesh() —— 每个水体一张水面（含洞），水面高程用 normal（潮汐河段
//      用 NOAA MSL 0.046 m，湖/池用它自己的水面高程，跌水溪流跟随地形）。
//   3) 岸线干湿过渡带 —— 轮廓外 1.5~2.5 m 的湿滩带，宽度逐点抖动，避免直线感。

import * as THREE from 'three';
import { textureWaterNormal } from './textures.js';

const COLS = 996, ROWS = 853;
const WATER_LEVEL_BED = 32767;

let waterNrm = null;

/* ------------------------------------------------------------------ 加载 */
export async function loadWater(base = 'assets/water/') {
  const [doc, buf] = await Promise.all([
    fetch(base + 'water.json', { cache: 'no-store' }).then(res => {
      if (!res.ok) throw new Error('water.json ' + res.status);
      return res.json();
    }),
    fetch(base + 'bed.i16', { cache: 'no-store' }).then(res => {
      if (!res.ok) throw new Error('bed.i16 ' + res.status);
      return res.arrayBuffer();
    }),
  ]);

  const want = COLS * ROWS * 2;
  if (buf.byteLength !== want) {
    // Chrome 一旦把某个扩展名拦成 204，fetch 的 ok 仍然为 true，body 却是空的。
    throw new Error(`bed.i16 长度 ${buf.byteLength} != ${want}（被拦成 204？）`);
  }

  const bed = new Int16Array(buf);
  const g = doc.grid || {};
  const x0 = g.x0 ?? -1277, y1 = g.y1 ?? 4189, step = g.step_m ?? 6;

  function sampleBed(x, z) {
    const fx = (x - x0) / step - 0.5;
    const fy = (y1 + z) / step - 0.5;
    const c = Math.round(fx), r = Math.round(fy);
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return null;
    const v = bed[r * COLS + c];
    return v === WATER_LEVEL_BED ? null : v * 0.01;
  }

  return { doc, bed, cols: COLS, rows: ROWS, x0, y1, step, sampleBed,
           bodies: doc.bodies || [], levels: doc.levels || {} };
}

/* --------------------------------------------------- 把地形挖成河槽 */
// terrain.js 的顶点是 r 行 c 列逐行排的，与 bed.i16 的 raster 顺序完全一致，
// 所以这里按下标直接对，不用再插值。
//
// 【坑】buildTerrainMesh() 返回的是 Group('L0_terrain')，不是 Mesh。
// 第一版直接把 Group 传进来，group.geometry 是 undefined，函数静默返回 0——
// 日志里「挖槽顶点 0」就是这么来的，地形其实一点没挖。
export function excavateTerrain(obj, W) {
  let mesh = obj;
  if (mesh && !mesh.geometry && mesh.isObject3D) {
    mesh = null;
    obj.traverse((o) => {
      if (!mesh && o.isMesh && o.geometry && o.geometry.getAttribute('position')) mesh = o;
    });
  }
  if (!mesh || !mesh.geometry) {
    console.warn('[water] 找不到地形网格，跳过挖槽', obj && obj.name);
    return 0;
  }
  const pos = mesh.geometry.getAttribute('position');
  const col = mesh.geometry.getAttribute('color');
  const n = pos.count;
  if (n !== COLS * ROWS) {
    console.warn('[water] 地形顶点数', n, '与 bed 网格', COLS * ROWS, '不一致，跳过挖槽');
    return 0;
  }

  // 岸线过渡：靠近多边形边缘时不要挖出一步台阶。bed 里边缘本来就是 0 深度
  // （build_water 的 ramp 从边缘算起），这里再对相邻像素做一次最小值平滑。
  const bed = W.bed;
  let dug = 0;
  for (let i = 0; i < n; i++) {
    const v = bed[i];
    if (v === WATER_LEVEL_BED) continue;
    const z = v * 0.01;
    if (z >= pos.getY(i)) continue;
    pos.setY(i, z);
    dug++;
    if (col) {
      // 河床：暗灰绿泥，越深越暗
      const t = Math.min(1, Math.max(0, -z / 6));
      col.setXYZ(i, 0.13 - t * 0.04, 0.17 - t * 0.04, 0.15 - t * 0.03);
    }
  }
  if (!dug) return 0;
  pos.needsUpdate = true;
  if (col) col.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
  mesh.geometry.computeBoundingSphere();
  return dug;
}

/* --------------------------------------------- 岸线湿泥晕染（消除格子锯齿感） */
// 6 m 地形网格在陡岸（Georgetown 崖 12 m 内抬 35 m）上，水线必然是 6 m 一格
// 的阶梯——这是**几何分辨率**决定的，改 bed 深度/环号都消不掉（试过 10+ 轮）。
// 唯一有效的办法是不跟几何较劲：把水线附近几米的陆地顶点染成湿泥色，让这一圈
// 阶梯读成「潮湿的河滩」，而不是「一刀切的硬边」。配合 water.js 的湿滩带
// alpha 渐变，视觉上就是 1~3 m 的干湿过渡（§9 第 6 条）。
export function paintShoreWet(obj, W) {
  let mesh = obj;
  if (mesh && !mesh.geometry && mesh.isObject3D) {
    mesh = null;
    obj.traverse((o) => {
      if (!mesh && o.isMesh && o.geometry && o.geometry.getAttribute('position')) mesh = o;
    });
  }
  if (!mesh || !mesh.geometry) return 0;
  const col = mesh.geometry.getAttribute('color');
  if (!col) return 0;

  const { cols, rows } = W;
  // 水面掩膜（bed 有值 = 河道/湖面范围）
  const wet = new Uint8Array(cols * rows);
  let has = false;
  for (let i = 0; i < wet.length; i++) {
    if (W.bed[i] !== WATER_LEVEL_BED) { wet[i] = 1; has = true; }
  }
  if (!has) return 0;
  // 向外扩 2 圈（12 m）得到「近岸带」，并记录每个顶点在第几圈（1 / 2）
  const ring = new Uint8Array(cols * rows);
  let cur = new Uint8Array(wet);
  for (let k = 0; k < 2; k++) {
    const prev = cur.slice();
    const next = prev.slice();
    for (let r = 0; r < rows; r++) {
      const o = r * cols;
      for (let c = 0; c < cols; c++) {
        const i = o + c;
        if (prev[i]) continue;
        if ((c > 0 && prev[i - 1]) || (c < cols - 1 && prev[i + 1]) ||
            (r > 0 && prev[i - cols]) || (r < rows - 1 && prev[i + cols])) {
          next[i] = 1;
          if (!ring[i]) ring[i] = k + 1;
        }
      }
    }
    cur = next;
  }

  let n = 0;
  const cnt = Math.min(col.count, wet.length);
  // 两圈渐变：紧贴水的第一圈湿得最重（62%），第二圈（6~12 m）只剩 26%。
  // 不做逐圈硬分界，否则 6 m 网格上会出现一条肉眼可见的色阶。
  const blend = [0.62, 0.26];
  for (let i = 0; i < cnt; i++) {
    if (wet[i] || !ring[i]) continue;          // 只在「陆地但近岸」的顶点上做
    const t = blend[ring[i] - 1];
    const r = col.getX(i), g = col.getY(i), b = col.getZ(i);
    col.setXYZ(i,
      r * (1 - t) + 0.26 * t,
      g * (1 - t) + 0.24 * t,
      b * (1 - t) + 0.18 * t);
    n++;
  }
  if (n) { col.needsUpdate = true; }
  return n;
}

/* --------------------------------------------------------- 水面网格 */
function ringToShape(ring, holes) {
  // shape 平面用 (x, planY)；整体旋转 -90° 后 z = -planY，与 three 的约定一致
  const pts = ring.map(p => new THREE.Vector2(p[0], p[1]));
  // 去掉退化的相邻重复点（earcut 对重复点敏感）
  const clean = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (a.distanceTo(b) > 0.05) clean.push(a);
  }
  const shape = new THREE.Shape(clean);
  for (const h of holes || []) {
    const hp = [];
    const v = h.map(p => new THREE.Vector2(p[0], p[1]));
    for (let i = 0; i < v.length; i++) {
      const a = v[i], b = v[(i + 1) % v.length];
      if (a.distanceTo(b) > 0.05) hp.push(a);
    }
    if (hp.length >= 3) shape.holes.push(new THREE.Path(hp));
  }
  return shape;
}

function surfaceY(body, x, z, T, lvl) {
  if (body.surface_mode === 'follow_terrain' && T) {
    // 跌水溪流：水面贴着地形走。
    //
    // 【坑】只写 clamp(T.sampleHeight, lvl-1.2, lvl+1.2) 不够：lvl 是这条水体的
    // 「主导水面高程」，个别溪流的 lvl 被 DEM 众数抬高了（water_17 lvl=17.14 而
    // 实际地面只有 6.3 m；water_29 lvl=29.07 而地面 19.9 m），clamp 的下界仍是
    // 15.9 / 27.9，水面整片悬空 9~10 m。再补一道「不得高于自身地面 0.25 m」的上限。
    const g = T.sampleHeight(x, z);
    const y = Math.max(lvl - 1.2, Math.min(lvl + 1.2, g));
    return Math.min(y, g + 0.25);
  }
  // 平水面：**局部也要贴地**。
  //
  // 【坑】直接 return lvl 会让少数「图纸上在小水塘、实际落在坡上」的多边形整块
  // 悬空：实测 water_water_29 全部 43/63 个顶点悬空，最高 9.14 m（水面 29.07 m，
  // 脚下地面只有 19.93 m）；water_14 悬空 3.33 m。根因是 build_water.py 用 DEM
  // 直方图众数当水位，水体轮廓里混进了一小段坡地。
  // 修法：只有「脚下地面比水位低了 0.6 m 以上」的顶点才把水面压到地面之上
  // 0.25 m；正常水塘/河道内部 DTM 是 hydro-flattened 的，与水位差 < 0.6 m，
  // 一律保持严格的水平面，不会把河面做成波浪。
  if (T) {
    const g = T.sampleHeight(x, z);
    if (g < lvl - 0.6) return Math.min(lvl, g + 0.25);
  }
  return lvl;
}

// 【河面藏在地形底下 —— 真水线遮罩】
// water.json 的 outline 是「外扩到岸坡下面」的水面轮廓，不一定等于真出水范围：
//   · bed.i16 没覆盖的地方（波托马克 224 ha 里 24%、Anacostia 一部分）：地形没被
//     挖低，水面就埋进地面里——从上往下看不见，从下往上看（DoubleSide）却看得见
//     一整条河挂在头顶。
//   · bed 有值但比水面还高的地方（岸坡 ramp、Rock Creek 谷壁）：excavateTerrain
//     只用 bed 往下挖、不往上填，地形保持原高，水面同样被埋。
// 所以这里按「挖完以后地面到底比水位低不低」逐像素判一次，把水面裁到真出水格子上。
// 1 m 的 DTM 与 6 m 的 bed 一起用，判据和渲染出来的地形完全一致。
function buildWaterMask(W, T) {
  const { cols, rows, x0, y1, step } = W;
  const mask = new Uint8Array(cols * rows);
  if (!T) { mask.fill(255); return mask; }
  const north = y1;                       // planY：北边 y1，往南减
  for (const b of W.bodies) {
    const ring = b.outline || [];
    if (ring.length < 3) continue;
    const lvl = b.normal_water_level_m;
    const follow = b.surface_mode === 'follow_terrain';
    let ymin = 1e9, ymax = -1e9;
    for (const p of ring) { if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1]; }
    const r0 = Math.max(0, Math.floor((north - ymax) / step) - 1);
    const r1 = Math.min(rows - 1, Math.ceil((north - ymin) / step) + 1);
    for (let r = r0; r <= r1; r++) {
      const planY = north - (r + 0.5) * step;
      // 扫描线求与多边形的交点，成对填格（比逐像素射线快两个数量级）
      const xs = [];
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const yi = ring[i][1], yj = ring[j][1];
        if ((yi > planY) === (yj > planY)) continue;
        xs.push(ring[i][0] + (planY - yi) / (yj - yi) * (ring[j][0] - ring[i][0]));
      }
      if (xs.length < 2) continue;
      xs.sort((a, b2) => a - b2);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - x0) / step - 0.5));
        const c1 = Math.min(cols - 1, Math.floor((xs[k + 1] - x0) / step - 0.5));
        for (let c = c0; c <= c1; c++) {
          const x = x0 + (c + 0.5) * step;
          const z = -(north - (r + 0.5) * step);
          const bz = W.sampleBed(x, z);
          if (bz === null) continue;                    // 源数据里这里就不是水
          const g = T.sampleHeight(x, z);
          const h = Math.min(g, bz || g);               // excavateTerrain：只挖不填
          if (follow || h < lvl - 0.02) mask[r * cols + c] = 255;
        }
      }
    }
  }
  return mask;
}

export function buildWaterMesh(W, T) {
  if (!waterNrm) waterNrm = textureWaterNormal(256);
  const group = new THREE.Group();
  group.name = 'L1_water';

  const maskData = buildWaterMask(W, T);
  const maskTex = new THREE.DataTexture(maskData, W.cols, W.rows, THREE.RedFormat);
  maskTex.minFilter = THREE.NearestFilter;
  maskTex.magFilter = THREE.NearestFilter;
  maskTex.needsUpdate = true;
  W.maskTex = maskTex;

  const mat = new THREE.MeshStandardMaterial({
    color: 0x3a7c9e,
    normalMap: waterNrm,
    normalScale: new THREE.Vector2(0.42, 0.42),
    // 0.055 太亮：太阳正对时河面炸出一团死白（07 号截图），提到 0.13 收住
    roughness: 0.13,
    metalness: 0.10,
    transparent: true,
    opacity: 0.965,
    envMapIntensity: 1.65,
    side: THREE.DoubleSide,
  });

  // 河面遮罩：见 loadWater 里的注释。UV 与 sampleBed 完全同一套换算。
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uBedMask = { value: W.maskTex };
    sh.uniforms.uMaskO = { value: new THREE.Vector2(W.x0, W.y1) };
    sh.uniforms.uMaskN = { value: new THREE.Vector2(W.cols, W.rows) };
    sh.uniforms.uMaskStep = { value: W.step };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>',
               '#include <common>\nvarying vec2 vMaskUV;\nuniform vec2 uMaskO;\nuniform vec2 uMaskN;\nuniform float uMaskStep;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 mwp = modelMatrix * vec4(transformed, 1.0);
        vMaskUV = vec2((mwp.x - uMaskO.x) / uMaskStep / uMaskN.x,
                       (uMaskO.y + mwp.z) / uMaskStep / uMaskN.y);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>',
               '#include <common>\nuniform sampler2D uBedMask;\nvarying vec2 vMaskUV;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (vMaskUV.x < 0.0 || vMaskUV.x > 1.0 || vMaskUV.y < 0.0 || vMaskUV.y > 1.0) discard;
        if (texture2D(uBedMask, vMaskUV).r < 0.5) discard;`);
  };

  // 岸线湿滩带：内圈贴水面、外圈贴地面，颜色由水色过渡到湿泥，alpha 归零，
  // 这样没有一条可见的硬边。宽度逐点 1.5~2.5 m 抖动（任务书要 1~3 m 且无直线感）。
  const fringeMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    roughness: 0.55,
    metalness: 0.0,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    dithering: true,
  });

  let tris = 0, wetPx = 0;
  for (const b of W.bodies) {
    const lvl = b.normal_water_level_m;
    const design = b.design_water_level_m;
    const shape = ringToShape(b.outline, b.holes);
    const geo = new THREE.ShapeGeometry(shape, 1);
    geo.rotateX(-Math.PI / 2);      // (x, planY, 0) → (x, 0, -planY)
    geo.computeVertexNormals();

    const p = geo.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      p.setY(i, surfaceY(b, p.getX(i), p.getZ(i), T, lvl));
    }
    p.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const m = new THREE.Mesh(geo, mat);
    m.name = 'water_' + b.id;
    m.matrixAutoUpdate = false;
    m.visible = true;
    m.userData.body = b;
    m.userData.T = T;               // surfaceY 重算需要地形采样器
    m.receiveShadow = false;
    m.castShadow = false;
    group.add(m);
    tris += geo.index ? geo.index.count / 3 : p.count / 3;

    // ---- 湿滩带 ----
    // 【坑】这里原来用 b.outline 配 b.fringe_outer。但 outline 现在是「外扩到岸坡
    // 下面的水面轮廓」（build_water 的 ring_w，波托马克 1043 点），而 fringe_outer
    // 是沿真实岸线（shoreline，718 点）外推的，两者长度不等 →
    // `outer.length !== ring.length` 直接 continue，**一条湿滩带都没建出来**。
    // 表现是 fringe-only 的截图和 tw 的截图字节完全相同。必须用 shoreline 配对。
    const ring = b.shoreline || b.outline, outer = b.fringe_outer;
    if (!outer || outer.length !== ring.length) continue;
    // 【坑】场景窗口把 landcover 截断，那里的「岸线」是数据边界不是真河岸
    // （波托马克南端有一条 885 m 直边压在 y=-931 窗口边上）。湿滩带整条
    // 贴在水平面上，沿这种直边铺出来就是一条横穿水面的灰白直线。
    // build_water.py 用 shore_edge[] 逐点标了 1，这里整段跳过。
    const edg = b.shore_edge;
    const onEdge = (i) => !!(edg && edg[i]);
    const n = ring.length;
    const vpos = new Float32Array(n * 2 * 3);
    const vcol = new Float32Array(n * 2 * 4);
    const vnorm = new Float32Array(n * 2 * 3);
    const idx = [];
    // 挖后地形高程（米）：地形被 excavateTerrain 挖到 bed 的地方取 min(DTM, bed)。
    // 必须用这个判断「哪里真的出水」——T.sampleHeight 是原始 hydro-flattened
    // DTM（河道里 -0.3、岸边却写着 2~5 m），与渲染出来的地面不符。
    const hEff = (x, PLAN_Y) => {
      const g = T ? T.sampleHeight(x, -PLAN_Y) : 0;
      const bz = W.sampleBed ? W.sampleBed(x, -PLAN_Y) : null;
      return bz === null ? g : Math.min(g, bz);
    };
    for (let i = 0; i < n; i++) {
      const [ix, iy] = ring[i];
      const [ox, oy] = outer[i];
      // 【终解·横穿水面的浅灰亮线】湿滩带不能直接拿「多边形岸线点」画。
      //   · fringe_outer 是沿多边形法线朝外推 1.5~2.5 m，但外侧是陆地还是
      //     河面取决于多边形绕向，波托马克多段朝河里 → 带子漂在水面上。
      //   · 更根本的：all_touched 栅格化 + shelf 缓滩之后，多边形边界离真正
      //     出水的位置普遍还有 6~12 m，直接用边界点画必然落在水里。
      // 做法：沿法线往外步进（0.5 m 步长，最多 24 m），找到**挖后地面**升到
      // 水位以上的第一点，那才是真实水线；从那里再往外 1.5~3 m 铺湿滩带。
      let dx = ox - ix, dy = oy - iy;
      const dl = Math.hypot(dx, dy);
      if (!(dl > 1e-6)) continue;
      dx /= dl; dy /= dl;
      // 【坑】多边形绕向不统一：波托马克/Anacostia 的法线朝河里，沿它走出
      // 24 m 全是水，一个点都找不到 → 这两条大河湿滩带 0 三角。所以两个方向
      // 都试，取先出水的那一侧。
      let ex = null, ey = 0, fx = 0, fy = 0;
      for (const sgn of [1, -1]) {
        for (let t = 0.5; t <= 72; t += 1.0) {
          const px = ix + dx * sgn * t, py = iy + dy * sgn * t;
          if (hEff(px, py) >= lvl) { ex = px; ey = py; fx = dx * sgn; fy = dy * sgn; break; }
        }
        if (ex !== null) break;
      }
      if (ex === null) continue;        // 两侧 72 m 内都没出水 → 跨水弦/截断，不画
      const fw = 1.5 + (((i * 0.6180339887) % 1) * 1.5);   // 1.5~3.0 m 抖动
      const ox2 = ex + fx * fw, oy2p = ey + fy * fw;
      const iy2 = lvl + 0.02;                               // 内圈：水面 +2 cm
      const oy2 = Math.max(hEff(ox2, oy2p), lvl) + 0.03;     // 外圈：贴岸面 +3 cm
      vpos[i * 6 + 0] = ex; vpos[i * 6 + 1] = iy2; vpos[i * 6 + 2] = -ey;
      vpos[i * 6 + 3] = ox2; vpos[i * 6 + 4] = oy2; vpos[i * 6 + 5] = -oy2p;
      // 内圈 = 水色（半透），外圈 = 湿泥（全透明）
      vcol[i * 8 + 0] = 0.20; vcol[i * 8 + 1] = 0.30; vcol[i * 8 + 2] = 0.31; vcol[i * 8 + 3] = 0.62;
      vcol[i * 8 + 4] = 0.34; vcol[i * 8 + 5] = 0.30; vcol[i * 8 + 6] = 0.22; vcol[i * 8 + 7] = 0.0;
      vnorm[i * 6 + 1] = 1; vnorm[i * 6 + 4] = 1;
      const a = i * 2, c = ((i + 1) % n) * 2;
      const j = (i + 1) % n;
      // 两端有任何一点落在场景窗口边界上 → 这条带子不是真岸线，不画
      if (onEdge(i) || onEdge(j)) continue;
      // 【坑】shoreline 不是逐 1 m 的连续折线：landcover 在窗口/水面截断处会
      // 直接跨过一大段（波托马克 y≈-556 有一条从 x=234 直跳到 x=-742 的 900 m
      // 边）。两点之间铺出来的就是一条横穿水面的直带。判据：相邻点间距在 1 m
      // 栅格量化后 ≤ 150 m（大河岸线 p50=25 m 属正常），更大的就是人工直边。
      const segLen = Math.hypot(ring[j][0] - ix, ring[j][1] - iy);
      if (segLen > 150) continue;
      // 【坑】岸线会「抄近路」横穿水面：相邻两点分处河湾两侧、或绕开码头
      // 缺口时，中间是开阔水面，湿滩带铺过去就是一条横穿水面的细线（贴水
      // 视角看是一条深色/亮色斜线）。判据：把这一整段按 2 m 采样，只要有一
      // 个点落在水下就整段不画——真岸线是连续的，不会下水。
      {
        const x0s = ex, y0s = ey, x1s = ring[j][0], y1s = ring[j][1];
        const sl = Math.hypot(x1s - x0s, y1s - y0s);
        const ns = Math.max(2, Math.ceil(sl / 2));
        let ok = true;
        for (let k = 0; k <= ns; k++) {
          const t = k / ns;
          if (hEff(x0s + (x1s - x0s) * t, y0s + (y1s - y0s) * t) < lvl - 0.05) { ok = false; break; }
        }
        if (!ok) continue;
      }
      // 大河（岸线采样间距 p50=25 m）按上面的整段检查几乎必被否掉，硬画出来
      // 也只是一根根几十米长的直弦。所以这里再用一条硬门槛：只给「1 m 级
      // 密集岸线」的水体（小池、溪流）画带子；大河的湿滩完全交给地形顶点色
      // 的按高程晕染（见 paintShoreWet），那条跟随真实水线，不会有直边。
      if (segLen > 12) continue;
      idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(vpos, 3));
    fg.setAttribute('color', new THREE.BufferAttribute(vcol, 4));
    fg.setAttribute('normal', new THREE.BufferAttribute(vnorm, 3));
    fg.setIndex(idx);
    fg.computeBoundingSphere();
    const fm = new THREE.Mesh(fg, fringeMat);
    fm.name = 'waterfringe_' + b.id;
    fm.renderOrder = 2;
    group.add(fm);
    wetPx += n;
  }

  console.log(`[water] ${W.bodies.length} 水体, ${Math.round(tris)} 三角, ` +
              `湿滩带 ${wetPx} 点, 水面高程 ${W.levels.MSL_m ?? 0.046} m (NOAA MSL)`);
  return group;
}

/* ------------------------------------------------ design 洪水位（内涝用） */
// 仿真需要"把水面抬到 design_water_level_m"这一刻的状态，先把接口留出来。
export function setWaterDesignLevel(W, group, on) {
  for (const m of group.children) {
    // 【坑】湿滩带网格没有 userData.body，必须先判名字再判 body；
    // 原来写成 `if (!b || !m.geometry) continue;` 在最前面，湿滩带网格
    // 因为 b===undefined 直接被跳过，design 模式下永远不隐藏。
    if (m.name.startsWith('waterfringe_')) { m.visible = !on; continue; }
    const b = m.userData.body;
    if (!b || !m.geometry) continue;
    const lvl = on ? b.design_water_level_m : b.normal_water_level_m;
    const p = m.geometry.getAttribute('position');
    // 【坑】不能直接 p.setY(i, lvl) 一刀拍平：follow_terrain 的溪流（沿程跌落的
    // 7 条）水面必须跟着地形走，拍平会把上游架空、下游淹没。
    // 用 surfaceY 让每类水体按自己的规则抬升，只是在新的 lvl 上重算一次。
    for (let i = 0; i < p.count; i++) {
      p.setY(i, surfaceY(b, p.getX(i), p.getZ(i), m.userData.T || null, lvl));
    }
    p.needsUpdate = true;
    m.geometry.computeBoundingSphere();
  }
}
