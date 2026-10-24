/**
 * 程序化几何工具库 —— 全部在代码里生成，零外部模型资源。
 *
 * 设计原则（对应导师参考图里那句「每个网格/纹理/着色器都必须在代码中生成」）：
 *   1. 不 import 任何 .glb / .obj / .png
 *   2. 纹理全部用 Canvas2D 现画（砖、石、草、水、玻璃），可无缝平铺
 *   3. 重复构件（柱、窗、栏杆）都用「参数化 + 微差」生成，避免"复制粘贴感"
 */

import * as THREE from 'three';

// ---------------------------------------------------------------- 随机数
// 固定种子的 mulberry32：同一个 seed 出同一个房子，便于复现与对比
export function rng(seed = 20261021) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 在 [lo,hi] 里取值，用于给重复构件加"手工感"微差 */
export const jitter = (r, lo, hi) => lo + r() * (hi - lo);

// ---------------------------------------------------------------- 画布纹理
function canvasTex(w, h, draw, { repeat = [1, 1], srgb = true, aniso = 8 } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** 值噪声（用于砖面斑驳、草地色差） */
function hash2(x, y) {
  let n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

// ---------------------------------------------------------------- 白宫外墙
/**
 * 白宫外墙是刷白的阿基亚溪砂岩（Aquia Creek sandstone），
 * 1814 年火烧后刷白，因此不是纯白 —— 带极淡的暖灰与竖向雨痕。
 */
export function textureWhiteHouseWall(size = 512) {
  return canvasTex(size, size, (g, w, h) => {
    g.fillStyle = '#eae7e0';
    g.fillRect(0, 0, w, h);
    // 大块极淡的横向色带（石材层理）
    for (let y = 0; y < h; y += 4) {
      const v = 0.94 + hash2(0, y) * 0.09;
      g.fillStyle = `rgba(226,222,213,${(1 - v).toFixed(3)})`;
      g.fillRect(0, y, w, 4);
    }
    // 竖向雨痕
    for (let i = 0; i < 26; i++) {
      const x = Math.floor(hash2(i, 7) * w);
      const len = 40 + hash2(i, 11) * 300;
      const y0 = hash2(i, 13) * h;
      const grad = g.createLinearGradient(x, y0, x, y0 + len);
      grad.addColorStop(0, 'rgba(196,193,184,0.16)');
      grad.addColorStop(1, 'rgba(196,193,184,0)');
      g.fillStyle = grad;
      g.fillRect(x, y0, 2 + hash2(i, 17) * 3, len);
    }
    // 细颗粒
    const img = g.getImageData(0, 0, w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (hash2(i * 0.017, i * 0.031) - 0.5) * 10;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
  }, { repeat: [1, 1] });
}

/** 白宫屋面的深色石板（站在草皮上看是近乎黑灰） */
export function textureSlateRoof(size = 256) {
  return canvasTex(size, size, (g, w, h) => {
    g.fillStyle = '#4a4f52';
    g.fillRect(0, 0, w, h);
    const rows = 12, cols = 8;
    const rh = h / rows, cw = w / cols;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * cw * 0.5;
      for (let c = -1; c <= cols; c++) {
        const x = c * cw + off, y = r * rh;
        const v = 0.85 + hash2(r, c) * 0.3;
        g.fillStyle = `rgb(${Math.floor(74 * v)},${Math.floor(79 * v)},${Math.floor(82 * v)})`;
        g.fillRect(x + 1, y + 1, cw - 2, rh - 1.5);
      }
    }
  }, { repeat: [3, 3] });
}

// ---------------------------------------------------------------- 玻璃
/**
 * 白宫的窗玻璃是老式手工玻璃 —— 有轻微起伏与反射差。
 *
 * 【重要】这张贴图必须把"反射的天空"画进去，不能指望 envMap：
 *   无头/软件渲染环境下 environment map 经常拿不到，玻璃会变成死黑的洞。
 *   所以这里把天空渐变直接烘进贴图，材质用低金属度 + 中等粗糙度，
 *   亮度和色相完全由贴图决定 —— 任何环境下都稳定。
 */
export function textureWindowGlass(size = 256) {
  return canvasTex(size, size, (g, w, h) => {
    // 上暗下亮：模拟室内暗、玻璃反射天空
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0.00, '#7d93a6');
    grad.addColorStop(0.18, '#a6bccc');
    grad.addColorStop(0.42, '#c2d6e2');
    grad.addColorStop(0.58, '#93a9ba');
    grad.addColorStop(0.80, '#6d8496');
    grad.addColorStop(1.00, '#57697a');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);

    // 天空反射的一条亮带（斜向，模拟对面树/天空在玻璃上的映像）
    g.save();
    g.translate(w * 0.5, h * 0.44);
    g.rotate(-0.38);
    const rg = g.createLinearGradient(-w, 0, w, 0);
    rg.addColorStop(0.00, 'rgba(240,248,255,0)');
    rg.addColorStop(0.38, 'rgba(246,252,255,0.62)');
    rg.addColorStop(0.55, 'rgba(226,240,250,0.34)');
    rg.addColorStop(1.00, 'rgba(240,248,255,0)');
    g.fillStyle = rg;
    g.fillRect(-w, -h * 0.13, w * 2, h * 0.26);
    g.restore();

    // 玻璃里的深色倒影（树影），让窗不呆板
    for (let i = 0; i < 7; i++) {
      const x = hash2(i, 21) * w;
      const y = h * (0.5 + hash2(i, 23) * 0.5);
      const rad = 8 + hash2(i, 25) * 26;
      const dg = g.createRadialGradient(x, y, 0, x, y, rad);
      dg.addColorStop(0, `rgba(42,58,44,${0.10 + hash2(i, 27) * 0.14})`);
      dg.addColorStop(1, 'rgba(42,58,44,0)');
      g.fillStyle = dg;
      g.beginPath();
      g.arc(x, y, rad, 0, Math.PI * 2);
      g.fill();
    }

    // 年久的气泡杂点
    for (let i = 0; i < 34; i++) {
      const x = hash2(i, 3) * w, y = hash2(i, 5) * h;
      g.fillStyle = `rgba(255,255,255,${0.05 + hash2(i, 9) * 0.12})`;
      g.beginPath();
      g.arc(x, y, 0.5 + hash2(i, 13) * 1.4, 0, Math.PI * 2);
      g.fill();
    }
  }, { repeat: [1, 1] });
}

