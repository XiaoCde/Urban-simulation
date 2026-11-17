/**
 * light-grid.js —— 全城「灯网」系统（2026-11-08）
 *
 * 【为什么要有这一层】此前夜里只有 2 盏路灯 PointLight + 2 盏室内灯，
 * 358 根灯杆虽然模型在，却只有相机附近 2 个灯头真的照亮地面；建筑窗户
 * 全黑、房间灯全天一个亮度、灯开灯关只按 hemi 强度粗略判。用户原话：
 * 「整个页面太暗了，晚上也没有路灯，半夜也要让人看清你在干什么」。
 *
 * 这一层把「灯」当成一张有时刻表的网，而不是几盏孤立的光源：
 *   ① 时间：dusk→dawn 连续渐亮，雨雾天提前 40 分钟开、延后 30 分钟关；
 *      亮窗率还按「傍晚全城亮 / 深夜只剩零星几户」变化。
 *   ② 路灯：358 个灯头自发光 + 358 片地面渐变光斑（一次 draw call，
 *      全城连成灯列）+ 6 盏动态 PointLight 池（只点相机附近的灯）。
 *   ③ 建筑：立面 shader 逐开间点亮窗户（共享 uniform，零额外 draw call），
 *      全城 2 万栋楼和 MegaKit 49 栋精细楼都参与。
 *   ④ 室内：life-scenes 的灯管/灯箱材质按夜间提亮；5 盏室内灯池按
 *      「相机所在楼 + 此刻有人的楼」分配，白天也补光（进楼不再一片黑）。
 *   ⑤ 信号灯 / 车灯：灯罩自发光强度跟着同一条曲线走。
 *
 * 性能预算：动态光源最多 11 盏；其余全是 instancing / shader，无逐帧遍历。
 */
import * as THREE from 'three';

/** 供 citytex.js / megakit.js 的立面 shader 共享的 uniform 对象。
 *  共享【对象引用】是关键：shader 编译前就能改 .value，不需要等材质编译。 */
