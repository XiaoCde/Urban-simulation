/**
 * 地形与下垫面 —— L0_terrain 层。
 *
 * 数据来源（§5.1 数据契约，全部由 tools/terrain/ 从 USGS 3DEP 1 m DEM
 *  与 DCGIS 2025 下垫面派生，不是平面、不是噪声）：
 *   web/assets/terrain/height.i16    DTM 高程，Int16 厘米，NAVD88
 *   web/assets/terrain/landcover.u8  0 水体 / 1 建筑 / 2 硬化 / 3 草地 / 4 林地 / 5 裸土
 *   web/assets/terrain/wet.u8        离水体距离（0 水边 → 255 ≥30 m），滨水湿土过渡带
 *   web/assets/terrain/terrain.json  窗口原点 / 步长 / 行列数
 *
 * 【硬约束】浏览器里没有 .glb、没有图片：几何与颜色全部在这里用代码生成。
 * 【硬约束】建筑底面 y = 各自 DTM 高程，不是 0（§5.5）。所以本模块导出的
 *   sampleHeight(x, z) 是全场景唯一的地面高程查询入口，建筑/树/喷泉都得走它。
 */

import * as THREE from 'three';

// ---------------------------------------------------------------- 下垫面配色
// 色板按 DC 实景调：潮汐湖/波托马克是浑绿褐，不是泳池蓝；沥青偏冷灰；
// 草地是偏黄的草甸绿（不是高尔夫球场那种饱和绿）。
export const LC = {
  WATER: 0, BUILDING: 1, PAVED: 2, GRASS: 3, FOREST: 4, BARE: 5,
};

const LC_COLOR = {
  0: [0.16, 0.24, 0.24],  // 水体：暗浑绿（水面由 water.js 覆盖，这里只是河床）
  1: [0.52, 0.50, 0.47],  // 建筑：中性灰（会被 L3 的楼盖住，只露出缝隙）
  2: [0.29, 0.30, 0.315], // 硬化：冷灰沥青 / 混凝土（原来 0.40 上屏偏米白，像沙地）
  3: [0.21, 0.34, 0.11],  // 草地：草甸绿（原来 0.33/0.42/0.21 渲染出来发米黄，见 §12）
  4: [0.12, 0.23, 0.09],  // 林地：更深的树荫绿
  5: [0.44, 0.37, 0.25],  // 裸土：棕黄壤质
};

// 湿土过渡带：靠近水边把下垫面往「湿泥」拉，形成 1~3 m 可辨但无直线边界的过渡
const MUD = [0.30, 0.27, 0.20];

// ---------------------------------------------------------------- 数据加载

/** 读二进制 + 元数据。row 0 = 最北一行。 */
export async function loadTerrain(base = 'assets/terrain/') {
  const meta = await fetch(base + 'terrain.json').then((r) => {
    if (!r.ok) throw new Error('terrain.json ' + r.status);
    return r.json();
  });
  const [hBuf, lcBuf, wetBuf] = await Promise.all([
    fetch(base + 'height.i16').then((r) => r.arrayBuffer()),
    fetch(base + 'landcover.u8').then((r) => r.arrayBuffer()),
    fetch(base + 'wet.u8').then((r) => r.arrayBuffer()),
  ]);

  const heights = new Int16Array(hBuf);
  const landcover = new Uint8Array(lcBuf);
  const wet = new Uint8Array(wetBuf);
  const { cols, rows } = meta.grid;
  if (heights.length !== cols * rows) {
    throw new Error(`height 长度 ${heights.length} ≠ ${cols}×${rows}`);
  }

  return {
    meta,
    heights,
    landcover,
    wet,
    cols,
    rows,
    step: meta.grid.step_m,
    x0: meta.grid.x0,
    y0: meta.grid.y0,   // 窗口「南」边界（planY 最小处）
    zMin: meta.height.z_min,
    zMax: meta.height.z_max,
    /** 双线性插值取地面高程（场景坐标，米，NAVD88）。 */
    sampleHeight: makeSampler(meta, heights),
    /** 取该点下垫面类别。 */
    classify: (x, z) => {
      const c = Math.round((x - meta.grid.x0) / meta.grid.step_m - 0.5);
      const r = Math.round((meta.grid.y1 + z) / meta.grid.step_m - 0.5);
      if (c < 0 || r < 0 || c >= cols || r >= rows) return -1;
      return landcover[r * cols + c];
    },
  };
}

function makeSampler(meta, heights) {
  const { x0, y1, step_m: s, cols, rows } = meta.grid;
  // 【坑】three 里 z = -planY，栅格的 y1 是 planY 的北边界。
  // 行号与 z 的关系是 r = (y1 + z)/s，不是 (y1 - z)/s。
  // 第一版写成 (y1 - z)/s，结果整块地形在 z 方向镜像：
  // 地形占了 z -926..4186，而建筑在 z -4189..931，两层只在中间重叠，
  // 画面上看起来就是「一片灰板 + 一堆悬空的盒子」。
  return function sampleHeight(x, z) {
    const fx = (x - x0) / s - 0.5;
    const fy = (y1 + z) / s - 0.5;
    // 【越界必须钳位，不能返回 0】
    // 之前这里 `if (...) return 0;` —— 场景边界外的查询一律得到「海拔 0 m」。
    // 但边界附近的地形其实有 10~50 m 高（Georgetown 崖、东北高地），于是任何
    // 落在边界外的几何（水体多边形、广场缘石、树）都会被摆到 0 m，再和真实
    // 地面差出十几米 —— 这就是「浮在空中的东西」里最难抓的一类：
    // 水体 water_06 最北端 350 个顶点浮起 15.94 m、water_17 浮 9.66 m 全是这个原因。
    // 钳位后边界外延用最近一行的真实高程，几何最多贴边、不会跳到海平面。
    let c0 = Math.floor(fx), r0 = Math.floor(fy);
    if (c0 < 0) c0 = 0; else if (c0 > cols - 2) c0 = cols - 2;
    if (r0 < 0) r0 = 0; else if (r0 > rows - 2) r0 = rows - 2;
    // 钳位后 tx/ty 可能超出 [0,1]：线性外延仍然是连续的，比跳变好。
    const tx = fx - c0, ty = fy - r0;
    const i = r0 * cols + c0;
    const h00 = heights[i], h10 = heights[i + 1];
    const h01 = heights[i + cols], h11 = heights[i + cols + 1];
    const a = h00 + (h10 - h00) * tx;
    const b = h01 + (h11 - h01) * tx;
    return (a + (b - a) * ty) * 0.01;   // 厘米 → 米
  };
}

// ---------------------------------------------------------------- 地形网格

/**
 * 建地形网格。
 * 每个顶点按 landcover 上色，所以整片地面是**一个 mesh、一次 draw call**，
 * 不需要 6 个材质分块。法线用高度场解析求（比 computeVertexNormals 快得多，
 * 996×853 网格上差一倍以上启动时间）。
 */
