import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadTerrain, buildTerrainMesh, loadRoadCut, loadBuildings, buildBuildingMesh } from './terrain.js';
import { loadCityTextures, prepareFacades, wallMaterial, roofMaterial, roadMaterial, terrainMaterial, marbleMaterial } from './citytex.js';
import { buildLocalRoads } from './roadribbon.js';
import { buildParkingLot, PARKING } from './parking-lot.js';
import { setRoadCut } from './roadmesh.js';
import { createFloodLayer } from './flood.js';
import { loadPedSurface, buildWalkGraph } from './ped.js';
import { OFFICE, buildOfficeBuilding } from './office-building.js';
import { HOME, buildHomeBuilding } from './home-building.js';
import { PROFILES } from './decision.js';
import { OfficeStory, STATE_TEXT, OFFICE_STORY_START_MIN, OFFICE_STORY_END_MIN } from './office-story.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x71808a);
scene.fog = new THREE.Fog(0x71808a, 220, 1500);
const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.06, 6000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.5;
controls.maxDistance = 1400;
controls.maxPolarAngle = Math.PI * 0.54;

scene.add(new THREE.HemisphereLight(0xc7d7e1, 0x3b4140, 2.25));
const sun = new THREE.DirectionalLight(0xe4edf2, 2.0);
sun.position.set(OFFICE.cx - 90, OFFICE.baseY + 140, OFFICE.cz + 70);
sun.target.position.set(OFFICE.cx, OFFICE.baseY, OFFICE.cz);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -120, right: 120, top: 120, bottom: -120, near: 1, far: 360 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.00025;
scene.add(sun, sun.target);
// 跟随一盏柔光，避免楼梯间、走廊在阴影里变成一块黑板。
const followLight = new THREE.PointLight(0xffeed2, 16, 16, 1.7);
scene.add(followLight);
const interiorLight = new THREE.PointLight(0xffedc9, 48, 46, 1.6);
interiorLight.position.copy(OFFICE ? new THREE.Vector3(OFFICE.cx - 35, OFFICE.baseY + 27.5, OFFICE.cz - 7) : new THREE.Vector3());
scene.add(interiorLight);

const world = new THREE.Group();
world.name = 'Office_Individual_World';
scene.add(world);

let story = null, office = null, home = null, flood = null, walk = null;
let agent = null, sitRoot = null, mixer = null, currentAction = null;
let markCar = null;
const actions = {};
const bones = {};
let sitWeight = 0, sitTarget = 0;
// 移动动作三态：idle / walk / run；切换时插 start / stop / run_stop 过渡
let motionMode = 'idle';
let pendingMotion = null;
let transAction = null;
let playing = true, viewMode = 'follow', speed = 1, last = performance.now();
let currentFloodIndex = -1, floodManifest = null;
const floodFrames = [];
let trackLine = null, planLine = null, targetMarker = null, rain = null;
let lastTrackLength = -1, lastUi = 0, recorder = null;

const STATE_LABEL = STATE_TEXT;
const ACTION_LABEL = {
  idle: '站立', idle2: '办公动作', look: '观察四周', walk: '步行', run: '跑步',
  stairs_down: '下楼梯', stairs_up: '上楼梯', door: '开门', crawl: '贴地爬行',
  crouch: '蹲伏/失能', shoved: '受冲击失衡', start: '起步', stop: '停步',
  sit: '坐在工位', phone: '打电话', pack: '收拾物品', lift: '乘电梯',
};

/** 没有对应 FBX 的动作，用状态文案说明，不假装有动画。 */
const MIME_ACTIONS = {
  notice: '看手机', window: '望向窗外', calling: '打电话', handover: '交接工作',
  packing: '收拾背包、取伞', preparing: '拿车钥匙', elevator: '乘电梯',
  observing: '停下观察', blocked: '停下判断', arrive: '进入公寓',
};

function toast(text) {
  $('toast').textContent = text;
  $('toast').style.display = 'block';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $('toast').style.display = 'none'; }, 2200);
}

