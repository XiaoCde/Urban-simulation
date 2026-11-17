/**
 * people.js — 6 个具名角色：心理状态 + Brain 决策 + 真实动作状态机。
 *
 * 【和上一版的区别】
 *   旧版每帧 `root.position.set(story.position)` 直接赋值、只按 speed>2.2
 *   切 walk/run，其余状态一律 idle —— 用户看到的「所有人平移着运动」。
 *   现在：
 *     1) 位移与动画步频绑定（mixer.timeScale 按真实速度），走慢了腿也慢；
 *     2) 起步/停步/转身/开门/上下楼都有一次性过渡 clip，播完自动回循环；
 *     3) 18 段 clip 按「状态 + 水深 + 紧张度 + 楼层变化」分配，不是 7 段；
 *     4) 心理状态来自 decision.js 的 Brain（感知→信念→候选效用打分），
 *        和马克同一套引擎、不同档案权重，HUD 里能看到紧张/焦虑和决策理由。
 *     5) 室外 y 贴地形、聚焦时剖开对应楼层，人物不再陷进路面或藏在楼板里。
 */
import { dayThink, DAY_THINK_STEP } from './day-think.js';
import { ANIM } from './motion-units.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  CAFE, CLINIC, SCHOOL, SITE,
  buildCafe, buildClinic, buildSchool, buildSite,
} from './district-buildings.js';
import { buildCast, STATE_CN } from './district-cast.js';
import { PROFILES, mulberry32 } from './decision.js';
import { scheduleFor, inCrisis, STORY_OFFSET, placeSpot } from './day-schedule.js';
import { buildStreetGraph, routeOnGraph } from './street-route.js';
import { toDayMin } from './clock.js';

const ROSTER = [
  { key: 'boss', name: '罗伯特·惠特克', role: '公司合伙人', model: '/assets/ped/char_boss.glb', height: 1.99 },
  { key: 'doctor', name: '大卫·帕特尔', role: '外科医生', model: '/assets/ped/char_doctor.glb', height: 1.78 },
  { key: 'worker', name: '路易斯·拉米雷斯', role: '钢筋工', model: '/assets/ped/char_worker.glb', height: 1.79 },
  { key: 'woman', name: '艾米·陈', role: '咖啡馆店员', model: '/assets/ped/char_woman.glb', height: 1.68 },
  { key: 'rider', name: '泰瑞尔·杰克逊', role: '外卖骑手', model: '/assets/ped/char_rider.glb', height: 1.83 },
  { key: 'girl', name: '索菲亚·马丁内斯', role: '小学三年级', model: '/assets/ped/char_girl.glb', height: 1.47 },
];

/** 静止状态 → 姿势。尽量用满 18 段 clip，别让所有人都是同一个 idle。 */
const POSE = {
  working: 'sit', operating: 'idle', class: 'sit', home: 'idle',
  calling: 'look', observing: 'look', blocked: 'look', notice: 'look',
  waiting: 'idle', sheltered: 'idle', sheltering: 'idle', riding: 'idle',
  lining: 'idle', safe: 'idle', idle: 'idle', informed: 'look',
  continuing: 'idle', power: 'idle', closing: 'idle', radio: 'look',
  packing: 'idle', handover: 'look', window: 'look', instructing: 'look',
  texting: 'look', locking: 'idle', walking: 'walk', returning: 'walk',
  indoor: 'walk', outdoor: 'walk', boarding: 'idle', elevator: 'idle',
  arrive: 'idle', parking: 'idle', preparing: 'idle', climbing: 'walk',
  wading: 'walk', evacuating: 'walk', detour: 'walk', escape: 'walk',
  shelter: 'walk', driving: 'idle', carblocked: 'look',
};

/** 一次性动作：播完自动回到循环动作。 */
const ONESHOT = new Set(['start', 'stop', 'run_stop', 'turn180', 'door',
  'stairs_up', 'stairs_down', 'crouch', 'crawl', 'back']);

/**
 * 每段动画「原地循环」对应的真实位移速度（m/s）。
 * clip 是原地动作（root motion 已在导出时拍平），位移由代码给；如果播放速率
 * 不跟位移匹配，脚就会打滑或者像在冰上滑行。
 *   walk 1.033 s / 两步，步幅 0.70 → 1.35
 *   run  0.633 s / 两步，步幅 1.10 → 3.47
 * 用户 2026-11-06：「跑步感觉特别慢」——真正原因有两个：
 *   ① 逻辑速度只有 2.9 m/s（慢跑）；② timeScale 一律用 speed/1.35 算，
 *      跑起来被 clamp 到 1.8，腿比地面快 1.8 倍，看着像原地蹬腿飘过去。
 */
const CLIP_V0 = ANIM.CLIP_V0;

/** 把母版 clip 的轨道前缀换成目标骨架前缀（同一套 Mixamo 骨架，只有编号不同）。 */
function retargetClip(src, fromPrefix, toPrefix, name) {
  const tracks = src.tracks.map((tr) => {
    const t = tr.clone();
    if (fromPrefix && t.name.startsWith(fromPrefix)) {
      t.name = toPrefix + t.name.slice(fromPrefix.length);
    }
    return t;
  });
  return new THREE.AnimationClip(name, src.duration, tracks);
}

function bonePrefix(root) {
  // 【按 Hips 反推前缀】不同批次的模型前缀完全不一样：
  //   马克那套是 `mixamorig7:Hips`（three sanitize 后变成 `mixamorig7_Hips`）
  //   六个具名角色是 `mixamorigHips`（连数字都没有）
  // 所以不能写死正则，直接用「Hips 之前的整段」当前缀，两边都能对上。
  let p = null;
  root.traverse((o) => {
    if (p) return;
    const n = o.name || '';
    const i = n.indexOf('Hips');
    if (i > 0) p = n.slice(0, i);
  });
  return p;
}