export function buildTerrainMesh(T, opt = {}) {
  const { cols, rows, step: s, x0, y1, heights, landcover, wet } = {
    ...T,
    y1: T.meta.grid.y1,
  };

  const vCount = cols * rows;
  const pos = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  // 「硬度」通道：0 = 长草/软土（用草地贴图），1 = 铺装/建筑（用铺装贴图）。
  // 顶点色给了色调，这个通道只决定叠哪张细节贴图，两者不冲突。
  const hard = new Float32Array(vCount);

  // 1) 顶点：x-z 平面网格 + 高程
  // 【坑】z = -planY（three 的右手系）。y1 是栅格北边界（planY 最大处），
  // 所以 row 0（北）应落在 z = -y1；第一版写成 z = y1 - (r+0.5)*s，
  // 整块地形在 z 方向被镜像到 +z 侧，与建筑在 z 上恰好不重叠。
  for (let r = 0; r < rows; r++) {
    const z = (r + 0.5) * s - y1;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const k = i * 3;
      pos[k] = x0 + (c + 0.5) * s;
      pos[k + 1] = heights[i] * 0.01;
      pos[k + 2] = z;
    }
  }

  // 1b) 路廊下切：让地形在道路走廊内让位
  // 【为什么需要】路面 ribbon 是零厚度的，高程取中心线附近的最大值；一条路连
  // 人行道有 12~14 m 宽，而地形网格是 6 m 一格、在坡上是斜的 —— 外侧地形会从
  // 路面上穿出来，看起来就是「路和地融在一块」。python 端 export_road_cut.py
  // 按同一套高程公式算出每格的路面高程（cut.i16），这里把地形压到它下面 3 cm。
  // 这一下不会让路变高架：地形是**让位**，两侧自然形成挖方边坡。
  if (T.roadCut) {
    const cut = T.roadCut;
    let nCut = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = cut[r * cols + c];
        if (v === -32768) continue;
        const i = r * cols + c;
        const target = v * 0.01 - 0.12;
        if (target < pos[i * 3 + 1]) { pos[i * 3 + 1] = target; nCut++; }
      }
    }
    // 路廊内的地形再压暗一点：路面 ribbon 是 12 m 宽的一整条，与地形几乎共面，
    // 任何一点高度差都会露出「灰色地形」或「绿草坪」。把路廊内的地形色调成
    // 深沥青灰，露出来的部分读作路肩/排水沟，而不是一块绿地。
    const ASPHALT = [0.115, 0.112, 0.108];
    for (let i = 0; i < vCount; i++) {
      const v = cut[i];
      if (v === -32768) continue;
      const k3 = i * 3;
      // 只在「地形本来就不是水面/建筑」的地方上色，避免把河道、楼基染黑
      const cls2 = landcover[i];
      if (cls2 === 0 || cls2 === 1) continue;
      col[k3] = col[k3] * 0.35 + ASPHALT[0] * 0.65;
      col[k3 + 1] = col[k3 + 1] * 0.35 + ASPHALT[1] * 0.65;
      col[k3 + 2] = col[k3 + 2] * 0.35 + ASPHALT[2] * 0.65;
    }
    console.log(`[terrain] 路廊下切 ${nCut} 个顶点`);
  }

  // 2) 顶点色：下垫面配色 + 湿土过渡 + 极轻的颗粒噪声
  for (let i = 0; i < vCount; i++) {
    const cls = landcover[i];
    let rgb = LC_COLOR[cls] || LC_COLOR[3];
    // 湿土过渡：wet 0 = 水边，255 = ≥30 m
    const w = 1 - Math.min(1, wet[i] / 255);
    if (w > 0.001 && cls !== LC.WATER) {
      const k = Math.min(1, w * 1.15);
      rgb = [
        rgb[0] + (MUD[0] - rgb[0]) * k,
        rgb[1] + (MUD[1] - rgb[1]) * k,
        rgb[2] + (MUD[2] - rgb[2]) * k,
      ];
    }
    // 颗粒噪声：同一种地类不能是一整片纯色（一眼看出是贴片）
    const n = hash2(i) * 0.055 - 0.0275;
    // 低频斑块：6 m 一格的噪声太细，远看仍是一片平色。再叠一层 48 m 见方的
    // 大斑块，草地才会读成「有深浅的草甸」而不是「一块绿布」。
    const rr0 = (i / cols) | 0, cc0 = i % cols;
    const blk = hash2(((rr0 >> 3) * 4099 + (cc0 >> 3)) >>> 0);
    const patch = cls === LC.GRASS ? (blk * 0.20 - 0.10)
      : cls === LC.FOREST ? (blk * 0.14 - 0.07)
        : cls === LC.PAVED ? (blk * 0.06 - 0.03)
          : cls === LC.BARE ? (blk * 0.12 - 0.06) : 0;
    const k = i * 3;
    col[k] = Math.max(0, rgb[0] + n + patch);
    col[k + 1] = Math.max(0, rgb[1] + n + patch * 1.15);
    col[k + 2] = Math.max(0, rgb[2] + n + patch * 0.7);

    // 硬度：硬化地面与建筑 = 1（铺装贴图），草地 = 0，林地 0.15，裸土 0.45
    hard[i] = cls === LC.PAVED || cls === LC.BUILDING ? 1.0
      : cls === LC.WATER ? 1.0
        : cls === LC.BARE ? 0.45
          : cls === LC.FOREST ? 0.15 : 0.0;
  }

  // 2.5) 空地绿化：DCGIS 的 impervious 把大量空地块（球场、停车场、河岸空地）
  //      都标成「硬化」，上屏就是一整片米白水泥地 —— 用户说的「大量空白地」。
  //      这里只在「48 m 方块内既没有楼、也没有水」的硬化格上撒草坪；有楼/临水的
  //      街区一律不动。**只改渲染顶点色，不改 landcover.u8 原始数据** ——
  //      淹没计算读的仍是分类结果。
  {
    const BS = 14;                                  // 14 格 × 6 m = 84 m（块更大，草坪才连成片）
    const bc = Math.ceil(cols / BS), brr = Math.ceil(rows / BS);
    const bBld = new Float32Array(bc * brr), bWat = new Float32Array(bc * brr);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const b = ((r / BS) | 0) * bc + ((c / BS) | 0);
        const cls = landcover[r * cols + c];
        if (cls === LC.BUILDING) bBld[b] += 1;
        else if (cls === LC.WATER) bWat[b] += 1;
      }
    }
    const per = BS * BS;
    let nLawn = 0;
    for (let i = 0; i < vCount; i++) {
      if (landcover[i] !== LC.PAVED) continue;
      const r = (i / cols) | 0, c = i % cols;
      const b = ((r / BS) | 0) * bc + ((c / BS) | 0);
      if (bBld[b] > 0.02 * per || bWat[b] > 0.10 * per) continue;  // 有楼/临水 → 留硬地
      if (hash2((b * 7919 + 13) >>> 0) > 0.87) continue;           // 13% 留作铺装/球场
      const t2 = hash2((b * 104729 + 7) >>> 0);
      // 草坪 / 林荫两种绿，按块哈希分开，避免整片一个色
      const g = t2 < 0.32 ? [0.13, 0.235, 0.085] : [0.205, 0.335, 0.105];
      const k3 = i * 3;
      const nA = hash2(i) * 0.05 - 0.025;
      const nB = hash2(i + 1) * 0.05 - 0.025;
      const nC = hash2(i + 2) * 0.03 - 0.015;
      col[k3] = Math.max(0, g[0] + nA);
      col[k3 + 1] = Math.max(0, g[1] + nB);
      col[k3 + 2] = Math.max(0, g[2] + nC);
      hard[i] = 0.0;                                 // 贴图也跟着换成草地
      nLawn++;
    }
    console.log(`[terrain] 空地绿化 ${nLawn} 格 ≈ ${(nLawn * s * s / 10000).toFixed(1)} 万 m²`);
  }

  // 3) 法线：中心差分，从高度场直接算（不依赖三角索引）
  const nrm = new Float32Array(vCount * 3);
  const hAt = (c, r) => {
    const cc = c < 0 ? 0 : c >= cols ? cols - 1 : c;
    const rr = r < 0 ? 0 : r >= rows ? rows - 1 : r;
    return heights[rr * cols + cc] * 0.01;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const dzdx = (hAt(c + 1, r) - hAt(c - 1, r)) / (2 * s);
      const dzdz = (hAt(c, r + 1) - hAt(c, r - 1)) / (2 * s);
      // 行号增加 = 向南（z 减小），所以 z 方向导数取反
      let nx = -dzdx, ny = 1, nz = dzdz;
      const L = Math.hypot(nx, ny, nz);
      const k = (r * cols + c) * 3;
      nrm[k] = nx / L;
      nrm[k + 1] = ny / L;
      nrm[k + 2] = nz / L;
    }
  }

  // 4) 索引：每个格子两个三角
  const quad = (cols - 1) * (rows - 1);
  const idx = new Uint32Array(quad * 6);
  let p = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      idx[p++] = a; idx[p++] = d; idx[p++] = b;
      idx[p++] = b; idx[p++] = d; idx[p++] = e;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aHard', new THREE.BufferAttribute(hard, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();

  const mat = opt.material || new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.0,
    // 地面是唯一大面积受阴影的面，必须 receiveShadow
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain_surface';
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  const g = new THREE.Group();
  g.name = 'L0_terrain';
  g.add(mesh);
  return g;
}

