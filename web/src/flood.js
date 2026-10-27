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
  varying vec2 vUv;
  varying vec3 vWorld;

  void main() {
    // 【可见性】阈值放到 1 cm：6 m 格子里只要有一处薄水膜就该露出来，
    // 否则整层积水在城市尺度上几乎看不见（用户反馈"拖进度条几乎没变化"）。
    float d = texture2D(uDepth, vUv).r * uScale;      // 米
    if (d < 0.01) discard;

    // 边缘要软：1 cm~12 cm 之间淡入，否则 6 m 栅格会显出方块边
    float a = smoothstep(0.01, 0.12, d);
    // 浅水半透明：只盖住地面颜色；中深水把地面压住
    a *= mix(0.55, 0.95, smoothstep(0.03, 0.45, d)) * uAlpha;

    vec3 shallow = vec3(0.60, 0.74, 0.78);            // 薄水膜：偏天光的灰青
    vec3 deep    = vec3(0.05, 0.15, 0.30);            // 齐膝深：靛
    vec3 col = mix(shallow, deep, clamp((d - 0.05) / 1.05, 0.0, 1.0));

    // 掠射角高光：水面越平、看得越斜，反光越强（不然就是一块蓝塑料布）
    vec3 V = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 3.0);
    col = mix(col, vec3(0.86, 0.92, 1.00), fres * 0.45);
    float spec = pow(clamp(dot(reflect(-V, vec3(0.0, 1.0, 0.0)),
                          normalize(vec3(0.35, 0.75, 0.25))), 0.0, 1.0), 24.0);
    col += vec3(0.55, 0.62, 0.72) * spec * 0.35;

    gl_FragColor = vec4(col, a);
  }
