/**
 * flood.js —— 积涝叠层（把 tools/flood/simple_drainage.py 的 L2 帧序列铺到地面上）
 *
 * 数据：assets/flood/manifest.json + fXX.u8（每格 1 字节，0..255 对应 0..scale 米）
 * 交互：按 F 开/关；面板上播放/暂停、拖时间轴。退水过程就是时间轴往后走。
 *
 * 【为什么用 u8 + DataTexture】L2 一轮 60 帧、6 m 一格，f32 是 3.4 MB/帧，
 * 整个序列 200 MB 起；u8 只要 850 KB/帧，肉眼分不出深浅差别（0.02 m 分辨率）。
 */
import * as THREE from 'three';
import { createFlowFeedback } from './flow-feedback.js';

const VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uDepth;
  uniform float uScale;
  uniform float uAlpha;
  uniform float uPow;        // 量化指数：2.0 = 开方量化（新工况），1.0 = 线性（老工况）
  uniform float uLight;      // 环境亮度 0..1：夜里把水一起压暗
  varying vec2 vUv;
  varying vec3 vWorld;

  void main() {
    // 【2026-11-16 按用户反馈改回真实观感】用户指出「感觉全城都要被淹掉了」。
    // 查证：水动力是对的（降雨+下渗+蒸散+管网+入河同时算，体积闭合差 -0.0009%），
    // 峰值湿区只有约 390 ha、占全城约 12.7%，并非全城。问题全在显示阈值：
    // 上一版把 1 cm 的薄水膜也画成接近半透明的水面，于是满街泛蓝、看着像全淹。
    // 现在 3 cm 以下不画，浅水只给很淡的底色，中深水才不透明——显示的才是真正
    // 积起来的水。这只改画面，不改 uDepth 里的水深数值，也不改任何内核计算。
    // 开方量化还原：存的是 sqrt(d/scale)，取 uPow 次方后乘回量程。
    // 老工况的 manifest 没有 quant_pow，uPow 按 1.0 走，行为不变。
    float d = pow(texture2D(uDepth, vUv).r, uPow) * uScale;   // 米
    if (d < 0.03) discard;

    // 3 cm 起淡入到 10 cm，浅水段只给清淡底色（0.22），0.3 m 以上才到全不透明。
    // 这样拖时间轴时真正积水的地方依旧明显变化，但薄水膜不再铺满整座城。
    float a = smoothstep(0.03, 0.10, d);
    a *= mix(0.22, 0.92, smoothstep(0.03, 0.35, d)) * uAlpha;

    vec3 shallow = vec3(0.46, 0.66, 0.76);            // 薄水膜：偏蓝的灰青
    vec3 deep    = vec3(0.05, 0.15, 0.30);            // 齐膝深：靛
    vec3 col = mix(shallow, deep, clamp((d - 0.05) / 1.05, 0.0, 1.0));

    // 掠射角高光：水面越平、看得越斜，反光越强（不然就是一块蓝塑料布）
    vec3 V = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 3.0);
    col = mix(col, vec3(0.86, 0.92, 1.00), fres * 0.45);
    float spec = pow(clamp(dot(reflect(-V, vec3(0.0, 1.0, 0.0)),
                          normalize(vec3(0.35, 0.75, 0.25))), 0.0, 1.0), 24.0);
    col += vec3(0.55, 0.62, 0.72) * spec * 0.35;

    // 【跟着日夜走】颜色是硬编码的，不受光照影响。场景一旦按时钟变暗
    // （applyDaylight），水面就成了全场最亮的东西 —— 18:00 那张图上
    // 积水看起来像一片发光的白雪。这里乘一个环境亮度，夜里自然压下去。
    col *= uLight;
    gl_FragColor = vec4(col, a);
  }