/**
 * 读 web/assets/roads/cut.i16（tools/terrain/export_road_cut.py 导出）。
 * 与地形网格同尺寸的 Int16 厘米栅格，-32768 = 该格没有路。
 */
export async function loadRoadCut(base = 'assets/roads/') {
  const res = await fetch(base + 'cut.i16', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`cut.i16 ${res.status}`);
  const buf = await res.arrayBuffer();
  if (!buf.byteLength) throw new Error('cut.i16 空响应（Chrome 会把某些扩展名合成 204）');
  return new Int16Array(buf);
}

// ---------------------------------------------------------------- 建筑体块

/**
 * 读 web/assets/city/buildings.{mesh,idx,json}（tools/terrain/export_web_buildings.py 导出）。
 * 顶点已经带好「各自 DTM 高程」的 base_y 与 top_y，所以这里不需要再查地形。
 *
 * 【坑】二进制文件不能用 .bin 扩展名：Chrome 会把它当下载/危险类型，
 * 请求根本不到服务器，fetch 拿到合成响应 204 + 空 body（r.ok 仍为 true！）。
 * 所以统一叫 .mesh，并且一定要按 Content-Length 校验长度。
 */
export async function loadBuildings(base = 'assets/city/') {
  const meta = await fetch(base + 'buildings.json').then((r) => {
    if (!r.ok) throw new Error('buildings.json ' + r.status);
    return r.json();
  });
  const [vBuf, iBuf] = await Promise.all([
    fetch(base + 'buildings.mesh').then((r) => r.arrayBuffer()),
    fetch(base + 'buildings.idx').then((r) => r.arrayBuffer()),
  ]);
  const wantV = meta.vertex_count * meta.stride_floats * 4;
  const wantI = meta.index_count * 4;
  if (vBuf.byteLength !== wantV) {
    throw new Error(`buildings.mesh 长度 ${vBuf.byteLength} != 期望 ${wantV}`);
  }
  if (iBuf.byteLength !== wantI) {
    throw new Error(`buildings.idx 长度 ${iBuf.byteLength} != 期望 ${wantI}`);
  }
  return {
    meta,
    verts: new Float32Array(vBuf),     // 每顶点 x, z, top_y, base_y
    index: new Uint32Array(iBuf),
    buildings: meta.buildings,
  };
}

const FUNC_COLOR = {
  house: [0.46, 0.42, 0.38],
  apartments: [0.50, 0.45, 0.39],
  residential: [0.48, 0.43, 0.38],
  detached: [0.47, 0.43, 0.39],
  office: [0.40, 0.44, 0.47],
  commercial: [0.44, 0.43, 0.42],
  government: [0.55, 0.54, 0.50],
  garage: [0.38, 0.38, 0.39],
  yes: [0.47, 0.44, 0.40],
};

/**
 * 立面 / 屋面材质分配（照 材质库.md 的规则，用高度 + 功能 + 稳定哈希）。
 *
 * 为什么按高度分层：
 *   DC 的现实是三层连排屋 → 中层办公楼 → 高层幕墙。14 m 以下几乎全是砖 / 漆面
 *   三四层；35 m 以上才有玻璃幕墙。windowed_facade 的贴图一张代表 30 m，
 *   里面 10x11 个窗格 = 真实窗距 3 m，所以只能给小高层用；贴到 12 m 的连排屋
 *   上会变成一格窗都没有的糊墙。
 *
 * @returns {{wall:string, roof:string}}
 */
function assignMaterial(bd, h, rnd) {
  const fn = bd.function || 'yes';
  const tall = h >= 35;
  const mid = h >= 16;

  let wall;
  if (tall) {
    wall = rnd < 0.55 ? 'glass' : rnd < 0.82 ? 'glass2'
      : rnd < 0.92 ? 'stone' : 'conc';
    if (fn === 'government' && rnd < 0.5) wall = 'stone';
  } else if (mid) {
    wall = rnd < 0.30 ? 'stone' : rnd < 0.50 ? 'conc'
      : rnd < 0.68 ? 'brick' : rnd < 0.82 ? 'paint' : rnd < 0.92 ? 'brick2' : 'glass2';
    if (fn === 'government') wall = rnd < 0.62 ? 'stone' : 'conc';
  } else {
    wall = rnd < 0.40 ? 'brick' : rnd < 0.60 ? 'brick2'
      : rnd < 0.82 ? 'paint' : rnd < 0.92 ? 'conc' : 'stone';
  }

  let roof;
  if (tall) roof = 'roof_gravel';
  else if (mid) roof = rnd < 0.72 ? 'roof_gravel' : rnd < 0.88 ? 'roof_slate' : 'roof_tile';
  else roof = rnd < 0.38 ? 'roof_gravel' : rnd < 0.72 ? 'roof_slate' : 'roof_tile';

  return { wall, roof };
}

/**
 * 建筑体块：按立面 / 屋面材质分桶，**一个桶一个 mesh**（约 10 个 draw call，
 * 换来真实贴图）。贴图走世界坐标盒式投影，几何不需要 uv。
 *
 * 【关键】顶点缓冲里每个轮廓点只给了 (x, z, top_y, base_y) —— 是「一根柱子」，
 * 不是实心体。必须自己长出侧墙与顶盖。
 * 第一版只用了 top_y 生成一圈顶点，结果所有楼变成悬在屋顶高度的**薄片** ——
 * 这是必须记住的坑。
 *
 * 【顶点色】进了贴图之后，顶点色不再是"颜色"，而是**明暗 / 色调微差**
 * （0.86 ± 0.16 的灰），乘到贴图上。若还按旧的 0.46 灰乘，整城会黑一半。
 *
 * @param {object} B  loadBuildings() 的返回
 * @param {object} opt {excludeIds:Set<string>, materials:{wall:fn, roof:fn}}
 */
