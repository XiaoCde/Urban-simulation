/**
 * 白宫（The White House）—— 程序化重建，零外部资源。
 *
 * 全部尺寸取自公开图纸与实测数据，单位 = 米：
 *   主楼（Executive Residence）  长 51.2 × 深 25.9 × 高 21.3
 *   北门廊    4 根爱奥尼柱，柱高 9.1
 *   南门廊    半圆，6 根柱，直径 12.8
 *   屋檐线    标高 18.9（其上是女儿墙 1.4 高的宝瓶栏杆）
 *   旗杆      立在屋顶中央，高约 10
 *
 * 为什么这样拆：白宫"一眼认得出来"靠三件事 ——
 *   ① 南门廊的圆弧（曲线在方盒子里最抢眼）
 *   ② 女儿墙那排宝瓶栏杆形成的水平锯齿
 *   ③ 严格的对称与两排窗的节奏
 * 所以这三样都要单独建模，不能靠贴图糊。
 */

import * as THREE from 'three';
import {
  textureWhiteHouseWall, textureSlateRoof, textureWindowGlass,
  boxWithBevel, jitter, rng, mergeInto,
} from './textures.js';

// ---------------------------------------------------------------- 真实尺寸
export const DIM = {
  L: 51.20,      // 主楼长（东西向）
  D: 25.90,      // 主楼深（南北向）
  H: 21.30,      // 主楼总高（到女儿墙顶）
  wallH: 18.90,  // 檐口标高
  stories: 3,    // 两层主层 + 一层低矮顶层
  bayCount: 11,  // 正面开间数
  porticoN: 4,   // 北门廊柱数
  porticoS: 6,   // 南门廊柱数
  colH: 9.10,    // 柱高
  colR: 0.52,    // 柱半径（爱奥尼，偏细）
  wingH: 6.4,    // 东西翼高度
  wingL: 26.0,   // 单侧翼长
};