function clockText(tMin) {
  const total = Math.floor(17 * 3600 + tMin * 60);
  const h = String(Math.floor(total / 3600) % 24).padStart(2, '0');
  const m = String(Math.floor(total / 60) % 60).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function rawDepth(data, x, z) {
  const m = floodManifest;
  const c = Math.floor((x - m.x0) / m.step_m);
  const r = Math.floor((z - m.z0) / m.step_m);
  if (c < 0 || c >= m.cols || r < 0 || r >= m.rows) return 0;
  return data[r * m.cols + c] / 255 * (m.scale || 4);
}

function depthAt(x, z, tMin) {
  if (!floodManifest || !floodFrames.length) return 0;
  const frames = floodManifest.frames;
  let hi = frames.findIndex((f) => f.t_min >= tMin);
  if (hi < 0) hi = frames.length - 1;
  const lo = Math.max(0, hi - 1);
  if (hi === lo) return rawDepth(floodFrames[lo], x, z);
  const a = THREE.MathUtils.clamp((tMin - frames[lo].t_min) / (frames[hi].t_min - frames[lo].t_min), 0, 1);
  return THREE.MathUtils.lerp(rawDepth(floodFrames[lo], x, z), rawDepth(floodFrames[hi], x, z), a);
}

function syncFlood() {
  if (!floodManifest || !story) return;
  let best = 0;
  for (let i = 0; i < floodManifest.frames.length; i++) {
    if (floodManifest.frames[i].t_min <= story.tMin) best = i;
    else break;
  }
  if (best !== currentFloodIndex) {
    currentFloodIndex = best;
    flood.showFrame(best);
  }
}

const SIT = { upLeg: 1.40, leg: -1.34, spine: 0.09, arm: -0.14, drop: 0.42 };
const _q = new THREE.Quaternion();
const _axisX = new THREE.Vector3(1, 0, 0);
let poseDirty = true;

function rotateBone(bone, angle, weight) {
  if (!bone || weight <= 0.001) return;
  _q.setFromAxisAngle(_axisX, angle * weight);
  bone.quaternion.multiply(_q);
}

/** 坐姿没有对应的 FBX 动作，用骨骼叠加还原“坐在工位”的姿势。 */
function applySitPose(weight) {
  if (!sitRoot) return;
  sitRoot.position.y = -SIT.drop * weight;
  rotateBone(bones.LeftUpLeg, SIT.upLeg, weight);
  rotateBone(bones.RightUpLeg, SIT.upLeg, weight);
  rotateBone(bones.LeftLeg, SIT.leg, weight);
  rotateBone(bones.RightLeg, SIT.leg, weight);
  rotateBone(bones.Spine, SIT.spine, weight);
  rotateBone(bones.LeftArm, SIT.arm, weight);
  rotateBone(bones.RightArm, SIT.arm, weight);
}

const LOOP_CLIPS = new Set(['walk', 'run', 'stairs_down', 'stairs_up', 'idle', 'idle2', 'look', 'crouch', 'sit', 'crawl']);

function playLoop(name) {
  const a = actions[name];
  if (!a) return;
  if (currentAction === a) return;
  a.reset();
  a.setLoop(THREE.LoopRepeat, Infinity);
  a.clampWhenFinished = false;
  a.setEffectiveTimeScale(1).setEffectiveWeight(1);
  if (currentAction) a.crossFadeFrom(currentAction, 0.16, false);
  a.play();
  currentAction = a;
  if (mixer) mixer.update(0);
  poseDirty = true;
}

/** 播一次过渡动作，播完自动接上 next。 */
function playTransition(clip, next) {
  const a = actions[clip];
  if (!a) { playLoop(next); motionMode = next; return; }
  a.reset();
  a.setLoop(THREE.LoopOnce, 1);
  a.clampWhenFinished = true;
  a.setEffectiveTimeScale(1).setEffectiveWeight(1);
  if (currentAction && currentAction !== a) a.crossFadeFrom(currentAction, 0.08, false);
  a.play();
  currentAction = a;
  pendingMotion = next;
  transAction = a;
  if (mixer) mixer.update(0);
  poseDirty = true;
}

/** 切换移动三态；起步用 start，停步用 stop / run_stop。 */
function setMotion(next) {
  if (next === motionMode || pendingMotion === next) return;
  if (motionMode === 'idle' && (next === 'walk' || next === 'run')) {
    if (actions.start) { playTransition('start', next); return; }
  }
  if (next === 'idle' && (motionMode === 'walk' || motionMode === 'run')) {
    const clip = motionMode === 'run' ? (actions.run_stop ? 'run_stop' : 'stop') : 'stop';
    if (actions[clip]) { playTransition(clip, 'idle'); return; }
  }
  playLoop(next);
  motionMode = next;
}

/** 每帧检查过渡是否播完（mixer.update 之后调用）。 */
function updateMotionTransition() {
  if (!pendingMotion || !transAction) return;
  const clip = transAction.getClip();
  if (transAction.time >= clip.duration - 0.03) {
    const next = pendingMotion;
    pendingMotion = null;
    transAction = null;
    playLoop(next);
    motionMode = next;
  }
}

function setAnimation(name) {
  const next = actions[name] || actions.idle || Object.values(actions)[0];
  if (!next || next === currentAction) return;
  next.reset().setEffectiveWeight(1).setEffectiveTimeScale(1);
  if (currentAction) next.crossFadeFrom(currentAction, 0.18, false);
  next.play();
  currentAction = next;
  if (mixer) mixer.update(0);
  poseDirty = true;
}

function updateAnimation() {
  if (!story) return;
  const s = story.state;
  if (s === 'driving' || s === 'carblocked' || s === 'parking' || s === 'boarding') return;

  // 动作按“实际速度”决定，不按状态名。起步/停步各自插一段过渡动作。
  const spd = story.speed || 0;
  const moving = spd > 0.25 && story.path.length > 0;
  const wp = moving ? story.path[story.pathIndex] : null;

  if (moving && wp && wp.kind === 'stairs') {
    pendingMotion = null; transAction = null; motionMode = 'walk';
    sitTarget = 0;
    playLoop(actions.stairs_down ? 'stairs_down' : 'walk');
    return;
  }
  if (moving) {
    sitTarget = 0;
    setMotion(spd > 2.2 ? 'run' : 'walk');
    return;
  }

  setMotion('idle');
  // 静止时按状态挑姿势；过渡动作还在播就别打断
  if (pendingMotion) return;
  sitTarget = 0;
  if (s === 'working') playLoop('sit');
  else if (s === 'notice' || s === 'window' || s === 'observing' || s === 'blocked' || s === 'arrive') {
    playLoop('look');
  } else if (s === 'calling' || s === 'handover' || s === 'packing' || s === 'preparing') {
    playLoop('idle');
  } else if (s === 'elevator' || s === 'home') playLoop('idle');
  else if (s === 'wading' || s === 'outdoor') playLoop('walk');
  else playLoop('idle');
}

function makeLines() {
  trackLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x62d6ed, transparent: true, opacity: 0.88 }));
  trackLine.name = 'Mark_Actual_Track';
  trackLine.frustumCulled = false;
  world.add(trackLine);
  planLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xf0bd68, transparent: true, opacity: 0.70 }));
  planLine.name = 'Mark_Current_Plan';
  planLine.frustumCulled = false;
  world.add(planLine);
  targetMarker = new THREE.Mesh(
    new THREE.RingGeometry(1.05, 1.35, 40),
    new THREE.MeshBasicMaterial({ color: 0xf0bd68, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }),
  );
  targetMarker.rotation.x = -Math.PI / 2;
  targetMarker.name = 'Home_Marker';
  targetMarker.position.set(HOME.entryX, home.baseY + 0.12, HOME.cz - HOME.depth / 2 - 3.0);
  world.add(targetMarker);
}