export function buildBuildingMesh(B, opt = {}) {
  const exclude = opt.excludeIds || new Set();
  const src = B.verts;
  const mkWall = opt.materials?.wall || null;
  const mkRoof = opt.materials?.roof || null;
  const textured = !!(mkWall && mkRoof);

  // ---- 1) 分桶
  // 【为什么不再预算顶点数】屋顶要按「双坡 / 四坡 / 折坡 / 攒尖 / 穹顶」分形态，
  // 每种形态的顶点数差得远（平地 4 → 双坡 6 顶点 + 2 个山墙三角 → 穹顶 100+），
  // 预分配就得把每种形态再算一遍，等于写两套几何逻辑。改用普通数组累积，
  // 最后一次性转 Float32Array —— 21,943 栋实测 +180 ms，可以接受。
  const wallBufs = new Map();
  const roofBufs = new Map();
  const bucket = (map, k) => {
    let b = map.get(k);
    if (!b) { b = { pos: [], col: [], bld: [], idx: [] }; map.set(k, b); }
    return b;
  };

  // ---- 2) 填充
  const roofStats = { flat: 0, gable: 0, hip: 0, pyramid: 0, mansard: 0, dome: 0, spire: 0, pyramidion: 0 };
  for (const bd of B.buildings) {
    if (exclude.has(bd.id)) continue;
    const n = bd.vc;
    const v0 = bd.v0;

    let wKey = 'plain', rKey = 'plain';
    const idNum = Number(bd.id.slice(-6)) || 7;
    if (textured) {
      const m = assignMaterial(bd, bd.height_m, hash2(idNum));
      wKey = m.wall; rKey = m.roof;
    }
    // 【地标必须换材质】DC 的国家纪念性建筑几乎全是白色大理石/石灰岩：
    // 国会山、林肯堂、杰斐逊堂、华盛顿纪念碑、国会图书馆、国家美术馆。
    // 按 height/function 分桶会把方尖碑分到 'stone' 甚至 'glass' 立面 ——
    // 于是华盛顿纪念碑被刷上了带窗户的写字楼贴图（用户原话：「这是个纪念碑啊，
    // 这不是这个图」）。这里按 id 强制换成素面大理石，不参与窗户 shader。
    const lmMat = LANDMARK[bd.id];
    if (lmMat && lmMat.wall) { wKey = lmMat.wall; rKey = lmMat.wall; }
    const wb = bucket(wallBufs, wKey);
    const rb = bucket(roofBufs, rKey);

    const rnd = hash2(idNum) * 2 - 1;
    const rnd2 = hash2(idNum + 5501);   // 0..1，色相用
    let cr, cg, cb, tr, tg, tb;
    if (textured) {
      // 顶点色 = 明暗 × 色相微差。全城同一个色调会被读成「一套模具」，
      // 所以按楼给三档色温 + 三档明度，范围控制在 ±8% 以内，不破坏贴图。
      const lum = 0.84 + rnd * 0.18;
      let wr, wg, wb2;
      if (rnd2 < 0.34) { wr = 0.030; wg = 0.004; wb2 = -0.020; }        // 偏暖（砖红）
      else if (rnd2 < 0.72) { wr = 0.006; wg = 0.006; wb2 = 0.002; }    // 中性
      else { wr = -0.022; wg = -0.002; wb2 = 0.028; }                   // 偏冷（石材/漆）
      cr = lum + wr; cg = lum + wg; cb = lum + wb2;
      tr = Math.min(1, lum * 1.03 + 0.01); tg = Math.min(1, lum * 1.02 + 0.01); tb = Math.min(1, lum * 1.01 + 0.01);
    } else {
      const base = FUNC_COLOR[bd.function] || FUNC_COLOR.yes;
      const tint = 1 + rnd * 0.075;
      const cool = Math.min(1, Math.max(0, (bd.height_m - 12) / 60)) * 0.09;
      cr = Math.max(0, base[0] * tint - cool * 0.10);
      cg = Math.max(0, base[1] * tint - cool * 0.02);
      cb = Math.max(0, base[2] * tint + cool * 0.12);
      tr = Math.min(1, cr * 1.14); tg = Math.min(1, cg * 1.12); tb = Math.min(1, cb * 1.10);
    }

    // ---- 环的绕向：按平面有符号面积判断，保证侧墙法线朝外
    //
    // 【坑，务必别改回去】src[si+1] 是 **three 的 z**（= -planY，导出时就取过负了）。
    // 所以 area2 是在 (x, z) 平面里的有符号面积，判据必须是 area2 > 0。
    // 第一版按 (x, planY) 理解写成 area2 < 0，结果所有建筑法线翻到内侧：
    // 正面被背面剔除，从外面看楼是空的，全城建筑是一片死黑剪影。
    let area2 = 0;
    for (let k = 0; k < n; k++) {
      const a = (v0 + k) * 4;
      const b = (v0 + ((k + 1) % n)) * 4;
      area2 += src[a] * src[b + 1] - src[b] * src[a + 1];
    }
    const ccw = area2 > 0;

    // 逐栋随机相位：0..1，用于立面 shader 里错开窗格（不让全城窗户排成一张网）。
    const seed = hash2(idNum + 977);
    const X = new Array(n), Z = new Array(n), BOT = new Array(n), TOP = new Array(n);
    let baseY = Infinity, topY = -Infinity;
    for (let k = 0; k < n; k++) {
      const si = (v0 + k) * 4;
      X[k] = src[si];
      // 【坑，别再写反】导出脚本写进 .mesh 的第二列**已经是 three 的 z**（= -planY），
      // 见 export_web_buildings.py 的 `verts.append((px, -py, ...))`。
      // 这里再取一次负会把全城楼翻到 +z 半区：楼与地形互相错位，
      // 从城里看出去是「空地面 + 远处一排竖片」，俯视看不出（因为两半区各有一片）。
      Z[k] = src[si + 1];
      BOT[k] = src[si + 3];
      TOP[k] = src[si + 2];
      if (BOT[k] < baseY) baseY = BOT[k];
      if (TOP[k] > topY) topY = TOP[k];
    }

    // 顶点写入器：wb/rb 二选一，bld = (逐栋相位, 落地高程, 檐口高程)
    const put = (buf, x, y, z, r, g, b) => {
      buf.pos.push(x, y, z);
      buf.col.push(r, g, b);
      buf.bld.push(seed, baseY, topY);
      return buf.pos.length / 3 - 1;
    };
    const putW = (x, y, z) => put(wb, x, y, z, cr, cg, cb);
    const putR = (x, y, z) => put(rb, x, y, z, tr, tg, tb);

    // 三角写入器：**自己修法线朝向**。屋面/穹顶的绕向要按「面朝上或朝外」定，
    // 逐段手推绕向必然会漏一处（上一版顶盖照抄侧墙 ccw，全城屋顶法线朝下、
    // 渲染成深蓝黑铁皮）。所以这里统一算三角形法线，y 分量为负就换序。
    const triUp = (buf, a, b, c) => {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const ny = uz * vx - ux * vz;
      const i0 = put(buf, a[0], a[1], a[2], buf === rb ? tr : cr, buf === rb ? tg : cg, buf === rb ? tb : cb);
      const i1 = put(buf, b[0], b[1], b[2], buf === rb ? tr : cr, buf === rb ? tg : cg, buf === rb ? tb : cb);
      const i2 = put(buf, c[0], c[1], c[2], buf === rb ? tr : cr, buf === rb ? tg : cg, buf === rb ? tb : cb);
      if (ny < 0) { buf.idx.push(i0, i2, i1); } else { buf.idx.push(i0, i1, i2); }
    };
    const quadUp = (buf, a, b, c, d) => { triUp(buf, a, b, c); triUp(buf, a, c, d); };
    // 竖直/任意朝向的四边形：算法线，专题朝向不对就换序（同 triUp 的教训）
    const quadOut = (buf, a, b, c, d, nx, nz) => {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const cx = uy * vz - uz * vy, cz = ux * vy - uy * vx;
      const pv = (p) => put(buf, p[0], p[1], p[2],
        buf === rb ? tr : cr, buf === rb ? tg : cg, buf === rb ? tb : cb);
      const i0 = pv(a), i1 = pv(b), i2 = pv(c), i3 = pv(d);
      if (cx * nx + cz * nz >= 0) buf.idx.push(i0, i1, i2, i0, i2, i3);
      else buf.idx.push(i0, i2, i1, i0, i3, i2);
    };

    // 外法线（水平）：(x,z) 平面上按有符号面积决定的顺时针/逆时针推出外向
    const outN = (k) => {
      const k1 = (k + 1) % n;
      let dx = X[k1] - X[k], dz = Z[k1] - Z[k];
      const L = Math.hypot(dx, dz) || 1;
      dx /= L; dz /= L;
      return ccw ? [dz, -dx] : [-dz, dx];
    };
    // 顶点外扩方向 = 两条相邻边外法线的角平分
    const outV = (k) => {
      const a = outN((k + n - 1) % n), b = outN(k);
      let ox = a[0] + b[0], oz = a[1] + b[1];
      const L = Math.hypot(ox, oz) || 1;
      return [ox / L, oz / L];
    };

    // ---- 侧墙：下圈 n + 上圈 n
    const lo = wb.pos.length / 3;
    for (let k = 0; k < n; k++) {
      const p = putW(X[k], BOT[k], Z[k]);
      void p;
    }
    const hi = wb.pos.length / 3;
    for (let k = 0; k < n; k++) putW(X[k], TOP[k], Z[k]);
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      const b0 = lo + k, b1 = lo + k1, t0 = hi + k, t1 = hi + k1;
      if (ccw) {
        wb.idx.push(b0, t1, b1, b0, t0, t1);
      } else {
        wb.idx.push(b0, b1, t1, b0, t1, t0);
      }
    }

    // ---- 环带（檐口 / 勒脚 / 女儿墙）：绕一圈的竖直带，可向外偏 out
    const band = (buf, y0, y1, out, capTop) => {
      const A = [], B = [];
      for (let k = 0; k < n; k++) {
        const o = outV(k);
        const xx = X[k] + o[0] * out, zz = Z[k] + o[1] * out;
        A.push(put(buf, xx, y0, zz, buf === rb ? tr : cr, buf === rb ? tg : cg, buf === rb ? tb : cb));
      }
      for (let k = 0; k < n; k++) {
        const o = outV(k);
        const xx = X[k] + o[0] * out, zz = Z[k] + o[1] * out;
        B.push(put(buf, xx, y1, zz, buf === rb ? tr : cr, buf === rb ? tg : cg, buf === rb ? tb : cb));
      }
      for (let k = 0; k < n; k++) {
        const k1 = (k + 1) % n;
        if (ccw) buf.idx.push(A[k], B[k1], A[k1], A[k], B[k], B[k1]);
        else buf.idx.push(A[k], A[k1], B[k1], A[k], B[k1], B[k]);
      }
      if (capTop) {
        for (let k = 1; k < n - 1; k++) {
          const a = [X[0] + outV(0)[0] * out, y1, Z[0] + outV(0)[1] * out];
          const b = [X[k] + outV(k)[0] * out, y1, Z[k] + outV(k)[1] * out];
          const c = [X[k + 1] + outV(k + 1)[0] * out, y1, Z[k + 1] + outV(k + 1)[1] * out];
          triUp(buf, a, b, c);
        }
      }
    };

    const H = topY - baseY;
    const fn = bd.function || 'yes';

    // 勒脚：贴地一圈微出挑，低矮楼才有意义（街道视角能看到）
    if (H <= 18 && bd.area_m2 > 45) band(wb, baseY, baseY + 0.85, 0.10, false);
    // 檐口：屋顶下 0.45 m 一圈出挑，给立面一条收边（远处看不到，街区近景靠它立住）
    if (H >= 4) band(wb, topY - Math.min(0.45, H * 0.18), topY + 0.02, 0.26, false);

    // ---- 屋面形态
    let kind = 'flat';
    if (n === 4) {
      const e0 = edgeLen(X, Z, 0), e1 = edgeLen(X, Z, 1);
      // 退化轮廓（面积 < 8 m²、短边 < 2.5 m 的 299 栋碎片）不走坡屋面：
      // 长边为 0 时 gableHip 里 `ux = dx / La` 会得到 NaN，NaN 顶点在 WebGL
      // 里会拉成一根横穿整个画面的黑色细杆 —— 之前画面里那根「黑横杆」就是它。
      if (e0 >= 2.5 && e1 >= 2.5) kind = roofKind(fn, H, Math.min(e0, e1), hash2(idNum + 3313));
    }
    const lm = LANDMARK[bd.id];
    if (lm) kind = lm.kind;
    roofStats[kind] = (roofStats[kind] || 0) + 1;

    // ---- 立面构件：门廊台阶（stoop）
    // 连排屋最显眼的结构特征不是窗，是门前那几级台阶 + 门套 —— 一条街上
    // 每栋都往前伸一小截，街景的节奏感和进深全靠它。只给坡屋顶小房子做，
    // 成本 12 三角/栋（约 1 万户），高楼不做（现实中也是平入口）。
    if (n === 4 && kind !== 'flat' && H >= 5 && H <= 16
        && bd.area_m2 >= 40 && bd.area_m2 <= 520) {
      // 连排屋的「正立面」是窄边：取最短那条边
      let fk = 0, best = Infinity;
      for (let k = 0; k < n; k++) {
        const e = edgeLen(X, Z, k);
        if (e < best) { best = e; fk = k; }
      }
      const w = Math.min(1.45, best * 0.42);
      if (w >= 0.8 && best > 2.2) {
        const el = best;
        const half = (w / 2) / el;
        const yb = baseY - 0.6;
        const yt = baseY + Math.min(0.95, H * 0.22);
        // 台阶本体的 4 个侧面 + 顶面
        const k1 = (fk + 1) % n;
        const ex = X[k1] - X[fk], ez = Z[k1] - Z[fk];
        const L = Math.hypot(ex, ez) || 1;
        const ux = ex / L, uz = ez / L;
        const o = outV(fk);
        const D = 1.15;
        const P = (t, d, y) => [X[fk] + ux * (t * L) + o[0] * d, y,
          Z[fk] + uz * (t * L) + o[1] * d];
        const t0 = 0.5 - half, t1 = 0.5 + half;
        const a0 = P(t0, 0, yb), b0 = P(t1, 0, yb);
        const b1 = P(t1, D, yb), a1 = P(t0, D, yb);
        const A0 = P(t0, 0, yt), B0 = P(t1, 0, yt);
        const B1 = P(t1, D, yt), A1 = P(t0, D, yt);
        quadOut(wb, a1, b1, B1, A1, o[0], o[1]);      // 踏面前脸
        quadOut(wb, a0, a1, A1, A0, -ux, -uz);        // 左侧翼
        quadOut(wb, b1, b0, B0, B1, ux, uz);          // 右侧翼
        quadUp(wb, A0, A1, B1, B0);                   // 顶面
      }
    }

    // 平面屋顶大扇出（flat / mansard 的顶盖 / 女儿墙内侧都用它）
    const flatFan = (y, inset) => {
      const pts = [];
      for (let k = 0; k < n; k++) {
        const o = outV(k);
        pts.push([X[k] - o[0] * inset, y, Z[k] - o[1] * inset]);
      }
      const base = pts.map((p) => putR(p[0], p[1], p[2]));
      for (let k = 1; k < n - 1; k++) {
        const a = pts[0], b = pts[k], c = pts[k + 1];
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const ny = uz * vx - ux * vz;
        if (ny < 0) rb.idx.push(base[0], base[k + 1], base[k]);
        else rb.idx.push(base[0], base[k], base[k + 1]);
      }
    };

    if (kind === 'dome' || kind === 'spire') {
      // 【必须先封平台面】穹顶/尖塔这两个分支以前只画了穹顶本身，没有 flatFan，
      // 于是整栋楼变成「四面墙 + 中间一个小圆顶、四周全敞着」的无顶盒子
      // —— 用户原话「你这几个圆顶的房子楼顶都是没有的」，指的就是国会山到
      // 纪念碑轴线上这批（国会图书馆、国家美术馆、史密森学会堡）。
      // 真实的这类建筑是「平台面 + 女儿墙 + 从屋面上鼓起的穹顶」，
      // 所以这里先加一圈女儿墙和屋面盖板，再把穹顶坐到盖板之上。
      const ph2 = H >= 8 ? 0.52 : 0.36;
      band(rb, topY - 0.02, topY + ph2, 0.11, false);
      flatFan(topY + ph2 + 0.01, 0.0);
      const yBase = topY + ph2 + 0.02;
      if (kind === 'dome') {
        const R = Math.max(3.2, Math.min(lm.k * Math.min(bboxW(X, Z), bboxD(X, Z)), 19));
        domeGeometry(rb.idx, (x, y, z) => putR(x, y, z), centroid(X), yBase, centroidZ(Z), R);
      } else {
        const cx = centroid(X), cz = centroidZ(Z);
        const halfS = 0.22 * Math.min(bboxW(X, Z), bboxD(X, Z));
        apexGeometry(rb.idx, (x, y, z) => putR(x, y, z), cx, cz, yBase, halfS, Math.max(6, H * 0.55));
      }
    } else if (kind === 'pyramidion') {
      apexGeometry(rb.idx, (x, y, z) => putR(x, y, z), centroid(X), centroidZ(Z), topY,
        Math.min(bboxW(X, Z), bboxD(X, Z)) * 0.5, Math.max(4, H * 0.055));
    } else if (kind === 'gable' || kind === 'hip' || kind === 'pyramid') {
      // 山墙三角是「墙」不是「瓦」，必须走立面桶 → 单独给一个墙桶写入器
      const triUpW = (a, b, c) => triUp(wb, a, b, c);
      gableHip(rb, kind, X, Z, topY, n, ccw, triUp, triUpW);
    } else if (kind === 'mansard') {
      // 折坡：一圈陡坡带（顶部内收 inset）+ 平面盖
      const ins = Math.min(1.5, 0.16 * Math.min(bboxW(X, Z), bboxD(X, Z)));
      const yTop = topY + Math.min(2.2, 0.22 * H);
      const inner = [];
      for (let k = 0; k < n; k++) {
        const o = outV(k);
        inner.push([X[k] - o[0] * ins, Z[k] - o[1] * ins]);
      }
      for (let k = 0; k < n; k++) {
        const k1 = (k + 1) % n;
        triUp(rb, [X[k], topY + 0.02, Z[k]], [X[k1], topY + 0.02, Z[k1]], [inner[k1][0], yTop, inner[k1][1]]);
        triUp(rb, [X[k], topY + 0.02, Z[k]], [inner[k1][0], yTop, inner[k1][1]], [inner[k][0], yTop, inner[k][1]]);
      }
      const cap = inner.map((p) => [p[0], yTop, p[1]]);
      for (let k = 1; k < n - 1; k++) triUp(rb, cap[0], cap[k], cap[k + 1]);
    } else {
      // flat：女儿墙 + 平面盖
      const ph = H >= 8 ? 0.62 : 0.42;
      band(rb, topY - 0.02, topY + ph, 0.12, false);
      flatFan(topY + 0.03, 0.0);
      // 高层加一个退台小体块（俯视时天际线才有层次）
      if (H >= 38) {
        const s = 0.58;
        const cx = centroid(X), cz = centroidZ(Z);
        const ins = [];
        for (let k = 0; k < n; k++) ins.push([cx + (X[k] - cx) * s, cz + (Z[k] - cz) * s]);
        const yb = topY + ph, yt = yb + Math.min(5.0, H * 0.075);
        const L = ins.map((p) => putR(p[0], yb, p[1]));
        const U = ins.map((p) => putR(p[0], yt, p[1]));
        for (let k = 0; k < n; k++) {
          const k1 = (k + 1) % n;
          if (ccw) rb.idx.push(L[k], U[k1], L[k1], L[k], U[k], U[k1]);
          else rb.idx.push(L[k], L[k1], U[k1], L[k], U[k1], U[k]);
        }
        const capB = ins.map((p) => [p[0], yt, p[1]]);
        for (let k = 1; k < n - 1; k++) triUp(rb, capB[0], capB[k], capB[k + 1]);
      }
    }

    // 烟囱：只给坡屋顶的小房子（连排屋的真实特征），从屋脊探出
    if ((kind === 'gable' || kind === 'hip') && H <= 16 && bd.area_m2 > 55) {
      const chir = hash2(idNum + 8123);
      if (chir < 0.72) {
        const w = 0.55 + chir * 0.35;
        const rise = roofRise(X, Z, n);
        const cx = centroid(X), cz = centroidZ(Z);
        const yb = topY + rise * 0.35;
        const yt = topY + rise + 1.0 + chir * 0.5;
        boxGeom(rb.idx, (x, y, z) => putR(x, y, z), cx, cz, yb, yt, w * 0.5, w * 0.5);
      }
    }
  }

  // ---- 3) 建 mesh
  const g = new THREE.Group();
  g.name = 'L3_building';

  const plain = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.82, metalness: 0.02, flatShading: true,
  });

  const makeMesh = (buf, mat, name) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(buf.pos), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(buf.col), 3));
    geo.setAttribute('aBld', new THREE.BufferAttribute(Float32Array.from(buf.bld), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(buf.idx), 1));
    // 建筑必须是硬边：flatShading 走 dFdx/dFdy，不需要 normal 属性；
    // 否则 computeVertexNormals() + 共享顶点会把墙角法线插值掉，
    // 退台式办公楼看起来像被融化过的圆石头。
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };

  let nMesh = 0, nTri = 0;
  for (const [k, buf] of wallBufs) {
    if (!buf.idx.length) continue;
    g.add(makeMesh(buf, textured ? mkWall(k) : plain, 'bldg_wall_' + k));
    nTri += buf.idx.length / 3;
    nMesh++;
  }
  for (const [k, buf] of roofBufs) {
    if (!buf.idx.length) continue;
    g.add(makeMesh(buf, textured ? mkRoof(k) : plain, 'bldg_roof_' + k));
    nTri += buf.idx.length / 3;
    nMesh++;
  }

  g.userData.meshCount = nMesh;
  g.userData.triCount = nTri;
  g.userData.roofStats = roofStats;
  return g;
}