export function buildWhiteHouse(mats) {
  const g = new THREE.Group();
  g.name = 'WhiteHouse';
  const r = rng(20261021);

  // ------------------------------------------------------------ 主楼
  // 主体用简单的四棱柱；但为了让檐口有厚度，分成"墙身 + 檐口 + 女儿墙"三段
  const body = new THREE.Mesh(
    boxWithBevel(DIM.L, DIM.wallH, DIM.D, 0.06),
    mats.wall
  );
  body.position.y = DIM.wallH / 2;
  body.castShadow = body.receiveShadow = true;
  g.add(body);

  // 檐口：一圈略微外挑的薄板，白宫的檐口有明确的投影
  const cornice = new THREE.Mesh(
    boxWithBevel(DIM.L + 0.85, 0.46, DIM.D + 0.85, 0.02),
    mats.trim
  );
  cornice.position.y = DIM.wallH + 0.23;
  cornice.castShadow = true;
  g.add(cornice);

  // 女儿墙底座
  const parBase = new THREE.Mesh(
    boxWithBevel(DIM.L + 0.55, 0.22, DIM.D + 0.55, 0.01),
    mats.trim
  );
  parBase.position.y = DIM.wallH + 0.46 + 0.11;
  parBase.castShadow = true;
  g.add(parBase);

  // ------------------------------------------------------------ 女儿墙宝瓶栏杆
  // 这是白宫最好认的特征之一：沿屋脊一圈，密排小栏杆
  g.add(buildBalustrade(r, mats, DIM.L + 0.55, DIM.D + 0.55, DIM.wallH + 0.68));

  // ------------------------------------------------------------ 主楼窗
  g.add(buildMainFacadeWindows(r, mats));

  // ------------------------------------------------------------ 北门廊
  g.add(buildNorthPortico(r, mats));

  // ------------------------------------------------------------ 南门廊（半圆）
  g.add(buildSouthPortico(r, mats));

  // ------------------------------------------------------------ 屋顶
  const roof = new THREE.Mesh(
    boxWithBevel(DIM.L + 0.3, 0.28, DIM.D + 0.3, 0.01),
    mats.roof
  );
  roof.position.y = DIM.wallH + 0.6;
  roof.receiveShadow = true;
  g.add(roof);

  // 屋顶上的几个方形采光罩/电梯机房（从南草坪看得到两个）
  for (const [x, z, w, d, h] of [
    [-14.5, -3.0, 5.0, 5.6, 2.2],
    [11.0, -3.0, 4.4, 5.6, 2.0],
    [0.5, 4.2, 8.0, 4.0, 1.5],
  ]) {
    const box = new THREE.Mesh(boxWithBevel(w, h, d, 0.03), mats.wall);
    box.position.set(x, DIM.wallH + 0.74 + h / 2, z);
    box.castShadow = true;
    g.add(box);
    // 顶部小屋面
    const cap = new THREE.Mesh(boxWithBevel(w + 0.4, 0.16, d + 0.4, 0.01), mats.roof);
    cap.position.set(x, DIM.wallH + 0.74 + h + 0.08, z);
    g.add(cap);
  }

  // ------------------------------------------------------------ 烟囱
  // 白宫屋面上有若干砖砌烟囱，是"非对称细节"的重要来源
  const chimneyX = [-19.2, -11.4, 9.6, 18.4];
  for (let i = 0; i < chimneyX.length; i++) {
    const h = jitter(r, 2.1, 2.9);
    const chim = new THREE.Mesh(
      boxWithBevel(1.55, h, 1.55, 0.02),
      mats.chimney
    );
    chim.position.set(chimneyX[i], DIM.wallH + 0.88 + h / 2, -3.2 + jitter(r, -0.6, 0.6));
    chim.castShadow = true;
    g.add(chim);
    // 烟囱帽
    const cap = new THREE.Mesh(boxWithBevel(1.95, 0.16, 1.95, 0.01), mats.trim);
    cap.position.copy(chim.position);
    cap.position.y += h / 2 + 0.08;
    g.add(cap);
  }

  // ------------------------------------------------------------ 旗杆与旗
  g.add(buildFlagpole(r, mats));

  // ------------------------------------------------------------ 东西两侧低矮连廊
  for (const sgn of [-1, 1]) {
    const wing = new THREE.Mesh(
      boxWithBevel(DIM.wingL, DIM.wingH, 12.5, 0.05),
      mats.wall
    );
    wing.position.set(sgn * (DIM.L / 2 + DIM.wingL / 2 + 1.2), DIM.wingH / 2, 1.5);
    wing.castShadow = wing.receiveShadow = true;
    g.add(wing);
    // 翼楼檐口
    const wc = new THREE.Mesh(
      boxWithBevel(DIM.wingL + 0.6, 0.32, 13.1, 0.01),
      mats.trim
    );
    wc.position.set(wing.position.x, DIM.wingH + 0.16, 1.5);
    wc.castShadow = true;
    g.add(wc);
    const wr = new THREE.Mesh(boxWithBevel(DIM.wingL + 0.3, 0.2, 12.8, 0.01), mats.roof);
    wr.position.set(wing.position.x, DIM.wingH + 0.42, 1.5);
    g.add(wr);
    // 翼楼窗（简化：每侧 5 扇）
    for (let i = 0; i < 5; i++) {
      const wx = wing.position.x - DIM.wingL / 2 + 3.2 + i * (DIM.wingL - 6.4) / 4;
      for (const zz of [-4.9, 7.9]) {
        g.add(makeWindow(r, mats, 1.15, 2.35, new THREE.Vector3(wx, 3.0, zz),
          zz > 0 ? 0 : Math.PI));
      }
    }
  }

  g.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  return g;
}

// ==================================================================== 窗
/**
 * 单扇窗：外框（白）+ 内玻璃 + 中横档（上下推拉窗的腰线）+ 窗楣
 * 高度 2.35、宽 1.15 是白宫主层窗的近似值。
 */