// ---------------------------------------------------------------- 地面
/** 南草坪：修剪过的肯塔基蓝草，带割草机留下的条纹 */
export function textureLawn(size = 512, stripes = true) {
  return canvasTex(size, size, (g, w, h) => {
    g.fillStyle = '#4a7a33';
    g.fillRect(0, 0, w, h);
    // 草色斑驳
    for (let i = 0; i < 9000; i++) {
      const x = hash2(i, 1) * w, y = hash2(i, 2) * h;
      const v = hash2(i, 3);
      const gr = v > 0.5 ? [96, 140, 62] : [58, 100, 42];
      g.fillStyle = `rgba(${gr[0]},${gr[1]},${gr[2]},${0.18 + v * 0.32})`;
      g.fillRect(x, y, 1 + v * 2.2, 1 + v * 3.4);
    }
    // 割草条纹（南草坪确实有，45° 交替明暗）
    if (stripes) {
      const band = h / 8;
      for (let i = 0; i < 8; i++) {
        g.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.05)';
        g.fillRect(0, i * band, w, band);
      }
    }
  }, { repeat: [12, 12] });
}

/** 花坛里的覆盖土（深色腐殖土 + 少量木屑） */
export function textureSoil(size = 256) {
  return canvasTex(size, size, (g, w, h) => {
    g.fillStyle = '#3b2f24';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 3000; i++) {
      const x = hash2(i, 4) * w, y = hash2(i, 6) * h;
      const v = hash2(i, 8);
      g.fillStyle = `rgba(${52 + v * 40},${40 + v * 32},${28 + v * 24},${0.3 + v * 0.4})`;
      g.fillRect(x, y, 1 + v * 3, 1 + v * 2);
    }
  }, { repeat: [6, 6] });
}