function keyCount(clip) {
  let n = 0;
  for (const t of clip.tracks) n += t.times.length;
  return n;
}

/**
 * 这条 clip 有多少比例的轨道真的绑到了模型骨骼上。
 *
 * 【为什么需要】只看关键帧数量是不够的：一条 clip 可能帧数很足，但轨道名里
 * 的骨骼前缀对不上（`mixamorigHips` vs `mixamorig7_Hips`），它就什么也驱动
 * 不了 —— 人物保持绑定姿势，也就是**双臂平举的十字架**。这正是用户报的
 * 「待机像十字架立在那」。所以除了「帧太少」，还要检查「绑不上」。
 */
function bindRatio(clip, names) {
  if (!clip.tracks.length) return 0;
  let ok = 0;
  for (const t of clip.tracks) {
    const n = t.name.split('.')[0];
    if (names.has(n)) ok++;
  }
  return ok / clip.tracks.length;
}

function playLoop(a, name) {
  const act = a.acts[name] || a.acts.idle;
  if (!act || a.cur === act) return;
  act.reset();
  act.setLoop(THREE.LoopRepeat, Infinity);
  act.setEffectiveWeight(1);
  if (a.cur) act.crossFadeFrom(a.cur, 0.18, false);
  act.play();
  a.cur = act;
  // 一次推进让 crossFade 落地，暂停时也不会停在绑定姿势（T-pose）
  a.mixer.update(0.32);
}

/** 触发一个一次性动作；它结束后 syncAll 会切回 loop。 */
function playOnce(a, name) {
  const act = a.acts[name];
  if (!act || a.once === act) return;
  a.once = act;
  a.onceT = 0;
  act.reset();
  act.setLoop(THREE.LoopOnce, 1);
  act.clampWhenFinished = true;
  act.setEffectiveWeight(1);
  act.play();
  a.mixer.update(0.02);
}

/** 按当前真实状态选循环动作。 */
function loopClip(a, s) {
  const acts = a.acts;
  const moving = s.speed > 0.25 && s.path.length;
  if (moving) {
    const wp = s.path[s.pathIndex];
    const stair = wp && (wp.kind === 'stairs' || wp.kind === 'stair');
    // 【方向由楼层变化判定】旧版用 `s.floor >= lastFloorShown ? up : down`，
    // 逐帧比较时 floor 常常还没变，于是从 6F 下楼的人一直在播 stairs_up。
    // 直接看路径下一个点与当前楼层的差，才是真正的上/下楼。
    if (stair) {
      // 直接看下一个路径点的真实高度：低了就是下楼，高了就是上楼。
      const nextY = wp.p ? wp.p.y : s.position.y;
      return nextY < s.position.y - 0.2
        ? (acts.stairs_down ? 'stairs_down' : 'walk')
        : (acts.stairs_up ? 'stairs_up' : 'walk');
    }
    if (s.state === 'wading' || s.depth > 0.28) {
      // 涉水：慢走 + 略微下蹲的变体（有 crouch 就用一次性提示，循环仍用 walk）
      return acts.walk ? 'walk' : 'idle';
    }
    if (s.pathSpeed === 'ride') return acts.sit ? 'sit' : 'idle';
    if (s.speed > 2.2) return acts.run ? 'run' : 'walk';
    return acts.walk ? 'walk' : 'idle';
  }
  // 静止：紧张的人不会呆站，会张望/侧身；女孩会蹲下
  if (s.stress > 0.62 && (s.state === 'blocked' || s.state === 'observing')) {
    return acts.crouch ? 'crouch' : 'look';
  }
  const want = POSE[s.state];
  if (want && acts[want]) return want;
  if (s.stress > 0.45) return acts.look ? 'look' : 'idle';
  return 'idle';
}