function makeWindow(r, mats, w, h, pos, rotY = 0, opts = {}) {
  const grp = new THREE.Group();
  grp.position.copy(pos);
  grp.rotation.y = rotY;

  const frameT = 0.10;   // 窗框厚
  const depth = 0.10;    // 入墙深度

  // 玻璃
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(w - frameT * 2, h - frameT * 2), mats.glass);
  glass.position.z = 0.02;
  grp.add(glass);

  // 外框四边
  const fg = [];
  mergeInto(fg, new THREE.BoxGeometry(w, frameT, depth), new THREE.Matrix4().makeTranslation(0, h / 2 - frameT / 2, 0));
  mergeInto(fg, new THREE.BoxGeometry(w, frameT, depth), new THREE.Matrix4().makeTranslation(0, -h / 2 + frameT / 2, 0));
  mergeInto(fg, new THREE.BoxGeometry(frameT, h, depth), new THREE.Matrix4().makeTranslation(-w / 2 + frameT / 2, 0, 0));
  mergeInto(fg, new THREE.BoxGeometry(frameT, h, depth), new THREE.Matrix4().makeTranslation(w / 2 - frameT / 2, 0, 0));
  // 腰线（推拉窗中间那道横档，白宫这道的投影很明确）
  mergeInto(fg, new THREE.BoxGeometry(w - frameT * 2, frameT * 0.9, depth * 0.9), new THREE.Matrix4().makeTranslation(0, 0, 0));
  // 竖梃（把窗分成两扇）
  mergeInto(fg, new THREE.BoxGeometry(frameT * 0.7, h - frameT * 2, depth * 0.8), new THREE.Matrix4().makeTranslation(0, 0, 0));

  const frameGeos = fg.map((x) => x);
  // 手动合并（不引 BufferGeometryUtils 以外的东西，这里用简单 add 也行；
  // 但为减少 draw call，把窗框合成一个 mesh）
  const merged = mergeGeometries(frameGeos);
  const frame = new THREE.Mesh(merged, mats.trim);
  frame.castShadow = true;
  grp.add(frame);

  // 窗楣（石质，白宫主层窗上方有简洁的平楣）
  if (opts.lintel !== false) {
    const lintel = new THREE.Mesh(
      boxWithBevel(w + 0.42, 0.22, 0.18, 0.02),
      mats.stone
    );
    lintel.position.set(0, h / 2 + 0.11, 0.04);
    lintel.castShadow = true;
    grp.add(lintel);
  }
  // 窗台
  const sill = new THREE.Mesh(
    boxWithBevel(w + 0.30, 0.14, 0.22, 0.015),
    mats.stone
  );
  sill.position.set(0, -h / 2 - 0.07, 0.05);
  sill.castShadow = true;
  grp.add(sill);

  return grp;
}

/** 极简几何合并（避免额外依赖） */
function mergeGeometries(geos) {
  let total = 0;
  for (const gg of geos) total += gg.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const idx = [];
  let vo = 0;
  for (const gg of geos) {
    const p = gg.attributes.position, n = gg.attributes.normal, u = gg.attributes.uv;
    pos.set(p.array, vo * 3);
    if (n) nor.set(n.array, vo * 3);
    if (u) uv.set(u.array, vo * 2);
    const gi = gg.index;
    if (gi) for (let i = 0; i < gi.count; i++) idx.push(gi.getX(i) + vo);
    else for (let i = 0; i < p.count; i++) idx.push(i + vo);
    vo += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(idx);
  return out;
}

// ==================================================================== 主楼立面窗
function buildMainFacadeWindows(r, mats) {
  const g = new THREE.Group();
  const winW = 1.15, winH = 2.35;
  const n = DIM.bayCount;

  // 首层（较高，落地窗感）与二层（略矮）
  const rows = [
    { y: 5.35, h: 2.55, w: 1.20 },
    { y: 12.05, h: 2.15, w: 1.10 },
  ];

  for (const row of rows) {
    for (let i = 0; i < n; i++) {
      // 11 个开间均匀分布，但留出中间给门廊
      const t = (i + 0.5) / n;
      const x = (t - 0.5) * (DIM.L - 5.2);
      // 南北两面
      for (const sgn of [-1, 1]) {
        const z = sgn * (DIM.D / 2 + 0.03);
        // 南面中间 3 个开间被南门廊遮住，不建
        if (sgn === 1 && Math.abs(x) < 6.6) continue;
        // 北面中间 2 个开间被北门廊遮住
        if (sgn === -1 && Math.abs(x) < 5.0) continue;
        // 微差：真实建筑的窗位不会绝对均匀
        const jx = x + jitter(r, -0.05, 0.05);
        g.add(makeWindow(r, mats, row.w, row.h,
          new THREE.Vector3(jx, row.y, z), sgn === 1 ? 0 : Math.PI));
      }
    }
  }

  // 东、西山墙各 3 扇
  for (const sgn of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const z = -6.2 + i * 6.2;
      for (const row of rows) {
        g.add(makeWindow(r, mats, 1.05, row.h * 0.92,
          new THREE.Vector3(sgn * (DIM.L / 2 + 0.03), row.y, z),
          sgn === 1 ? Math.PI / 2 : -Math.PI / 2));
      }
    }
  }
  return g;
}

