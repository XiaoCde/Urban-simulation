/**
 * 城市贴图库 + 世界坐标「盒式投影」材质。
 *
 * 为什么需要盒式投影（box projection）：
 *   场景里 21,943 栋楼是一整块合并网格，**没有 UV**。逐栋展开 UV 不现实，
 *   而盒式投影让任意几何直接按世界坐标贴图 —— 墙面、屋顶同时成立。
 *
 * 为什么按主导轴选投影面（不是三平面混合）：
 *   建筑是硬边体块，一个面只属于一个朝向。按主导轴取 UV 没有混合，
 *   砖缝/窗格在墙面上严格水平垂直，转角是干净直角。法线用屏幕空间导数
 *   `normalize(cross(dFdx(vWPos), dFdy(vWPos)))` 求，正好等于真实面法线。
 *
 * 贴图全部来自 ambientCG（CC0 1.0 公有领域，可商用、可再分发、无需署名），
 * 由 tools/terrain/make_web_tex.py 压成 512x512 JPG。
 */

import * as THREE from 'three';

const TEX_BASE = 'assets/tex/';

/**
 * 每层贴图的目标「**渲染出来的**屏幕亮度」（sRGB 均值）。
 *
 * 【为什么不能直接把 albedo 拉到目标值】three 的物理光照里
 *   diffuse = albedo × irradiance / π，irradiance ≈ 太阳 1.7 × N·L(≈0.7) + 半球 1.05
 *   ≈ 2.2。所以「渲染亮度 ≈ albedo × 0.70」（再经 ACES 压缩）。
 * 第一版把 target 直接当 albedo：albedo 0.18 的墙渲染出来只有 0.68 sRGB，
 * 而地形（顶点色 0.45 × 贴图 0.95）渲染出来是 0.47 —— 于是每一次调参都在
 * 「墙黑得看不见窗」和「墙白成纸板」之间跳。下面用 LIGHT_GAIN 换算。
 */
const LIGHT_GAIN = 0.70;

/**
 * 目标值按 DC 实景定：砖墙 / 乳白石材是主体，偏亮；玻璃幕墙故意压暗。
 * 屋面必须明显比墙面暗 —— DC 的真实屋面是深灰碎石卷材，而屋顶在俯视图里
 * 占 60% 以上面积，屋面一亮整座城市就读成「米色纸板」。
 */
const TARGET = {
  brick_a: 0.55, brick_b: 0.52, paint_a: 0.60, stone_a: 0.58,
  conc_a: 0.56, facade_a: 0.46, facade_b: 0.48, facade_c: 0.44,
  facade_d: 0.46, glass_a: 0.34, glass_b: 0.36,
  roof_slate: 0.28, roof_tile: 0.40, roof_gravel: 0.32,
  asphalt: 0.30, pave: 0.62, grass: 0.42,
};

/** 用 canvas 量一张贴图的 sRGB 平均亮度（0..1）。 */
function meanLum(img) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, 32, 32);
  const d = g.getImageData(0, 0, 32, 32).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) {
    s += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
  }
  // sRGB 均值 → 线性均值，贴近渲染里实际乘的量
  const srgb = s / (32 * 32);
  return Math.pow(srgb, 2.2);
}

/** 一次性加载所有贴图，返回 {key: {tex, tile_m, lift, mean, pack}}。 */
export async function loadCityTextures(base = TEX_BASE) {
  const idx = await (await fetch(base + 'index.json')).json();
  const loader = new THREE.TextureLoader();
  const out = {};

  await Promise.all(idx.layers.map(async (L) => {
    const tex = await loader.loadAsync(base + L.key + '.jpg');
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;

    const mean = meanLum(tex.image);
    const tgt = TARGET[L.key];
    // target 是「渲染亮度」，除以 LIGHT_GAIN 换回 albedo 再和实测均值比
    const lift = tgt == null ? 1.0
      : Math.min(4.0, Math.max(0.55, Math.pow(tgt, 2.2) / LIGHT_GAIN / Math.max(1e-4, mean)));

    out[L.key] = { tex, tile_m: L.tile_m, pack: L.pack, mean, lift };
  }));

  console.log(`[tex] ${Object.keys(out).length} 张贴图就位（ambientCG CC0）`);
  return out;
}