/**
 * 花岗岩广场铺装：0.9 m 见方石板 + 深色灰缝。
 *
 * 国会山西平台、纪念碑场地在真实 DC 是整块深灰花岗岩板，缝很细但极密，
 * 远看是一片"有秩序的灰"。纯色顶点色读不出这个秩序（远处糊成一片浅灰），
 * 所以必须有真实灰缝纹理。
 * repeat 设为 1：广场的 UV 是世界坐标 / tile（见 plazas.js），
 * 一张图正好铺 tile 米，不靠 texture.repeat 缩放。
 */
export function textureGranitePaving(size = 512, slabs = 6) {
  return canvasTex(size, size, (g, w, h) => {
    g.fillStyle = '#6f6b63';           // 灰缝底色（深，远处 mip 才留得住）
    g.fillRect(0, 0, w, h);
    const cw = w / slabs, ch = h / slabs;
    for (let r = 0; r < slabs; r++) {
      // 错缝：奇数行整体挪半块
      const off = (r & 1) ? cw * 0.5 : 0;
      for (let c = -1; c <= slabs; c++) {
        const v = 0.92 + hash2(r + 11, c + 7) * 0.16;
        const x = c * cw + off + 1.5;
        const y = r * ch + 1.5;
        g.fillStyle = `rgb(${Math.floor(176 * v)},${Math.floor(172 * v)},${Math.floor(163 * v)})`;
        g.fillRect(x, y, cw - 4, ch - 4);
        // 板面细麻点（花岗岩颗粒），让近景不至于是一块塑料
        for (let k = 0; k < 22; k++) {
          const px = x + hash2(r * 31 + k, c * 17 + k) * (cw - 4);
          const py = y + hash2(c * 13 + k, r * 29 + k) * (ch - 4);
          const t = hash2(k + r, k + c);
          g.fillStyle = t > 0.5
            ? `rgba(120,116,108,${0.10 + t * 0.16})`
            : `rgba(226,222,213,${0.10 + t * 0.18})`;
          g.fillRect(px, py, 1 + t * 2, 1 + t * 1);
        }
      }
    }
  }, { repeat: [1, 1] });
}

/** 人字砖铺装（北门车道与步道） */
export function textureBrickPaving(size = 512) {
  return canvasTex(size, size, (g, w, h) => {
    g.fillStyle = '#6b5548';
    g.fillRect(0, 0, w, h);
    const bw = w / 8, bh = h / 16;
    for (let r = 0; r < 16; r++) {
      for (let c = 0; c < 8; c++) {
        const v = 0.82 + hash2(r, c) * 0.36;
        g.fillStyle = `rgb(${Math.floor(150 * v)},${Math.floor(86 * v)},${Math.floor(66 * v)})`;
        g.fillRect(c * bw + 1.5, r * bh + 1.5, bw - 3, bh - 3);
      }
    }
  }, { repeat: [4, 4] });
}

// ---------------------------------------------------------------- 树
/**
 * 树叶粒子贴图：单个叶片簇，带 alpha。
 * 用 Points 或 InstancedMesh 撒，比一棵真树省几个数量级。
 */