// ==================================================================== 女儿墙栏杆
/**
 * 宝瓶栏杆：底座 + 密排小瓶 + 压顶。
 * 小瓶用「参数化 + 微差」生成，每根略不同，避免一眼看出是复制。
 * 为控制 draw call，所有小瓶合并成一个 BufferGeometry。
 */
function buildBalustrade(r, mats, L, D, y) {
  const g = new THREE.Group();
  const railH = 0.92;
  const balusterH = 0.74;
  const spacing = 0.30;

  const geos = [];

  // 沿四条边撒小瓶
  const edges = [
    { ax: 'x', len: L, at: D / 2 },
    { ax: 'x', len: L, at: -D / 2 },
    { ax: 'z', len: D, at: L / 2 },
    { ax: 'z', len: D, at: -L / 2 },
  ];
  for (const e of edges) {
    const count = Math.floor(e.len / spacing);
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const p = (t - 0.5) * e.len;
      // 微差：高度 ±1.5%，位置 ±3 mm
      const hh = balusterH * jitter(r, 0.985, 1.015);
      const jp = p + jitter(r, -0.003, 0.003);
      // 小瓶：细长圆柱 + 中间略鼓（宝瓶造型）
      const bg = new THREE.CylinderGeometry(0.042, 0.058, hh, 6, 1);
      // 中间鼓一点
      const pos = bg.attributes.position;
      for (let v = 0; v < pos.count; v++) {
        const yy = pos.getY(v) / (hh / 2);
        const bulge = 1 + 0.42 * Math.exp(-Math.pow(yy * 1.7, 2));
        pos.setX(v, pos.getX(v) * bulge);
        pos.setZ(v, pos.getZ(v) * bulge);
      }
      pos.needsUpdate = true;
      bg.computeVertexNormals();

      const m = new THREE.Matrix4().makeTranslation(
        e.ax === 'x' ? jp : e.at,
        y + railH / 2 - balusterH / 2 + 0.02,
        e.ax === 'x' ? e.at : jp
      );
      geos.push(mergeOne(bg, m));
    }
  }

  const balMesh = new THREE.Mesh(mergeGeometries(geos), mats.trim);
  balMesh.castShadow = true;
  g.add(balMesh);

  // 上压顶 + 下底座（四条边各一个盒子）
  for (const e of edges) {
    const isX = e.ax === 'x';
    const top = new THREE.Mesh(
      boxWithBevel(isX ? e.len : 0.34, 0.13, isX ? 0.34 : e.len, 0.01),
      mats.trim
    );
    top.position.set(isX ? 0 : e.at, y + railH / 2 + 0.06, isX ? e.at : 0);
    top.castShadow = true;
    g.add(top);

    const bot = new THREE.Mesh(
      boxWithBevel(isX ? e.len : 0.40, 0.16, isX ? 0.40 : e.len, 0.01),
      mats.trim
    );
    bot.position.set(isX ? 0 : e.at, y - railH / 2 + 0.08, isX ? e.at : 0);
    bot.castShadow = true;
    g.add(bot);
  }
  return g;
}

function mergeOne(geo, matrix) {
  const g2 = geo.clone();
  g2.applyMatrix4(matrix);
  return g2;
}

// ==================================================================== 北门廊
/**
 * 北门廊：4 根爱奥尼柱托着三角山花，柱后是门。
 * 这是白宫北面的正面形象，也是"北门"那个著名镜头的构图中心。
 */