// ---------------------------------------------------------------- 屋顶几何

/**
 * 屋面形态选择。
 *
 * 依据是 DC 的真实构造（见 `①DC连排屋特征-做了什么.md`）：三层连排屋几乎全是
 * **双坡屋顶**（面宽 5~8 m，坡起 1.5~2.5 m）；联排转角与独立宅做**四坡**；
 * 少部分老宅做**折坡（mansard）**；中层办公楼与政府楼多为**平屋顶 + 女儿墙**。
 * 高层一律平顶（退台在别的分支里加）。
 *
 * @param {string} fn       OSM function
 * @param {number} H        檐口高（m）
 * @param {number} minSide  轮廓短边（m）
 * @param {number} r        0..1 稳定哈希
 */
function roofKind(fn, H, minSide, r) {
  if (fn === 'garage' || fn === 'roof' || H >= 30) return 'flat';
  // 大进深建筑（>26 m 短边）做双坡会得到一个 13 m 高的三角锥，失真 —— 一律平顶
  if (minSide > 26) return 'flat';
  if (H <= 16 && minSide <= 22) {
    if (r < 0.50) return 'gable';
    if (r < 0.74) return 'hip';
    if (r < 0.84) return 'mansard';
    if (r < 0.90) return 'pyramid';
    return 'flat';
  }
  if (r < 0.26) return 'gable';
  if (r < 0.44) return 'hip';
  if (r < 0.54) return 'mansard';
  return 'flat';
}