`;

export function createFloodLayer(T, { base = '/assets/flood/', fps = 5, dir = null } = {}) {
  const group = new THREE.Group();
  group.name = 'flood';
  group.visible = false;

  let man = null, mesh = null, tex = null, mat = null;
  const cache = new Map();        // file -> Uint8Array
  let idx = 0, playing = false, acc = 0;
  let playFps = fps;              // 每工况自适应：总时长压到 ~6 s，长短工况手感一致
  let curDir = dir || '';         // 当前工况子目录（'' = assets/flood 根）
  let gen = 0;                    // 工况世代号：换工况 +1，用来丢弃在飞的旧请求

  // ---------------------------------------------------------------- 布局
  async function load(which) {
    if (which === undefined) which = curDir;
    curDir = which || '';
    gen++;
    const root = base + (curDir ? curDir.replace(/\/?$/, '/') : '');
    const res = await fetch(root + 'manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('没有积水数据：' + res.status);
    man = await res.json();
    man.root = root;
    cache.clear();
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

    mat = new THREE.ShaderMaterial({
      uniforms: { uDepth: { value: tex }, uScale: { value: man.scale || 5 }, uAlpha: { value: 1.0 } },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    group.add(mesh);
    await showFrame(0);
    return man;
  }

  // 【坑】缓存键必须是「工况目录 + 文件名」，不能只用 f.file ——
  // 五个工况的帧文件都叫 f00.u8/f01.u8…，只用文件名时换工况会命中上一个
  // 工况的同名帧，于是「切到 72 h」看到的还是 2 h 的水。另外 load() 里
  // cache.clear() 也拦不住「切换瞬间已经在飞的旧请求」：它们 await 回来
  // 之后照样 cache.set(旧键)。带上目录前缀后，旧请求落进的是旧键，无害。
  const ckey = (d, f) => d + '|' + f;
  async function frameBytes(f) {
    const k = ckey(curDir, f.file);
    if (cache.has(k)) return cache.get(k);
    const root = man.root;
    const r = await fetch(root + f.file, { cache: 'no-cache' });
    const buf = new Uint8Array(await r.arrayBuffer());
    cache.set(k, buf);
    return buf;
  }

  /** 逐点采样当前帧水深（米）。给行人避水用；没开叠层/没数据时返回 0。 */
  const _samp = { d: 0, wet: false };
  function depthAt(x, z) {
    if (!man || !tex || !tex.image || !tex.image.data) return 0;
    const { cols, rows, step_m: step, x0, z0, scale } = man;
    const c = Math.floor((x - x0) / step);
    const r = Math.floor((z - z0) / step);
    if (c < 0 || c >= cols || r < 0 || r >= rows) return 0;
    return tex.image.data[r * cols + c] / 255 * (scale || 5);
  }
  function depthInfo(x, z, out) {
    out = out || _samp;
    const d = depthAt(x, z);
    out.d = d;
    out.wet = d >= 0.12;      // 12 cm 以上行人就当路断了（齐踝）
    return out;
  }

  async function showFrame(i) {
    if (!man) return;
    const want = Math.max(0, Math.min(man.frames.length - 1, i | 0));
    const g = gen, myTex = tex, f = man.frames[want];
    const buf = await frameBytes(f);
    // 等数据期间换过工况：这张帧属于旧工况，直接丢弃（否则会把旧尺寸的
    // 字节 set 进新纹理，DataTexture 长度不匹配 → 静默错帧/黑屏）
    if (g !== gen || myTex !== tex) return;
    idx = want;
    myTex.image.data.set(buf);
    myTex.needsUpdate = true;
    updateHud();
  }

  // ---------------------------------------------------------------- HUD
  const hud = {
    root: null, range: null, label: null, play: null, sel: null,
  };
  function updateHud() {
    if (!hud.root || !man) return;
    const f = man.frames[idx];
    const rain = f.t_min <= (man.rain_min ?? 60);
    hud.label.textContent = `t=${f.t_min.toFixed(0)} min${rain ? ' · 降雨中' : ''}`;
    hud.range.max = man.frames.length - 1;
    hud.range.value = idx;
    hud.play.textContent = playing ? '暂停' : '播放';
    // 【坑】下拉框必须跟着 curDir 走：setCase 是程序调用时不会触发 change 事件，
    // 不在这里回写就会出现「已经切到 72 h、框里还显示 2 h」。
    if (hud.sel && hud.sel.value !== curDir) hud.sel.value = curDir;
  }

  function bindHud() {
    hud.root = document.getElementById('flood');
    if (!hud.root) return;
    hud.range = hud.root.querySelector('#flRange');
    hud.label = hud.root.querySelector('#flTime');
    hud.play = hud.root.querySelector('#flPlay');
    hud.sel = hud.root.querySelector('#flCase');
    hud.range.addEventListener('input', () => { playing = false; showFrame(Number(hud.range.value)); });
    hud.play.addEventListener('click', () => togglePlay());
    hud.root.querySelector('#flClose').addEventListener('click', () => setVisible(false));
    if (hud.sel) {
      hud.sel.addEventListener('change', () => {
        setCase(hud.sel.value).catch((e) => console.warn('[flood] 换工况失败：', e && e.message));
      });
    }
  }

  /** 换雨型工况：assets/flood/<dir>/manifest.json。换完停在第一帧并开始播。 */
  async function setCase(which) {
    await load(which);
    idx = 0; playing = false;
    await showFrame(0);
    updateHud();
    return man.frames.length;
  }

  function togglePlay() {
    playing = !playing;
    if (playing && idx >= man.frames.length - 1) showFrame(0);
    updateHud();
  }

  function setVisible(v) {
    group.visible = v;
    if (hud.root) hud.root.style.display = v ? 'block' : 'none';
    if (v && man) { hud.range.max = man.frames.length - 1; updateHud(); }
  }

  function toggle() {
    if (!man) return;               // 数据还没加载完
    setVisible(!group.visible);
    if (group.visible) { idx = 0; playing = true; showFrame(0); }
    else playing = false;
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
    if (playing && man && man.frames.length > 1) {
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
    group, load, toggle, setVisible, showFrame, bindHud, setCase, depthAt, depthInfo,
    startClock() { requestAnimationFrame(tick); },
    get playing() { return playing; },
    get frames() { return man ? man.frames.length : 0; },
    get index() { return idx; },
    get caseName() { return curDir; },
    get manifest() { return man; },
  };
}