export async function createPeople(opt) {
  const {
    world, office, terrain, flood, clock, camera, controls, roadnet, dayMotion = null,
    collide = null,
  } = opt;

  // ---------- 1) 四座精细建筑（室内路线靠它们的 route / start） ----------
  const buildings = {
    cafe: buildCafe(terrain.sampleHeight(CAFE.cx, CAFE.cz)),
    clinic: buildClinic(terrain.sampleHeight(CLINIC.cx, CLINIC.cz)),
    school: buildSchool(terrain.sampleHeight(SCHOOL.cx, SCHOOL.cz)),
  };
  let siteY = -1e9;
  for (let i = -3; i <= 3; i++) for (let j = -4; j <= 4; j++) {
    siteY = Math.max(siteY, terrain.sampleHeight(SITE.cx + i * 2, SITE.cz + j * 2));
  }
  buildings.site = buildSite(siteY + 0.12);
  for (const b of Object.values(buildings)) world.add(b.group);

  // ---------- 2) 路线 + 6 条故事线（每人一份心理档案） ----------
  const districtRoutes = await fetch('/assets/ped/district_routes.json').then((r) => r.json());
  // 【t 必须换算，否则时间维等于没做】Brain 传进来的是「故事相对分钟」（52 =
  // 17:52），而 FLOOD.depthAt 的时间维口径是「一天分钟」（1072 = 17:52）。
  // 旧版 wrapper 直接 (x,z) 把第三个参数吃掉了，于是所有人永远只看当前帧 ——
  // 「我现在出发，20 分钟走到那儿会不会被淹」这个问题根本没法回答。
  const depthAt = (x, z, t) => {
    if (!flood || !flood.depthAt || (flood.group && !flood.group.visible)) return 0;
    const day = (t === undefined || t === null) ? undefined : toDayMin(t);
    return flood.depthAt(x, z, day) || 0;
  };
  // 【脚不要陷进瓦片】新路瓦片顶面比地形高约 0.35 m，6 个具名角色之前
  // 一直用纯地形 y，室外 194 个路线点的人脚都埋在沥青里。现在贴瓦片顶面。
  const groundAt = (x, z) => {
    const base = terrain.sampleHeight(x, z);
    return roadnet && roadnet.surfaceY ? Math.max(base, roadnet.surfaceY(x, z)) : base;
  };
  const stories = buildCast({
    office, clinic: buildings.clinic, school: buildings.school,
    cafe: buildings.cafe, site: buildings.site,
    districtRoutes, depthAt, STATE_CN, groundAt, PROFILES,
    clockMinute: () => clock.minute,
  });

  // ---------- 街道图 + 行程 ----------
  const G = buildStreetGraph(roadnet);

  /** 给某人建一条从 from 到 to 的步行折线（沿街网）。 */
  /** 巡游目标：在站点半径内随机挑一个路网节点（保证沿着路走，不穿楼）。 */
  function pickWanderTarget(a, sch) {
    if (!G) return null;
    const R = sch.wanderR || 26;
    const cx = sch.x, cz = sch.z;
    for (let k = 0; k < 24; k += 1) {
      const n = G.nodes[Math.floor(a.rand() * G.nodes.length)];
      const d = Math.hypot(n.x - cx, n.z - cz);
      if (d > 8 && d < R) return { x: n.x, z: n.z };
    }
    return null;
  }

  function startTrip(a, from, to) {
    const pts = routeOnGraph(G, from.x, from.z, to.x, to.z);
    a.trip = { pts, i: 1, to, left: 0 };
    a.tripLen = 0;
    for (let k = 1; k < pts.length; k++) {
      a.tripLen += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    }
  }

  /**
   * 沿行程往前走 dtSec 秒。返回此刻是否还在路上。
   * 位移与动作由同一个速度驱动，所以脚不会打滑。
   */
  function stepTrip(a, dtSec, speed) {
    const t = a.trip;
    if (!t) return false;
    let rem = Math.max(0, dtSec) * Math.max(0.2, speed);
    let moved = 0;
    while (rem > 1e-4 && t.i < t.pts.length) {
      const [px, pz] = t.pts[t.i];
      const dx = px - a.root.position.x;
      const dz = pz - a.root.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.12) { t.i += 1; continue; }
      const step = Math.min(d, rem);
      a.root.position.x += (dx / d) * step;
      a.root.position.z += (dz / d) * step;
      // 朝行进方向；只在有明显位移时改朝向，避免抖动
      if (step > 0.02) a.root.rotation.y = Math.atan2(dx, dz);
      rem -= step;
      moved += step;
      if (step >= d - 1e-6) t.i += 1;
    }
    a.root.position.y = groundAt(a.root.position.x, a.root.position.z);
    a.tripSpeed = dtSec > 0 ? moved / dtSec : 0;
    a.tripMoved = (a.tripMoved || 0) + moved;
    if (t.i >= t.pts.length) { a.trip = null; return false; }
    return true;
  }

  // ---------- 3) 动作母版 + 雨伞 + 六个具名模型 ----------
  // 【重大 bug】6 个具名模型的 walk 在 glb 里只有 2 个关键帧、时长 0.067 s，
  // 等于是定格 —— 无论怎么调速度，人都是「不迈腿、整体平移」。只有马克那套
  // office_worker.glb 的 walk 是完整的（1.033 s / 32 帧）。两套骨架同源
  // （mixamorig7: vs mixamorig1:），所以直接把母版轨道重定向前缀即可，
  // 不需要回 Blender 重导。
  const loader = new GLTFLoader();
  let masterAnims = {};
  let masterPrefix = null;
  try {
    const g = await loader.loadAsync('/assets/ped/office_worker.glb');
    for (const c of g.animations) masterAnims[c.name] = c;
    masterPrefix = bonePrefix(g.scene);
    console.info(`[people] 动作母版 ${Object.keys(masterAnims).length} 段，前缀 ${masterPrefix}`);
  } catch (e) {
    console.warn('[people] 动作母版未加载', e && e.message);
  }
  // 雨伞由 makeUmbrella() 代码生成（glb 版本在本项目里画不出来，见函数注释）。
  // 车（老板通勤开 SUV）：让「在车里 / 在车外」是真实可见的差别
  let carProto = null;
  try {
    const g = await loader.loadAsync('/assets/props/car_suv.glb');
    carProto = g.scene;
  } catch (e) { console.warn('[people] 车模型未加载', e && e.message); }
  /**
   * 把 glb 的 Scene 拍平成一组独立 Mesh。
   * 【为什么不用 clone】这个伞模型 clone 出来的 Scene 在本项目里始终不显示
   * （几何 drawRange.count=null、物理材质透射、Scene 层嵌套……逐个排完还是不画）。
   * roadprops 里对灯具用的就是「取几何 + 应用世界矩阵 + 自建 Mesh」，那套是能画出来的，
   * 这里直接沿用，一次性绕开所有这些坑。
   */
  function flattenGLTF(scene, colorBias = 1) {
    scene.updateMatrixWorld(true);
    const g = new THREE.Group();
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const geo = o.geometry.clone();
      geo.applyMatrix4(o.matrixWorld);
      geo.drawRange.count = Infinity;      // 原值是 null，渲染器一个顶点都不画
      geo.computeBoundingSphere();
      const old = o.material;
      const c = old && old.color ? old.color.clone() : new THREE.Color(0x8a9099);
      g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: c.multiplyScalar(colorBias),
        roughness: 0.78, metalness: 0.0, side: THREE.DoubleSide,
        emissive: new THREE.Color(c.r * 0.16, c.g * 0.16, c.b * 0.16),
      })));
    });
    return g;
  }
  /**
   * 雨伞（代码生成）。
   * 【为什么不用 classic_umbrella 的 glb】那份模型在本项目里怎么都画不出来：
   * 几何 drawRange.count 是 null、材质是带透射的 MeshPhysicalMaterial、
   * Scene 克隆后世界矩阵不跟父级走 —— 逐个修完仍然只有空气。既然用户要的是
   * 「谁打伞、谁没打伞」这个可读的差别，就自己用半球 + 细杆搭一把，尺寸颜色
   * 完全可控，也一定渲染得出来。
   */
  function makeUmbrella(color, opened) {
    const g = new THREE.Group();
    const cloth = new THREE.MeshStandardMaterial({
      color, roughness: 0.82, metalness: 0.0, side: THREE.DoubleSide,
      emissive: new THREE.Color(color).multiplyScalar(0.22),
    });
    const metal = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.55 });
    if (opened) {
      // 半球压扁当伞面（八片伞骨的感觉靠 flatShading）
      const canopy = new THREE.Mesh(
        new THREE.SphereGeometry(0.62, 12, 5, 0, Math.PI * 2, 0, Math.PI * 0.46),
        new THREE.MeshStandardMaterial({
          color, roughness: 0.82, metalness: 0.0, side: THREE.DoubleSide,
          flatShading: true,
          emissive: new THREE.Color(color).multiplyScalar(0.22),
        }),
      );
      canopy.scale.y = 0.55;
      canopy.position.y = 0.96;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.98, 6), metal);
      pole.position.y = 0.49;
      g.add(canopy, pole);
    } else {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.020, 0.020, 0.92, 6), metal);
      pole.position.y = 0.46;
      const wrap = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.028, 0.46, 6), cloth);
      wrap.position.y = 0.72;
      g.add(pole, wrap);
    }
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    return g;
  }

  /**
   * 每把伞的颜色。
   * 【必须高明度】之前用深灰蓝，在雨夜的沥青/草地上几乎完全同色 ——
   * 伞明明在画（draw call 实测 +4），肉眼却看不到。现在全部改成浅色，
   * 靠色相区分人，靠明度保证在暗背景上一定看得见。
   */
  const UMB_COLOR = {
    mark: 0x9fb6cc, boss: 0xc2c6cf, doctor: 0x8fb3d6,
    woman: 0xd98b98, girl: 0xe8a86e, worker: 0xa9bd97, rider: 0xb0b8c6,
  };

  function makeCar() {
    if (!carProto) return null;
    const c = carProto.clone(true);
    const box = new THREE.Box3().setFromObject(c);
    const sz = box.getSize(new THREE.Vector3());
    c.scale.setScalar(4.85 / Math.max(0.1, sz.x, sz.z));
    c.updateMatrixWorld(true);
    const b2 = new THREE.Box3().setFromObject(c);
    c.userData.yOff = -b2.min.y + 0.02;
    c.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    c.visible = false;
    return c;
  }

  const actors = [];
  let LIVE_PED = null;            // 绑定后，6 个模型只是实时居民的另一种外观
  for (const def of ROSTER) {
    let gltf = null;
    try { gltf = await loader.loadAsync(def.model); }
    catch (e) { console.warn('[people] 模型未加载', def.key, e && e.message); continue; }
    const model = gltf.scene;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const scale = def.height / Math.max(0.1, box.max.y - box.min.y);
    model.scale.setScalar(scale);
    const footFix = -box.min.y * scale;
    model.position.y = footFix;
    const root = new THREE.Group();
    root.name = 'CITY_CAST_' + def.key;
    root.add(model);
    model.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.frustumCulled = false; }
    });
    world.add(root);
    const mixer = new THREE.AnimationMixer(model);
    const acts = {};
    const ownPrefix = bonePrefix(model);
    const fixed = [];
    const bad = [];
    // 模型里真实存在的节点名（判断一条 clip 到底能不能驱动它）
    const names = new Set();
    model.traverse((o) => { if (o.name) names.add(o.name); });
    for (const clip of gltf.animations) {
      let use = clip;
      const m = masterAnims[clip.name];
      let why = null;
      // ① 关键帧密度差 1.5 倍以上 → 这个 clip 被裁坏了
      if (m && ownPrefix && masterPrefix && keyCount(m) > keyCount(clip) * 1.5) why = '帧太少';
      // ② 半数以上轨道绑不到骨骼 → 播了也等于没播（十字架）
      else if (bindRatio(clip, names) < 0.5) why = `绑不上(${(bindRatio(clip, names) * 100) | 0}%)`;
      if (why && m && ownPrefix && masterPrefix) {
        use = retargetClip(m, masterPrefix, ownPrefix, clip.name);
        fixed.push(`${clip.name}[${why}]`);
      } else if (why) {
        bad.push(`${clip.name}[${why}]`);
      }
      acts[clip.name] = mixer.clipAction(use);
    }
    if (fixed.length) console.info(`[people] ${def.key} 修复动作: ${fixed.join(', ')}`);
    if (bad.length) console.warn(`[people] ${def.key} 无母版可修: ${bad.join(', ')}`);

    // ---- 雨伞（谁备伞由 person-state 的 UMBRELLA 决定）----
    let umOpen = null, umClosed = null;
    if (stories[def.key] && stories[def.key].hasUmbrella) {
      if (stories[def.key] && stories[def.key].hasUmbrella) {
        const sceneRoot = world.parent || world;
        umOpen = makeUmbrella(UMB_COLOR[def.key] || 0x2b3440, true);
        umOpen.visible = false;
        sceneRoot.add(umOpen);
        umClosed = makeUmbrella(UMB_COLOR[def.key] || 0x2b3440, false);
        umClosed.visible = false;
        sceneRoot.add(umClosed);
      }
    }

    actors.push({
      def, root, model, mixer, acts, footFix, umOpen, umClosed,
      // 老板通勤开车（日程层 travelByCar 时切到车上）
      vehicle: def.key === 'boss' ? (() => {
        const c = makeCar();
        if (c) world.add(c);
        return c;
      })() : null,
      cur: null, once: null, onceT: 0, lastHeading: null,
      story: stories[def.key], lastFloorShown: 1, day: null, trip: null,
      // 每人一条确定性随机流：seek 重放到同一分钟，动作过渡也完全一致
      rand: mulberry32(3100 + ROSTER.indexOf(def) * 977),
    });
    // 立刻落地一个姿势，暂停时不是 T-pose
    playLoop(actors[actors.length - 1], 'idle');
  }

  let focusKey = null;
  const cityMinDistance = controls ? controls.minDistance : 12;
  const eyeWant = new THREE.Vector3();

  /** 楼层剖切：聚焦谁就切开谁的楼，室内段才看得见人。 */
  function applyFocus() {
    // 【2026-11-07】日程时段的剖切由 main.js 按「此刻谁在室内」统一管理；
    // 这里若照旧重置，每帧都会把刚打开的半透明外壳关掉。
    const focused = actors.find((x) => x.def.key === focusKey);
    if (focused && focused.day) return;
    const cutters = [
      [buildings.clinic, 'clinic'], [buildings.school, 'school'],
      [buildings.cafe, 'cafe'], [office, 'office'],
    ];
    const a = actors.find((x) => x.def.key === focusKey);
    const s = a ? a.story : null;
    for (const [b] of cutters) {
      if (!b) continue;
      if (b.setActiveFloor) b.setActiveFloor(null);
      if (b.setCutaway) b.setCutaway(false);
    }
    // 日程时段人在街面/家门口，别沿用故事残留的 6F 去剖开办公楼
    if (!s || (a && a.day) || s.floor <= 1 || !a) return;
    const owner = ({ boss: office, doctor: buildings.clinic, girl: buildings.school,
      woman: buildings.cafe, worker: buildings.site, rider: office })[focusKey] || office;
    if (owner && owner.setActiveFloor) owner.setActiveFloor(s.floor);
    if (owner && owner.setCutaway) owner.setCutaway(true);
  }

  // ---------- 24 小时连续轨迹（暴雨窗口之外）----------
  // 【2026-11-07 重写】旧版靠 trip/wander 状态机：走到终点后 trip=null，
  // 下一帧 want 仍是时段给的 'walk'，于是人停在原地播跑步循环 —— 用户说的
  // 「出去买早餐就在原地跑呀跑」。而且旧版把 indoor 段的人直接 model.visible=false
  // 摆在楼外锚点，8 小时「人物连动都不动」。
  // 现在 7 个人（含马克）统一由 day-motion 的时刻纯函数给位置 / 朝向 / 动作。
  let inDayMode = true;
  function applyDay(dm, dt, isSeek = false) {
    for (const a of actors) {
      const q = dayMotion ? dayMotion.at(a.def.key, dm) : null;
      if (!q || q.crisis) { a.day = null; a.trip = null; continue; }
      // 兼容 HUD 里沿用的旧字段名
      a.day = {
        ...q,
        activity: q.activity, reason: q.note || q.activity,
        label: q.activity, placeName: q.placeName, dayLabel: q.activity,
        moodNote: q.spot, mode: q.moving ? 'travel' : 'stay',
        segment: `${q.a}-${q.b}`, inBuilding: q.indoor,
      };
      a.trip = null;
      const inCar = !!a.vehicle && q.inVehicle;

      a.root.position.set(q.x, q.y, q.z);
      a.root.rotation.y = q.heading;
      // 室内照样显示：main.js 会按「此刻谁在室内」把楼外壳剖成半透明，
      // 于是 0 点能看见 7 个人各在各屋，而不是街上空无一人。
      a.model.visible = !inCar;
      if (a.vehicle) {
        a.vehicle.visible = inCar;
        if (inCar) {
          a.vehicle.position.set(q.x, groundAt(q.x, q.z) + (a.vehicle.userData.yOff || 0), q.z);
          a.vehicle.rotation.y = q.heading;
        }
      }

      // 生理状态按真实位置连续累（饥饿 / 淋湿 / 体力）
      const d = depthAt(q.x, q.z);
      const ph = a.story.phys;
      if (ph) {
        ph.inVehicle = inCar;
        ph.inBuilding = !!q.indoor;
        ph.tick(dm, {
          depth: d, speed: q.moving ? q.speed : 0,
          raining: !!(clock && clock.raining),
          inVehicle: inCar, inBuilding: !!q.indoor,
          asleep: q.a < 360 && q.clip === 'sit',
        });
      }

      // 动作：clip 由轨迹层按「有没有位移」算好，站定绝不播 walk/run
      if (a.once) { a.once.stop(); a.once = null; a.onceT = 0; a.cur = null; }
      let want = q.clip;
      if (!a.acts[want]) want = a.acts.idle ? 'idle' : Object.keys(a.acts)[0];
      playLoop(a, want);
      a.mixer.timeScale = q.moving ? ANIM.timeScale(q.speed, want) : 1;
      // dt 已经含 CLOCK.speed（main.js 传的是同一子步 h），绝不再乘一次倍率。
      if (dt > 0) a.mixer.update(Math.min(ANIM.animDt(dt), 0.1));

      // 伞：室内 / 车里一律收起，只有室外走在雨里才撑开
      const outdoors = !q.indoor && !inCar;
      if (a.umOpen) {
        a.umOpen.visible = outdoors && q.moving && !!(clock && clock.raining);
        if (a.umOpen.visible) {
          a.umOpen.position.set(q.x, q.y + a.def.height - 1.0, q.z);
          a.umOpen.rotation.y = q.heading;
        }
      }
      if (a.umClosed) {
        a.umClosed.visible = outdoors && !!(clock && clock.raining) && !q.moving;
        if (a.umClosed.visible) {
          a.umClosed.position.set(q.x + Math.cos(q.heading) * 0.3,
            q.y + a.def.height * 0.28, q.z - Math.sin(q.heading) * 0.3);
          a.umClosed.rotation.set(0.16, q.heading, 0.22);
        }
      }
      // 【日程里也要「想」】只靠暴雨那 43 分钟决策，等于其余 23 小时没有脑子。
      // 每 25 分钟用同一套 Brain 权衡一次「按计划 / 抄近道 / 先停一下」，
      // 记录写进 a.story.decisions（和暴雨窗口同一份结构，面板同源）。
      if (a.story && a.story.brain
        && Math.abs(dm - (a.lastThinkMin ?? -999)) >= DAY_THINK_STEP) {
        a.lastThinkMin = dm;
        const rec = dayThink(a.story.brain, q, dm, q.activity || q.spot, a.def.key);
        if (rec) {
          a.story.decisions.push(rec);
          if (a.story.decisions.length > 40) a.story.decisions.shift();
          a.story.decision = rec;
        }
      }
      a.lastFloorShown = q.floor;
      a.lastHeading = q.heading;
    }
    if (buildings.site.water) buildings.site.water.visible = false;
    if (focusKey) applyFocus();
  }


  /** 伞的显示：下雨且在室外才撑开；进楼/上车自动收起。位置每帧跟人同步。 */
  function updateCarry(a, ph) {
    if (!ph) return;
    const outdoors = !ph.inVehicle && !ph.inBuilding;
    const open = ph.umbrella === 'open' && outdoors;
    const px = a.root.position.x, py = a.root.position.y, pz = a.root.position.z;
    const hd = a.root.rotation.y;
    if (a.umOpen) {
      a.umOpen.visible = open;
      if (open) {
        a.umOpen.position.set(px, py + a.def.height - 1.0, pz);
        a.umOpen.rotation.y = hd;
      }
    }
    if (a.umClosed) {
      const show = ph.hasUmbrella && !open && !ph.inVehicle;
      a.umClosed.visible = show;
      if (show) {
        a.umClosed.position.set(
          px + Math.cos(hd) * 0.3, py + a.def.height * 0.28, pz - Math.sin(hd) * 0.3);
        a.umClosed.rotation.set(0.16, hd, 0.22);
      }
    }
  }

  function syncAll(dt) {
    const dmNow = clock ? clock.minute : 0;
    // 【避险结局不能钉死】故事引擎的 beats 在窗口前 18 分钟就走完了，
    // 18:10–18:35 六个人的坐标逐帧完全一致、clip 全是 idle（实测三帧
    // 一模一样），拖时间轴到暴雨高潮会看到「所有人都卡住」。
    // 这里给结局后的待命加确定性的小幅往返：走动相位才播 walk，停下就
    // 回到原地待机，绝不出现「位置不动却在跑步」。
    const shelterIdle = dmNow >= 1090 && dmNow <= 1115;
    for (const a of actors) {
      const s = a.story;
      // 暴雨窗口由故事层接管（boss 这段是步行撤离，不开车）
      a.model.visible = true;
      if (a.vehicle) a.vehicle.visible = false;
      let px = s.position.x, pz = s.position.z;
      let extraClip = null, extraSpeed = 0, extraHeading = null;
      if (shelterIdle && (s.speed || 0) < 0.15) {
        let h = 7;
        for (const ch of String(a.def.key || '')) h = (h * 31 + ch.charCodeAt(0)) % 6283;
        const ang = h / 1000;
        const ph = (dmNow - 1090) / 25;
        const wave = ph * Math.PI * 4 + ang;
        const osc = Math.sin(wave), v = Math.cos(wave);
        px += Math.cos(ang) * 1.7 * osc;
        pz += Math.sin(ang) * 1.7 * osc;
        if (Math.abs(v) > 0.42) {
          extraClip = 'walk'; extraSpeed = 1.0;
          extraHeading = Math.atan2(Math.cos(ang) * v, Math.sin(ang) * v);
        }
        // 【待命微动作不能撞墙】上一版没有实体约束，避险锚点旁的家具/隔墙
        // 会把人反复顶回来（用户「小女孩一直在撞墙」）。落点撞实体就退回
        // 锚点、这一帧保持静止。
        if (collide && collide.blockedCircle(px, pz, 0.34,
          s.position.y + 0.1, s.position.y + 1.7,
          { ignoreTags: new Set(['building', 'tree']) })) {
          px = s.position.x; pz = s.position.z;
          extraClip = null; extraSpeed = 0; extraHeading = null;
        }
      }
      // 室外贴地（不再用预烘焙的绝对 y 直接穿地形），室内沿用楼内楼层高程
      const y = s.floor <= 1 ? Math.max(s.position.y, groundAt(px, pz))
        : s.position.y;
      a.root.position.set(px, y, pz);
      a.root.rotation.y = extraHeading === null ? (s.heading || 0) : extraHeading;

      // 转身：heading 突变时插一个 turn180 / 侧身，而不是硬转模型
      if (a.lastHeading !== null) {
        let d = (s.heading || 0) - a.lastHeading;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        if (Math.abs(d) > 1.75 && !a.once) playOnce(a, 'turn180');
        else if (Math.abs(d) > 0.85 && !a.once && a.rand() < 0.25) {
          playOnce(a, d > 0 ? 'side_r' : 'side_l');
        }
      }
      a.lastHeading = s.heading || 0;

      const cue = s.actionCue;
      if (cue && !a.once && a.rand() < 0.75) playOnce(a, cue);
      if (s.state === 'wading' && s.depth > 0.42 && !a.once && a.rand() < 0.008) {
        playOnce(a, 'crouch');
      }

      const want0 = loopClip(a, s);
      const want = (extraClip && a.acts[extraClip]) ? extraClip : want0;
      if (a.once) {
        a.onceT += dt;
        // 一次性动作播完（或超时）就切回循环
        if (dt <= 0 || a.onceT > 0.85) {
          a.once.stop();
          a.once = null;
          a.onceT = 0;
          a.cur = null;
        }
      }
      if (!a.once) playLoop(a, want);
      else if (a.cur !== a.once) {
        // 让一次性动作保持权重，不被循环动作顶掉
        a.once.setEffectiveWeight(1);
      }
      // 步频与真实位移速度绑定：走慢腿也慢，停下来不空跑。
      // 【基准速度按 clip 取】旧版一律除 1.35，跑起来被 clamp 到 1.8，
      // 腿比地面快 1.8 倍 —— 看着就是"原地蹬腿往前飘"。
      const speed = extraClip ? extraSpeed : (s.speed || 0);
      const clipName = a.cur ? String(a.cur.getClip().name) : 'walk';
      a.mixer.timeScale = speed > 0.05 ? ANIM.timeScale(speed, clipName) : 1;
      // dt 已经含倍率：动画时间与位移时间必须同一个仿真秒。
      if (dt > 0) a.mixer.update(Math.min(ANIM.animDt(dt), 0.1));
      updateCarry(a, s.phys);
      a.lastFloorShown = s.floor;
    }
    const w = stories.worker;
    if (buildings.site.water) buildings.site.water.visible = !!(w && w.depth > 0.30);
    if (focusKey) applyFocus();
  }

  /**
   * 具名角色与 PED 第 1~6 人共用同一状态。模型仍保留各自外观，位置/动作/
   * 目标不再由 DAYMOTION 或六条 OfficeStory 另行计算，避免两个“现在”。
   */
  function bindLive(ped) { LIVE_PED = ped || null; syncLive(0); }
  function syncLive(simSec = 0) {
    if (!LIVE_PED) return;
    for (let k = 0; k < actors.length; k++) {
      const a = actors[k], p = LIVE_PED.peds[k + 1];
      if (!p) { a.model.visible = false; continue; }
      const q = LIVE_PED.crowdLife ? LIVE_PED.crowdLife.at(p.i) : null;
      const L = LIVE_PED.live ? LIVE_PED.live.debug(p.i) : null;
      const vis = p.obj.visible;
      a.root.position.copy(p.obj.position);
      a.root.rotation.y = p.obj.rotation.y;
      a.model.visible = vis;
      p.obj.visible = false;             // 同一个人不能画两遍
      if (a.vehicle) a.vehicle.visible = false;
      if (a.umOpen) a.umOpen.visible = false;
      if (a.umClosed) a.umClosed.visible = false;
      const clip = p.cur ? String(p.cur.getClip().name) : 'idle';
      const floor = q && q.indoor
        ? ({ office: 6, clinic: 2, school: 3, cafe: 1, site: 1, street: 1 }[q.place] || 1) : 1;
      a.day = q ? {
        ...q, floor, clip, moving: /walk|run/i.test(clip) && vis,
        activity: L && L.goal ? L.goal.label : q.activity,
        label: L && L.goal ? L.goal.label : q.activity,
        reason: (L && L.lastReason) || q.activity,
        placeName: q.place === 'home' ? '自己的住所' : (q.place === 'street' ? '城市街面' : '工作岗位'),
        mode: 'live', inVehicle: false,
      } : null;
      a.story.position.copy(p.obj.position);
      a.story.heading = p.obj.rotation.y;
      const want = a.acts[clip] ? clip : (a.acts.idle ? 'idle' : Object.keys(a.acts)[0]);
      if (want) playLoop(a, want);
      if (vis && simSec > 0) a.mixer.update(Math.min(simSec, 0.1));
    }
  }

  /** 由城市时钟调用：一次推进所有人（仿真秒）。全天 24h 都有状态。 */
  function advance(simSec) {
    if (LIVE_PED) { syncLive(simSec); return; }
    const dm = clock ? clock.minute : 0;
    if (!inCrisis(dm)) {
      inDayMode = true;
      applyDay(dm, simSec);
      return;
    }
    // 从日程切进暴雨窗口：把 6 条故事线确定性重放到这一刻，再交给 Brain。
    if (inDayMode) { seekAll(dm - STORY_OFFSET); inDayMode = false; }
    for (const a of actors) a.day = null;
    if (simSec > 0) for (const a of actors) a.story.step(simSec);
    syncAll(simSec);
  }

  /** 跳时刻：从 17:52 确定性重放；窗口外立刻把日程摆到这一刻（含行程进度）。 */
  function seekAll(m) {
    if (LIVE_PED) { syncLive(0); return; }
    const t = Math.max(52, Math.min(96, m));
    const dm = Number(m) + STORY_OFFSET;      // 换算回一天分钟
    if (!inCrisis(dm)) {
      // 【不能等下一帧】拖动时间轴要求立刻同步；rAF 被节流时旧写法会一直
      // 停留在上一个时段（实测无头浏览器里 6 人卡在「准备下班」不动）。
      inDayMode = true;
      for (const a of actors) {
        a.trip = null; a.tripKey = null;
        // 生理量按「这一刻应该是什么样」直接落位，否则拖时间轴永远停在旧数值
        if (a.story.phys && a.story.phys.seekTo) a.story.phys.seekTo(dm);
      }
      applyDay(dm, 0, true);
      return;
    }
    inDayMode = false;
    for (const a of actors) {
      a.story.reset();
      a.story.tMin = 52;
      const need = Math.max(0, (t - 52) * 60);
      // 【必须子步重放】一步推进 18 分钟会跳过所有 beat，直接落在结局
      // （实测 18:10 就显示「到家」）。≤2 s 子步才让 Brain 逐个决策真的发生。
      const n = Math.max(1, Math.ceil(need / 2));
      for (let k = 0; k < n; k++) a.story.step(need / n);
      a.day = null;
      a.once = null; a.onceT = 0; a.cur = null; a.lastHeading = null;
    }
    syncAll(0);
  }

  function hud() {
    return actors.map((a) => {
      // 日程时段：HUD 照样能查位置 / 动作 / 心理 / 决策（此时决策为空是真实的，
      // 因为没遇到险情就不做判断），而不是一片空白。
      if (a.day) {
        const q = a.day;
        const ph = a.story.phys ? a.story.phys.snapshot() : null;
        return {
          key: a.def.key, name: a.def.name, role: a.def.role,
          state: 'schedule', stateText: q.activity,
          floor: 1,
          // 用真实位置，不是日程锚点（人在路上走的时候两者不一样）
          x: a.root.position.x, z: a.root.position.z,
          reason: q.reason, outcome: null, finished: false,
          clip: a.cur ? String(a.cur.getClip().name) : q.clip,
          // 面板右列要显示中文动作（办公 / 手术 / 授课…），别再漏成 idle/walk
          kind: q.kind, moving: q.moving, indoor: q.indoor,
          profile: a.def.key,
          mood: q.mood, moodNote: `${q.label} · ${q.placeName}`,
          stress: q.stress, urgency: 0.1, caution: 0.1,
          depth: depthAt(a.root.position.x, a.root.position.z), decisions: [],
          trait: (PROFILES[a.def.key] || {}).trait || '',
          placeName: q.placeName, dayLabel: q.label,
          mode: q.mode, phys: ph,
        };
      }
      const s = a.story;
      return {
        key: a.def.key, name: a.def.name, role: a.def.role,
        state: s.state, stateText: STATE_CN[s.state] || s.state,
        floor: s.floor, x: s.position.x, z: s.position.z,
        reason: s.reason, outcome: s.outcome, finished: s.finished,
        clip: a.once ? String(a.once.getClip().name)
          : (a.cur ? String(a.cur.getClip().name) : '—'),
        // 【原来写 PROFILES[s.profile]，而 s.profile 是对象】索引永远 undefined，
        // HUD 里"档案"一栏一直是空的。
        profile: (s.profile && s.profile.key) || a.def.key,
        mood: s.mood, moodNote: s.moodNote,
        stress: s.stress, urgency: s.urgency, caution: s.caution,
        depth: s.depth, decisions: s.decisions,
        trait: (PROFILES[a.def.key] || {}).trait || '',
        mode: 'crisis',
        phys: s.phys ? s.phys.snapshot() : null,
      };
    });
  }

  /** 点 HUD 里某一行：镜头过去，之后每帧跟拍。 */
  function select(key, cam = camera, ctl = controls) {
    const a = actors.find((x) => x.def.key === key);
    if (!a || !cam || !ctl) return;
    focusKey = key;
    ctl.minDistance = 2.2;
    applyFocus();
    followEye(eyeWant);
    cam.position.copy(eyeWant);
    const q = a.day
      ? { x: a.root.position.x, y: groundAt(a.root.position.x, a.root.position.z) + 1.1, z: a.root.position.z }
      : { x: a.story.position.x, y: a.story.position.y + 1.1, z: a.story.position.z };
    ctl.target.set(q.x, q.y, q.z);
    ctl.update();
  }
  function clearFocus() {
    focusKey = null;
    if (controls) controls.minDistance = cityMinDistance;
    applyFocus();
  }
  /** 跟拍机位；返回当前聚焦角色的位置，没有聚焦就返回 null。 */
  function followEye(out) {
    const a = actors.find((x) => x.def.key === focusKey);
    if (!a) return null;
    const s = a.story;
    const hd = a.day ? a.root.rotation.y : s.heading;
    const dx = Math.sin(hd), dz = Math.cos(hd);
    const px = a.day ? a.root.position.x : s.position.x;
    // 【BUG 修复】旧版这里取的是「地面高度」，不是人的高度：跟拍 6F 工位上的人
    // 时相机被放到地面 +10 m，抬头看楼，整屏都是外墙。必须用人的真实 y。
    const py = a.day ? a.root.position.y : s.position.y;
    const pz = a.day ? a.root.position.z : s.position.z;
    // 室内用贴身机位（后退 3.6 / 抬高 2.0），室外保留 16 m 的远景
    const indoor = !!(a.day && a.day.indoor);
    const back = indoor ? 4.6 : 16;
    const side = indoor ? 1.6 : 6;
    const up = indoor ? 2.3 : 10;
    out.set(px - dx * back - dz * side, py + up, pz - dz * back + dx * side);
    return new THREE.Vector3(px, py, pz);
  }

  syncAll(0);
  return {
    actors, stories, buildings, ROSTER, PROFILES,
    bindLive, syncLive, advance, seekAll, syncAll, hud, select, clearFocus, followEye,
    /** 跟拍目标此刻是否在楼里（决定相机要不要做越障收缩）。 */
    indoorOf: (k) => {
      const a = actors.find((x) => x.def.key === (k || focusKey));
      return !!(a && a.day && a.day.indoor);
    },
    get focusKey() { return focusKey; },
  };
}
