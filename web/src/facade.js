/**
 * 程序化立面贴图。
 *
 * 为什么不用 ambientCG 的 Facade*：那几套是「窗户图集」——一张 1K 图里
 * 塞了几十个互不相同的窗格小块（见 assets/tex/facade_a.jpg，是一张棋盘状
 * 的窗样集）。按 30 m 铺到墙上，一栋 12 m 的连排屋只能取到其中 1~2 格，
 * 于是整面墙变成随机深浅的方块马赛克；远景 mip 一把平均又变成一片脏绿。
 * 这是「纸盒子 / 糊墙」观感的直接来源。
 *
 * 做法：用 ambientCG 的**连续材质**（砖 / 石材 / 混凝土 / 灰泥）当墙基，
 * 按真实的**层高 × 开间**在 canvas 上画窗，得到「一面真墙」：
 *   - 4 层 × 4 开间，层高 3.3 m、开间 3.0 m
 *   - 窗洞、窗框、窗台、窗楣、玻璃的竖向渐变反光
 *   - 连排屋是双悬窗（上下两扇）、办公楼是整层带窗、幕墙是竖挺 + 整片玻璃
 * 每张代表 12 m(横) × 13.2 m(竖)，UV 分别按这两个尺寸取模，
 * 所以窗子是等高等宽的，不会随楼高拉伸。
 */

import * as THREE from 'three';

const S = 512;            // 贴图边长
const BAYS = 4;           // 横向开间数
const FLOORS = 4;         // 纵向层数
export const TILE_U = 12.0;    // 一张贴图覆盖 12 m（4 开间 × 3 m）
export const TILE_V = 13.2;    // 覆盖 13.2 m（4 层 × 3.3 m）

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 把一张墙基贴图铺满 canvas。
 * @param {CanvasRenderingContext2D} g
 * @param {HTMLImageElement|HTMLCanvasElement} img
 */
function fillBase(g, img) {
  g.drawImage(img, 0, 0, S, S);
}

/**
 * 画一扇窗。
 * style: 'sash'（双悬窗）| 'punched'（办公楼方窗）| 'ribbon'（带形窗）
 */
function drawWindow(g, x, y, w, h, style, rand, warm) {
  // 窗洞内侧阴影
  g.fillStyle = 'rgba(0,0,0,0.34)';
  g.fillRect(x - 2, y - 2, w + 4, h + 3);

  // 玻璃：反射天光 —— 上缘亮、中部映天空、下缘暗（室内）。
  // 【贴图设计要点】玻璃不能画成纯黑：远景 mip 平均后整面墙会变成煤渣，
  // 近景又像蜂窝。但也不能画太亮：白天玻璃的**平均**亮度必须显著低于墙基，
  // 否则整面墙只看得见一片亮窗格，中远景读成「冲孔板 / 蜂窝」—— 这是第二版
  // 的实际症状（第一版是纯黑煤渣，两个极端都错）。目标：玻璃均值 ≈ 墙基 × 0.72。
  const gr = g.createLinearGradient(0, y, 0, y + h);
  const t = rand();
  const sky = 118 + Math.round(34 * t);       // 天光反射亮度
  const deep = 52 + Math.round(26 * t);       // 下缘（室内/挑檐阴影）
  gr.addColorStop(0.00, `rgba(${sky - 20},${sky - 6},${sky + 12},1)`);
  gr.addColorStop(0.38, `rgba(${Math.round((sky + deep) / 2) - 6},${Math.round((sky + deep) / 2) + 4},${Math.round((sky + deep) / 2) + 20},1)`);
  gr.addColorStop(0.72, `rgba(${deep + 20},${deep + 28},${deep + 40},1)`);
  gr.addColorStop(1.00, `rgba(${deep - 8},${deep - 2},${deep + 10},1)`);
  g.fillStyle = gr;
  g.fillRect(x, y, w, h);

  // 斜向高光：模拟对面楼/天空在玻璃上的软反射条
  const hg = g.createLinearGradient(x, y + h, x + w, y);
  hg.addColorStop(0.00, 'rgba(255,255,255,0)');
  hg.addColorStop(0.45 + 0.2 * rand(), 'rgba(226,238,250,0.14)');
  hg.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = hg;
  g.fillRect(x, y, w, h);

  if (style === 'sash') {
    // 上下两扇 + 中梃（细，别做成白条）
    g.fillStyle = 'rgba(226,224,216,0.78)';
    const mh = Math.max(1, Math.round(h * 0.030));
    g.fillRect(x, y + h * 0.5 - mh / 2, w, mh);
    g.fillRect(x + w / 2 - mh / 2, y + h * 0.5, mh, h * 0.5);
  } else if (style === 'punched') {
    // 中间一根竖梃
    g.fillStyle = 'rgba(112,116,120,0.70)';
    g.fillRect(x + w * 0.5 - 1, y, 2, h);
  } else if (style === 'ribbon') {
    g.fillStyle = 'rgba(140,145,150,0.60)';
    for (let k = 1; k < 4; k++) g.fillRect(x + (w * k) / 4 - 1, y, 2, h);
  }

  // 窗框：必须细且不太亮。第一版 lineWidth = w*0.045 + alpha 0.95，
  // 远景 mip 一平均，全城墙面变成一片亮点阵（用户说的「蜂窝」就是这个）。
  g.strokeStyle = 'rgba(214,212,204,0.72)';
  g.lineWidth = Math.max(1, Math.round(w * 0.022));
  g.strokeRect(x + g.lineWidth / 2, y + g.lineWidth / 2, w - g.lineWidth, h - g.lineWidth);

  // 窗台：一条很窄的浅色 + 下方阴影，宽度别超过窗洞 4 px
  g.fillStyle = 'rgba(232,230,222,0.55)';
  g.fillRect(x - 2, y + h, w + 4, Math.max(2, Math.round(h * 0.028)));
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(x - 2, y + h + Math.max(2, Math.round(h * 0.028)), w + 4, Math.max(1, Math.round(h * 0.02)));

  // 偶尔一点暖光（有人在家）
  if (warm && rand() < 0.08) {
    const gx = g.createLinearGradient(0, y, 0, y + h);
    gx.addColorStop(0, 'rgba(255,214,150,0.12)');
    gx.addColorStop(1, 'rgba(255,196,120,0.04)');
    g.fillStyle = gx;
    g.fillRect(x, y, w, h);
  }
}