/** 坡屋顶起坡高度：连排屋面宽 6 m → 1.6 m（约 28°），上限 4.5 m。 */
function roofRise(X, Z, n) {
  const minSide = Math.min(edgeLen(X, Z, 0), edgeLen(X, Z, 1 % n) || edgeLen(X, Z, 0));
  return Math.min(4.5, Math.max(1.1, 0.42 * minSide * 0.5));
}

/**
 * 屋面形态（与 buildBuildingMesh 里第 639 行那段判据**必须保持一致**）。
 * 抽出来是为了让「行人站房顶」和「画出来的屋顶」用同一套规则。
 */
function roofKindOf(bd, X, Z, topY, baseY) {
  const n = bd.vc;
  let kind = 'flat';
  if (n === 4) {
    const e0 = edgeLen(X, Z, 0), e1 = edgeLen(X, Z, 1);
    if (e0 >= 2.5 && e1 >= 2.5) {
      const idNum = Number(bd.id.slice(-6)) || 7;
      kind = roofKind(bd.function || 'yes', topY - baseY, Math.min(e0, e1), hash2(idNum + 3313));
    }
  }
  const lm = LANDMARK[bd.id];
  if (lm) kind = lm.kind;
  return kind;
}

/**
 * 屋顶**可站立**高度（米，NAVD88）—— 不是檐口高度。
 *
 * 【为什么需要这个函数】`buildings.mesh` 的 `top_y` 是**檐口**高程，而
 * `buildBuildingMesh` 会在这之上再长出屋面：双坡/四坡的屋脊比檐口高
 * `min(4.5, max(1.1, 0.21·La, 0.42·Lb·0.5))`，折坡高 `min(2.2, 0.22H)`。
 * 直接拿 top_y 当站立高度，人会被整个埋进屋面实体里（实测 15,119 个屋顶
 * 候选里约 72% 是坡屋顶/折坡/攒尖，全都会隐形）。这里返回人**脚底**该放的 y。
 */