function buildNorthPortico(r, mats) {
  const g = new THREE.Group();
  const z0 = -DIM.D / 2;
  const depth = 5.6;
  const colXs = [-4.35, -1.45, 1.45, 4.35];

  // 台基
  const plinth = new THREE.Mesh(boxWithBevel(13.6, 1.15, depth + 0.6, 0.03), mats.stone);
  plinth.position.set(0, 0.575, z0 - depth / 2 - 0.1);
  plinth.receiveShadow = true;
  g.add(plinth);

  // 柱
  for (const cx of colXs) {
    g.add(buildIonicColumn(mats, cx, 1.15, z0 - depth + 0.9, DIM.colH, DIM.colR));
  }

  // 檐部（entablature）：横梁 + 檐口
  const arch = new THREE.Mesh(
    boxWithBevel(11.4, 1.35, depth + 0.5, 0.02),
    mats.trim
  );
  arch.position.set(0, 1.15 + DIM.colH + 0.675, z0 - depth / 2 - 0.1);
  arch.castShadow = true;
  g.add(arch);

  // 三角山花
  const pedH = 2.05, pedL = 11.4;
  const shape = new THREE.Shape();
  shape.moveTo(-pedL / 2, 0);
  shape.lineTo(pedL / 2, 0);
  shape.lineTo(0, pedH);
  shape.lineTo(-pedL / 2, 0);
  const pedGeo = new THREE.ExtrudeGeometry(shape, { depth: 1.1, bevelEnabled: false });
  const ped = new THREE.Mesh(pedGeo, mats.trim);
  ped.position.set(0, 1.15 + DIM.colH + 1.35, z0 - depth / 2 - 0.1 - 0.55);
  ped.castShadow = true;
  g.add(ped);

  // 山花内的半圆窗（白宫北门廊山花里有一个）
  const oc = new THREE.Mesh(
    new THREE.CircleGeometry(0.55, 24, 0, Math.PI),
    mats.glass
  );
  oc.position.set(0, 1.15 + DIM.colH + 1.45, z0 - depth / 2 - 0.1 - 0.56);
  oc.rotation.y = Math.PI;
  g.add(oc);

  // 门（双扇，深色）
  const door = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 4.1), mats.door);
  door.position.set(0, 1.15 + 2.05, z0 - 0.05);
  door.rotation.y = Math.PI;
  g.add(door);
  // 门两侧壁柱
  for (const sgn of [-1, 1]) {
    const pil = new THREE.Mesh(boxWithBevel(0.42, 4.6, 0.22, 0.015), mats.trim);
    pil.position.set(sgn * 1.62, 1.15 + 2.3, z0 - 0.12);
    pil.castShadow = true;
    g.add(pil);
  }

  return g;
}

/** 爱奥尼柱：柱础 + 柱身（带收分）+ 涡卷柱头 */
function buildIonicColumn(mats, x, baseY, z, h, rad) {
  const g = new THREE.Group();
  g.position.set(x, baseY, z);

  // 柱础（两层圆盘）
  const b1 = new THREE.Mesh(new THREE.CylinderGeometry(rad * 1.42, rad * 1.52, 0.20, 20), mats.stone);
  b1.position.y = 0.10; b1.castShadow = true; g.add(b1);
  const b2 = new THREE.Mesh(new THREE.CylinderGeometry(rad * 1.22, rad * 1.40, 0.14, 20), mats.stone);
  b2.position.y = 0.27; b2.castShadow = true; g.add(b2);

  // 柱身：上细下粗（收分 entasis），20 边够圆
  const shaftH = h - 0.90;
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(rad * 0.88, rad, shaftH, 20, 1),
    mats.column
  );
  shaft.position.y = 0.34 + shaftH / 2;
  shaft.castShadow = true;
  g.add(shaft);

  // 柱头：一个方板 + 两个涡卷（用扁圆柱近似）
  const capY = 0.34 + shaftH;
  const abacus = new THREE.Mesh(boxWithBevel(rad * 2.7, 0.16, rad * 2.7, 0.01), mats.trim);
  abacus.position.y = capY + 0.40; abacus.castShadow = true; g.add(abacus);

  const echinus = new THREE.Mesh(
    new THREE.CylinderGeometry(rad * 1.22, rad * 0.92, 0.24, 20),
    mats.trim
  );
  echinus.position.y = capY + 0.20; echinus.castShadow = true; g.add(echinus);

  // 两个涡卷（南北朝向的扁圆柱）
  for (const sgn of [-1, 1]) {
    const vol = new THREE.Mesh(
      new THREE.CylinderGeometry(rad * 0.62, rad * 0.62, rad * 0.62, 14),
      mats.trim
    );
    vol.rotation.x = Math.PI / 2;
    vol.position.set(sgn * rad * 1.05, capY + 0.26, 0);
    vol.castShadow = true;
    g.add(vol);
  }
  return g;
}

// ==================================================================== 南门廊
/**
 * 南门廊：半圆平面 + 6 根柱 + 顶部弧形阳台（杜鲁门阳台）。
 * 白宫最著名的一景就是从这个圆弧往北看。
 */