let lastTrackPaint = 0;
function updateLines() {
  if (!story || story.trace.length === lastTrackLength) return;
  const now = performance.now();
  if (now - lastTrackPaint < 180) return;
  lastTrackPaint = now;
  lastTrackLength = story.trace.length;
  const actual = story.trace.map((p) => new THREE.Vector3(p.x, p.y + 0.055, p.z));
  trackLine.geometry.dispose();
  trackLine.geometry = new THREE.BufferGeometry().setFromPoints(actual);
  if (!story.path.length) {
    planLine.geometry.dispose();
    planLine.geometry = new THREE.BufferGeometry();
    return;
  }
  const remaining = story.path.slice(story.pathIndex).map((wp) => wp.p.clone().add(new THREE.Vector3(0, 0.07, 0)));
  if (remaining.length) remaining.unshift(story.position.clone().add(new THREE.Vector3(0, 0.07, 0)));
  planLine.geometry.dispose();
  planLine.geometry = new THREE.BufferGeometry().setFromPoints(remaining);
}

function makeRain() {
  // 暴雨用雨丝线段表现：每滴是一条 0.35–0.75 m 的竖线，比点精灵更像下雨。
  const n = 1500;
  const pos = new Float32Array(n * 6);
  const len = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const x = (Math.random() - 0.5) * 60;
    const y = Math.random() * 26;
    const z = (Math.random() - 0.5) * 60;
    len[i] = 0.35 + Math.random() * 0.4;
    pos[i * 6] = x; pos[i * 6 + 1] = y; pos[i * 6 + 2] = z;
    pos[i * 6 + 3] = x; pos[i * 6 + 4] = y - len[i]; pos[i * 6 + 5] = z;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
    color: 0xd6e8f2, transparent: true, opacity: 0.34, depthWrite: false,
  }));
  rain.frustumCulled = false;
  rain.userData.len = len;
  scene.add(rain);
}

/** 雨不是从头就最大：17:52 小雨，18:04 前后转成真正的暴雨。 */
function rainIntensity(tMin) {
  if (tMin <= 52) return 0.28;
  if (tMin < 58) return 0.28 + ((tMin - 52) / 6) * 0.34;
  if (tMin < 66) return 0.62 + ((tMin - 58) / 8) * 0.38;
  if (tMin < 84) return 1.0;
  return Math.max(0.6, 1.0 - ((tMin - 84) / 22) * 0.4);
}

/** 是否在任意一栋可进入建筑的轮廓内（室内不该下雨）。 */
function isIndoors(pos) {
  const inOffice = Math.abs(pos.x - OFFICE.cx) <= OFFICE.width / 2 + 0.6
    && Math.abs(pos.z - OFFICE.cz) <= OFFICE.depth / 2 + 0.6;
  const inHome = Math.abs(pos.x - HOME.cx) <= HOME.width / 2 + 0.6
    && Math.abs(pos.z - HOME.cz) <= HOME.depth / 2 + 0.6;
  return inOffice || inHome;
}

function updateRain(dt) {
  if (!rain || !story) return;
  const outside = !isIndoors(story.position);
  const k = rainIntensity(story.tMin);
  rain.visible = outside && k > 0.05;
  if (!rain.visible) return;
  rain.material.opacity = 0.10 + k * 0.42;
  rain.position.set(story.position.x, story.position.y, story.position.z);
  const p = rain.geometry.attributes.position;
  const lens = rain.userData.len;
  const fall = dt * (11 + k * 15);
  const count = p.count / 2;
  for (let i = 0; i < count; i += 1) {
    let y = p.getY(i * 2) - fall;
    if (y < 0) y += 26;
    p.setY(i * 2, y);
    p.setY(i * 2 + 1, y - lens[i]);
  }
  p.needsUpdate = true;
}

function setView(name) {
  if (!story || !office) return;
  viewMode = name;
  document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  controls.enabled = name !== 'follow';
  office.setCutaway(false);
  office.setActiveFloor(null);
  if (home) { home.setCutaway(false); home.setActiveFloor(null); }
  const p = story.position;
  if (name === 'desk') {
    office.setActiveFloor(6);
    camera.position.copy(office.start).add(new THREE.Vector3(3.6, 2.2, 3.8));
    controls.target.copy(office.start).add(new THREE.Vector3(0, 1.05, 0));
  } else if (name === 'cutaway') {
    office.setActiveFloor(6);
    office.setCutaway(true);
    camera.position.set(OFFICE.cx - 22, OFFICE.baseY + 39, OFFICE.cz + 29);
    controls.target.set(OFFICE.cx - 20, OFFICE.baseY + 26, OFFICE.cz - 3);
  } else if (name === 'office') {
    camera.position.set(OFFICE.cx + 156, OFFICE.baseY + 104, OFFICE.cz + 151);
    controls.target.set(OFFICE.cx, OFFICE.baseY + 15, OFFICE.cz);
  } else if (name === 'street') {
    const y = office.exit.y;
    camera.position.set(office.exit.x + 17, y + 2.2, office.exit.z + 24);
    controls.target.set(office.exit.x, y + 1.1, office.exit.z);
  } else if (name === 'home') {
    if (home) {
      const fy = home.baseY + (HOME.homeFloor - 1) * HOME.floorH;
      home.setActiveFloor(HOME.homeFloor);
      // 站在客厅西南角往里看，避免相机落到外墙里。
      camera.position.set(HOME.cx - 22.6, fy + 1.9, HOME.cz + 12.6);
      controls.target.set(HOME.cx - 18.6, fy + 1.15, HOME.cz - 5.0);
    }
  } else if (name === 'homeout') {
    camera.position.set(HOME.cx + 118, HOME.baseY + 62, HOME.cz + 96);
    controls.target.set(HOME.cx, HOME.baseY + 18, HOME.cz);
  } else if (name === 'free') {
    controls.target.copy(p).add(new THREE.Vector3(0, 1.1, 0));
    camera.position.copy(p).add(new THREE.Vector3(6, 3.4, 7));
  }
  controls.update();
}