export function roofSurfaceY(bd, verts) {
  const n = bd.vc, v0 = bd.v0;
  if (!(n >= 3)) return null;
  const X = new Array(n), Z = new Array(n);
  let topY = -Infinity, baseY = Infinity;
  for (let k = 0; k < n; k++) {
    const si = (v0 + k) * 4;
    X[k] = verts[si];
    Z[k] = verts[si + 1];          // 导出时已经是 three 的 z
    if (verts[si + 2] > topY) topY = verts[si + 2];
    if (verts[si + 3] < baseY) baseY = verts[si + 3];
  }
  if (!Number.isFinite(topY) || !Number.isFinite(baseY)) return null;
  const H = topY - baseY;
  const kind = roofKindOf(bd, X, Z, topY, baseY);
  switch (kind) {
    case 'gable':
    case 'hip':
    case 'pyramid': {
      // 屋脊在轮廓中心上方（坡屋顶的人站屋脊上），与 gableHip 的 rise 同式
      const e0 = edgeLen(X, Z, 0), e1 = edgeLen(X, Z, 1);
      const La = Math.max(e0, e1), Lb = Math.min(e0, e1);
      return topY + Math.min(4.5, Math.max(1.1, 0.21 * La, 0.42 * Lb * 0.5));
    }
    case 'mansard':
      // 折坡：陡坡带顶端 `yTop` 上有平面盖，人站盖子上
      return topY + Math.min(2.2, 0.22 * H);
    case 'dome':
    case 'spire':
      // 穹顶/尖塔：先有一圈女儿墙 + 屋面盖板，穹顶坐在盖板之上 → 站盖板
      return topY + (H >= 8 ? 0.52 : 0.36) + 0.03;
    case 'pyramidion':
      // 方尖碑压顶：锥面从 topY 起，能站的是锥底那一圈平台
      return topY + 0.02;
    default: {
      // 平顶：平台面在 topY+0.03，女儿墙挡在脚踝以上（人不该站墙顶上）
      return topY + 0.03;
    }
  }
}

function edgeLen(X, Z, k) {
  const n = X.length;
  const k1 = (k + 1) % n;
  return Math.hypot(X[k1] - X[k], Z[k1] - Z[k]);
}
function centroid(A) { let s = 0; for (const v of A) s += v; return s / A.length; }
function centroidZ(Z) { return centroid(Z); }
function bboxW(X) { return Math.max(...X) - Math.min(...X); }
function bboxD(Z) { return Math.max(...Z) - Math.min(...Z); }

/**
 * 双坡 / 四坡 / 攒尖。四条边里长边为屋脊方向。
 *
 * 双坡（gable）：屋脊 = 两条短边中点连线；两片坡面进屋面桶，两个山墙三角进
 *   立面桶（山墙是墙，不是瓦）。
 * 四坡（hip）：屋脊缩短 `短边` 的长度，两端各一个三角坡。
 * 攒尖（pyramid）：屋脊缩到 0，四条三角坡交于中心一点。
 */