// ---------------------------------------------------------------- 盒式投影

/**
 * 立面 UV 的三条规则（每条都是踩过的坑）：
 *
 * 1) **竖轴必须从楼底起算**：`p.y` 是世界绝对高度。DC 地形起伏 60+ m，直接用
 *    p.y 排层会让坡上的楼从半层开始切窗，楼上楼下都歪。改用 `p.y - aBld.y`
 *    （楼底高程），窗户就从楼脚往上排。
 *
 * 2) **逐栋横向相位**：全城楼的墙都按世界坐标取 UV，窗户会排成一张贯穿整个
 *    城市的网，读起来像贴了张「冲孔板」的壁纸 —— 这是第一版最刺眼的毛病。
 *    用 `aBld.x`（逐栋 0..1 随机）给横轴加一个整开间的偏移，窗格就各归各楼。
 *
 * 3) **女儿墙收边**：楼顶最后 0.55 m（或一层的 15%）用一条素色压顶，
 *    否则贴图会在屋顶边缘被硬切一半，像贴纸没贴齐。
 */
const BOX_FRAG = `
  varying vec3 vWPos;
  varying vec3 vBld;
  uniform vec2 uTile;
  uniform float uLift;
  uniform vec3 uTint;
  uniform float uPlain;
  vec2 boxUv( vec3 p, vec3 n, vec2 t, vec3 bd ) {
    vec3 a = abs( n );
    vec2 uv;
    if ( a.y > max( a.x, a.z ) ) {
      // 屋面：俯视投影，按楼错开，避免全城屋顶的碎石纹连成一张网
      uv = p.xz + vec2( bd.x * 37.0, bd.x * 61.0 );
      return uv / t;
    }
    float h = p.y - bd.y;                       // 相对楼底的高度
    float across = ( a.x > a.z ) ? p.z : p.x;   // 沿墙水平方向
    across += bd.x * t.x * 3.0;                 // 逐栋错开整开间
    // 立面上沿取整：让最上面一层窗户不被切
    uv = vec2( across, h ) / t;
    return uv;
  }
`;

/**
 * 给 MeshStandardMaterial 打上「世界坐标盒式投影」补丁：保留整套 PBR / 阴影，
 * 只替换 map 的采样方式（因为几何没有 uv 属性）。
 */