export const WINDOW_NIGHT = { value: 0 };      // 0=白天 1=深夜
export const WINDOW_RATIO = { value: 0 };      // 亮窗比例
export const WINDOW_COLOR = new THREE.Color(0xffc27a);  // 暖白钠灯 / 室内白炽

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / Math.max(1e-6, b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * 灯网开关曲线。返回 0..1。
 * 17:40–19:10 渐开，05:30–07:00 渐关；雨雾天提前 40 min 开、延后 30 min 关。
 * 用「两个半天的并集」而不是 daylightLevel：后者是天光强度，暴雨压暗时
 * 会把路灯误开到中午，也会在真正的黄昏还没到就全亮。
 */
export function nightFactor(minute, rain = 0) {
  const m = ((Number(minute) || 0) % 1440 + 1440) % 1440;
  const lead = 40 * clamp(rain, 0, 1), lag = 30 * clamp(rain, 0, 1);
  const dusk = smooth(1060 - lead, 1150 - lead, m);         // 17:40 → 19:10
  const dawn = 1 - smooth(330 - lag, 420 - lag, m);         // 05:30 → 07:00
  const base = Math.max(dusk, dawn);
  // 白天暴雨也稍微开一点（能见度低），但不至于变成夜晚
  return clamp(base + (1 - base) * 0.22 * clamp(rain, 0, 1), 0, 1);
}

/** 亮窗率：傍晚办公/住宅齐亮，深夜只剩零星几户，清晨几乎全灭。 */
function windowRatio(minute) {
  const m = ((Number(minute) || 0) % 1440 + 1440) % 1440;
  if (m < 330) return 0.17;                 // 深夜
  if (m < 420) return 0.08;                 // 起床前
  if (m < 1020) return 0.02;                // 白天（night=0 时也不显示）
  if (m < 1150) return 0.46;                // 下班 / 亮灯高峰
  if (m < 1260) return 0.34;                // 晚间
  return 0.20;                              // 深夜渐灭
}

/** 64×64 径向渐变：灯下地面光斑用，避免硬边圆盘。 */
function glowTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.24, 'rgba(255,255,255,0.72)');
  grd.addColorStop(0.58, 'rgba(255,255,255,0.22)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * @param {object} o
 *  THREE, world, camera, scene
 *  lampPositions  roadprops 回填的灯头坐标（358 根，y 是灯头高度）
 *  lifeGroup      life-scenes 的 group（房间灯材质）
 *  placeCenters   day_full.json 的 places（室内灯池兜底位置）
 */
export function createLightGrid(o = {}) {
  const THREE = o.THREE || globalThis.THREE;
  const world = o.world, camera = o.camera;
  const lamps = o.lampPositions || [];
  const placeCenters = o.placeCenters || {};
  const LAMP_H = 7.2, BULB_DROP = LAMP_H * 0.92;   // 灯头离地 6.624 m

  // ---------------------------------------------------------------- 1) 地面光斑
  // 一片大晕（9.5 m）+ 一片灯下亮核（2.4 m），358×2 个实例，一次 draw call。
  const glowMat = new THREE.MeshBasicMaterial({
    map: glowTexture(), color: 0xffc27e, transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    toneMapped: false,
  });
  const glowGeo = new THREE.CircleGeometry(1, 18);
  glowGeo.rotateX(-Math.PI / 2);
  const glow = new THREE.InstancedMesh(glowGeo, glowMat, Math.max(1, lamps.length * 2));
  glow.name = 'lamp_glow_grid';
  glow.frustumCulled = false;
  glow.renderOrder = 3;
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
  const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
  const groundY = (q) => (Number.isFinite(q.gy) ? q.gy : q.y - BULB_DROP);

  for (let i = 0; i < lamps.length; i++) {
    const q = lamps[i], gy = groundY(q) + 0.14;
    _p.set(q.x, gy, q.z); _s.set(11.0, 1, 11.0);
    glow.setMatrixAt(i * 2, _m.compose(_p, _q, _s));
    _s.set(2.4, 1, 2.4);
    glow.setMatrixAt(i * 2 + 1, _m.compose(_p, _q, _s));
    // 每根灯一点色温差：80% 暖钠灯、20% 冷白 LED，避免全城一个颜色
    const cool = ((i * 2654435761) >>> 0) % 5 === 0;
    _c.setHex(cool ? 0xd8ecff : 0xffc27e);
    glow.setColorAt(i * 2, _c);
    _c.multiplyScalar(1.25);
    glow.setColorAt(i * 2 + 1, _c);
  }
  glow.count = lamps.length * 2;
  glow.instanceMatrix.needsUpdate = true;
  if (glow.instanceColor) glow.instanceColor.needsUpdate = true;
  glow.visible = false;
  if (world) world.add(glow);

  // ---------------------------------------------------------------- 2) 动态路灯池
  // 全开 358 盏 PointLight 会直接拖垮片元着色器；只给相机附近 6 盏真光，
  // 远处靠光斑 + 灯头自发光（视觉上仍是连成一片的灯网）。
  const STREET_N = 6;
  const streetPool = [];
  for (let i = 0; i < STREET_N; i++) {
    const L = new THREE.PointLight(0xffd2a0, 0, 64, 1.7);
    L.visible = false;
    L.name = 'grid_street_light';
    if (world) world.add(L);
    streetPool.push(L);
  }
  let lastPick = -1e9;
  function pickStreet(night) {
    if (!lamps.length || !camera) return;
    const cx = camera.position.x, cz = camera.position.z;
    const best = [];
    for (let i = 0; i < lamps.length; i++) {
      const q = lamps[i];
      const d2 = (q.x - cx) ** 2 + (q.z - cz) ** 2;
      if (d2 > 620 ** 2) continue;         // 全城俯视时不浪费光源
      if (best.length < STREET_N) { best.push({ q, d2 }); best.sort((a, b) => a.d2 - b.d2); }
      else if (d2 < best[best.length - 1].d2) {
        best[best.length - 1] = { q, d2 }; best.sort((a, b) => a.d2 - b.d2);
      }
    }
    for (let i = 0; i < STREET_N; i++) {
      const L = streetPool[i], it = best[i];
      if (!it || night < 0.06) { L.visible = false; L.intensity = 0; continue; }
      L.visible = true;
      L.position.set(it.q.x, it.q.y - 0.5, it.q.z);
      L.intensity = 38 + night * 132;
    }
  }

  // ---------------------------------------------------------------- 3) 室内灯池
  // 相机所在那栋优先，其余给「此刻有人的楼」。白天也留 55 的基础亮度，
  // 否则镜头一进楼就是纯黑（用户上一轮「进去看不清」）。
  const INDOOR_N = 5;
  const indoorPool = [];
  for (let i = 0; i < INDOOR_N; i++) {
    const L = new THREE.PointLight(0xffd7a5, 0, 38, 1.7);
    L.visible = false;
    L.name = 'grid_indoor_light';
    L.userData.place = null;
    if (world) world.add(L);
    indoorPool.push(L);
  }
  if (typeof window !== 'undefined') window.__indoorLights = indoorPool;

  function updateIndoor({ night, camPlace, occupied, minute, at, controls }) {
    const wants = [];
    if (camPlace) wants.push(camPlace);
    for (const k of Object.keys(occupied || {})) if (k !== camPlace) wants.push(k);
    for (let i = 0; i < INDOOR_N; i++) {
      const L = indoorPool[i], pl = wants[i];
      if (!pl) { L.visible = false; L.intensity = 0; L.userData.place = null; continue; }
      let x = null, y = null, z = null;
      if (pl === camPlace && controls && controls.target) {
        x = controls.target.x; y = controls.target.y + 3.3; z = controls.target.z;
      } else {
        const v = occupied && occupied[pl];
        const who = v && v.who && v.who[0];
        const q = who && at ? at(who, minute) : null;
        if (q && !q.crisis) { x = q.x; y = q.y + 2.5; z = q.z; }
        else {
          const P = placeCenters[pl];
          if (P) { x = P.x; y = (P.y || 0) + 3.0; z = P.z; }
        }
      }
      if (x === null) { L.visible = false; L.intensity = 0; L.userData.place = null; continue; }
      L.visible = true;
      L.position.set(x, y, z);
      // 旧版 158 candela 把剖面房间的地板/墙打到纯白过曝，家具反而看不见。
      // 白天留 46~68 补光（进楼不再全黑），夜里最多 102，配合房间灯管自发光。
      L.intensity = (pl === camPlace ? 68 : 46) + night * 34;
      L.userData.place = pl;
    }
  }

  // ---------------------------------------------------------------- 4) 材质清单
  // 灯罩 / 灯管 / 广告灯箱：按夜间提亮；白天压一点，避免屋里像开了探照灯。
  const emissiveMats = [];
  const seenMat = new Set();
  const collect = (root, test) => {
    if (!root) return;
    root.traverse((obj) => {
      const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
      for (const mat of mats) {
        if (!mat || seenMat.has(mat.uuid) || !mat.emissive) continue;
        const e = mat.emissive;
        if (!test(obj, mat, e)) continue;
        seenMat.add(mat.uuid);
        emissiveMats.push({ mat, base: Number.isFinite(mat.emissiveIntensity) ? mat.emissiveIntensity : 1,
          kind: test.kind || 'bulb' });
      }
    });
  };
  // roadprops：lamp_bulb / lamp1 / lamp2 / sig_head* 的灯罩
  const isStreetBulb = (obj, mat, e) => {
    const n = obj.name || '';
    return /lamp_bulb|lamp[12]|sig_head/.test(n)
      && (e.r > 0.25 || e.g > 0.2 || e.b > 0.2);
  };
  isStreetBulb.kind = 'street';
  collect(world, isStreetBulb);
  // life-scenes：M.light(0xfff0c0) / M.lampGlow(0xffd27a) 这类暖白灯
  const isRoomLamp = (obj, mat, e) => e.r > 0.55 && e.g > 0.40 && e.b > 0.20
    && (mat.emissiveIntensity || 1) > 0.8;
  isRoomLamp.kind = 'room';
  collect(o.lifeGroup, isRoomLamp);

  // ---------------------------------------------------------------- 5) 每帧更新
  let lastNight = -1;
  function update(opt = {}) {
    const minute = Number(opt.minute) || 0;
    const rain = clamp(Number(opt.rain) || 0, 0, 1);
    const night = nightFactor(minute, rain);
    WINDOW_NIGHT.value = night;
    WINDOW_RATIO.value = windowRatio(minute) * (0.55 + 0.45 * night);

    // 光斑：夜里成片，雨天湿地面再亮一点
    glowMat.opacity = night * (0.40 + 0.16 * rain);
    glow.visible = night > 0.012 && glow.count > 0;

    for (const it of emissiveMats) {
      it.mat.emissiveIntensity = it.kind === 'room'
        ? it.base * (0.62 + 1.35 * night)
        : it.base * (0.22 + 2.05 * night);
    }

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - lastPick > 330 || Math.abs(night - lastNight) > 0.2) {
      lastPick = now; lastNight = night;
      pickStreet(night);
    }
    updateIndoor({
      night, camPlace: opt.camPlace || null, occupied: opt.occupied || {},
      minute, at: opt.at || null, controls: opt.controls || null,
    });
    return night;
  }

  function stats() {
    return {
      lamps: lamps.length, glowQuads: glow.count,
      streetLights: streetPool.filter((L) => L.visible).length,
      indoorLights: indoorPool.filter((L) => L.visible).length,
      emissiveMats: emissiveMats.length,
      night: +WINDOW_NIGHT.value.toFixed(3), ratio: +WINDOW_RATIO.value.toFixed(3),
    };
  }

  if (typeof window !== 'undefined') {
    window.__lightGrid = { update, stats, nightFactor, glow, streetPool, indoorPool };
  }
  return { update, stats, glow, streetPool, indoorPool, nightFactor };
}