/* ------------------------------------------------- 室内相机碰撞
 * 楼梯间只有 2.4 m 宽，靠固定距离后退一定会把镜头塞进墙里（画面直接变灰）。
 * 这里不手写碰撞体，直接遍历建筑里已经生成好的实例反推 AABB。
 */
const OCELL = 5;
const ocGrid = new Map();
let ocCount = 0;

function buildOfficeColliders(root) {
  if (!root) return;
  const m = new THREE.Matrix4();
  root.traverse((o) => {
    if (!o.isInstancedMesh) return;
    for (let i = 0; i < o.count; i += 1) {
      o.getMatrixAt(i, m);
      const e = m.elements;
      const sx = Math.abs(e[0]); const sy = Math.abs(e[5]); const sz = Math.abs(e[10]);
      if (sy < 0.25) continue;              // 薄水平板（地板、吊顶、灯带）不算
      if (sx < 0.05 || sz < 0.05) continue;
      const x = e[12]; const y = e[13]; const z = e[14];
      const box = { x0: x - sx / 2, x1: x + sx / 2, y0: y - sy / 2, y1: y + sy / 2, z0: z - sz / 2, z1: z + sz / 2 };
      const cx0 = Math.floor(box.x0 / OCELL); const cx1 = Math.floor(box.x1 / OCELL);
      const cz0 = Math.floor(box.z0 / OCELL); const cz1 = Math.floor(box.z1 / OCELL);
      for (let cx = cx0; cx <= cx1; cx += 1) {
        for (let cz = cz0; cz <= cz1; cz += 1) {
          const k = `${cx},${cz}`;
          let arr = ocGrid.get(k);
          if (!arr) { arr = []; ocGrid.set(k, arr); }
          arr.push(box);
        }
      }
      ocCount += 1;
    }
  });
}

function ocBlocked(x, y, z, pad = 0.22) {
  const cx = Math.floor(x / OCELL); const cz = Math.floor(z / OCELL);
  for (let i = -1; i <= 1; i += 1) {
    for (let j = -1; j <= 1; j += 1) {
      const arr = ocGrid.get(`${cx + i},${cz + j}`);
      if (!arr) continue;
      for (const b of arr) {
        if (x > b.x0 - pad && x < b.x1 + pad && y > b.y0 - pad && y < b.y1 + pad
          && z > b.z0 - pad && z < b.z1 + pad) return true;
      }
    }
  }
  return false;
}

/** 从目标点往机位推进，撞到第一堵墙就停；距离不够就抬高重试。 */
function safeCamera(target, desired) {
  // 三个高度各试一次，取“退得最远”的那个：
  // 只取第一个可行解会在楼梯间贴到后脑勺上。
  const tries = [
    desired,
    desired.clone().add(new THREE.Vector3(0, 1.1, 0)),
    desired.clone().add(new THREE.Vector3(0, 2.2, 0)),
    desired.clone().add(new THREE.Vector3(0, 3.1, 0)),
  ];
  let best = null;
  let bestD = -1;
  for (const want of tries) {
    let last = target.clone();
    for (let i = 1; i <= 14; i += 1) {
      const p = target.clone().lerp(want, i / 14);
      if (ocBlocked(p.x, p.y, p.z)) break;
      last.copy(p);
    }
    const d = last.distanceTo(target);
    if (d > bestD) { bestD = d; best = last; }
  }
  return best || target.clone().add(new THREE.Vector3(0, 1.8, 0));
}

function updateCamera(immediate = false) {
  if (!story) return;
  const inHome = story.pathName === 'apartment'
    || ['arrive', 'elevator', 'home'].includes(story.state);
  const inOffice = !inHome && (story.state === 'indoor' || story.floor > 1);
  if (viewMode === 'follow' && ['driving', 'carblocked', 'parking', 'boarding'].includes(story.state)) {
    office.setActiveFloor(null);
    home.setActiveFloor(null);
    const dir = new THREE.Vector3(Math.sin(story.heading), 0, Math.cos(story.heading));
    const desired = story.position.clone().addScaledVector(dir, -10.5).add(new THREE.Vector3(0, 5.2, 0));
    camera.position.lerp(desired, immediate ? 1 : 0.10);
    camera.lookAt(story.position.clone().addScaledVector(dir, 7).add(new THREE.Vector3(0, 1.0, 0)));
    return;
  }
  if (viewMode === 'follow' && story.state === 'elevator') {
    // 轿厢只有 2.8×3.0 m，跟随镜头会贴死在壁上：改成固定角落的越肩视角。
    office.setActiveFloor(null);
    home.setActiveFloor(Math.min(12, Math.max(1, story.floor)));
    const cab = home.liftCab;
    camera.position.set(cab.x - 0.20, story.position.y + 2.32, cab.z + 1.28);
    camera.lookAt(cab.x, story.position.y + 0.98, cab.z - 0.95);
    return;
  }
  if (viewMode === 'follow') {
    office.setActiveFloor(inOffice ? Math.min(6, Math.max(1, story.floor)) : null);
    home.setActiveFloor(inHome ? Math.min(12, Math.max(1, story.floor)) : null);
    const indoor = inOffice || inHome;
    const onStairs = story.state === 'indoor'
      && story.path[story.pathIndex]?.kind === 'stairs';
    const direction = new THREE.Vector3(Math.sin(story.heading), 0, Math.cos(story.heading));
    const running = story.state === 'escape' || story.state === 'detour';
    // 楼梯间只有 2.4 m 宽，第三人称必须拉近并抬高，否则相机一定穿进踏步或墙里。
    const distance = onStairs ? 1.9 : indoor ? 2.6 : running ? 7.2 : 5.4;
    const height = onStairs ? 2.25 : indoor ? 2.2 : running ? 3.2 : 2.9;
    const desired = story.position.clone().addScaledVector(direction, -distance).add(new THREE.Vector3(0, height, 0));
    const target = story.position.clone().add(new THREE.Vector3(0, indoor ? 1.18 : 1.35, 0));
    // 室内必须避墙：楼梯间、走廊都只有 2 m 多宽
    const pos = indoor ? safeCamera(target, desired) : desired;
    if (immediate) camera.position.copy(pos); else camera.position.lerp(pos, running ? 0.09 : 0.13);
    camera.lookAt(target);
  }
}