function patchBoxProjection(mat, tu, tv, tag = '', lift = 1.0, tint = null, plain = 0) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTile = { value: new THREE.Vector2(tu, tv === undefined ? tu : tv) };
    shader.uniforms.uLift = { value: lift };
    shader.uniforms.uTint = { value: tint ? new THREE.Vector3(...tint) : new THREE.Vector3(1, 1, 1) };
    shader.uniforms.uPlain = { value: plain };
    mat.userData.uTileRef = shader.uniforms.uTile;
    mat.userData.uLiftRef = shader.uniforms.uLift;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vBld;\nattribute vec3 aBld;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
        vBld = aBld;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${BOX_FRAG}`)
      .replace('#include <map_fragment>', `
        #ifdef USE_MAP
          vec3 bN = normalize( cross( dFdx( vWPos ), dFdy( vWPos ) ) );
          vec2 buv = boxUv( vWPos, bN, uTile, vBld );
          vec3 alb = texture2D( map, buv ).rgb;

          // —— 女儿墙 / 檐口收边：楼顶 0.55 m 压成素色，避免贴图在屋顶被硬切
          float dh = vWPos.y - vBld.y;
          float dTop = vBld.z - vWPos.y;            // 距楼顶的高差
          float isRoofFace = step( max( abs( bN.x ), abs( bN.z ) ), abs( bN.y ) );
          float parapet = ( 1.0 - isRoofFace ) * ( 1.0 - smoothstep( 0.30, 0.60, dTop ) );
          alb = mix( alb, alb * 0.80 + vec3( 0.16, 0.155, 0.145 ), parapet * 0.85 );

          // —— 勒脚：楼底 0.6 m 压深，把楼按在地上
          float plinth = ( 1.0 - isRoofFace ) * ( 1.0 - smoothstep( 0.15, 0.55, dh ) );
          alb = mix( alb, alb * 0.55, plinth * 0.9 );

          // 裸露 albedo 乘上光照后偏暗（砖石线性 albedo 只有 0.1~0.25），
          // 与地形（顶点色已含亮度）并列时建筑会像黑盒子。这里做一次
          // 与参考照片一致的提亮，让砖石在晴天下读成中灰棕而不是深黑。
          diffuseColor.rgb *= min( alb * uLift * uTint, vec3( 1.0 ) );
        #endif
      `);
  };
  // 【坑】cache key 必须带上贴图 tag：three 的 program 缓存以 key 为索引，
  // 同 key 复用程序时不会重新执行 onBeforeCompile，materialProperties.uniforms
  // 就留空 → uTile 拿不到正确值 → UV 变成 0/巨大值，整栋楼采样到贴图的
  // 最暗 mip，全城变成一堆黑盒子。第一版只用了 tile，砖墙/漆面/石材共用
  // 一个 key，就是这个症状。
  const tvv = tv === undefined ? tu : tv;
  mat.customProgramCacheKey = () =>
    `box|${tag}|${tu.toFixed(1)}|${tvv.toFixed(1)}|${lift.toFixed(2)}|${plain}`;
  return mat;
}

// ---------------------------------------------------------------- 立面贴图

let FACADE = null;
let ROOF = null;

/**
 * 立面贴图来自 **AI 生成的建筑立面**（dashscope qwen-image-3.0，
 * 由 tools/terrain/make_aitex.py 裁成「整数开间 × 整数层」并做无缝处理）。
 *
 * 为什么不用程序化 canvas 画窗：
 *   画得再准也只有「一块亮/暗矩形」的信息量，近看是色块，远看是点阵，
 *   这正是用户说的「纸糊」。AI 图里带砖的色差、窗框的厚度、玻璃的天光反射，
 *   是程序化画不出来的。
 *
 * 为什么不用 ambientCG 的 Facade* ：
 *   那几张是「窗样图集」——一张 512 里塞几十个互不相同的窗格小块，
 *   按 30 m 铺到 12 m 高的连排屋上只取到一两格，整面墙变成随机方块马赛克。
 *
 * manifest 里每层有 tile_u_m / tile_v_m，直接就是 shader 的 uTile ——
 * 于是「3 m 一个开间、3.3 m 一层」是物理量，不是像素比例，楼多高都排得对。
 */
async function buildFacades(T) {
  if (FACADE) return FACADE;
  const base = 'assets/aitex/';
  const man = await (await fetch(base + 'manifest.json')).json();
  const loader = new THREE.TextureLoader();
  FACADE = {};

  // 场景里 assignMaterial 用的 7 个 key → aitex 里的层名
  const MAP = {
    brick: 'brick', brick2: 'brick2', paint: 'paint', stone: 'stone',
    conc: 'conc', glass: 'glass', glass2: 'glass',
  };
  // 每类的目标渲染亮度 + 是否玻璃（玻璃要更亮的反射、更低的粗糙度）
  const SPEC = {
    brick: { tgt: 0.50, glassy: false },
    brick2: { tgt: 0.46, glassy: false },
    paint: { tgt: 0.58, glassy: false },
    stone: { tgt: 0.55, glassy: false },
    conc: { tgt: 0.52, glassy: false },
    glass: { tgt: 0.40, glassy: true },
    glass2: { tgt: 0.36, glassy: true },
  };

  for (const [k, layer] of Object.entries(MAP)) {
    const L = man.layers[layer];
    if (!L) throw new Error('aitex 缺层 ' + layer);
    const tex = await loader.loadAsync(base + L.file);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;

    const s = SPEC[k];
    const mean = meanLum(tex.image);
    const lift = Math.min(4.0, Math.max(0.55, Math.pow(s.tgt, 2.2) / LIGHT_GAIN / Math.max(1e-4, mean)));
    FACADE[k] = {
      tex,
      tu: L.tile_u_m,
      tv: L.tile_v_m,
      lift,
      glassy: s.glassy,
    };
  }
  console.log(`[tex] ${Object.keys(FACADE).length} 张 AI 立面（物理尺寸平铺，无缝）`);

  // 屋面：同一次 manifest 里取，四象限镜像过，无缝
  ROOF = {};
  const RSPEC = { roof_gravel: 0.32, roof_slate: 0.26, roof_tile: 0.38 };
  for (const [k, tgt] of Object.entries(RSPEC)) {
    const L = man.layers[k];
    if (!L) continue;
    const tex = await loader.loadAsync(base + L.file);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    const mean = meanLum(tex.image);
    const lift = Math.min(4.0, Math.max(0.55, Math.pow(tgt, 2.2) / LIGHT_GAIN / Math.max(1e-4, mean)));
    ROOF[k] = { tex, tile_m: L.tile_m, lift };
  }
  console.log(`[tex] ${Object.keys(ROOF).length} 张 AI 屋面`);
  return FACADE;
}

/** 预生成立面贴图（main.js 在 loadCityTextures 之后调一次）。 */
export async function prepareFacades(T) {
  await buildFacades(T);
}

/** 立面材质：程序化立面贴图，key ∈ brick|brick2|paint|stone|conc|glass|glass2。 */
export function wallMaterial(T, key, opt = {}) {
  const F = FACADE && FACADE[key];
  if (!F) throw new Error('缺立面 ' + key);
  const glassy = key.startsWith('glass');
  const mat = new THREE.MeshStandardMaterial({
    map: F.tex,
    vertexColors: true,
    roughness: opt.roughness ?? (glassy ? 0.30 : 0.88),
    metalness: opt.metalness ?? (glassy ? 0.30 : 0.02),
    flatShading: true,
    dithering: true,
  });
  return patchBoxProjection(mat, F.tu, F.tv, key, opt.lift ?? F.lift);
}

/**
 * 屋面材质：碎石卷材 / 石板瓦 / 陶瓦，优先用 **AI 生成**的屋面图（aitex），
 * 没有就退回 ambientCG。屋面图是「四象限镜像」得到的，天然无缝，
 * 不需要管裁切位置。
 */
export function roofMaterial(T, key, opt = {}) {
  // 【调色】AI 屋面贴图本身很暗（实测平均亮度：碎石 0.275 / 石板 0.265 /
  // 陶瓦 0.402）。但俯视城市时**屋顶占了画面的大半**，乘上暗贴图整座城
  // 就读成一团炭黑 —— 这是「画面丑」最大的单一来源。
  // 这里不做压暗，而是把三类屋面各自提到目标亮度（乘色分量可以 > 1，
  // three 的 Color 允许），并把陶瓦往灰褐收敛，去掉乡村感。
  const ROOF_GAIN = {
    roof_gravel: [1.95, 1.95, 1.88],
    roof_slate: [1.90, 1.96, 2.02],
    roof_tile: [1.46, 1.40, 1.34],
  };
  const gain = ROOF_GAIN[key] || [1, 1, 1];
  const A = ROOF && ROOF[key];
  const L = A || T[key];
  if (!L) throw new Error('缺贴图 ' + key);
  const mat = new THREE.MeshStandardMaterial({
    map: L.tex,
    // 乘色只影响贴图亮度/色相，几何自带的顶点色仍然生效
    color: new THREE.Color(gain[0], gain[1], gain[2]),
    vertexColors: true,
    roughness: opt.roughness ?? 0.93,
    metalness: opt.metalness ?? 0.0,
    flatShading: true,
    dithering: true,
    // 【双面】坡屋顶/穹顶的绕向只要有一处算错，那个面就会被背面剔除，
    // 从外面看就是一个"洞"，用户看到的是"楼顶看不见"。几何上已经用
    // triUp 强制朝上，但加一道双面保险，代价只是少量 overdraw。
    side: THREE.DoubleSide,
  });
  const tile = A ? A.tile_m : L.tile_m;
  const lift = opt.lift ?? (A ? A.lift : (L.lift ?? 1.0));
  return patchBoxProjection(mat, tile, tile, key, lift);
}

/** 路面 / 步道：几何自带 UV（世界米 / tile），不走盒式投影。 */
/**
 * 地标大理石材质（不用盒式投影、不用窗户 shader）。
 *
 * DC 的国家纪念建筑是素面白石：华盛顿纪念碑是一根没有任何窗的方尖碑，
 * 林肯堂/杰斐逊堂是白石柱廊 + 穹顶。给它们套写字楼立面贴图是最刺眼的错误，
 * 所以这里给一个**纯色 + 轻微世界坐标噪点**的材质，让它们读成白石。
 */
export function marbleMaterial(opt = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: opt.color ?? 0xded8c9,
    vertexColors: true,
    roughness: opt.roughness ?? 0.82,
    metalness: 0.0,
    flatShading: true,
    dithering: true,
    side: THREE.DoubleSide,
  });
  // 极轻的分层色差：真实大理石有横向砌缝，纯色会读成塑料。
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPlane = { value: 3.0 };
    mat.userData.uPlaneRef = shader.uniforms.uPlane;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPosM;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vWPosM = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPosM;\nuniform float uPlane;')
      .replace('#include <map_fragment>', `
        // 横向砌缝：每 uPlane 米一条暗线；再叠一点逐像素微差，避免大面积纯色
        float band = fract( vWPosM.y / uPlane );
        float joint = smoothstep( 0.0, 0.06, band ) * ( 1.0 - smoothstep( 0.94, 1.0, band ) );
        float grain = fract( sin( dot( vWPosM.xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
        vec3 stone = diffuseColor.rgb * ( 0.90 + 0.10 * joint ) * ( 0.96 + 0.04 * grain );
        diffuseColor.rgb = stone;
      `);
  };
  mat.customProgramCacheKey = () => 'marble';
  return mat;
}


/**
 * 由贴图亮度求法线图（Sobel）。
 *
 * 【为什么需要】路面的「像一层纸」不是几何厚度不够（0.18 m 立缘石在 1000 px
 * 的鸟瞰里本来就只有 1~2 px），而是**表面没有起伏信息**：一张 AI 沥青图平贴
 * 在一个完全水平的三角面上，光照是常数，读起来就是一张纸。
 * 立缘石给的是轮廓，法线图给的是表面 —— 两个都要。
 */
export function normalFromTexture(tex, strength = 2.2, S = 512) {
  if (tex.__nrm) return tex.__nrm;
  const img = tex.image;
  if (!img) return null;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, S, S);
  const d = g.getImageData(0, 0, S, S);
  const lum = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) {
    lum[i] = (d.data[i * 4] * 0.299 + d.data[i * 4 + 1] * 0.587 + d.data[i * 4 + 2] * 0.114) / 255;
  }
  const out = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const xm = (x - 1 + S) % S, xp = (x + 1) % S;
      const ym = (y - 1 + S) % S, yp = (y + 1) % S;
      const dx = (lum[y * S + xp] - lum[y * S + xm]) * strength;
      const dy = (lum[yp * S + x] - lum[ym * S + x]) * strength;
      const nx = -dx, ny = -dy, nz = 1;
      const L = Math.hypot(nx, ny, nz);
      const o = (y * S + x) * 4;
      out.data[o] = (nx / L * 0.5 + 0.5) * 255;
      out.data[o + 1] = (ny / L * 0.5 + 0.5) * 255;
      out.data[o + 2] = (nz / L * 0.5 + 0.5) * 255;
      out.data[o + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.copy(tex.repeat || new THREE.Vector2(1, 1));
  t.anisotropy = 4;
  tex.__nrm = t;
  return t;
}

export function roadMaterial(T, key, opt = {}) {
  const L = T[key];
  if (!L) throw new Error('缺贴图 ' + key);
  const mat = new THREE.MeshStandardMaterial({
    map: L.tex,
    // AI 生成的沥青贴图偏浅，直接铺会把车行道渲染成米白水泥地。
    // 用 color 做一次固定的乘法调色（不影响贴图细节）。
    color: opt.color ?? 0xffffff,
    roughness: opt.roughness ?? 0.9,
    metalness: opt.metalness ?? 0.0,
    // 【polygonOffset 别乱抢】路面已经抬在地形上方 0.16 m，够用了。
    // 之前这里用 factor -2 / units -4 把路面整体往镜头拉，结果把贴在路面
    // 上 1.2 cm 的标线整块盖掉（街景里一条车线都看不见）。
    // 现在只给极小的一点，纯为远处深度抖动兜底。
    polygonOffset: opt.polygonOffset !== false,
    polygonOffsetFactor: opt.polygonOffsetFactor ?? 0,
    polygonOffsetUnits: opt.polygonOffsetUnits ?? -1,
    dithering: true,
  });
  // 表面起伏：由底色求法线，路面才有砂砾质感而不是一张纸（strength 可调）。
  const nrm = normalFromTexture(L.tex, opt.nrmStrength ?? 2.2);
  if (nrm) {
    mat.normalMap = nrm;
    mat.normalScale.set(opt.nrmScale ?? 0.75, opt.nrmScale ?? 0.75);
    mat.needsUpdate = true;
  }
  return mat;
}

/**
 * 地形材质：草地/铺装两张图按逐顶点「硬度」混合，再乘下垫面顶点色。
 *
 * 【为什么不直接换贴图】顶点色编码了 landcover（草地绿 / 沥青灰 / 裸土黄），
 * 那是可信的分类结果，不能丢。贴图只补「细节对比度」：
 *     albedo = 顶点色 × (0.42 + 1.25 × 纹理亮度)
 * 整体色调由 landcover 决定，贴图提供砂砾/草叶的明暗颗粒。
 */
export function terrainMaterial(T, opt = {}) {
  const grass = T['grass'], pave = T['pave'];
  if (!grass || !pave) throw new Error('缺地形贴图');
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.0,
    dithering: true,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGrass = { value: grass.tex };
    shader.uniforms.uPave = { value: pave.tex };
    shader.uniforms.uTileG = { value: grass.tile_m };
    shader.uniforms.uTileP = { value: pave.tile_m };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aHard;
        varying vec3 vWPos;
        varying float vHard;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
        vHard = aHard;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos;
        varying float vHard;
        uniform sampler2D uGrass;
        uniform sampler2D uPave;
        uniform float uTileG;
        uniform float uTileP;`)
      .replace('#include <map_fragment>', `
        vec3 gTex = texture2D( uGrass, vWPos.xz / uTileG ).rgb;
        vec3 pTex = texture2D( uPave,  vWPos.xz / uTileP ).rgb;
        vec3 dtl = mix( gTex, pTex, clamp( vHard, 0.0, 1.0 ) );
        // 【硬化面偏暖】pave 贴图本身是暖米黄的石板/砾石，乘以暖阳光后整条
        // 街读成「黄土」。硬化面往冷灰压一档，草地面保持原样（vHard→0 时无影响）。
        dtl = mix( dtl * vec3( 0.74, 0.79, 0.90 ), dtl, 1.0 - clamp( vHard, 0.0, 1.0 ) * 0.88 );
        float lum = dot( dtl, vec3( 0.299, 0.587, 0.114 ) );
        // 只补细节对比度，不整体提亮：地形顶点色本身已经带了 landcover 的明度，
        // 再乘 1.25 会把铺装刷成一片白（第一版就是这样）。
        diffuseColor.rgb *= ( 0.72 + 0.46 * lum );

        // —— 饱和度/对比度调色（2026-10-24 美化）
        // 第一版草地上屏是「米黄沙地」：ACES + 三重光 + 贴图平均亮度偏高，
        // 绿色被压成灰绿。这里按亮度做一次轻度饱和外扩 + 保留细节的 S 曲线，
        // 草地回到绿、铺装保持中性灰，不用改曝光去牺牲建筑层次。
        float l = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
        // 硬化面（vHard→1）是暖调混凝土贴图 × 暖阳光，上屏会整体泛米黄；
        // 这里对硬面降饱和 + 往冷灰拉，和草地的提饱和分开做。
        float sat = mix( 1.42, 0.62, clamp( vHard, 0.0, 1.0 ) );
        diffuseColor.rgb = mix( vec3( l ), diffuseColor.rgb, sat );
        diffuseColor.rgb = mix( diffuseColor.rgb,
          diffuseColor.rgb * vec3( 0.80, 0.86, 0.96 ), clamp( vHard, 0.0, 1.0 ) * 0.75 );
        diffuseColor.rgb = clamp( diffuseColor.rgb, 0.0, 1.0 );
        // 微对比：中灰附近提一点，暗部压一点，读起来不那么「灰蒙蒙」
        diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * diffuseColor.rgb * 1.55, 0.18 );
      `);
  };
  mat.customProgramCacheKey = () => 'terrainTex';
  return mat;
}
