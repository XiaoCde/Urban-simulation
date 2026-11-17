/**
 * rain.js —— 主场景的降雨层（跟着城市时钟走，全天可见）
 *
 * 【为什么现在才加】雨只存在于旧的单人 demo（office-main.js）里，全城页
 * 从头到尾**没有一滴雨**：时间轴写着「降雨中」，画面却是大晴天。用户
 * 2026-11-06 要求「从头到尾都要降雨」，所以这里补一层。
 *
 * 做法：一个**跟着相机的盒子**（默认 110 m 见方 × 40 m 高），里面固定
 * 4000 条竖直雨丝（LineSegments，一次 draw call）。雨丝只在这个盒子里
 * 循环下落，盒子跟着相机走 —— 城市场景里不需要真的在 6 km 范围内下雨，
 * 相机看得到的范围有雨就够了。
 *
 * 强度不是常数：按工具里同一个 `day` 雨型（0:00 弱 → 18:00 峰值 → 夜里
 * 回落）算当前 mm/h，再折算成「可见雨丝比例 + 不透明度 + 下落速度」。
 * 这样时间轴拖到凌晨看到的是毛毛雨，拖到傍晚是瓢泼 —— 和积水曲线同一条。
 */
import * as THREE from 'three';

/** 与 tools/flood/shallow2d.py 的 SHAPE_NODES["day"] 完全一致（u, v）。 */
const DAY_NODES = {
  u: [0.00, 0.08, 0.17, 0.29, 0.42, 0.54, 0.63, 0.71, 0.75, 0.79, 0.85, 0.92, 1.00],
  v: [0.55, 0.40, 0.35, 0.35, 0.45, 0.70, 1.10, 2.20, 3.20, 2.60, 1.40, 0.80, 0.60],
};

/** 雨型均值（归一化用，和内核里 `shape_norm` 同一个意思）。 */
const DAY_MEAN = (() => {
  let s = 0;
  for (let i = 0; i < 200; i++) {
    const u = (i + 0.5) / 200;
    s += interp(u);
  }
  return s / 200;
})();

function interp(u) {
  const { u: U, v: V } = DAY_NODES;
  if (u <= U[0]) return V[0];
  if (u >= U[U.length - 1]) return V[V.length - 1];
  for (let i = 0; i < U.length - 1; i++) {
    if (u <= U[i + 1]) {
      const k = (u - U[i]) / (U[i + 1] - U[i]);
      return V[i] + (V[i + 1] - V[i]) * k;
    }
  }
  return 1;
}

/** 一天中 minute 这一分钟的雨强（mm/h），pAvg = 24 h 平均雨强。 */
export function rainRateAt(minute, pAvg = 8) {
  const u = Math.min(1, Math.max(0, (Number(minute) || 0) / 1440));
  return (Number(pAvg) || 8) * interp(u) / DAY_MEAN;
}

export function createRain({
  scene, camera, count = 4000, span = 110, tall = 40,
  occlude = null,          // (x,y,z) => true 表示这个点在楼实体里，雨丝不画
} = {}) {
  const pos = new Float32Array(count * 6);      // 每条雨丝两个端点
  const seed = new Float32Array(count * 4);     // x, y, z, 速度
  for (let i = 0; i < count; i++) {
    const a = i * 4;
    seed[a] = (Math.random() - 0.5) * span;
    seed[a + 1] = Math.random() * tall;
    seed[a + 2] = (Math.random() - 0.5) * span;
    seed[a + 3] = 13 + Math.random() * 7;       // m/s
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const mat = new THREE.LineBasicMaterial({
    color: 0xcfe0f2, transparent: true, opacity: 0.34,
    depthWrite: false, blending: THREE.NormalBlending,
  });
  const mesh = new THREE.LineSegments(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;                          // 压在水面之上
  mesh.visible = false;
  scene.add(mesh);

  let intensity = 0;        // 0..1
  let rate = 0;             // mm/h
  let draw = 0;             // 当前参与绘制的雨丝数
  let t = 0;
  let off = false;                                     // 手动关掉（?norain=1）

  /**
   * @param {number} dt 真实秒（雨是观感，不跟仿真倍速，否则 24× 时像白幕）
   * @param {number} mmH 当前雨强 mm/h
   */
  function update(dt, mmH) {
    rate = mmH;
    // 2 mm/h 起可见、40 mm/h 满档（day 雨型峰值 ≈ 2.9 × 平均，8 mm/h 档约 23 mm/h）
    intensity = Math.min(1, Math.max(0, (mmH - 1.5) / 38));
    // 【室内不降雨】2026-11-07 用户：剖切看楼里的时候雨丝照样往室内落。
    // 只做逐条遮挡：中点落在楼实体内部的雨丝收掉，楼顶以上的雨照常下。
    // 不用「相机在楼里就整体关雨」——实测街面低机位只要贴近楼 footprint
    // 就会被误判成室内，镜头一压低整片雨突然消失，比穿模更怪。
    mesh.visible = !off && intensity > 0.02;
    if (!mesh.visible) return;
    t += dt;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const fall = 1 + intensity * 0.8;
    const len = 0.55 + intensity * 0.9;          // 雨丝长度
    draw = Math.max(1, Math.round(count * (0.18 + 0.82 * intensity)));
    for (let i = 0; i < draw; i++) {
      const a = i * 4, o = i * 6;
      // 下落 + 循环：y 在 [0, tall) 里回绕，x/z 固定（盒子跟着相机）
      let y = seed[a + 1] - ((t * seed[a + 3] * fall) % tall);
      if (y < 0) y += tall;
      const x = seed[a], z = seed[a + 2];
      const wx = cx + x, wz = cz + z;
      const wy = cy - tall * 0.45 + y;
      if (occlude && occlude(wx, wy + len * 0.5, wz)) {
        // 楼里的雨丝：收成 0 长度丢到地下，不会在室内穿下来
        pos[o] = pos[o + 3] = wx;
        pos[o + 1] = pos[o + 4] = -9999;
        pos[o + 2] = pos[o + 5] = wz;
        continue;
      }
      pos[o] = wx; pos[o + 1] = wy; pos[o + 2] = wz;
      pos[o + 3] = wx + 0.12;                     // 略微倾斜，看着不是竖棍
      pos[o + 4] = wy + len;
      pos[o + 5] = wz;
    }
    // 剩余的雨丝缩成 0 长度（不画）
    for (let i = draw; i < count; i++) {
      const o = i * 6;
      pos[o] = pos[o + 3] = cx;
      pos[o + 1] = pos[o + 4] = -9999;
      pos[o + 2] = pos[o + 5] = cz;
    }
    geo.attributes.position.needsUpdate = true;
    geo.setDrawRange(0, draw * 2);
    mat.opacity = 0.16 + 0.34 * intensity;
  }

  return {
    mesh, update,
    get intensity() { return intensity; },
    get rate() { return rate; },
    setVisible(v) { off = !v; if (off) mesh.visible = false; },
    get on() { return !off; },
  };
}