function updateBubble() {
  if (!story || !agent) return;
  const p = story.position.clone().add(new THREE.Vector3(0, 2.25, 0)).project(camera);
  const visible = p.z > -1 && p.z < 1 && Math.abs(p.x) < 1.12 && Math.abs(p.y) < 1.12;
  const bubble = $('agentBubble');
  bubble.style.display = visible ? 'block' : 'none';
  if (!visible) return;
  bubble.style.left = `${(p.x * 0.5 + 0.5) * innerWidth}px`;
  bubble.style.top = `${(-p.y * 0.5 + 0.5) * innerHeight - 8}px`;
  const floor = story.floor > 1 ? ` · ${story.floor}F` : '';
  bubble.textContent = `${STATE_LABEL[story.state] || story.state}${floor}`;
}

function updateDetails() {
  if (!story) return;
  const s = story.snapshot();
  $('dState').textContent = s.stateText;
  const clip = currentAction?.getClip?.().name;
  const mime = MIME_ACTIONS[s.state];
  $('dAction').textContent = mime ? `${mime}（无对应动画，仅状态记录）` : (clip ? (ACTION_LABEL[clip] || clip) : '—');
  $('dReason').textContent = s.reason;
  $('dFloor').textContent = `${s.floor}F · (${s.position.x.toFixed(1)}, ${s.position.y.toFixed(1)}, ${s.position.z.toFixed(1)})`;
  const goal = s.finished ? '已到家（565 Penn 公寓 9F）'
    : ['escape', 'detour', 'wading', 'blocked', 'driving', 'carblocked', 'parking'].includes(s.state) ? '565 Penn 公寓 9F 家'
      : s.state === 'indoor' ? '一层大堂' : s.state === 'outdoor' ? '楼前停车场 · 自己的车' : '—';
  $('dTarget').textContent = `${goal} · 已走 ${Math.round(s.travelled)} m`;
  $('dDepth').textContent = `${s.depth.toFixed(2)} m${s.floor > 1 ? '（上层楼板，不按街面积水计）' : ''}`;
  $('dReroutes').textContent = `${s.reroutes} 次`;
  // 决策留痕：选了哪个、备选各多少分
  const dec = (s.decisions && s.decisions.length) ? s.decisions[s.decisions.length - 1] : null;
  if (dec) {
    const opts = dec.options.map((o) => `${o.label} ${o.utility.toFixed(2)}`).join(' / ');
    $('dDecision').innerHTML = `<b>${dec.chosen}</b><br><span class="muted">${dec.situation}</span>`
      + `<br><span class="muted">候选：${opts}</span>`;
  } else {
    $('dDecision').textContent = '还没有需要判断的情况';
  }
  $('dInfo').textContent = s.info.length ? s.info.map((m) => `${clockText(m.t)} ${m.source}`).join('；') : '尚未收到预警';
  $('dStamina').textContent = `${s.stamina.toFixed(0)} / 100`;
  $('dHealth').textContent = `${s.health.toFixed(0)} / 100`;
  $('staminaBar').style.width = `${s.stamina}%`;
  $('healthBar').style.width = `${s.health}%`;
  $('healthBar').style.background = s.health < 35 ? '#df6d65' : '#65c3bb';
  $('eventList').innerHTML = s.events.slice(-8).reverse().map((e) => `<li><time>${clockText(e.t)}</time>${e.title}</li>`).join('');
}

function syncUi() {
  if (!story) return;
  $('timeRange').value = story.tMin;
  $('timeLabel').textContent = clockText(story.tMin);
  $('playBtn').textContent = playing ? '暂停' : '播放';
  $('stat').textContent = `${STATE_LABEL[story.state] || story.state} · ${story.trace.length} 个0.25秒轨迹点 · 统一仿真时钟`;
  updateDetails();
}

// 上车动作期间人还站在车边，进入 driving 才隐藏（坐进驾驶位）。
const IN_CAR = ['driving', 'carblocked', 'parking'];
let carSpin = 0;
const carPrevPos = new THREE.Vector3();
let carPrevHeading = 0;