export function textureLeafCluster(size = 256, tint = [88, 132, 62]) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.clearRect(0, 0, size, size);

  // 叶簇不能是"均匀撒点" —— 真实树冠是一团团叶球，中间有暗的枝空隙。
  // 做法：先撒几个团簇中心，叶片按团簇聚集，团簇之间留空隙。
  const clusters = 5 + Math.floor(hash2(size, 1) * 3);
  const centers = [];
  for (let i = 0; i < clusters; i++) {
    const a = (i / clusters) * Math.PI * 2 + hash2(i, 2) * 1.2;
    const rad = (0.18 + hash2(i, 3) * 0.30) * size;
    centers.push([
      size / 2 + Math.cos(a) * rad,
      size / 2 + Math.sin(a) * rad,
      (0.16 + hash2(i, 4) * 0.16) * size,     // 团簇半径
    ]);
  }

  const leafCount = 340;
  for (let i = 0; i < leafCount; i++) {
    const ci = Math.floor(hash2(i, 7) * clusters) % clusters;
    const [cx, cy, cr] = centers[ci];
    // 高斯近似：两次随机求和，往中心聚
    const rr = (hash2(i, 11) + hash2(i, 13)) * 0.5 * cr * 1.5;
    const aa = hash2(i, 17) * Math.PI * 2;
    const x = cx + Math.cos(aa) * rr;
    const y = cy + Math.sin(aa) * rr * 0.85;
    if (x < 0 || x > size || y < 0 || y > size) continue;

    const s = (0.020 + hash2(i, 19) * 0.030) * size;
    // 明暗按"距团簇中心的相对位置"给 —— 边缘亮、内部暗，产生体积感
    const edge = Math.min(1, rr / (cr * 0.9));
    const v = 0.55 + edge * 0.55 + hash2(i, 23) * 0.18;
    const r8 = Math.min(255, tint[0] * v) | 0;
    const g8 = Math.min(255, tint[1] * v) | 0;
    const b8 = Math.min(255, tint[2] * v) | 0;

    g.save();
    g.translate(x, y);
    g.rotate(hash2(i, 29) * Math.PI);
    g.fillStyle = `rgba(${r8},${g8},${b8},0.95)`;
    // 叶片：细长椭圆（比圆更像叶子）
    g.beginPath();
    g.ellipse(0, 0, s * 0.62, s * 0.26, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** 树皮（用于树干） */
export function textureBark(size = 128) {
  return canvasTex(size, size, (g, w, h) => {
    g.fillStyle = '#4a4038';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 240; i++) {
      const x = hash2(i, 1) * w;
      const v = hash2(i, 2);
      g.fillStyle = `rgba(${58 + v * 46},${50 + v * 38},${42 + v * 30},${0.35 + v * 0.45})`;
      g.fillRect(x, 0, 1 + v * 3, h);
    }
  }, { repeat: [1, 3] });
}

// ---------------------------------------------------------------- 水
/**
 * 喷泉水池的水面法线扰动贴图（程序化波纹）。
 * 用两层正弦叠加 + 噪声，做成可滚动的法线。
 */
export function textureWaterNormal(size = 256) {
  return canvasTex(size, size, (g, w, h) => {
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // 两组交叉波 + 一层噪声，避免规则条纹
        const u = x / w, v = y / h;
        const nx = Math.sin((u * 4 + v * 2.2) * Math.PI * 2) * 0.5
                 + Math.sin((u * 7 - v * 5) * Math.PI * 2) * 0.28
                 + (hash2(x * 0.11, y * 0.13) - 0.5) * 0.9;
        const ny = Math.cos((u * 3.4 - v * 4.1) * Math.PI * 2) * 0.5
                 + Math.cos((u * 6 + v * 8) * Math.PI * 2) * 0.26
                 + (hash2(x * 0.13 + 5, y * 0.11 + 9) - 0.5) * 0.9;
        const nz = 1.0;
        const len = Math.hypot(nx, ny, nz);
        const i = (y * w + x) * 4;
        img.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
        img.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
        img.data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }, { repeat: [2, 2], srgb: false });
}

// ---------------------------------------------------------------- 小工具
/** 把 BufferGeometry 平移/旋转后并进来，减少 draw call */
export function mergeInto(target, geo, matrix) {
  const g = geo.clone();
  if (matrix) g.applyMatrix4(matrix);
  target.push(g);
  return g;
}

/** 简单圆角盒（倒角让边缘不至于像塑料） */
export function boxWithBevel(w, h, d, bevel = 0.02, seg = 1) {
  // three 没有内建圆角盒，这里用较小 bevel + BoxGeometry 近似
  // （真正的倒角需要 ExtrudeGeometry，成本高，这里只求边缘不死板）
  const g = new THREE.BoxGeometry(w, h, d, 1, 1, 1);
  if (bevel > 0) {
    const pos = g.attributes.position;
    // 极轻的顶点收缩，模拟一点倒角反光
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i,
        pos.getX(i) * (1 - bevel / Math.max(w, 0.001)),
        pos.getY(i) * (1 - bevel / Math.max(h, 0.001)),
        pos.getZ(i) * (1 - bevel / Math.max(d, 0.001)));
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}
