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

export function createFloodLayer(T, { base = '/assets/flood/', fps = 5 } = {}) {
  const group = new THREE.Group();
  group.name = 'flood';
  group.visible = false;

  let man = null, mesh = null, tex = null, mat = null;
  const cache = new Map();        // file -> Uint8Array
  let idx = 0, playing = false, acc = 0;

  // ---------------------------------------------------------------- 布局
  async function load() {
    const res = await fetch(base + 'manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('没有积水数据：' + res.status);
    man = await res.json();
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

  async function frameBytes(f) {
    if (cache.has(f.file)) return cache.get(f.file);
    const r = await fetch(base + f.file);
    const buf = new Uint8Array(await r.arrayBuffer());
    cache.set(f.file, buf);
    return buf;
  }

  async function showFrame(i) {
    if (!man) return;
    idx = Math.max(0, Math.min(man.frames.length - 1, i | 0));
    const f = man.frames[idx];
    const buf = await frameBytes(f);
    tex.image.data.set(buf);
    tex.needsUpdate = true;
    updateHud();
  }

  // ---------------------------------------------------------------- HUD
  const hud = {
    root: null, range: null, label: null, play: null,
  };
  function updateHud() {
    if (!hud.root || !man) return;
    const f = man.frames[idx];
    const rain = f.t_min <= (man.rain_min ?? 60);
    hud.label.textContent = `t=${f.t_min.toFixed(0)} min${rain ? ' · 降雨中' : ''}`;
    hud.range.value = idx;
    hud.play.textContent = playing ? '暂停' : '播放';
  }

  function bindHud() {
    hud.root = document.getElementById('flood');
    if (!hud.root) return;
    hud.range = hud.root.querySelector('#flRange');
    hud.label = hud.root.querySelector('#flTime');
    hud.play = hud.root.querySelector('#flPlay');
    hud.range.addEventListener('input', () => { playing = false; showFrame(Number(hud.range.value)); });
    hud.play.addEventListener('click', () => togglePlay());
    hud.root.querySelector('#flClose').addEventListener('click', () => setVisible(false));
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
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing && man && man.frames.length > 1) {
      acc += dt;
      const stepT = 1 / fps;
      if (acc >= stepT) {
        acc = 0;
        if (idx < man.frames.length - 1) showFrame(idx + 1);
        else { playing = false; updateHud(); }
      }
    }
    requestAnimationFrame(tick);
  }

  return {
    group, load, toggle, setVisible, showFrame, bindHud,
    startClock() { requestAnimationFrame(tick); },
    get playing() { return playing; },
    get frames() { return man ? man.frames.length : 0; },
    get index() { return idx; },
  };
}