function syncAgent(dt = 0) {
  if (!story || !agent) return;
  const inCar = IN_CAR.includes(story.state);
  if (markCar) {
    markCar.visible = true;
    if (story.state === 'driving' || story.state === 'carblocked') {
      const moved = carPrevPos.distanceTo(story.position);
      if (moved > 0.001 && moved < 6) {
        carSpin += moved / 0.32;      // 轮半径约 0.32 m
        const w = markCar.userData.wheels;
        if (w) {
          for (const k of ['fl', 'fr', 'bl', 'br']) if (w[k]) w[k].rotateX(moved / 0.32);
        }
      }
      carPrevPos.copy(story.position);
      // 前轮随转向偏一点（用航向变化率估算）
      let dh = story.heading - carPrevHeading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      carPrevHeading = story.heading;
      const steer = Math.max(-0.5, Math.min(0.5, dh * 4));
      const w2 = markCar.userData.wheels;
      if (w2 && w2.fl) w2.fl.rotation.y = steer;
      if (w2 && w2.fr) w2.fr.rotation.y = steer;
      markCar.position.set(story.position.x,
        story.position.y + (markCar.userData.yOffset || 0), story.position.z);
      markCar.rotation.y = story.heading;
    }
  }
  agent.visible = !inCar;
  if (story.state === 'boarding' && markCar) {
    // 站到驾驶侧车门外，不再和车模重叠
    agent.position.set(markCar.position.x - 1.55, story.position.y, markCar.position.z + 0.15);
    agent.rotation.y = -Math.PI / 2;
  } else {
    agent.position.copy(story.position);
    agent.rotation.y = story.heading;
  }
  if (mixer && dt > 0) mixer.update(dt);
  updateAnimation();
  updateMotionTransition();
  if (Math.abs(sitTarget - sitWeight) > 0.004) {
    const k = dt > 0 ? Math.min(1, dt * 6) : 1;
    sitWeight += (sitTarget - sitWeight) * k;
    poseDirty = true;
  }
  if (poseDirty) {
    // 先让混合器把动画姿势写回骨骼，再叠加坐姿，避免每帧累乘。
    if (mixer) mixer.update(0);
    applySitPose(sitWeight);
    poseDirty = false;
  }
  followLight.position.set(story.position.x, story.position.y + 2.5, story.position.z);
  updateLines();
  updateCamera();
  updateBubble();
  syncFlood();
  updateRain(dt);
}

function resetStory() {
  story.reset();
  currentFloodIndex = -1;
  lastTrackLength = -1;
  sitWeight = 0; sitTarget = 0; poseDirty = true;
  motionMode = 'idle'; pendingMotion = null; transAction = null;
  agent.position.copy(story.position);
  if (mixer) { mixer.stopAllAction(); currentAction = null; }
  motionMode = 'idle'; pendingMotion = null; transAction = null;
  playLoop('idle');
  setView('follow');
  updateCamera(true);
  syncAgent(0);
  syncUi();
}

function seekStory(target) {
  if (!story) return;
  const t = THREE.MathUtils.clamp(Number(target), OFFICE_STORY_START_MIN, OFFICE_STORY_END_MIN);
  playing = false;
  story.reset();
  story.step((t - OFFICE_STORY_START_MIN) * 60);
  currentFloodIndex = -1;
  lastTrackLength = -1;
  sitWeight = 0;
  sitTarget = 0;
  poseDirty = true;
  if (mixer) { mixer.stopAllAction(); currentAction = null; }
  updateAnimation();
  updateCamera(true);
  syncAgent(0);
  syncUi();
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toggleRecording() {
  if (recorder) {
    recorder.stop();
    return;
  }
  if (!window.MediaRecorder || !renderer.domElement.captureStream) {
    toast('当前浏览器不支持画布录制'); return;
  }
  const stream = renderer.domElement.captureStream(30);
  const chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = '马克的撤离.webm'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    recorder = null;
    $('recordBtn').textContent = '录制动画';
    toast('动画已导出；逐秒轨迹可另行下载');
  };
  recorder.start();
  $('recordBtn').textContent = '停止并导出';
  toast('开始录制当前跟随画面');
}

function bindUi() {
  $('playBtn').addEventListener('click', () => { playing = !playing; syncUi(); });
  $('stepBtn').addEventListener('click', () => { playing = false; story?.step(1 / 30); if (mixer) mixer.update(1 / 30); syncAgent(0); syncUi(); });
  $('resetBtn').addEventListener('click', () => { playing = false; resetStory(); });
  $('speedSel').addEventListener('change', () => { speed = Number($('speedSel').value); });
  $('timeRange').addEventListener('input', () => seekStory($('timeRange').value));
  $('downloadBtn').addEventListener('click', () => {
    if (!story) return;
    const s = story.snapshot();
    downloadJson('马克的撤离_逐秒轨迹.json', {
      schema: 'office-individual-trace-v1', seed: story.seed,
      coordinate: 'three.js: x/east, y/NAVD88+floor, z=-planY',
      fixedStepSeconds: 0.25, story: { name: s.name, age: s.age, occupation: s.occupation },
      events: s.events, information: s.info, trace: s.trace,
    });
  });
  $('recordBtn').addEventListener('click', toggleRecording);
  $('agentBubble').addEventListener('click', () => {
    $('agentCard').classList.toggle('open');
    updateDetails();
  });
  document.querySelectorAll('#views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  addEventListener('keydown', (e) => {
    if (e.target && ['INPUT', 'SELECT', 'BUTTON'].includes(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); playing = !playing; syncUi(); }
    else if (e.key === '.') { playing = false; story?.step(1 / 30); syncAgent(0); syncUi(); }
    else if (e.key.toLowerCase() === 'f') setView('follow');
  });
}