function gableHip(rb, kind, X, Z, topY, n, ccw, triUp, triUpW) {
  void n; void ccw;
  const e0 = edgeLen(X, Z, 0), e1 = edgeLen(X, Z, 1);
  const longFirst = e0 >= e1;
  // 统一成「长轴 = 0→1」
  const order = longFirst ? [0, 1, 2, 3] : [1, 2, 3, 0];
  const P = order.map((k) => [X[k], Z[k]]);
  const La = longFirst ? e0 : e1;
  const Lb = longFirst ? e1 : e0;
  if (!(La > 0.01) || !(Lb > 0.01)) return;   // 防御：零长边会算出 NaN 顶点
  const rise = Math.min(4.5, Math.max(1.1, 0.21 * La, 0.42 * Lb * 0.5));
  const yR = topY + rise;

  // 短边中点（起点端 / 终点端）
  const m30 = [(P[3][0] + P[0][0]) / 2, (P[3][1] + P[0][1]) / 2];
  const m12 = [(P[1][0] + P[2][0]) / 2, (P[1][1] + P[2][1]) / 2];

  const y0 = topY + 0.02;
  if (kind === 'pyramid' || La - Lb < 1.2) {
    const cx = (P[0][0] + P[2][0]) / 2, cz = (P[0][1] + P[2][1]) / 2;
    const apex = [cx, yR, cz];
    for (let k = 0; k < 4; k++) {
      const a = P[k], b = P[(k + 1) % 4];
      triUp(rb, [a[0], y0, a[1]], [b[0], y0, b[1]], apex);
    }
    return;
  }

  if (kind === 'hip') {
    const ux = (P[1][0] - P[0][0]) / La, uz = (P[1][1] - P[0][1]) / La;
    const half = Math.max(0.2, La / 2 - Lb / 2);
    const cx = (P[0][0] + P[2][0]) / 2, cz = (P[0][1] + P[2][1]) / 2;
    const R1 = [cx - ux * half, yR, cz - uz * half];
    const R2 = [cx + ux * half, yR, cz + uz * half];
    // 两条长边各一片梯形坡
    triUp(rb, [P[0][0], y0, P[0][1]], [P[1][0], y0, P[1][1]], R2);
    triUp(rb, [P[0][0], y0, P[0][1]], R2, R1);
    triUp(rb, [P[2][0], y0, P[2][1]], [P[3][0], y0, P[3][1]], R1);
    triUp(rb, [P[2][0], y0, P[2][1]], R1, R2);
    // 两端各一个三角坡
    triUp(rb, [P[1][0], y0, P[1][1]], [P[2][0], y0, P[2][1]], R2);
    triUp(rb, [P[3][0], y0, P[3][1]], [P[0][0], y0, P[0][1]], R1);
    return;
  }

  // gable
  const R1 = [m30[0], yR, m30[1]];
  const R2 = [m12[0], yR, m12[1]];
  triUp(rb, [P[0][0], y0, P[0][1]], [P[1][0], y0, P[1][1]], R2);
  triUp(rb, [P[0][0], y0, P[0][1]], R2, R1);
  triUp(rb, [P[2][0], y0, P[2][1]], [P[3][0], y0, P[3][1]], R1);
  triUp(rb, [P[2][0], y0, P[2][1]], R1, R2);
  // 两个山墙三角 → 立面桶（山墙是墙，不是瓦；用屋面桶会让三角面糊上瓦片贴图）
  const gA = [P[3][0], y0, P[3][1]], gB = [P[0][0], y0, P[0][1]];
  const gC = [P[1][0], y0, P[1][1]], gD = [P[2][0], y0, P[2][1]];
  triUpW(gA, gB, R1);
  triUpW(gC, gD, R2);
}

/** 攒尖（方锥）——大教堂尖顶、华盛顿纪念碑的压顶都用它。 */
function apexGeometry(idx, put, cx, cz, y0, halfS, hgt) {
  const base = [
    [cx - halfS, y0, cz - halfS],
    [cx + halfS, y0, cz - halfS],
    [cx + halfS, y0, cz + halfS],
    [cx - halfS, y0, cz + halfS],
  ];
  const apex = [cx, y0 + hgt, cz];
  const bi = base.map((p) => put(p[0], p[1], p[2]));
  const ai = put(apex[0], apex[1], apex[2]);
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4;
    idx.push(bi[k], bi[k1], ai);
  }
}

/** 长方体（烟囱 / 女儿墙墩）：只出四个侧面 + 顶盖。 */
function boxGeom(idx, put, cx, cz, yb, yt, hx, hz) {
  const c = [
    [cx - hx, cz - hz], [cx + hx, cz - hz], [cx + hx, cz + hz], [cx - hx, cz + hz],
  ];
  const L = c.map((p) => put(p[0], yb, p[1]));
  const U = c.map((p) => put(p[0], yt, p[1]));
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4;
    idx.push(L[k], U[k1], L[k1], L[k], U[k], U[k1]);
  }
  idx.push(U[0], U[1], U[2], U[0], U[2], U[3]);
}

/**
 * 穹顶：鼓座（圆柱侧壁）+ 半球 + 采光亭。
 *
 * 【为什么不做半球网格细分】** 城市视角下穹顶只有 20~40 px，8 边形鼓座 +
 * 3 圈半球已经完全看不出棱角，而细分一圈就是 200 个三角 × 每栋楼。
 */
function domeGeometry(idx, put, cx, topY, cz, R) {
  const SEG = 12, RINGS = 3;
  const drumH = R * 0.55;
  const yDrum = topY + 0.02;
  const yTop = yDrum + drumH;
  const ring = (rad, y) => {
    const out = [];
    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      out.push(put(cx + Math.cos(a) * rad, y, cz + Math.sin(a) * rad));
    }
    return out;
  };
  const b0 = ring(R, yDrum);
  const b1 = ring(R, yTop);
  for (let s = 0; s < SEG; s++) {
    const s1 = (s + 1) % SEG;
    idx.push(b0[s], b1[s1], b0[s1], b0[s], b1[s], b1[s1]);
  }
  // 半球
  let prev = b1;
  for (let r = 1; r <= RINGS; r++) {
    const phi = (r / RINGS) * (Math.PI / 2);
    const rad = Math.cos(phi) * R;
    const y = yTop + Math.sin(phi) * R;
    let cur;
    if (r === RINGS) {
      const apex = put(cx, yTop + R, cz);
      cur = new Array(SEG).fill(apex);
    } else {
      cur = ring(rad, y);
    }
    for (let s = 0; s < SEG; s++) {
      const s1 = (s + 1) % SEG;
      idx.push(prev[s], cur[s1], prev[s1], prev[s], cur[s], cur[s1]);
    }
    prev = cur;
  }
  // 采光亭
  const lr = R * 0.17, lh = R * 0.42;
  const l0 = ring(lr, yTop + R);
  const l1 = ring(lr, yTop + R + lh);
  for (let s = 0; s < SEG; s++) {
    const s1 = (s + 1) % SEG;
    idx.push(l0[s], l1[s1], l0[s1], l0[s], l1[s], l1[s1]);
  }
  const lc = put(cx, yTop + R + lh + lr * 0.9, cz);
  for (let s = 0; s < SEG; s++) {
    const s1 = (s + 1) % SEG;
    idx.push(l1[s], lc, l1[s1]);
  }
}

/**
 * 地标：这些楼在 DC 天际线里一眼可辨，用固定形态而不是随机。
 * 穹顶半径 = k × 轮廓短边（US Capitol 实测短边约 107 m → 直径 27 m 左右）。
 */
const LANDMARK = {
  '66418809': { kind: 'dome', k: 0.135, wall: 'marble' },   // United States Capitol
  '398769543': { kind: 'dome', k: 0.30, wall: 'marble' },   // Lincoln Memorial
  '1029374': { kind: 'dome', k: 0.26, wall: 'marble' },     // Library of Congress (Jefferson)
  '66418868': { kind: 'dome', k: 0.22, wall: 'marble' },    // Library of Congress (Madison)
  '66418944': { kind: 'dome', k: 0.20, wall: 'marble' },    // National Gallery of Art (West)
  '66418590': { kind: 'dome', k: 0.22, wall: 'marble' },    // National Gallery of Art (East)
  '55327016': { kind: 'spire' },                            // Cathedral of St. Matthew
  '7393969': { kind: 'spire', wall: 'marble' },             // Smithsonian Institution Building
  '766761337': { kind: 'pyramidion', wall: 'marble' },      // Washington Monument（方尖碑）
  '66418819': { kind: 'dome', k: 0.34, wall: 'marble' },    // Jefferson Memorial
  '66418949': { kind: 'flat', wall: 'marble' },             // Reagan Building
  '66417587': { kind: 'flat' },                             // Watergate
  '1029361': { kind: 'flat' },                              // US EPA
};

// ---------------------------------------------------------------- 工具

/** 稳定的 2D 哈希 → [0,1)，用来做「逐顶点/逐栋」的确定性微差。 */
function hash2(n) {
  let x = (n | 0) * 374761393;
  x = (x ^ (x >>> 13)) * 1274126177;
  x = x ^ (x >>> 16);
  return ((x >>> 0) % 100000) / 100000;
}