function buildSouthPortico(r, mats) {
  const g = new THREE.Group();
  const z0 = DIM.D / 2;
  const R = 6.4;          // 半圆半径
  const colCount = DIM.porticoS;

  // 弧形台基
  const plinthGeo = new THREE.CylinderGeometry(R + 1.1, R + 1.3, 1.05, 40, 1, false, 0, Math.PI);
  const plinth = new THREE.Mesh(plinthGeo, mats.stone);
  plinth.position.set(0, 0.525, z0 - 0.2);
  plinth.rotation.y = -Math.PI / 2;
  plinth.receiveShadow = true;
  g.add(plinth);

  // 6 根柱，沿半圆均布
  for (let i = 0; i < colCount; i++) {
    const a = Math.PI * (i + 0.5) / colCount - Math.PI / 2;
    const cx = Math.sin(a) * R;
    const cz = z0 - 0.2 + Math.cos(a) * R * 0.92;
    g.add(buildIonicColumn(mats, cx, 1.05, cz, DIM.colH, DIM.colR));
  }

  // 弧形檐部：用一段圆筒壳
  const archGeo = new THREE.CylinderGeometry(R + 0.55, R + 0.55, 1.30, 40, 1, true, 0, Math.PI);
  const arch = new THREE.Mesh(archGeo, mats.trim);
  arch.position.set(0, 1.05 + DIM.colH + 0.65, z0 - 0.2);
  arch.rotation.y = -Math.PI / 2;
  arch.material.side = THREE.DoubleSide;
  arch.castShadow = true;
  g.add(arch);

  // 弧形屋顶（杜鲁门阳台的地面）
  const roofGeo = new THREE.CylinderGeometry(R + 0.75, R + 0.75, 0.26, 40, 1, false, 0, Math.PI);
  const roof = new THREE.Mesh(roofGeo, mats.trim);
  roof.position.set(0, 1.05 + DIM.colH + 1.43, z0 - 0.2);
  roof.rotation.y = -Math.PI / 2;
  roof.castShadow = true;
  g.add(roof);

  // 二层柱（阳台上面那一圈短柱 + 栏杆）
  // 【修正】白宫南门廊上面是**杜鲁门阳台 + 石栏杆**，不是第二排柱。
  // 第一版在这里放了 6 根细柱 + 一道细横杆，渲染出来像"脚手架"（实测）。
  // 现在改成：沿圆弧密排小瓶（宝瓶栏杆），两端加方形端柱。
  {
    const balY = 1.05 + DIM.colH + 1.56 + 0.10;
    const balH = 0.78;
    const balR = R + 0.62;
    const arcLen = Math.PI * balR;
    const count = Math.round(arcLen / 0.30);

    const geos = [];
    for (let i = 0; i < count; i++) {
      const a = Math.PI * (i + 0.5) / count - Math.PI / 2;
      const px = Math.sin(a) * balR;
      const pz = z0 - 0.2 + Math.cos(a) * balR * 0.92;
      const hh = balH * jitter(r, 0.985, 1.015);
      const bg = new THREE.CylinderGeometry(0.040, 0.055, hh, 6, 1);
      const pos = bg.attributes.position;
      for (let v = 0; v < pos.count; v++) {
        const yy = pos.getY(v) / (hh / 2);
        const bulge = 1 + 0.40 * Math.exp(-Math.pow(yy * 1.7, 2));
        pos.setX(v, pos.getX(v) * bulge);
        pos.setZ(v, pos.getZ(v) * bulge);
      }
      pos.needsUpdate = true;
      bg.computeVertexNormals();
      const m = new THREE.Matrix4().makeTranslation(px, balY + balH / 2, pz);
      const g2 = bg.clone(); g2.applyMatrix4(m); geos.push(g2);
    }
    g.add(new THREE.Mesh(mergeGeometries(geos), mats.trim));

    // 上压顶 / 下底座：用两段弧形薄筒
    for (const [yy, th, rr] of [[balY + balH + 0.075, 0.15, balR + 0.06],
                                 [balY - 0.07, 0.14, balR + 0.02]]) {
      const ringGeo = new THREE.CylinderGeometry(rr, rr, th, 44, 1, true, 0, Math.PI);
      const ring = new THREE.Mesh(ringGeo, mats.trim);
      ring.position.set(0, yy, z0 - 0.2);
      ring.rotation.y = -Math.PI / 2;
      ring.material.side = THREE.DoubleSide;
      ring.castShadow = true;
      g.add(ring);
    }

    // 两端方形端柱
    for (const sgn of [-1, 1]) {
      const post = new THREE.Mesh(boxWithBevel(0.42, balH + 0.34, 0.42, 0.02), mats.trim);
      post.position.set(sgn * balR, balY + balH / 2 + 0.06, z0 - 0.2 + 0.18);
      post.castShadow = true;
      g.add(post);
    }
  }

  // 半圆中心那三扇落地窗（从南草坪一眼看到）
  for (let i = -1; i <= 1; i++) {
    const win = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 4.2), mats.glass);
    win.position.set(i * 1.85, 1.05 + 2.3, z0 + 0.06);
    g.add(win);
    const fr = new THREE.Mesh(new THREE.BoxGeometry(1.55, 4.45, 0.10), mats.trim);
    fr.position.set(i * 1.85, 1.05 + 2.3, z0 + 0.02);
    g.add(fr);
    win.position.z = z0 + 0.085;
  }

  return g;
}