/**
 * 生成一张立面贴图。
 * @param {HTMLImageElement} baseImg  墙基贴图（砖 / 石材 / 混凝土 / 灰泥）
 * @param {object} o
 *   style  'sash'|'punched'|'ribbon'|'curtain'
 *   winW   窗宽（占开间比例，0..1）
 *   winH   窗高（占层高比例，0..1）
 *   seed   随机种子
 *   trim   'light'|'none'  是否有浅色窗套
 */
export function makeFacade(baseImg, o = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const rand = rng(o.seed ?? 12345);
  const style = o.style || 'sash';
  const winW = o.winW ?? 0.46;
  const winH = o.winH ?? 0.56;
  const trim = o.trim ?? 'light';

  fillBase(g, baseImg);

  const bw = S / BAYS;     // 开间像素宽
  const fh = S / FLOORS;   // 层高像素高

  for (let f = 0; f < FLOORS; f++) {
    for (let b = 0; b < BAYS; b++) {
      const cx = b * bw + bw / 2;
      const cy = f * fh + fh / 2;

      if (style === 'curtain') {
        // 幕墙：整开间玻璃 + 竖挺
        const x = b * bw + bw * 0.06;
        const y = f * fh + fh * 0.10;
        drawWindow(g, x, y, bw * 0.88, fh * 0.80, 'ribbon', rand, false);
        continue;
      }

      let w = bw * winW;
      let h = fh * winH;
      if (style === 'ribbon') {
        w = bw * 0.86;
        h = fh * 0.52;
      }
      const x = cx - w / 2;
      const y = fh * (f + 1) - fh * 0.16 - h;   // 贴着楼层底部略抬

      if (trim === 'light') {
        g.fillStyle = 'rgba(242,239,231,0.55)';
        g.fillRect(x - 5, y - 5, w + 10, h + 10);
      }
      drawWindow(g, x, y, w, h, style, rand, true);
    }
  }

  // 层间线：每层一条很淡的水平分带（真实立面都有勒脚/腰线）
  g.fillStyle = 'rgba(255,255,255,0.045)';
  for (let f = 0; f < FLOORS; f++) g.fillRect(0, f * fh, S, 2);
  g.fillStyle = 'rgba(0,0,0,0.055)';
  for (let f = 0; f < FLOORS; f++) g.fillRect(0, f * fh + 2, S, 2);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}