`;

export function createFloodLayer(T, { base = '/assets/flood/', fps = 5, dir = null, clock = null,
  fbGain = 1 } = {}) {
  // ?nopreload=1 关掉后台整档预取（弱网/移动端调试用，功能不受影响，只是
  // 首次问未来时刻会先拿到近似值）。
  const QS_NOPRELOAD = typeof location !== 'undefined'
    && /[?&]nopreload=1/.test(location.search);

  const group = new THREE.Group();
  group.name = 'flood';
  group.visible = false;

  let man = null, mesh = null, tex = null, mat = null;
  const cache = new Map();        // file -> Uint8Array
  // 【2026-11-20 流速】每帧多两张 u8：流速大小（开方量化，量程见 manifest.velocity）
  // 与流向。只在有人真的踩进水里时才取，干格不下这个下载。
  const cacheV = new Map();       // file -> Uint8Array 流速
  const cacheG = new Map();       // file -> Uint8Array 流向
  let idx = 0, playing = false, acc = 0;
  // 【统一时钟】传了 clock 就由城市时钟选帧，本层不再自己播。
  // clockMin 是时钟当前分钟；tMin / raining / HUD 都读它，行人 LDT 才和人同步。
  let clockMin = null;
  let playFps = fps;              // 每工况自适应：总时长压到 ~6 s，长短工况手感一致
  let curDir = dir || '';         // 当前工况子目录（'' = assets/flood 根）
  let gen = 0;                    // 工况世代号：换工况 +1，用来丢弃在飞的旧请求
  let frameSeq = 0;               // 帧请求序号：只让最新那个 showFrame 落地
  let pendingIdx = -1;            // 正在取的那一帧（防止每帧重复发同一个请求）

  // ---- 双向耦合：人车写回来的人流扰动场 ----
  const fb = createFlowFeedback({ gain: fbGain });
  // 基准帧字节（文件里的原样）与「显示用」缓冲（基准 + 回写）。两张分开，
  // 回写格退出活跃时必须能干净地退回基准值，否则扰动会永久糊在水面上。
  let baseData = null;            // 当前帧的原始 u8
  let visData = null;             // 真正送进纹理的那一份
  let painted = [];               // 上一轮被回写覆盖过的格，重画前要还回去
  let lut = null;                 // 0..255 → 米 的查表（避免每次采样做 pow）
  let invQp = 1;                  // 量化指数的倒数，写回 u8 时用
  let lastPaint = 0;


  // ---------------------------------------------------------------- 布局
  async function load(which) {
    if (which === undefined) which = curDir;
    curDir = which || '';
    gen++;
    pendingIdx = -1;              // 换工况：上一套在飞的帧请求作废
    const root = base + (curDir ? curDir.replace(/\/?$/, '/') : '');
    const res = await fetch(root + 'manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('没有积水数据：' + res.status);
    // 【修 2026-11-17】res.json() 对损坏文件 / 拦截页会抛 SyntaxError，
    // 原先没有捕获，整个 load() 静默失败；frames 为空数组时后面
    // man.frames.length - 1 = -1，showFrame 会读到 undefined 帧。
    let parsed;
    try { parsed = await res.json(); } catch (e) {
      throw new Error('积水 manifest 不是有效 JSON：' + (e && e.message));
    }
    if (!parsed || !Array.isArray(parsed.frames) || parsed.frames.length === 0) {
      throw new Error('积水 manifest 没有帧记录：' + curDir);
    }
    if (!Number.isFinite(Number(parsed.cols)) || !Number.isFinite(Number(parsed.rows))
      || !Number.isFinite(Number(parsed.step_m)) || Number(parsed.step_m) <= 0) {
      throw new Error('积水 manifest 的栅格参数无效：' + curDir);
    }
    man = parsed;
    man.root = root;
    cache.clear();
    cacheV.clear(); cacheG.clear();
    _bt = NaN; _br = null;        // 换工况：帧表变了，夹帧记忆作废
    // 【统一 24h】时钟量程和降雨窗口都由这一套工况的 manifest 决定，
    // 不再写死 52–360。切档位时 clock.minute 会被夹进新量程并广播重放。
    if (clock && clock.configure) {
      clock.configure({
        start: 0,
        end: Number(man.day_minutes) || 1440,
        rainStart: Number(man.rain_start_min ?? 1020),
        rainEnd: Number(man.rain_end_min ?? man.rain_min ?? 1140),
      });
    }
    // 播放速度自适应：16 帧的 72 h 工况若按 5 帧/秒播，3.2 s 就从 0 滑到 5310 min，
    // 太快看不清；统一压到约 6 s 一遍（帧少就慢一点，帧多就快一点）。
    playFps = Math.min(12, Math.max(2, man.frames.length / 6));
    // 换工况时几何参数可能不同（格距/原点），整层重建最省心
    if (mesh) { group.remove(mesh); mesh.geometry.dispose(); mat.dispose(); tex.dispose(); }
    const { cols, rows, step_m: step, x0, z0 } = man;
    const half = step * 0.5;

    // 顶点：每格中心取地形高程 + 0.12 m（贴地但不 z-fight）
    const pos = new Float32Array(cols * rows * 3);
    const uv = new Float32Array(cols * rows * 2);
    let o = 0, u = 0;
    for (let r = 0; r < rows; r++) {
      const z = z0 + r * step + half;
      for (let c = 0; c < cols; c++) {
        const x = x0 + c * step + half;
        pos[o++] = x; pos[o++] = (T ? T.sampleHeight(x, z) : 0) + 0.12; pos[o++] = z;
        uv[u++] = (c + 0.5) / cols; uv[u++] = (r + 0.5) / rows;
      }
    }
    const n = cols * rows;
    const idxArr = new Uint32Array((cols - 1) * (rows - 1) * 6);
    let k = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
        idxArr[k++] = a; idxArr[k++] = d; idxArr[k++] = b;
        idxArr[k++] = b; idxArr[k++] = d; idxArr[k++] = e;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idxArr, 1));
    g.computeBoundingSphere();

    tex = new THREE.DataTexture(new Uint8Array(n), cols, rows, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;

    // ---- 量化查表 + 回写场挂到同一张栅格 ----
    // 每次采样做 Math.pow 太贵（行人每帧要取上千次），先把 256 个档位算成米。
    const qp = man.quant_pow || 1.0;
    invQp = 1 / qp;
    lut = new Float32Array(256);
    for (let b = 0; b < 256; b++) lut[b] = Math.pow(b / 255, qp) * (man.scale || 2);
    fb.attach(man);
    // 换工况：上一档的人流扰动不能留到新档（雨强都变了，谁踩过谁没踩过没意义）
    fb.reset();
    baseData = null;
    visData = new Uint8Array(n);
    painted = [];

    mat = new THREE.ShaderMaterial({
      uniforms: { uDepth: { value: tex }, uScale: { value: man.scale || 2 },
                  uAlpha: { value: 1.0 },
    uLight: { value: 1.0 }, uPow: { value: man.quant_pow || 1.0 } },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    group.add(mesh);
    await showFrame(0);
    preloadAll();
    return man;
  }

  /**
   * 后台把这一档 23 帧全部拉进缓存（约 11 MB）。
   * 【为什么值得】时间维一旦真的被用起来，决策层会问「我 20 分钟后走到那儿
   * 有多深」，那是另一帧。只有当前帧在内存里时，bytesOf 只能退回近似值 ——
   * 第一问必然不准（实测问 1140 拿到 4.0 m，真实 1.4 m）。
   * 串行拉，不抢主线程；换工况（gen 变）立刻停手。
   */
  async function preloadAll() {
    if (QS_NOPRELOAD) return;
    const g = gen, myMan = man;
    for (let i = 0; i < myMan.frames.length; i++) {
      if (g !== gen || myMan !== man) return;
      try { await frameBytes(myMan.frames[i]); } catch (e) { return; }
    }
  }

  // 【坑】缓存键必须是「工况目录 + 文件名」，不能只用 f.file ——
  // 五个工况的帧文件都叫 f00.u8/f01.u8…，只用文件名时换工况会命中上一个
  // 工况的同名帧，于是「切到 72 h」看到的还是 2 h 的水。另外 load() 里
  // cache.clear() 也拦不住「切换瞬间已经在飞的旧请求」：它们 await 回来
  // 之后照样 cache.set(旧键)。带上目录前缀后，旧请求落进的是旧键，无害。
  const ckey = (d, f) => d + '|' + f;
  async function frameBytes(f) {
    if (!f || typeof f.file !== 'string') throw new Error('水深帧记录缺少 file 字段');
    const k = ckey(curDir, f.file);
    if (cache.has(k)) return cache.get(k);
    const root = man.root;
    const r = await fetch(root + f.file, { cache: 'no-cache' });
    // 【修 2026-11-17】404 / 错误页不会 reject，arrayBuffer() 会正常返回一段
    // HTML，被当成水深帧缓存起来，之后所有采样读到的是网页字节而不是水深。
    if (!r.ok) throw new Error(`水深帧 ${f.file} 读取失败：HTTP ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length === 0) throw new Error(`水深帧 ${f.file} 是空文件`);
    cache.set(k, buf);
    // 【2026-11-20】水深到了顺手把同一帧的流速/流向也踢进后台。
    // 不这么做，决策层第一次问流速时拿到的是「还没下载完」的 0 —— 那等于把
    // 急流当成静水，冲走判据静默失效。preloadAll 会把整档都预热掉。
    wantKind(f, 'vel'); wantKind(f, 'dir');
    return buf;
  }

  /**
   * 取第 i 帧的流速 / 流向图。旧工况（没有 vel 帧）一律返回 null，
   * 采样侧据此记 0 —— 不许编一个速度出来。
   */
  const wantingV = new Set();
  function bytesOfKind(i, kind) {
    const f = man && man.frames[i];
    if (!f || typeof f[kind] !== 'string') return null;
    const map = kind === 'vel' ? cacheV : cacheG;
    const k = ckey(curDir, f[kind]);
    const b = map.get(k);
    if (b) return b;
    // 和 bytesOf 同一个思路：宁可用邻帧，也不能把「有流速」说成「没流速」。
    for (let d = 1; d <= 4; d++) {
      for (const j of [i - d, i + d]) {
        const g = man.frames[j];
        if (!g || typeof g[kind] !== 'string') continue;
        const nb = map.get(ckey(curDir, g[kind]));
        if (nb) { wantKind(f, kind); return nb; }
      }
    }
    wantKind(f, kind);
    return null;
  }
  function wantKind(f, kind) {
    const file = f && f[kind];
    if (!file || wantingV.has(file)) return;
    wantingV.add(file);
    const map = kind === 'vel' ? cacheV : cacheG;
    fetch(man.root + file, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((ab) => {
        if (!ab) return;
        const u = new Uint8Array(ab);
        if (u.length) map.set(ckey(curDir, file), u);
      })
      .catch(() => {})
      .finally(() => wantingV.delete(file));
  }

  // ---------------------------------------------------------------- 采样
  // 【时间维】旧版 depthAt(x, z) 只读「纹理里现在这一帧」，于是：
  //   · 帧间隔 20 min，人在两帧之间走，脚底下的水是阶梯跳变的；
  //   · 更致命的是决策层早就把 t 传进来了（Brain.perceive → depthAt(x,z,tMin)），
  //     却被 wrapper 吞掉 —— 「20 分钟后我到那儿有多深」这个问题根本没法回答，
  //     所谓的时间维等于不存在。
  // 现在：t 是**一天分钟**（0=00:00）。空间双线性 + 帧间线性插值，取任意时刻。
  // 故事脚本内部用的是「相对分钟」，wrapper 负责加 STORY_OFFSET 换算，见 people.js。

  /** 当前时刻（一天分钟）。没有时钟时退回当前帧的 t_min。 */
  function curMinute() {
    if (clock) return clockMin ?? clock.minute;
    return man && man.frames[idx] ? man.frames[idx].t_min : 0;
  }

  /**
   * 找出夹住 t 的两帧（t_min 升序，二分）。
   * 【为什么带记忆】行人每秒要采样上千次，而绝大多数调用的 t 是同一个
   * 「此刻」。每次重跑二分 + 重算小数位是纯浪费（实测占 depthAt 的近一半）。
   * 只记最近一次，够用且没有失效风险（换工况时置空，见 load()）。
   */
  let _bt = NaN, _br = null;
  function bracket(t) {
    if (t === _bt && _br) return _br;
    const fr = man.frames;
    if (!fr.length) return { i0: 0, i1: 0, f: 0 };
    // 【修 2026-11-17】t 为 NaN/Infinity 时所有比较为 false，二分会落到第 0
    // 帧并算出 NaN 的插值权重 f，进一步把采样水深污染成 NaN。
    const tt = Number(t);
    if (!Number.isFinite(tt)) return { i0: 0, i1: 0, f: 0 };
    const hi0 = fr.length - 1;
    let out;
    if (tt <= fr[0].t_min) out = { i0: 0, i1: 0, f: 0 };
    else if (tt >= fr[hi0].t_min) out = { i0: hi0, i1: hi0, f: 0 };
    else {
      let lo = 0, hi = hi0;
      while (lo < hi) {
        const m = (lo + hi + 1) >> 1;
        if (fr[m].t_min <= tt) lo = m; else hi = m - 1;
      }
      const i1 = Math.min(hi0, lo + 1);
      const span = fr[i1].t_min - fr[lo].t_min;
      out = { i0: lo, i1, f: span > 1e-6 ? (tt - fr[lo].t_min) / span : 0 };
    }
    _bt = t; _br = out;
    return out;
  }

  /** 取第 i 帧的 u8 字节（绝不阻塞采样）。 */
  function bytesOf(i) {
    const f = man && man.frames[i];
    if (!f) return null;
    // 缓存键挂在帧对象上：ckey 是字符串拼接，每次采样拼 8 遍是热路径上的浪费
    const k = f._ck || (f._ck = ckey(curDir, f.file));
    const b = cache.get(k);
    if (b) return b;
    if (i === idx && baseData) return baseData;
    // 【宁可用邻帧，也不能回答「没水」】决策层问「20 分钟后我走到那儿多深」时，
    // 那一帧可能还没下载。旧实现直接返回 0，等于告诉所有人「前面是干的」，
    // 人会一头走进 4 m 深的水里。这里退回最近的已缓存帧，并顺手把它补上，
    // 第二次问就是准的。帧一共 23 张 × 478 KB，全缓存也只有 11 MB。
    for (let d = 1; d <= 4; d++) {
      for (const j of [i - d, i + d]) {
        const g = man.frames[j];
        if (!g) continue;
        const nb = cache.get(ckey(curDir, g.file));
        if (nb) { wantFrame(f); return nb; }
      }
    }
    wantFrame(f);
    // 最后一层兜底：连邻帧都没有就拿「此刻」这一帧顶着。
    // 时间上可能差一帧，但至少不会把深水说成干的。
    return baseData || null;
  }

  /** 后台补帧：同一张只发一次请求，失败就算了。 */
  const wanting = new Set();
  function wantFrame(f) {
    if (!f || wanting.has(f.file)) return;
    wanting.add(f.file);
    frameBytes(f).catch(() => {}).finally(() => wanting.delete(f.file));
  }

  /** 单格在时刻 t 的 u8 值（0..255 浮点）。没有可用帧时返回 -1。 */
  function u8AtCell(i, t) {
    if (!Number.isFinite(i) || i < 0) return -1;
    const { i0, i1, f } = bracket(t);
    const b0 = bytesOf(i0);
    if (!b0 || i >= b0.length) return -1;
    if (i1 === i0 || f <= 1e-4) return b0[i];
    const b1 = bytesOf(i1);
    if (!b1 || i >= b1.length) return b0[i];
    return b0[i] + (b1[i] - b0[i]) * f;
  }

  /**
   * 流速采样（m/s + x/z 分量）。复用与水深相同的「空间双线性 + 帧间线性」，
   * 但先把角度换成向量再插值 —— 直接插值角度会在 0/2π 接缝上算出反向流。
   * 所有角点都是干格（没有流速）时返回 0。
   */
  const _fl = { sp: 0, ux: 0, uz: 0 };
  function sampleFlow(x, z, t, out) {
    out = out || _fl;
    out.sp = 0; out.ux = 0; out.uz = 0;
    if (!man || !Array.isArray(man.frames)) return out;
    const vel = man.velocity;
    if (!vel || !(vel.speed_scale_mps > 0)) return out;
    const { cols, rows, step_m: step, x0, z0 } = man;
    const px = Number(x), pz = Number(z);
    if (!Number.isFinite(px) || !Number.isFinite(pz) || !(step > 0)) return out;
    const fx = (px - x0) / step - 0.5;
    const fz = (pz - z0) / step - 0.5;
    if (!(fx >= -1) || !(fz >= -1) || fx > cols || fz > rows) return out;
    // 【修 2026-11-20】t 省略时用「此刻」。不能把 undefined 直接喂 bracket：
    // Number(undefined)=NaN，bracket 会退到第 0 帧（开局全干），逐人采样就
    // 永远读到 sp=0，整条冲走判据静默失效（现场表现就是 peakHr 恒 0）。
    const pt = (t === undefined || t === null || !Number.isFinite(+t)) ? curMinute() : +t;
    let c0 = Math.floor(fx), r0 = Math.floor(fz);
    const tx = fx - c0, tz = fz - r0;
    const c1 = Math.min(cols - 1, c0 + 1), r1 = Math.min(rows - 1, r0 + 1);
    c0 = Math.max(0, Math.min(cols - 1, c0)); r0 = Math.max(0, Math.min(rows - 1, r0));
    const { i0, i1, f } = bracket(pt);
    const v0 = bytesOfKind(i0, 'vel'), g0 = bytesOfKind(i0, 'dir');
    if (!v0 || !g0) return out;
    const blend = i1 !== i0 && f > 1e-4;
    const v1 = blend ? bytesOfKind(i1, 'vel') : null;
    const g1 = blend ? bytesOfKind(i1, 'dir') : null;
    const scale = vel.speed_scale_mps;
    const n = cols * rows;
    let wsum = 0, sumSp = 0, sumUx = 0, sumUz = 0;
    for (let k = 0; k < 4; k++) {
      const c = k & 1 ? c1 : c0, r = k >>> 1 ? r1 : r0;
      const w = (k & 1 ? tx : 1 - tx) * (k >>> 1 ? tz : 1 - tz);
      if (!(w > 0)) continue;
      const i = r * cols + c;
      if (i >= n) continue;
      let sv = v0[i];
      if (v1 && i < v1.length) sv += (v1[i] - sv) * f;
      if (!(sv > 0)) continue;                 // 干格不记流速，权重让给湿格
      let sa = g0[i];
      if (g1 && i < g1.length) sa += (g1[i] - sa) * f;
      const q = sv / 255;
      const sp = scale * q * q;                // 与导出时的开方量化对应
      const ang = (sa / 255) * Math.PI * 2 - Math.PI;
      sumSp += sp * w;
      sumUx += Math.cos(ang) * w;
      sumUz += Math.sin(ang) * w;
      wsum += w;
    }
    if (!(wsum > 1e-9)) return out;
    const sp = sumSp / wsum;
    const mag = Math.hypot(sumUx, sumUz) / wsum;
    out.sp = sp;
    if (mag > 1e-6) {
      out.ux = (sumUx / wsum) / mag * sp;
      out.uz = (sumUz / wsum) / mag * sp;
    }
    return out;
  }

  /** 空间双线性 + 帧间线性，返回米。 */
  const _fbS = { delay: 0, disp: 0, load: 0 };
  const _samp = { d: 0, wet: false, sp: 0, ux: 0, uz: 0 };
  const _cs = [0, 0, 0, 0], _cw = [0, 0, 0, 0];
  function sampleAt(x, z, t) {
    const { cols, rows, step_m: step, x0, z0 } = man;
    // 【修 2026-11-17】NaN 坐标能让所有边界比较为 false，一路算出 NaN 权重，
    // 最后 wsum>1e-9 不成立 → 静静返回 0，把深水说成干地。step=0 会除零。
    const px = Number(x), pz = Number(z);
    if (!Number.isFinite(px) || !Number.isFinite(pz) || !Number.isFinite(step) || step <= 0) return 0;
    const fx = (px - x0) / step - 0.5;
    const fz = (pz - z0) / step - 0.5;
    if (!(fx >= -1) || !(fz >= -1) || fx > cols || fz > rows) return 0;
    let c0 = Math.floor(fx), r0 = Math.floor(fz);
    const tx = fx - c0, tz = fz - r0;
    const c1 = Math.min(cols - 1, c0 + 1), r1 = Math.min(rows - 1, r0 + 1);
    c0 = Math.max(0, Math.min(cols - 1, c0)); r0 = Math.max(0, Math.min(rows - 1, r0));

    const { i0, i1, f } = bracket(t);
    const b0 = bytesOf(i0);
    const b1 = (i1 !== i0 && f > 1e-4) ? bytesOf(i1) : null;
    const n = cols * rows;

    let avg = 0, got = 0;
    for (let k = 0; k < 4; k++) {
      const c = k & 1 ? c1 : c0, r = k >>> 1 ? r1 : r0;
      _cw[k] = (k & 1 ? tx : 1 - tx) * (k >>> 1 ? tz : 1 - tz);
      _cs[k] = NaN;
      const i = r * cols + c;
      if (!b0 || i >= n) continue;
      let v = b0[i];
      if (b1 && i < b1.length) v += (b1[i] - v) * f;   // 帧间插值：20 min 一帧的台阶被抹平
      const vi = v | 0, fv = v - vi;
      _cs[k] = lut[vi] * (1 - fv) + lut[Math.min(255, vi + 1)] * fv;
      avg += _cs[k]; got++;
    }
    if (!got) return 0;
    if (got < 4) {                       // 有角点那帧还没下载到 → 用已取到的均值补，别整片变浅
      avg /= got;
      for (let k = 0; k < 4; k++) if (Number.isNaN(_cs[k])) _cs[k] = avg;
    }
    let acc = 0, wsum = 0;
    for (let k = 0; k < 4; k++) { acc += _cs[k] * _cw[k]; wsum += _cw[k]; }
    return wsum > 1e-9 ? acc / wsum : 0;
  }

  /**
   * 逐点采样水深（米）。
   * @param {number} x world x
   * @param {number} z world z
   * @param {number} [tMin] 一天分钟（0=00:00）。省缺 = 此刻。
   *   【注意】不是「17 点后的分钟数」。故事脚本的相对分钟要先 +STORY_OFFSET。
   */
  function depthAt(x, z, tMin) {
    if (!man || !tex || !tex.image) return 0;
    let t = (tMin === undefined || tMin === null || !Number.isFinite(+tMin)) ? curMinute() : +tMin;
    let add = 0;
    if (fb.ready) {
      const s = fb.sample(x, z, _fbS);
      if (s.delay > 0.01) t -= s.delay;     // ①②③ 合成的退水延滞：往回读更早的时刻
      add = s.disp;                          // 排水体积撑起来的那一点点
    }
    return sampleAt(x, z, t) + add;
  }

  /** 只要「现在」这一帧、只要最近格：给上千人/车做批量涉水统计时的快路径。 */
  function depthNow(x, z) {
    if (!man || !baseData) return 0;
    const { cols, rows, step_m: step, x0, z0 } = man;
    const px = Number(x), pz = Number(z);
    if (!Number.isFinite(px) || !Number.isFinite(pz) || !Number.isFinite(step) || step <= 0) return 0;
    const c = Math.floor((px - x0) / step), r = Math.floor((pz - z0) / step);
    if (c < 0 || c >= cols || r < 0 || r >= rows) return 0;
    const i = r * cols + c;
    const d = baseData[i];
    // lut[undefined] 是 undefined，乘进任何数都会变 NaN。
    const v = lut && Number.isFinite(d) ? lut[d | 0] : 0;
    return Number.isFinite(v) ? v : 0;
  }

  function depthInfo(x, z, out) {
    out = out || _samp;
    const d = depthAt(x, z);
    out.d = d;
    out.wet = d >= 0.12;      // 12 cm 以上行人就当路断了（齐踝）
    // 【2026-11-20 流速】只有脚底真的在水里才取流速：全城上千人每帧都做一次
    // 双线性是白烧 CPU。旧工况没有 vel 帧，sampleFlow 返回 0，行为与改动前一致。
    if (d >= 0.05) {
      sampleFlow(x, z, undefined, _fl);
      out.sp = _fl.sp; out.ux = _fl.ux; out.uz = _fl.uz;
    } else { out.sp = 0; out.ux = 0; out.uz = 0; }
    return out;
  }

  // ---------------------------------------------------------------- 回写重绘
  /** 把活跃格的「延滞后深度 + 壅高」写进显示缓冲，其余格保持基准帧。 */
  function repaint(force) {
    if (!man || !visData || !baseData || !fb.ready) return 0;
    const now = performance.now();
    if (!force && now - lastPaint < 180) return 0;
    lastPaint = now;
    // 先把上一轮涂过的格还回基准值：否则扰动淡出后水面上留着一块洗不掉的补丁
    const had = painted.length;
    for (let k = 0; k < had; k++) {
      const i = painted[k];
      if (i < visData.length) visData[i] = baseData[i];
    }
    painted.length = 0;
    const t = curMinute();
    const scale = man.scale || 2;
    let cnt = 0;
    fb.forEachActive((i, delay, dsp) => {
      if (i >= visData.length) return;
      const u8 = u8AtCell(i, t - delay);
      const h = (u8 < 0 ? lut[baseData[i]] : lut[Math.min(255, Math.max(0, u8 | 0))]) + dsp;
      const q = Math.max(0, Math.min(1, h / scale));
      visData[i] = Math.round(255 * Math.pow(q, invQp));
      painted.push(i);
      cnt++;
    });
    if (cnt > 0 || had > 0) tex.needsUpdate = true;
    return cnt;
  }

  async function showFrame(i) {
    if (!man || !Array.isArray(man.frames) || man.frames.length === 0) return;
    const want = Math.max(0, Math.min(man.frames.length - 1, Number.isFinite(i) ? (i | 0) : 0));
    // 【两个坑，一起治】
    // ① 乱序覆盖：frameBytes 是异步的，预加载 f001 和 seek 的 f005 会同时在飞，
    //    f005 先回来、f001 后回来，idx 就被写回 1 —— 实测「拖到 18:20，画面
    //    还是 17:00 的干地」。
    // ② 自己把自己饿死：showMinute 每帧都调，只要 best !== idx 就再发一次请求，
    //    而序号守卫会把上一次在飞的请求作废 —— 于是永远没有一帧能落地
    //    （实测 idx 卡死在 1，深度采样全 0，看起来像「水没加载」）。
    // 所以：同一帧在飞就不再发（pendingIdx），落地时用序号只认最新的一次。
    if (pendingIdx === want) return;
    pendingIdx = want;
    const seq = ++frameSeq;
    const g = gen, myTex = tex, f = man.frames[want];
    let buf;
    try {
      buf = await frameBytes(f);
    } catch (e) {
      if (pendingIdx === want) pendingIdx = -1;
      console.warn('[flood] 帧读取失败', f && f.file, e && e.message);
      return;
    }
    if (pendingIdx === want) pendingIdx = -1;
    if (seq !== frameSeq) return;
    // 等数据期间换过工况：这张帧属于旧工况，直接丢弃（否则会把旧尺寸的
    // 字节 set 进新纹理，DataTexture 长度不匹配 → 静默错帧/黑屏）
    if (g !== gen || myTex !== tex || !visData || buf.length !== visData.length) return;
    idx = want;
    baseData = buf;
    // 【基准帧和显示帧必须分开】纹理里那一份会被回写改脏，而深度采样要的是
    // 仿真原值。混用会让扰动逐帧累积，最后整片水面漂成墨色。
    visData.set(buf);
    painted = [];
    myTex.image.data = visData;
    myTex.needsUpdate = true;
    repaint(true);
    // 预取上一帧：回写延滞后要读 t-delay（最多 20 min ≈ 一帧），没下过就只能退化
    if (want > 0) frameBytes(man.frames[want - 1]).catch(() => {});
    updateHud();
  }

  /** 子步内只同步仿真分钟，不重绘水面（水面选帧仍每渲染帧末做一次）。
   *  行人的 LDT / 被困判定读 flood.tMin，若只在帧末更新，子步里人和水
   *  就会差一帧；倍率越高差得越明显。 */
  function setClockMin(m) { clockMin = m; }

  /** 统一时钟选帧：挑 t_min <= minute 的最后一帧（和旧 demo 的 syncFlood 同口径）。 */
  function showMinute(m) {
    clockMin = m;
    if (!man) return;
    let best = 0;
    for (let i = 0; i < man.frames.length; i++) {
      if (man.frames[i].t_min <= m + 1e-6) best = i;
      else break;
    }
    if (best !== idx) showFrame(best);
    else { repaint(false); updateHud(); }
  }

  // ---------------------------------------------------------------- HUD
  const hud = {
    root: null, range: null, label: null, play: null, sel: null, deep: null, dragging: false,
  };
  function updateHud() {
    if (!hud.root || !man) return;
    const f = man.frames[idx];
    const showT = clock ? clock.minute : f.t_min;
    // 【统一】降雨判定只读时钟窗口。旧版文案缺省 60、行人 getter 缺省 120，
    // 两套口径打架，已合并成一个。
    const rain = clock ? clock.raining
      : (showT >= (man.rain_start_min ?? 0) && showT < (man.rain_end_min ?? man.rain_min ?? 120));
    if (hud.label) {
      const hh = String(Math.floor(showT / 60) % 24).padStart(2, '0');
      const mm = String(Math.floor(showT % 60)).padStart(2, '0');
      const tag = rain ? ' · 降雨中'
        : (showT >= (man.rain_end_min ?? 1140) ? ' · 退水中' : '');
      const txt = `${hh}:${mm}${tag}`;
      if (hud.label._t !== txt) { hud.label._t = txt; hud.label.textContent = txt; }
    }
    if (hud.range) {
      let v;
      if (clock) {
        // 一根滑块贯穿 0:00→24:00（单位是分钟），拖它 = 全城一起跳时刻
        if (hud.range.min !== String(clock.start)) hud.range.min = clock.start;
        if (hud.range.max !== String(clock.end)) hud.range.max = clock.end;
        if (hud.range.step !== '1') hud.range.step = 1;
        v = Math.round(clock.minute);
      } else {
        hud.range.max = man.frames.length - 1;
        v = idx;
      }
      // 【别每帧无条件写 value】赋值会打断拖动：用户正拖到 900，下一帧时钟还是
      // 890，滑块被拽回去，手感像「拖不动」。只在真的不同且用户没在拖时写。
      if (String(v) !== hud.range.value && !hud.dragging) hud.range.value = v;
    }
    if (hud.play) {
      const t = (clock ? clock.playing : playing) ? '暂停' : '播放';
      if (hud.play._t !== t) { hud.play._t = t; hud.play.textContent = t; }
    }
    if (hud.deep) hud.deep.textContent = `深 ${(man.scale || 2).toFixed(0)} m+`;
  }

  function bindHud() {
    // 【统一栏目】优先绑到新的 #control 面板；老 #flood 面板留作兼容，
    // 但不再有第二根独立时间轴（两根滑块量程不一致是旧 bug）。
    hud.root = document.getElementById('control') || document.getElementById('flood');
    if (!hud.root) return;
    hud.range = document.getElementById('ctlTime') || hud.root.querySelector('#flRange');
    // 【不要在统一面板上写 #ctlClock】control.js 每 250 ms 也往那里写 "HH:MM"，
    // 本层再写 "HH:MM · 降雨中"，两个写者以不同频率互相覆盖 → 时分秒在闪烁。
    // 新面板的相位由 #ctlPhase 负责，这里只服务已退役的旧面板。
    hud.label = hud.root.querySelector('#flTime');
    hud.play = document.getElementById('ctlPlay') || hud.root.querySelector('#flPlay');
    hud.sel = hud.root.querySelector('#flCase');
    hud.deep = hud.root.querySelector('#flDeep');
    if (hud.range) {
      hud.range.addEventListener('pointerdown', () => { hud.dragging = true; });
      // 松手可能落在窗口外/被别的元素抢走，pointerup 收不到时滑块会被永久
      // 冻结（hud.dragging 卡在 true，时钟再走也不动滑块）。多加两条退路。
      const release = () => { hud.dragging = false; };
      addEventListener('pointerup', release);
      addEventListener('pointercancel', release);
      addEventListener('blur', release);
      hud.range.addEventListener('input', () => {
        playing = false;
        if (clock) clock.seek(Number(hud.range.value));   // 全城一起重放到这一分钟
        else showFrame(Number(hud.range.value));
      });
    }
    if (hud.play) hud.play.addEventListener('click', () => {
      if (clock) { clock.togglePlay(); updateHud(); }
      else togglePlay();
    });
    const close = hud.root.querySelector('#flClose');
    if (close) close.addEventListener('click', () => setVisible(false));
    if (hud.sel) {
      hud.sel.addEventListener('change', () => {
        setCase(hud.sel.value).catch((e) => console.warn('[flood] 换工况失败：', e && e.message));
      });
    }
  }

  /** 换工况：保留当前时刻（调雨强/增水时画面不跳回 0 点）。 */
  async function setCase(which) {
    await load(which);
    playing = false;
    if (clock) showMinute(clock.minute);
    else await showFrame(0);
    updateHud();
    return man.frames.length;
  }

  // ---------------------------------------------------------------- 参数矩阵
  // 统一面板的「左雨强档 / 右加水档」→ 预计算工况。全部由同一个内核跑出，
  // 只是 p_mm_h 与 surge_m 不同，所以切档 = 立刻换帧，不需要浏览器重算水动力。
  let index = null;
  async function loadIndex() {
    if (index) return index;
    try {
      const r = await fetch(base + 'unified_index.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error(String(r.status));
      index = await r.json();
    } catch (e) {
      console.warn('[flood] 统一工况索引未加载：', e && e.message);
      index = { rain_tiers: [], surge_tiers: [], cases: [] };
    }
    return index;
  }
  function caseFor(p, s) {
    if (!index || !index.cases.length) return null;
    const near = (arr, v) => arr.reduce((a, b) =>
      Math.abs(b - v) < Math.abs(a - v) ? b : a, arr[0] ?? v);
    const target = `u_p${near(index.rain_tiers, p)}_s${near(index.surge_tiers, s)}`;
    return index.cases.find((c) => c.name === target)
      || index.cases.find((c) => Math.abs(c.p_mm_h - p) < 1e-6
        && Math.abs(c.surge_m - s) < 1e-6) || null;
  }
  /** 面板调参入口：找最接近的预计算档位并换帧，返回实际档位。 */
  async function setParams(p, s) {
    await loadIndex();
    const c = caseFor(p, s);
    if (c && c.name !== curDir) await setCase(c.name);
    return c;
  }

  function togglePlay() {
    playing = !playing;
    // 【修 2026-11-17】未加载完就点播放时 man 还是 null，原先直接抛错。
    if (playing && man && Array.isArray(man.frames)
      && idx >= man.frames.length - 1) showFrame(0);
    updateHud();
  }

  function setVisible(v) {
    group.visible = v;
    // 新统一面板是常驻控制条，不随水面显隐；只有老的 #flood 面板跟着开关。
    if (hud.root && hud.root.id === 'flood') hud.root.style.display = v ? 'block' : 'none';
    if (v && man) updateHud();   // 别再把分钟滑块量程覆写成帧号
  }

  function toggle() {
    if (!man) return;               // 数据还没加载完
    setVisible(!group.visible);
    // 统一时钟模式下 F 键只是「显示/隐藏水面」，不再重置或抢时间轴
    if (!clock) {
      if (group.visible) { idx = 0; playing = true; showFrame(0); }
      else playing = false;
    }
    updateHud();
  }

  // 独立 rAF：不受主循环改动影响
  let last = performance.now();
  function tick(now) {
    // 【坑】这里不能像主循环那样把 dt 钳到 0.1 s：软渲染/低帧率时（<10 fps）
    // 每帧只累加 0.1 s，时间轴就爬不动，连点 3 秒一帧都不前进。播放头应该跟
    // 真实墙钟走，只防「切到别的标签页回来一次跳几十帧」，上限放到 0.5 s。
    const dt = Math.min(0.5, (now - last) / 1000);
    last = now;
    if (!clock && playing && man && man.frames.length > 1) {
      acc += dt;
      const stepT = 1 / playFps;
      if (acc >= stepT) {
        acc -= stepT;                 // 不是归零：低帧率时把余量留着，别丢时间
        if (idx < man.frames.length - 1) showFrame(idx + 1);
        else { acc = 0; playing = false; updateHud(); }
      }
    }
    requestAnimationFrame(tick);
  }

  return {
    group, load, toggle, setVisible, showFrame, showMinute, setClockMin, bindHud, setCase,
    depthAt, depthInfo, depthNow,
    // 【2026-11-20】流速口：sampleFlow 是原始采样，speedAt 只给大小。
    sampleFlow,
    speedAt(x, z, tMin) {
      sampleFlow(x, z, tMin, _fl);
      return _fl.sp;
    },
    loadIndex, setParams,
    fb,                                  // 人车写回口（见 flow-feedback.js）
    setGain(v) { fb.gain = v; return fb.gain; },
    /** 环境亮度 0..1（由 main.js 的一天光照曲线给）：夜里把水一起压暗。 */
    setDaylight(v) {
      const x = Math.max(0.12, Math.min(1, Number(v) || 1));
      if (mat && mat.uniforms && mat.uniforms.uLight) mat.uniforms.uLight.value = x;
      return x;
    },
    repaint,
    __dbg() { return { idx, pendingIdx, frameSeq, curMinute: curMinute(), frames: man ? man.frames.length : 0 }; },
    startClock() { requestAnimationFrame(tick); },
    get playing() { return clock ? clock.playing : playing; },
    get frames() { return man ? man.frames.length : 0; },
    get frameIndex() { return idx; },
    get caseName() { return curDir; },
    get manifest() { return man; },
    get index() { return index; },
    /** 当前帧标识（工况名 + 帧号）。行人侧用它判断「该不该重算连通域」。 */
    get frameKey() { return curDir + '|' + idx; },
    /** 当前帧的仿真时刻（分钟）。统一时钟下返回城市时钟的当前分钟，
     *  行人的 LDT / 被困判定读的就是它，所以人和水一定在同一时刻。 */
    get tMin() { return clock ? (clockMin ?? clock.minute) : (man ? (man.frames[idx] ? man.frames[idx].t_min : 0) : 0); },
    /** 24 小时量程与降雨窗口，全部来自当前工况 manifest。 */
    get dayMinutes() { return man ? (man.day_minutes ?? 1440) : 1440; },
    get rainStart() { return man ? (man.rain_start_min ?? 1020) : 1020; },
    get rainEnd() { return man ? (man.rain_end_min ?? man.rain_min ?? 1140) : 1140; },
    get rainMin() { return this.rainEnd; },     // 旧调用兼容
    /** 此刻还在下雨吗（统一读时钟窗口）。 */
    get raining() { return !!man && (clock ? clock.raining : this.tMin < this.rainEnd); },
    /** 当前帧的**原始** u8 深度栅格（给行人做连接域/被困判定，不要拿去改）。
     *  【不能给 tex.image.data】那是显示缓冲，回写格已经被改过，拿它算连通域
     *  等于让「有人走过」把路判成断的。 */
    get depthGrid() {
      if (!man || !baseData) return null;
      return {
        data: baseData, cols: man.cols, rows: man.rows,
        step: man.step_m, x0: man.x0, z0: man.z0, scale: man.scale,
      };
    },
  };
}