// ==================================================================== 旗杆
function buildFlagpole(r, mats) {
  const g = new THREE.Group();
  const h = 9.6;
  const baseY = DIM.wallH + 0.74;

  // 底座（圆台）
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.62, 0.86, 0.55, 18),
    mats.trim
  );
  base.position.set(0, baseY + 0.275, 1.2);
  base.castShadow = true;
  g.add(base);

  // 杆
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.085, h, 12),
    mats.metal
  );
  pole.position.set(0, baseY + 0.55 + h / 2, 1.2);
  pole.castShadow = true;
  g.add(pole);

  // 杆顶球
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 10), mats.metal);
  ball.position.set(0, baseY + 0.55 + h + 0.12, 1.2);
  g.add(ball);

  // 旗：用细分的平面做一点飘动感（顶点按正弦偏移）
  const fw = 2.6, fh = 1.5;
  const flagGeo = new THREE.PlaneGeometry(fw, fh, 24, 10);
  const pos = flagGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const u = (pos.getX(i) + fw / 2) / fw;   // 0 靠杆，1 飘出去
    const wave = Math.sin(u * Math.PI * 2.6) * 0.13 * u
               + Math.sin(u * Math.PI * 5.1 + 1.7) * 0.05 * u;
    pos.setZ(i, wave);
    // 越往外越垂
    pos.setY(i, pos.getY(i) - u * u * 0.08);
  }
  pos.needsUpdate = true;
  flagGeo.computeVertexNormals();

  const flagCanvas = makeFlagTexture();
  const flagMat = new THREE.MeshStandardMaterial({
    map: flagCanvas, side: THREE.DoubleSide, roughness: 0.85, metalness: 0.0,
  });
  const flag = new THREE.Mesh(flagGeo, flagMat);
  flag.position.set(fw / 2 + 0.02, baseY + 0.55 + h - fh / 2 - 0.35, 1.2);
  flag.rotation.y = Math.PI * 0.06;
  flag.castShadow = true;
  g.add(flag);

  return g;
}

/** 星条旗：13 道条纹 + 蓝底星区（星用点阵近似） */
function makeFlagTexture() {
  const w = 512, h = 288;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const stripes = 13;
  const sh = h / stripes;
  for (let i = 0; i < stripes; i++) {
    g.fillStyle = i % 2 === 0 ? '#b22234' : '#ffffff';
    g.fillRect(0, i * sh, w, sh + 1);
  }
  const cw = w * 0.40, ch = sh * 7;
  g.fillStyle = '#3c3b6e';
  g.fillRect(0, 0, cw, ch);
  // 星（9 行交错，简化）
  g.fillStyle = '#ffffff';
  const rows = 9, per = 11;
  for (let ry = 0; ry < rows; ry++) {
    const cols = ry % 2 === 0 ? per : per - 1;
    for (let cx = 0; cx < cols; cx++) {
      const x = (cx + 0.5 + (ry % 2 === 0 ? 0 : 0.5)) * (cw / per);
      const y = (ry + 0.5) * (ch / rows);
      g.beginPath();
      g.arc(x, y, 2.1, 0, Math.PI * 2);
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