async function init() {
  bindUi();
  const T = await loadTerrain();
  let TEX = null;
  try { TEX = await loadCityTextures(); await prepareFacades(TEX); }
  catch (e) { console.warn('[office] 城市贴图降级', e); }
  try { T.roadCut = await loadRoadCut(); setRoadCut(T.roadCut); }
  catch (e) { console.warn('[office] roadCut 不可用', e); }
  const terrain = buildTerrainMesh(T, TEX ? { material: terrainMaterial(TEX) } : {});
  world.add(terrain);


  const B = await loadBuildings();
  const nearby = B.buildings.filter((b) => {
    if (b.id === OFFICE.id || b.id === HOME.id) return false;
    const c = b.center || [0, 0];
    return Math.hypot(c[0] - OFFICE.cx, c[1] - OFFICE.cz) < 650;
  });
  const marble = marbleMaterial();
  const blocks = buildBuildingMesh({ ...B, buildings: nearby }, TEX ? {
    materials: {
      wall: (k) => k === 'marble' ? marble : wallMaterial(TEX, k),
      roof: (k) => k === 'marble' ? marble : roofMaterial(TEX, k),
    },
  } : {});
  world.add(blocks);

  office = buildOfficeBuilding();
  world.add(office.group);
  const surface = await loadPedSurface();
  const net = await fetch('/assets/ped/walknet.json').then((r) => r.json());
  walk = buildWalkGraph(net, T, surface);
  office.exit.y = walk.groundAt(office.exit.x, office.exit.z);

  // 办公楼前的露天停车场：先铺场坪，再把车停进车位。
  let lot = null;
  try {
    lot = buildParkingLot((x, z) => T.sampleHeight(x, z));
    world.add(lot.group);
    console.log(`[props] 停车场 ${lot.stalls.length} 个车位`);
  } catch (e) { console.warn('[props] 停车场未生成', e?.message || e); }

  // 街边停车：CC0 车辆模型（Kenney Car Kit），失败就跳过，不影响主流程。
  try {
    const sedan = await new GLTFLoader().loadAsync('/assets/props/car_sedan.glb');
    const suv = await new GLTFLoader().loadAsync('/assets/props/car_suv.glb');
    const cars = new THREE.Group();
    cars.name = 'Parked_Cars';
    // 马克自己的车停在停车场里（南排最东一格），车头朝北。
    const south = (lot?.stalls || []).filter((s) => s.face > 0).sort((a, b) => b.x - a.x);
    const myStall = south[0] || { x: 2541.6, z: 385.2 };
    const parkSpot = [myStall.x, lot ? lot.groundY : 6.87, myStall.z];
    markCar = sedan.scene.clone(true);
    const mb = new THREE.Box3().setFromObject(markCar);
    const msize = mb.getSize(new THREE.Vector3());
    markCar.scale.setScalar(4.55 / Math.max(msize.z, msize.x));
    markCar.updateMatrixWorld(true);
    const mb2 = new THREE.Box3().setFromObject(markCar);
    // Kenney 车模带 4 个独立 wheel 节点，可以真的转起来
    const wheelNodes = { fl: null, fr: null, bl: null, br: null };
    markCar.traverse((o) => {
      const n = (o.name || '').toLowerCase();
      if (!n.includes('wheel')) return;
      const front = n.includes('front');
      const left = n.includes('left');
      wheelNodes[front ? (left ? 'fl' : 'fr') : (left ? 'bl' : 'br')] = o;
    });
    markCar.userData.wheels = wheelNodes;

    markCar.userData.yOffset = -mb2.min.y + 0.02;
    markCar.position.set(parkSpot[0], parkSpot[1] + markCar.userData.yOffset, parkSpot[2]);
    markCar.rotation.y = Math.PI;   // 车头朝北（车道在中间）
    window.__markStall = { x: myStall.x, z: myStall.z, y: parkSpot[1] };
    markCar.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    world.add(markCar);

    const spots = [];
    if (lot) {
      // 绕开马克那一格，其余车位隔几格停一辆
      const others = lot.stalls.filter((s) => !(Math.abs(s.x - myStall.x) < 0.1 && Math.abs(s.z - myStall.z) < 0.1));
      const picks = [0, 3, 7, 12, 18, 23].map((i) => others[i]).filter(Boolean);
      picks.forEach((s, i) => {
        spots.push([i % 2 ? suv : sedan, s.x, s.z, s.face > 0 ? Math.PI : 0]);
      });
    }
    spots.push([sedan, HOME.entryX - 12, HOME.cz - HOME.depth / 2 - 9.0, Math.PI]);
    spots.push([suv, HOME.entryX + 9, HOME.cz - HOME.depth / 2 - 9.0, Math.PI]);
    for (const [src, x, z, rot] of spots) {
      const car = src.scene.clone(true);
      const box = new THREE.Box3().setFromObject(car);
      const size = box.getSize(new THREE.Vector3());
      const s = 4.55 / Math.max(size.z, size.x);
      car.scale.setScalar(s);
      car.updateMatrixWorld(true);
      const b2 = new THREE.Box3().setFromObject(car);
      car.position.set(x, walk.groundAt(x, z) - b2.min.y + 0.02, z);
      car.rotation.y = rot;
      car.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      cars.add(car);
    }
    world.add(cars);
    console.log(`[props] 街边停车 ${spots.length} 辆`);
  } catch (e) { console.warn('[props] 车辆模型未加载', e?.message || e); }

  // 路面改由中心线现场铺：连续 ribbon + 路口补圆，替代原来一段段拼的离线 mesh。
  try {
    const localStreets = await fetch('/assets/roads/local_streets.json').then((r) => r.json());
    // 必须和积涝水面用同一个高度基准（T.sampleHeight）；walk.groundAt 会带路缘抬高，
    // 用它铺路会让路面浮在水面之上，整片积水都看不见。
    const localRoads = buildLocalRoads(localStreets, (x, z) => T.sampleHeight(x, z));
    world.add(localRoads);
    console.log(`[roads] 现场铺路 ${localStreets.ways.length} 条 way / ${localStreets.junctions.length} 个路口 / ${localRoads.userData.triCount} 三角`);
  } catch (e) { console.error('[office] 现场铺路失败', e); }

  // 公寓楼按实测体量重建；地面高度取建筑北门外的真实地形。
  const routeData = await fetch('/assets/ped/home_route.json').then((r) => r.json());
  // 楼板要压在 footprint 内最高地面之上：北侧比南侧高 3 m，取入口一点会把半栋楼埋掉。
  const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => [
    HOME.cx + sx * HOME.width / 2, HOME.cz + sz * HOME.depth / 2,
  ]);
  const homeGround = Math.max(
    ...corners.map(([x, z]) => walk.groundAt(x, z)),
    walk.groundAt(HOME.entryX, HOME.cz - HOME.depth / 2 - 1.5),
  );
  home = buildHomeBuilding(homeGround + 0.25);
  buildOfficeColliders(office.group);
  buildOfficeColliders(home.group);
  console.log(`[office] 相机碰撞盒 ${ocCount} 个`);
  world.add(home.group);

  flood = createFloodLayer(T, { base: '/assets/flood/' });
  world.add(flood.group);
  floodManifest = await flood.load();
  // 本场景不使用全城积涝面板；直接显示图层，时间轴由单一时钟驱动。
  flood.group.visible = true;
  for (const frame of floodManifest.frames) {
    const res = await fetch(floodManifest.root + frame.file);
    if (!res.ok) throw new Error(`积水帧加载失败 ${frame.file}: ${res.status}`);
    floodFrames.push(new Uint8Array(await res.arrayBuffer()));
  }

  // buildOfficeBuilding 返回的是场景对象，不含 OFFICE 元数据；故事层两者都要。
  story = new OfficeStory({
    office: { ...OFFICE, ...office },
    home: { ...HOME, ...home, name: HOME.name },
    routes: routeData,
    depthAt,
    groundAt: walk.groundAt,
    seed: 33,
    // ?profile=cautious / bold 可以换一套性格权重，其余场景完全一样
    // URL 里写 cautious / bold 即可，不必记住内部 key
    profile: PROFILES[({
      mark: 'mark', cautious: 'markCautious', bold: 'markBold',
    })[new URLSearchParams(location.search).get('profile')] || 'mark'] || PROFILES.mark,
  });
  makeLines();
  makeRain();

  const gltf = await new GLTFLoader().loadAsync('/assets/ped/office_worker.glb');
  agent = new THREE.Group();
  agent.name = 'MARK-JENSEN-001';
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const h = Math.max(0.1, box.max.y - box.min.y);
  const scale = 1.82 / h;
  model.scale.setScalar(scale);
  model.position.y = -box.min.y * scale;
  model.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) {
      o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
    }
    if (o.isBone) {
      const short = o.name.includes(':') ? o.name.split(':').pop() : o.name;
      bones[short] = o;
    }
  });
  sitRoot = new THREE.Group();
  sitRoot.name = 'Sit_Root';
  sitRoot.add(model);
  agent.add(sitRoot);
  world.add(agent);
  mixer = new THREE.AnimationMixer(model);
  for (const clip of gltf.animations) actions[clip.name] = mixer.clipAction(clip);
  console.log('[office-worker] clips', Object.keys(actions), 'bones', Object.keys(bones).length,
    'heightSource', h, 'scale', scale);
  setAnimation('idle');

  const params = new URLSearchParams(location.search);
  if (params.has('speed')) {
    speed = [1, 4, 12].includes(Number(params.get('speed'))) ? Number(params.get('speed')) : 1;
    $('speedSel').value = String(speed);
  }
  if (params.has('t')) seekStory(Number(params.get('t')));
  else resetStory();
  setView(params.get('view') || 'follow');
  playing = params.get('play') !== '0';
  if (params.get('details') === '1') $('agentCard').classList.add('open');
  syncAgent(0); syncUi(); updateCamera(true);
  $('loading').classList.add('done');

  window.__scene = scene;
  window.__agent = agent;
  window.__flood = flood;
  window.__office = office;
  window.__home = home;
  window.__officeStory = story;
  window.__officeSeek = seekStory;
  window.__officeSnapshot = () => story.snapshot();
  window.__officeDecisions = () => story.decisions;
  window.__officeDebug = () => ({
    clips: Object.keys(actions),
    action: currentAction?.getClip?.().name || null,
    sitWeight, state: story.state, pathName: story.pathName,
    view: viewMode, playing, speed,
    floodFrame: currentFloodIndex,
  });
  window.__setView = setView;
  window.__ready = true;
  console.log(`[office] ready · 单人 · ${office.group.userData.triCount} 办公三角 · ${home.group.userData.triCount} 公寓三角 · ${story.trace.length} 轨迹点`);
  last = performance.now();
  renderer.setAnimationLoop(animate);
}

function animate(now) {
  const realDt = Math.min(0.10, Math.max(0, (now - last) / 1000));
  last = now;
  if (story) {
    if (playing && !story.finished) {
      story.step(realDt * speed);
      syncAgent(realDt * speed);
      if (story.finished) { playing = false; syncUi(); }
    } else {
      syncAgent(0);
    }
    if (now - lastUi > 200) { syncUi(); lastUi = now; }
  }
  if (controls.enabled) controls.update();
  renderer.render(scene, camera);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

init().catch((e) => {
  console.error('[office] 初始化失败', e);
  $('loading').innerHTML = `场景初始化失败<small>${String(e.message || e)}</small>`;
  window.__officeError = String(e.stack || e);
});
