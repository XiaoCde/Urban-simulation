import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadTerrain, buildTerrainMesh, loadRoadCut, loadBuildings, buildBuildingMesh } from './terrain.js';
import { loadCityTextures, prepareFacades, wallMaterial, roofMaterial, marbleMaterial } from './citytex.js';
import { buildLocalRoads } from './roadribbon.js';
import { buildParkingLot } from './parking-lot.js';
import { setRoadCut } from './roadmesh.js';
import { createFloodLayer } from './flood.js';
import { loadPedSurface, buildWalkGraph } from './ped.js';
import { OFFICE, buildOfficeBuilding } from './office-building.js';
import { HOME, buildHomeBuilding } from './home-building.js';
import { CAFE, buildCafe, CLINIC, buildClinic, SCHOOL, buildSchool, SITE, buildSite } from './district-buildings.js';
import { OfficeStory } from './office-story.js';
import { PersonStory } from './district-story.js';

const $ = (id) => document.getElementById(id);

// 进度与错误都写到加载层：预览面板里如果 WebGL 或资源出问题，至少能看到原因，
// 而不是只看到一片黑。
let loadStep = 0;
function step(text) {
  loadStep += 1;
  const el = document.getElementById('loading');
  if (!el) return;
  const small = el.querySelector('small');
  if (small) small.textContent = `[${loadStep}] ${text}`;
}
window.addEventListener('error', (e) => {
  const el = document.getElementById('loading');
  if (el && !el.classList.contains('done')) {
    el.innerHTML = `加载出错：${e.message}<small>${e.filename || ''}:${e.lineno || ''}</small>`;
  }
});
const START_MIN = 52;
const END_MIN = 96;

/* ------------------------------------------------------------- 渲染基础 */
const app = $('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x6d7c86);
scene.fog = new THREE.Fog(0x6d7c86, 240, 1600);
const camera = new THREE.PerspectiveCamera(56, innerWidth / innerHeight, 0.06, 6000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1.2;
controls.maxDistance = 400;
controls.maxPolarAngle = Math.PI * 0.54;

scene.add(new THREE.HemisphereLight(0xc7d7e1, 0x3b4140, 1.45));
const sun = new THREE.DirectionalLight(0xe4edf2, 1.35);
sun.position.set(OFFICE.cx - 120, OFFICE.baseY + 150, OFFICE.cz + 90);
sun.target.position.set(OFFICE.cx, OFFICE.baseY, OFFICE.cz - 100);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -170, right: 170, top: 170, bottom: -170, near: 1, far: 420 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.00025;
scene.add(sun, sun.target);

const followLight = new THREE.PointLight(0xffeed2, 22, 14, 1.6);
scene.add(followLight);

const world = new THREE.Group();
world.name = 'District_World';
scene.add(world);

let office = null, home = null, cafe = null, clinic = null, school = null, site = null;
let flood = null, floodManifest = null, walkGraph = null, groundAt = () => 6;
let markCar = null;
let scooter = null;
let scooterPlaced = false;
let currentFloodIndex = -1;
let clockMin = START_MIN;
let playing = true;
let speed = 4;
let viewMode = 'follow';
let selectedKey = 'mark';
let last = performance.now();
let detailStamp = 0;

const actors = new Map();

/* ------------------------------------------------------------- 人物表 */
const ROSTER = [
  {
    key: 'mark', name: '马克·詹森', age: 36, occupation: '工程咨询公司项目职员',
    tag: '手机 17:54 才看到预警 · 有车', color: '#6fc3dd', model: '/assets/ped/office_worker.glb', height: 1.82,
  },
  {
    key: 'boss', name: '罗伯特·惠特克', age: 58, occupation: '公司合伙人',
    tag: '会议静音，最后收到消息 · 责任约束', color: '#d8b45c', model: '/assets/ped/char_boss.glb', height: 1.99,
  },
  {
    key: 'doctor', name: '大卫·帕特尔', age: 41, occupation: '外科医生',
    tag: '手术进行中，不能走', color: '#e08a7a', model: '/assets/ped/char_doctor.glb', height: 1.78,
  },
  {
    key: 'worker', name: '路易斯·拉米雷斯', age: 45, occupation: '钢筋工',
    tag: '从工头那里最早知道 · 基坑汇水', color: '#8fbf7a', model: '/assets/ped/char_worker.glb', height: 1.79,
  },
  {
    key: 'woman', name: '艾米·陈', age: 29, occupation: 'Pavilion 咖啡馆店员',
    tag: '最早收到消息 · 路线没被淹', color: '#d59ad0', model: '/assets/ped/char_woman.glb', height: 1.68,
  },
  {
    key: 'rider', name: '泰瑞尔·杰克逊', age: 24, occupation: '外卖骑手',
    tag: '戴耳机，几乎收不到预警', color: '#7ea6e0', model: '/assets/ped/char_rider.glb', height: 1.83,
  },
  {
    key: 'girl', name: '索菲亚·马丁内斯', age: 9, occupation: '小学三年级',
    tag: '没有手机，只能听老师的', color: '#efc46a', model: '/assets/ped/char_girl.glb', height: 1.47,
  },
];

const STATE_CN = {
  working: '在手头的事情上', notice: '注意到预警', window: '在窗边看雨', calling: '打电话',
  handover: '交接工作', packing: '收拾东西', preparing: '准备离开', indoor: '在楼梯间',
  outdoor: '在室外', boarding: '上车', driving: '开车', carblocked: '被淹水挡住', parking: '停车',
  observing: '停下观察', escape: '撤离', blocked: '被深水挡住', detour: '绕行', wading: '涉水',
  arrive: '抵达', elevator: '乘电梯', home: '到家', safe: '安全', sheltered: '就地避险',
  operating: '在做手术', informed: '得知外面在淹水', continuing: '继续手术', power: '停电切备用电源',
  closing: '收尾缝合', instructing: '让团队先走', returning: '退回楼上', radio: '听到工头喊话',
  climbing: '从基坑撤出', texting: '收到老板短信', locking: '锁门', walking: '走回家',
  riding: '骑车送单', sheltering: '跑进楼里', class: '在上课', lining: '排队清点',
  evacuating: '跟着队伍上楼',
  waiting: '等待家长', idle: '在等单',
};

/* ------------------------------------------------------------- 角色实例 */
const LOOP_CLIPS = new Set(['walk', 'run', 'stairs_down', 'stairs_up', 'idle', 'idle2', 'look', 'crouch', 'sit', 'crawl']);

let blobTexture = null;
function getBlobTexture() {
  if (blobTexture) return blobTexture;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 6, 64, 64, 62);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)');
  grd.addColorStop(0.55, 'rgba(0,0,0,0.22)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  blobTexture = new THREE.CanvasTexture(c);
  blobTexture.colorSpace = THREE.SRGBColorSpace;
  return blobTexture;
}

function makeActor(def, gltf, poseOverrides = {}) {
  const root = new THREE.Group();
  root.name = `actor_${def.key}`;
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const h = Math.max(0.1, box.max.y - box.min.y);
  // 按真实身高缩放；不能一律 1.82 m，否则小女孩会变成成年人那么高
  const scale = def.height / h;
  model.scale.setScalar(scale);
  model.position.y = -box.min.y * scale;
  model.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) {
      o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
    }
  });
  root.add(model);
  world.add(root);

  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  for (const clip of gltf.animations) actions[clip.name] = mixer.clipAction(clip);

  // 骨骼缓存：Mixamo 导出的前缀每个角色都不一样（mixamorig7 / mixamorig9 …），
  // 所以按名字后缀找，不能写死全名。
  const bones = {};
  const want = {
    hips: 'Hips', spine: 'Spine1', leftUpLeg: 'LeftUpLeg', rightUpLeg: 'RightUpLeg',
    leftLeg: 'LeftLeg', rightLeg: 'RightLeg', leftFoot: 'LeftFoot', rightFoot: 'RightFoot',
    leftArm: 'LeftArm', rightArm: 'RightArm', leftHand: 'LeftHand', rightHand: 'RightHand',
    leftForeArm: 'LeftForeArm', rightForeArm: 'RightForeArm',
  };
  model.traverse((o) => {
    if (!o.isBone) return;
    // GLTFLoader 会把节点名里的冒号去掉：mixamorig9:Hips → mixamorig9Hips。
    // 所以必须按“去掉前缀再比”，不能 split(':')——上一版就是这里匹配不到，骨骼全是空的。
    const n = o.name.replace(/^mixamorig\d*/i, '');
    for (const [k, suffix] of Object.entries(want)) {
      if (n === suffix) bones[k] = o;
    }
  });
  console.log(`[bones] ${def.key} ${Object.keys(bones).length} 根`);

  // 接触阴影：没有它人物像贴在画面上飘着
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(1.15, 1.15),
    new THREE.MeshBasicMaterial({ map: getBlobTexture(), transparent: true, depthWrite: false, opacity: 0.9 }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.renderOrder = 2;
  scene.add(blob);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.style.setProperty('--b', def.color);
  document.body.appendChild(bubble);

  actors.set(def.key, {
    def, root, model, mixer, actions, bubble, blob, bones,
    current: null, motion: 'idle', pending: null, trans: null,
    poseOverrides, poseKey: null,
  });
}

function playLoop(a, name) {
  const act = a.actions[name];
  if (!act || a.current === act) return;
  act.reset();
  act.setLoop(THREE.LoopRepeat, Infinity);
  act.clampWhenFinished = false;
  act.setEffectiveTimeScale(1).setEffectiveWeight(1);
  if (a.current) act.crossFadeFrom(a.current, 0.16, false);
  act.play();
  a.current = act;
  a.mixer.update(0);
}

function playTransition(a, clip, next) {
  const act = a.actions[clip];
  if (!act) { playLoop(a, next); a.motion = next; return; }
  act.reset();
  act.setLoop(THREE.LoopOnce, 1);
  act.clampWhenFinished = true;
  act.setEffectiveTimeScale(1).setEffectiveWeight(1);
  if (a.current && a.current !== act) act.crossFadeFrom(a.current, 0.08, false);
  act.play();
  a.current = act;
  a.pending = next;
  a.trans = act;
  a.mixer.update(0);
}

function setMotion(a, next) {
  if (next === a.motion || a.pending === next) return;
  if (a.motion === 'idle' && (next === 'walk' || next === 'run') && a.actions.start) {
    playTransition(a, 'start', next);
    return;
  }
  if (next === 'idle' && (a.motion === 'walk' || a.motion === 'run')) {
    const clip = a.motion === 'run' && a.actions.run_stop ? 'run_stop' : 'stop';
    if (a.actions[clip]) { playTransition(a, clip, 'idle'); return; }
  }
  playLoop(a, next);
  a.motion = next;
}

function finishTransition(a) {
  if (!a.pending || !a.trans) return;
  const clip = a.trans.getClip();
  if (a.trans.time >= clip.duration - 0.03) {
    const next = a.pending;
    a.pending = null;
    a.trans = null;
    playLoop(a, next);
    a.motion = next;
  }
}

/** 站立/坐下的姿势按状态挑，行走按实时速度挑。 */
function updateActorAnim(a, st) {
  // 骑在电动车上时用坐姿，不能一边骑车一边跑
  if (st.state === 'riding') {
    // 姿势由 seatRiderOnScooter() 按世界方向摆；这里只保证是不动的站姿底子。
    a.pending = null; a.trans = null; a.motion = 'idle'; a.poseKey = 'ride';
    playLoop(a, 'idle');
    return;
  }
  const moving = st.speed > 0.25 && st.pathLength > 0;
  if (moving) {
    const onStairs = st.onStairs;
    if (onStairs) {
      a.pending = null; a.trans = null; a.motion = 'walk';
      playLoop(a, a.actions.stairs_down ? 'stairs_down' : 'walk');
      return;
    }
    if (st.speed > 3.2 && a.actions.run) setMotion(a, 'run');
    else setMotion(a, 'walk');
    return;
  }
  setMotion(a, 'idle');
  if (a.pending) return;

  const pose = a.poseOverrides[st.state]
    || (st.state === 'blocked' || st.state === 'observing' ? 'look'
      : st.state === 'sheltered' || st.state === 'safe' ? 'idle'
        : st.state === 'wading' ? 'walk'
          : st.state === 'waiting' || st.state === 'class' || st.state === 'working' ? 'sit'
            : 'idle');
  if (a.poseKey !== pose) {
    a.poseKey = pose;
    playLoop(a, pose);
  }
}

/* ------------------------------------------------------------- 建筑装配 */
function buildBossOffice() {
  // 六层西端给他隔出一间玻璃办公室：真实墙角 + 玻璃隔断，人物可以自由进出。
  const g = new THREE.Group();
  g.name = 'Boss_Corner_Office';
  const y = OFFICE.baseY + 5 * OFFICE.floorH;
  const x0 = OFFICE.cx - 62.4; const x1 = OFFICE.cx - 54.4;
  const z0 = OFFICE.cz - 13.4; const z1 = OFFICE.cz - 6.2;
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x9dc0cc, roughness: 0.12, metalness: 0.05, transparent: true,
    opacity: 0.28, depthWrite: false, side: THREE.DoubleSide,
  });
  const frame = new THREE.MeshStandardMaterial({ color: 0x6c757a, roughness: 0.4, metalness: 0.6 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x7d5c3e, roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b3338, roughness: 0.5 });
  const fabric = new THREE.MeshStandardMaterial({ color: 0x37474f, roughness: 0.95 });

  const panel = (cx, cz, w, d, h = 2.6) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), glass);
    m.position.set(cx, y + h / 2, cz);
    g.add(m);
    const top = new THREE.Mesh(new THREE.BoxGeometry(w + 0.06, 0.07, d + 0.06), frame);
    top.position.set(cx, y + h, cz);
    g.add(top);
  };
  // 南侧玻璃（中间留 1.2 m 门）
  panel((x0 + (OFFICE.cx - 58.0)) / 2, z1, Math.abs(OFFICE.cx - 58.0 - x0), 0.06);
  panel(((OFFICE.cx - 56.8) + x1) / 2, z1, Math.abs(x1 - (OFFICE.cx - 56.8)), 0.06);
  panel(x0, (z0 + z1) / 2, 0.06, z1 - z0);
  panel(OFFICE.cx - 58.0, (z0 + z1) / 2, 0.06, z1 - z0);

  // 办公桌、转椅、书柜、会客椅
  const desk = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.08, 1.1), wood);
  desk.position.set(OFFICE.cx - 58.0, y + 0.74, z0 + 1.9);
  g.add(desk);
  for (const dx of [-1.15, 1.15]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.72, 0.85), dark);
    leg.position.set(OFFICE.cx - 58.0 + dx, y + 0.36, z0 + 1.9);
    g.add(leg);
  }
  const chair = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.12, 0.6), fabric);
  chair.position.set(OFFICE.cx - 58.0, y + 0.46, z0 + 2.9);
  g.add(chair);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.7, 0.1), fabric);
  back.position.set(OFFICE.cx - 58.0, y + 0.82, z0 + 3.2);
  g.add(back);
  const cabinet = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.0, 3.2), dark);
  cabinet.position.set(x1 - 0.4, y + 1.0, z0 + 2.4);
  g.add(cabinet);
  for (const dz of [-2.2, 2.2]) {
    const sofa = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.45, 1.8), fabric);
    sofa.position.set(x0 + 1.4, y + 0.24, z0 + 2.4 + dz);
    g.add(sofa);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

/**
 * 外卖电动车：项目里没有现成模型，这里用基本几何体搭一台。
 * 车轮、踏板、座垫、车把、后箱齐全，能看出是送外卖的电动车而不是自行车。
 */
function buildScooter() {
  const g = new THREE.Group();
  g.name = 'Delivery_Scooter';

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.42, metalness: 0.3 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1e2226, roughness: 0.65, metalness: 0.25 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x15181a, roughness: 0.92 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xa8afb3, roughness: 0.32, metalness: 0.85 });
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x191c1f, roughness: 0.78 });
  const boxMat = new THREE.MeshStandardMaterial({ color: 0xe0a72a, roughness: 0.68 });
  const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xffe9a8, emissiveIntensity: 1.5 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x7d1a12, emissive: 0xd83a24, emissiveIntensity: 1.0, roughness: 0.5 });

  // 车轮：轮胎 + 轮毂 + 挡泥板（半圆环）
  const wheels = [];
  const makeWheel = (z) => {
    const w = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(0.255, 0.255, 0.095, 20), rubber);
    tire.rotation.z = Math.PI / 2;
    w.add(tire);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.1, 16), metal);
    rim.rotation.z = Math.PI / 2;
    w.add(rim);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.115, 10), darkMat);
    hub.rotation.z = Math.PI / 2;
    w.add(hub);
    w.position.set(0, 0.255, z);
    g.add(w);
    wheels.push(w);

    const fender = new THREE.Mesh(new THREE.TorusGeometry(0.30, 0.045, 6, 16, Math.PI * 0.95), bodyMat);
    fender.rotation.y = Math.PI / 2;
    fender.rotation.z = Math.PI * 0.02;
    fender.position.set(0, 0.255, z);
    g.add(fender);
  };
  makeWheel(0.58);
  makeWheel(-0.58);

  // 踏板与侧裙：把前后轮连起来，别让车看起来是几块积木
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.07, 1.0), darkMat);
  deck.position.set(0, 0.33, 0.02);
  g.add(deck);
  for (const sx of [-1, 1]) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.86), bodyMat);
    skirt.position.set(sx * 0.175, 0.27, 0.02);
    g.add(skirt);
  }

  // 车身：座桶 + 座垫
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.40, 0.52), bodyMat);
  body.position.set(0, 0.56, -0.30);
  g.add(body);
  const seatBase = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.10, 0.30), bodyMat);
  seatBase.position.set(0, 0.74, -0.02);
  g.add(seatBase);
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.09, 0.64), seatMat);
  saddle.position.set(0, 0.80, -0.24);
  g.add(saddle);
  const seatBack = new THREE.Mesh(new THREE.BoxGeometry(0.29, 0.10, 0.09), seatMat);
  seatBack.position.set(0, 0.85, -0.55);
  g.add(seatBack);

  // 前脸：斜的护腿板 + 转向柱 + 前叉
  const apron = new THREE.Mesh(new THREE.BoxGeometry(0.33, 0.66, 0.11), bodyMat);
  apron.position.set(0, 0.62, 0.50);
  apron.rotation.x = -0.14;
  g.add(apron);
  const column = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.50, 0.075), metal);
  column.position.set(0, 0.93, 0.53);
  column.rotation.x = -0.16;
  g.add(column);
  for (const sx of [-1, 1]) {
    const fork = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.52, 0.045), metal);
    fork.position.set(sx * 0.085, 0.52, 0.575);
    fork.rotation.x = -0.1;
    g.add(fork);
  }

  // 车把 + 握把 + 后视镜
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.045, 0.045), darkMat);
  bar.position.set(0, 1.12, 0.50);
  g.add(bar);
  for (const sx of [-1, 1]) {
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.055, 0.055), seatMat);
    grip.position.set(sx * 0.26, 1.12, 0.50);
    g.add(grip);
    const stem = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.16, 0.02), metal);
    stem.position.set(sx * 0.21, 1.20, 0.50);
    stem.rotation.z = sx * 0.28;
    g.add(stem);
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.07, 0.02), darkMat);
    mirror.position.set(sx * 0.26, 1.28, 0.50);
    g.add(mirror);
  }

  // 前灯、后视镜支架
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.10, 0.05), lightMat);
  head.position.set(0, 0.93, 0.565);
  g.add(head);
  const headRim = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.13, 0.03), darkMat);
  headRim.position.set(0, 0.93, 0.545);
  g.add(headRim);

  // 后货架 + 送餐箱（低于肩高，别从背后挡住骑手）
  const rack = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.04, 0.34), metal);
  rack.position.set(0, 0.84, -0.72);
  g.add(rack);
  for (const sx of [-1, 1]) {
    const stay = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.30, 0.03), metal);
    stay.position.set(sx * 0.14, 0.70, -0.70);
    g.add(stay);
  }
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.34, 0.34), boxMat);
  box.position.set(0, 1.02, -0.72);
  g.add(box);
  const lid = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.04, 0.36), darkMat);
  lid.position.set(0, 1.20, -0.72);
  g.add(lid);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.05, 0.03), tailMat);
  tail.position.set(0, 0.80, -0.90);
  g.add(tail);

  // 侧撑
  const stand = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.34, 0.04), metal);
  stand.position.set(-0.19, 0.16, -0.18);
  stand.rotation.z = 0.28;
  g.add(stand);

  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.userData.wheels = wheels;
  return g;
}

/**
 * 相机碰撞：直接从建筑里已经生成好的 InstancedMesh 反推 AABB。
 * 不再手写碰撞体，省得两边坐标对不上——只要模型里有墙和家具，这里就一定有。
 * 过滤条件：太薄的水平板（地板、吊顶、灯带）和太细的杆件不参与，
 * 否则镜头会被地板挡住或者被一根踢脚线卡死。
 */
const CELL = 5;
const colliderGrid = new Map();
let colliderCount = 0;

function colliderKey(cx, cz) { return `${cx},${cz}`; }

function collectColliders(root) {
  const m = new THREE.Matrix4();
  const add = (box) => {
    const cx0 = Math.floor(box.x0 / CELL); const cx1 = Math.floor(box.x1 / CELL);
    const cz0 = Math.floor(box.z0 / CELL); const cz1 = Math.floor(box.z1 / CELL);
    for (let cx = cx0; cx <= cx1; cx += 1) {
      for (let cz = cz0; cz <= cz1; cz += 1) {
        const k = colliderKey(cx, cz);
        let arr = colliderGrid.get(k);
        if (!arr) { arr = []; colliderGrid.set(k, arr); }
        arr.push(box);
      }
    }
    colliderCount += 1;
  };
  root.traverse((o) => {
    if (!o.isInstancedMesh) return;
    for (let i = 0; i < o.count; i += 1) {
      o.getMatrixAt(i, m);
      const e = m.elements;
      const sx = Math.abs(e[0]); const sy = Math.abs(e[5]); const sz = Math.abs(e[10]);
      // 只排除“薄的水平板”（地板、吊顶、灯带、踢脚线）；竖着的薄墙必须算进来，
      // 上一版按 sx/sz>=0.2 过滤，把 0.16 m 厚的隔墙全滤掉了，镜头直接穿墙进黑区。
      if (sy < 0.25) continue;
      if (sx < 0.05 || sz < 0.05) continue;
      const x = e[12]; const y = e[13]; const z = e[14];
      add({ x0: x - sx / 2, x1: x + sx / 2, y0: y - sy / 2, y1: y + sy / 2, z0: z - sz / 2, z1: z + sz / 2 });
    }
  });
}

function blockedAt(x, y, z, pad = 0.2) {
  const cx = Math.floor(x / CELL); const cz = Math.floor(z / CELL);
  for (let i = -1; i <= 1; i += 1) {
    for (let j = -1; j <= 1; j += 1) {
      const arr = colliderGrid.get(colliderKey(cx + i, cz + j));
      if (!arr) continue;
      for (const b of arr) {
        if (x > b.x0 - pad && x < b.x1 + pad
          && y > b.y0 - pad && y < b.y1 + pad
          && z > b.z0 - pad && z < b.z1 + pad) return true;
      }
    }
  }
  return false;
}

/** 把相机从目标点往外推，遇到第一堵墙就停住。 */
function resolveCamera(target, desired, minDist = 0.9) {
  const steps = 14;
  let last = target.clone();
  for (let i = 1; i <= steps; i += 1) {
    const p = target.clone().lerp(desired, i / steps);
    if (blockedAt(p.x, p.y, p.z, 0.24)) break;
    last.copy(p);
  }
  if (last.distanceTo(target) < minDist) last.copy(target).lerp(desired, minDist / target.distanceTo(desired));
  return last;
}

/* ------------------------------------------------------------- 初始化 */
async function init() {
  step('读取地形与高程');
  const T = await loadTerrain();
  let TEX = null;
  try { TEX = await loadCityTextures(); await prepareFacades(TEX); } catch (e) { console.warn('[district] 贴图降级', e); }
  try { T.roadCut = await loadRoadCut(); setRoadCut(T.roadCut); } catch (e) { console.warn('[district] roadCut 不可用', e); }

  world.add(buildTerrainMesh(T, TEX ? { material: (await import('./citytex.js')).terrainMaterial(TEX) } : {}));

  step('读取建筑与贴图');
  const B = await loadBuildings();
  const skipIds = new Set([OFFICE.id, HOME.id, CAFE.id, CLINIC.id, SCHOOL.id]);
  const nearby = B.buildings.filter((b) => {
    if (skipIds.has(b.id)) return false;
    const c = b.center || [0, 0];
    return Math.hypot(c[0] - 2500, c[1] - 0) < 420;
  });
  const marble = marbleMaterial();
  world.add(buildBuildingMesh({ ...B, buildings: nearby }, TEX ? {
    materials: {
      wall: (k) => (k === 'marble' ? marble : wallMaterial(TEX, k)),
      roof: (k) => (k === 'marble' ? marble : roofMaterial(TEX, k)),
    },
  } : {}));

  const surface = await loadPedSurface();
  const net = await fetch('/assets/ped/walknet.json').then((r) => r.json());
  walkGraph = buildWalkGraph(net, T, surface);
  groundAt = (x, z) => T.sampleHeight(x, z);

  // 路面与停车场沿用单人场景的做法
  try {
    const localStreets = await fetch('/assets/roads/local_streets.json').then((r) => r.json());
    world.add(buildLocalRoads(localStreets, (x, z) => T.sampleHeight(x, z)));
  } catch (e) { console.warn('[district] 铺路失败', e); }
  try {
    const lot = buildParkingLot((x, z) => T.sampleHeight(x, z));
    world.add(lot.group);
  } catch (e) { console.warn('[district] 停车场失败', e); }

  step('搭建办公楼、公寓、咖啡馆、诊所、学校、工地');
  office = buildOfficeBuilding();
  world.add(office.group);
  office.exit.y = T.sampleHeight(office.exit.x, office.exit.z);
  world.add(buildBossOffice());

  const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => [
    HOME.cx + (sx * HOME.width) / 2, HOME.cz + (sz * HOME.depth) / 2,
  ]);
  const homeGround = Math.max(...corners.map(([x, z]) => T.sampleHeight(x, z)));
  home = buildHomeBuilding(homeGround + 0.25);
  world.add(home.group);

  cafe = buildCafe(T.sampleHeight(CAFE.cx, CAFE.cz));
  world.add(cafe.group);
  clinic = buildClinic(T.sampleHeight(CLINIC.cx, CLINIC.cz));
  world.add(clinic.group);
  school = buildSchool(T.sampleHeight(SCHOOL.cx, SCHOOL.cz));
  world.add(school.group);
  // 地块内高差 1.5 m，平台必须压到最高点之上，否则地形会从场坪里顶出来
  let siteY = -Infinity;
  for (let dx = -30; dx <= 30; dx += 10) {
    for (let dz = -24; dz <= 24; dz += 8) {
      siteY = Math.max(siteY, T.sampleHeight(SITE.cx + dx, SITE.cz + dz));
    }
  }
  site = buildSite(siteY + 0.12);
  world.add(site.group);
  console.log(`[district] 建筑三角 诊所${clinic.tris} 咖啡${cafe.tris} 学校${school.tris} 工地${site.tris}`);

  // 相机碰撞集合：四座新建筑 + 办公楼 + 公寓
  for (const g of [office.group, home.group, cafe.group, clinic.group, school.group, site.group]) {
    if (g) collectColliders(g);
  }
  console.log(`[district] 相机碰撞盒 ${colliderCount} 个 / ${colliderGrid.size} 个网格`);

  step('读取积涝序列');
  flood = createFloodLayer(T, { base: '/assets/flood/' });
  floodManifest = await flood.load();
  // 这个页面没有积涝自己的时间轴 HUD（那个控件只存在于全城页），直接控制 group 可见性，
  // 不能调 setVisible(true)：它会去写 hud.range.max，而 hud.range 在这里是 null。
  world.add(flood.group);
  flood.group.visible = true;

  const depthAt = (x, z) => flood.depthAt(x, z);

  // 数据：马克的两条老路线 + 三条新路线
  const [homeRoutes, districtRoutes] = await Promise.all([
    fetch('/assets/ped/home_route.json').then((r) => r.json()),
    fetch('/assets/ped/district_routes.json').then((r) => r.json()),
  ]);

  /* ---- 马克：沿用单人版的完整故事 ---- */
  const markStory = new OfficeStory({
    // home 必须是 { ...HOME, ...home }：buildHomeBuilding 只返回 group/route/baseY，
    // 少了 entryX / cz / depth 会让 walkIn 目标变成 NaN，人物原地“抵达”22 分钟。
    office: { ...office, ...OFFICE },
    home: { ...HOME, ...home, name: HOME.name },
    routes: homeRoutes, depthAt, groundAt: T.sampleHeight, seed: 33,
  });
  markStory.tMin = START_MIN;
  const stories = { mark: markStory };

  /* ---- 老板：六层玻璃办公室 → 一层大堂 → 退回三层 ---- */
  const ir = office.indoorRoute;
  const iCorridor = Math.max(0, ir.findIndex((w) => w.label === '进入6F走廊'));
  const iLobby = ir.findIndex((w) => w.floor === 1);
  const y6 = OFFICE.baseY + 5 * OFFICE.floorH;
  const y3 = OFFICE.baseY + 2 * OFFICE.floorH;
  const bossDown = [
    { p: [OFFICE.cx - 58.0, y6, OFFICE.cz - 10.2], kind: 'walk', floor: 6, label: '办公室' },
    { p: [OFFICE.cx - 55.6, y6, OFFICE.cz - 9.8], kind: 'walk', floor: 6, label: '走出玻璃门' },
    { p: [OFFICE.cx - 55.6, y6, OFFICE.cz], kind: 'walk', floor: 6, label: '进入6F走廊' },
    { p: [OFFICE.cx - 44.0, y6, OFFICE.cz], kind: 'walk', floor: 6, label: '沿走廊向东' },
    ...ir.slice(iCorridor, iLobby + 4).map((w) => ({
      p: [w.p.x, w.p.y, w.p.z], kind: w.kind, floor: w.floor, label: w.label,
    })),
  ];
  const bossBackCore = ir.slice(iCorridor, iLobby + 4).reverse();
  let cut3 = bossBackCore.length - 1;
  for (let i = 0; i < bossBackCore.length; i += 1) {
    if (bossBackCore[i].floor <= 3) { cut3 = i; break; }
  }
  const bossBack = [
    ...bossBackCore.slice(0, cut3 + 1).map((w) => ({ p: [w.p.x, w.p.y, w.p.z], kind: w.kind, floor: w.floor, label: w.label })),
    { p: [OFFICE.cx - 22.0, y3, OFFICE.cz], kind: 'walk', floor: 3, label: '三层走廊' },
    { p: [OFFICE.cx - 22.0, y3, OFFICE.cz + 7.5], kind: 'walk', floor: 3, label: '三层会议室' },
  ];

  const boss = new PersonStory({
    id: 'BOSS-001', name: '罗伯特·惠特克', age: 58, occupation: '公司合伙人',
    tag: '最后离开', intro: '季度会议刚散，手机静音；他要等团队走完才肯走。',
    start: new THREE.Vector3(OFFICE.cx - 58.0, y6, OFFICE.cz - 10.2),
    floor: 6, heading: 0, baseY: OFFICE.baseY, floorH: OFFICE.floorH,
    routes: { bossDown, bossBack },
    depthAt, states: STATE_CN,
    script: [
      { at: 52.3, state: 'working', reason: '季度会议刚散，他在整理明天要交的材料', hold: 1.4 },
      {
        at: 53.8, state: 'calling', hold: 1.3,
        info: ['秘书电话', '大楼物业通知：地下车库开始进水，建议尽快离开'],
        reason: '他的手机在会议里一直静音，这是今天第一条预警',
        event: ['information', '比马克晚 4 分钟知道', '他的手机静音；同一栋楼里，信息到达时间也不一样'],
      },
      {
        at: 55.3, state: 'instructing', hold: 1.5,
        reason: '他让还在加班的五个人立刻走，自己留下收尾',
        event: ['decision', '让团队先走', '五名员工先下楼；他回办公室取硬盘和纸质合同'],
      },
      { at: 57.1, state: 'packing', hold: 1.1, reason: '保险柜里有客户资料，他不想把这些留在这里' },
      { at: 58.5, state: 'indoor', path: 'bossDown', speed: 'walk', reason: '电梯停了，他从六层走楼梯下去' },
      {
        at: 0, state: 'observing', hold: 2.0,
        reason: '一层大堂门口的水已经漫进来，踩下去到脚踝',
        event: ['observation', '一层大堂进水', '门口约 0.1 m，外面街上更深；他没有雨具，车在地下车库'],
      },
      { at: 0, state: 'returning', path: 'bossBack', speed: 'walk', reason: '他判断硬走出去更危险，退回楼上等救援' },
      { at: 0, state: 'sheltered', finish: true, outcome: 'sheltered', summary: '退到三层会议室，和物业一起等消防上来' },
    ],
  });

  /* ---- 医生：二层手术室 ---- */
  const clinicDoorIdx = Math.max(0, clinic.route.findIndex((w) => w.label === '走到门口看水情'));
  const clinicDown = clinic.route.slice(0, clinicDoorIdx + 1).map((w) => ({
    p: [w.p.x, w.p.y, w.p.z], kind: w.kind, floor: w.floor, label: w.label,
  }));
  const clinicBack = clinic.route.slice(clinicDoorIdx + 1).map((w) => ({
    p: [w.p.x, w.p.y, w.p.z], kind: w.kind, floor: w.floor, label: w.label,
  }));

  const doctor = new PersonStory({
    id: 'DOCTOR-001', name: '大卫·帕特尔', age: 41, occupation: '外科医生',
    tag: '手术进行中', intro: '一台急性阑尾切除正在做，病人已经开腹。',
    start: clinic.start.clone(), floor: 2, heading: 0,
    baseY: CLINIC.baseY, floorH: CLINIC.floorH,
    routes: { clinicDown, clinicBack }, depthAt, states: STATE_CN,
    script: [
      { at: 52.2, state: 'operating', reason: '一台急性阑尾切除正在进行，病人已经开腹', hold: 1.9 },
      {
        at: 54.1, state: 'informed', hold: 1.2,
        info: ['医院广播', '暴雨红色预警：一楼大厅开始进水，非必要人员不要外出'],
        reason: '护士在手术室门口转达，他手上的动作没有停',
      },
      {
        at: 55.4, state: 'continuing', hold: 2.4,
        reason: '手术做到一半，转运病人的风险比继续做完更高；他决定不中断',
        event: ['decision', '决定不中断手术', '他让护士把一楼的文件和药品搬到二楼，自己继续'],
      },
      {
        at: 61.0, state: 'power', hold: 1.6,
        info: ['护士报告', '市电中断，备用电源只够照明和监护仪，电梯停运'],
        reason: '无影灯闪了一下，他让护士用手电补光',
      },
      { at: 63.0, state: 'closing', hold: 1.6, reason: '手术完成，开始缝合' },
      { at: 64.8, state: 'indoor', path: 'clinicDown', speed: 'walk', reason: '他想亲眼看一眼楼下的水，判断要不要把病人往楼上转' },
      {
        at: 0, state: 'observing', hold: 2.2,
        reason: '一层门口的水已经进到分诊台，外面街道更深',
        event: ['observation', '一层进水', '门口约 0.15 m；他判断二层暂时安全，决定不动病人'],
      },
      { at: 0, state: 'returning', path: 'clinicBack', speed: 'walk', reason: '病人还在二层恢复区，他必须回去' },
      { at: 0, state: 'sheltered', finish: true, outcome: 'sheltered', summary: '留在二层恢复区守着病人，等救援队上来' },
    ],
  });

  /* ---- 钢筋工：工地围护区 ---- */
  const worker = new PersonStory({
    id: 'WORKER-001', name: '路易斯·拉米雷斯', age: 45, occupation: '钢筋工',
    tag: '最早知道', intro: '三层底板钢筋今天必须绑完，泵已经停了。',
    start: site.start.clone(), floor: 1, heading: 0,
    baseY: SITE.baseY, floorH: 4,
    routes: { siteOut: site.route.map((w) => ({ p: [w.p.x, w.p.y, w.p.z], kind: w.kind, floor: w.floor, label: w.label })) },
    // 基坑是模型 6 m 网格之外的低点：这一处用局部汇水，水面按时间上升
    depthAt: (x, z) => {
      const inside = Math.abs(x - SITE.cx) < SITE.width / 2 && Math.abs(z - SITE.cz) < SITE.depth / 2;
      if (inside) {
        const t = Math.max(0, Math.min(1, (clockMin - 53) / 14));
        return 0.06 + t * 1.05;
      }
      return flood.depthAt(x, z);
    },
    states: STATE_CN,
    script: [
      { at: 52.0, state: 'working', reason: '三层底板钢筋今天必须绑完，雨已经下了一阵', hold: 1.3 },
      {
        at: 53.3, state: 'radio', hold: 0.9,
        info: ['工头对讲机', '所有人立刻撤出基坑：泵停了，水开始往里灌'],
        reason: '他比气象预警更早从工头那里知道',
        event: ['information', '最早收到撤离指令', '灾害现场的第一个信使往往是班组长，不是手机推送'],
      },
      { at: 54.3, state: 'packing', hold: 1.2, reason: '把电动工具收进箱子，不能泡水' },
      { at: 55.6, state: 'climbing', path: 'siteOut', speed: 'walk', reason: '沿坡道走出围护区，坑底已经开始积水' },
      {
        at: 0, state: 'calling', hold: 1.9,
        reason: '给妻子打电话报平安',
        info: ['家人电话', '妻子在城北，家里没停电，让他别骑车回家'],
        event: ['observation', '基坑积水', '围护区内的水十几分钟就涨到膝盖，泵停了排不出去'],
      },
      { at: 0, state: 'sheltered', finish: true, outcome: 'sheltered', summary: '进集装箱办公室避雨，等工地统一撤离' },
    ],
  });

  /* ---- 咖啡店员 ---- */
  const cafeIn = cafe.route.map((w) => ({ p: [w.p.x, w.p.y, w.p.z], kind: w.kind, floor: w.floor, label: w.label }));
  const woman = new PersonStory({
    id: 'WOMAN-001', name: '艾米·陈', age: 29, occupation: 'Pavilion 咖啡馆店员',
    tag: '最早知道', intro: '下午的客人走光了，她在收吧台。',
    start: cafe.start.clone(), floor: 1, heading: 0,
    baseY: CAFE.baseY, floorH: CAFE.floorH,
    routes: { cafeIn, cafe_to_market: districtRoutes.cafe_to_market },
    depthAt, states: STATE_CN, walk: 1.4, run: 2.6,
    script: [
      { at: 52.0, state: 'working', reason: '下午的客人走光了，她在收吧台', hold: 1.3 },
      {
        at: 53.5, state: 'texting', hold: 1.0,
        info: ['老板短信', '雨太大，提前关店，别走地下通道'],
        reason: '她是最早收到消息的人之一',
        event: ['information', '最早收到预警', '老板直接发短信；她比马克早 20 秒，比老板本人早 20 分钟'],
      },
      { at: 54.7, state: 'closing', path: 'cafeIn', speed: 'walk', reason: '关咖啡机、清收银、把后门插上' },
      { at: 0, state: 'locking', hold: 1.1, reason: '锁前门' },
      { at: 0, state: 'walking', path: 'cafe_to_market', speed: 'run', reason: '家在北边 400 米，她走熟悉的路' },
      {
        at: 0, state: 'home', finish: true, outcome: 'safe',
        summary: '到家。她这条路线上没有积水——同样的雨，暴露完全不同',
      },
    ],
  });

  /* ---- 外卖骑手 ---- */
  const rider = new PersonStory({
    id: 'RIDER-001', name: '泰瑞尔·杰克逊', age: 24, occupation: '外卖骑手',
    tag: '几乎收不到预警', intro: '耳机里放着音乐，手机导航静音。',
    start: new THREE.Vector3(CAFE.cx + 4.6, CAFE.baseY, CAFE.cz + 16.0), floor: 1, heading: Math.PI,
    baseY: CAFE.baseY, floorH: CAFE.floorH,
    routes: {
      rider_ride: districtRoutes.rider_ride,
      rider_shelter: districtRoutes.rider_shelter,
    },
    depthAt, states: STATE_CN, ride: 6.4,
    script: [
      { at: 52.0, state: 'idle', reason: '耳机里放着音乐，手机导航静音；系统还没派单', hold: 6.3 },
      {
        at: 58.4, state: 'notice', hold: 1.3,
        info: ['自己看到', '街对面的人开始往高处跑，有人推着自行车'],
        reason: '他摘下一只耳机，才发觉雨已经大到听不清导航',
        event: ['information', '最后知道的一批人', '没有收到任何官方预警；信息来自看见别人跑'],
      },
      {
        at: 59.9, state: 'riding', path: 'rider_ride', speed: 'ride',
        alt: 'rider_shelter', blockHold: 1.6,
        reason: '这单在南边，他想着冲过去还能赶上',
        blockNote: '他把电动车停在路边，水已经过膝，不敢再往前',
      },
      {
        at: 0, state: 'blocked', hold: 1.4, alt: 'rider_shelter',
        altTitle: '弃车，绕回办公楼',
        altReason: '他把车锁在路牌上，沿着水的边缘往北绕，去办公楼一层',
        reason: '前面的路口已经是一片水，看不到路缘',
      },
      {
        at: 0, state: 'sheltering', path: 'rider_shelter', speed: 'run',
        tail: [[2544.4, 7.19, 372.0, '走上办公楼台阶'], [2538.0, 7.19, 366.0, '进入大堂'], [2522.0, 7.19, 358.0, '在大堂避雨']],
        reason: '办公楼一层大堂开着门，里面已经站了几个躲雨的人',
      },
      { at: 0, state: 'sheltered', finish: true, outcome: 'sheltered', summary: '把车丢在路边，在办公楼大堂等雨停' },
    ],
  });

  /* ---- 小女孩 ---- */
  const schoolUp = school.route.map((w) => ({ p: [w.p.x, w.p.y, w.p.z], kind: w.kind, floor: w.floor, label: w.label }));
  const girl = new PersonStory({
    id: 'GIRL-001', name: '索菲亚·马丁内斯', age: 9, occupation: '小学三年级',
    tag: '没有手机', intro: '最后一节课，窗外雨很大，老师还在讲生词。',
    start: school.start.clone(), floor: 3, heading: 0,
    baseY: SCHOOL.baseY, floorH: SCHOOL.floorH,
    routes: { schoolUp }, depthAt, walk: 1.1,
    states: { ...STATE_CN, climbing: '跟着队伍上楼' },
    script: [
      { at: 52.0, state: 'class', reason: '最后一节课，窗外雨很大，老师还在讲生词', hold: 2.1 },
      {
        at: 54.1, state: 'notice', hold: 1.1,
        info: ['班主任', '全校往四层以上转移，一楼二楼不要留人'],
        reason: '她没有手机，所有信息都来自老师',
        event: ['information', '信息来自老师', '9 岁的孩子没有自己的手机，也没有判断天气的能力'],
      },
      {
        at: 55.4, state: 'lining', hold: 2.0,
        reason: '老师让全班在走廊排队，两个人一排',
        event: ['state', '全班排队', '26 名学生，老师清点两遍才出发'],
      },
      { at: 57.6, state: 'evacuating', path: 'schoolUp', speed: 'stair', reason: '跟着队伍从三层走到五层音乐教室' },
      {
        at: 0, state: 'calling', hold: 2.1,
        reason: '借老师的手机给妈妈打电话',
        info: ['妈妈电话', '妈妈被堵在高架上，一时来不了，让她听老师的话'],
      },
      { at: 0, state: 'waiting', finish: true, outcome: 'sheltered', summary: '和全班留在五层音乐教室，等家长来接' },
    ],
  });

  for (const [key, st] of [['boss', boss], ['doctor', doctor], ['worker', worker], ['woman', woman], ['rider', rider], ['girl', girl]]) {
    st.tMin = START_MIN;
    stories[key] = st;
  }

  /* ---- 模型加载 ---- */
  const loader = new GLTFLoader();
  await Promise.all(ROSTER.map(async (def) => {
    try {
      const gltf = await loader.loadAsync(def.model);
      const overrides = def.key === 'boss' ? { working: 'sit' }
        : def.key === 'doctor' ? { operating: 'idle2' }
          : def.key === 'worker' ? { working: 'crouch' }
            : def.key === 'woman' ? { working: 'idle2' }
              : def.key === 'girl' ? { class: 'sit' }
                : {};
      makeActor(def, gltf, overrides);
    } catch (e) {
      console.warn(`[district] ${def.key} 模型未加载`, e?.message || e);
    }
  }));

  // 故事必须等模型建好之后再挂上去：makeActor 会整体覆盖 actors 里的条目
  for (const [key, st] of Object.entries(stories)) {
    const a = actors.get(key);
    if (a) a.story = st;
    else console.warn(`[district] ${key} 没有模型，故事未挂载`);
  }

  // 马克的车（只在他开车时出现）
  try {
    const sedan = await new GLTFLoader().loadAsync('/assets/props/car_sedan.glb');
    markCar = sedan.scene.clone(true);
    const box = new THREE.Box3().setFromObject(markCar);
    const size = box.getSize(new THREE.Vector3());
    markCar.scale.setScalar(4.55 / Math.max(size.z, size.x));
    markCar.updateMatrixWorld(true);
    const b2 = new THREE.Box3().setFromObject(markCar);
    markCar.userData.yOffset = -b2.min.y + 0.02;
    markCar.visible = false;
    markCar.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    world.add(markCar);
  } catch (e) { console.warn('[district] 车辆未加载', e?.message || e); }

  // 外卖电动车：跟着骑手走，弃车之后就留在原地
  scooter = buildScooter();
  scooter.visible = false;
  world.add(scooter);

  buildRain();
  buildRoster();
  setView('follow');
  window.__district = { actors, get story() { return actors.get(selectedKey)?.story; } };
  window.__districtSnapshot = (key = selectedKey) => {
    const a = actors.get(key);
    if (!a || !a.story) return null;
    const s = a.story.snapshot ? a.story.snapshot() : null;
    const base = s || {};
    return {
      key, name: a.def.name, tMin: a.story.tMin, state: a.story.state,
      stateText: STATE_CN[a.story.state] || a.story.state,
      reason: a.story.reason, floor: a.story.floor,
      position: [a.story.position.x, a.story.position.y, a.story.position.z],
      depth: a.story.depth, speed: a.story.speed || 0,
      pathName: a.story.pathName || null,
      finished: !!a.story.finished, outcome: a.story.outcome || null,
      info: base.info || [], events: base.events || [],
      traceCount: base.traceLength ?? (base.trace ? base.trace.length : 0),
      clip: a.current ? a.current.getClip().name : null,
    };
  };
  window.__districtAll = () => ROSTER.map((d) => window.__districtSnapshot(d.key));
  window.__districtSelect = selectActor;

  // URL 参数：?t=66&play=0&view=follow&who=rider
  const q = new URLSearchParams(location.search);
  if (q.get('who')) selectActor(q.get('who'));
  if (q.get('t')) seekTo(q.get('t'));
  if (q.get('play') === '0') { playing = false; $('playBtn').textContent = '继续'; }
  if (q.get('view')) setView(q.get('view'));

  window.__cam = camera;
  window.__ready = true;
  $('loading').classList.add('done');
  console.log('[district] ready · 7 条故事线');
}

/* ------------------------------------------------------------- 雨 */
let rain = null;
function buildRain() {
  const n = 1800;
  const pos = new Float32Array(n * 6);
  const len = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const x = (Math.random() - 0.5) * 90;
    const y = Math.random() * 30;
    const z = (Math.random() - 0.5) * 90;
    len[i] = 0.35 + Math.random() * 0.4;
    pos[i * 6] = x; pos[i * 6 + 1] = y; pos[i * 6 + 2] = z;
    pos[i * 6 + 3] = x; pos[i * 6 + 4] = y - len[i]; pos[i * 6 + 5] = z;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
    color: 0xd6e8f2, transparent: true, opacity: 0.3, depthWrite: false,
  }));
  rain.frustumCulled = false;
  rain.userData.len = len;
  scene.add(rain);
}

function rainIntensity(tMin) {
  if (tMin < 56) return 0.28 + (tMin - START_MIN) * 0.03;
  if (tMin < 70) return 0.45 + (tMin - 56) * 0.04;
  if (tMin < 82) return 1.0;
  return Math.max(0.3, 1.0 - (tMin - 82) * 0.05);
}

function isIndoors(pos) {
  const inOffice = Math.abs(pos.x - OFFICE.cx) <= OFFICE.width / 2 + 0.6 && Math.abs(pos.z - OFFICE.cz) <= OFFICE.depth / 2 + 0.6;
  const inHome = Math.abs(pos.x - HOME.cx) <= HOME.width / 2 + 0.6 && Math.abs(pos.z - HOME.cz) <= HOME.depth / 2 + 0.6;
  const inCafe = Math.abs(pos.x - CAFE.cx) <= CAFE.width / 2 + 0.4 && Math.abs(pos.z - CAFE.cz) <= CAFE.depth / 2 + 0.4;
  const inClinic = Math.abs(pos.x - CLINIC.cx) <= CLINIC.width / 2 + 0.4 && Math.abs(pos.z - CLINIC.cz) <= CLINIC.depth / 2 + 0.4;
  const inSchool = Math.abs(pos.x - SCHOOL.cx) <= SCHOOL.width / 2 + 0.4 && Math.abs(pos.z - SCHOOL.cz) <= SCHOOL.depth / 2 + 0.4;
  return inOffice || inHome || inCafe || inClinic || inSchool;
}

/** 返回所在空间：'office' / 'home' / 'cafe' / 'clinic' / 'school' / 'site' / 'out'。 */
function spaceOf(pos) {
  if (Math.abs(pos.x - OFFICE.cx) <= OFFICE.width / 2 + 0.6 && Math.abs(pos.z - OFFICE.cz) <= OFFICE.depth / 2 + 0.6) return 'office';
  if (Math.abs(pos.x - HOME.cx) <= HOME.width / 2 + 0.6 && Math.abs(pos.z - HOME.cz) <= HOME.depth / 2 + 0.6) return 'home';
  if (Math.abs(pos.x - CAFE.cx) <= CAFE.width / 2 + 0.4 && Math.abs(pos.z - CAFE.cz) <= CAFE.depth / 2 + 0.4) return 'cafe';
  if (Math.abs(pos.x - CLINIC.cx) <= CLINIC.width / 2 + 0.4 && Math.abs(pos.z - CLINIC.cz) <= CLINIC.depth / 2 + 0.4) return 'clinic';
  if (Math.abs(pos.x - SCHOOL.cx) <= SCHOOL.width / 2 + 0.4 && Math.abs(pos.z - SCHOOL.cz) <= SCHOOL.depth / 2 + 0.4) return 'school';
  if (Math.abs(pos.x - SITE.cx) <= SITE.width / 2 + 6 && Math.abs(pos.z - SITE.cz) <= SITE.depth / 2 + 6) return 'site';
  return 'out';
}

function updateRain(dt) {
  if (!rain) return;
  const focus = actors.get(selectedKey);
  const pos = focus?.story?.position;
  if (!pos) return;
  const k = rainIntensity(clockMin);
  rain.visible = !isIndoors(pos) && k > 0.05;
  if (!rain.visible) return;
  rain.material.opacity = 0.08 + k * 0.4;
  rain.position.set(pos.x, pos.y, pos.z);
  const p = rain.geometry.attributes.position;
  const lens = rain.userData.len;
  const fall = dt * (11 + k * 15);
  const count = p.count / 2;
  for (let i = 0; i < count; i += 1) {
    let y = p.getY(i * 2) - fall;
    if (y < 0) y += 30;
    p.setY(i * 2, y);
    p.setY(i * 2 + 1, y - lens[i]);
  }
  p.needsUpdate = true;
}

/* ------------------------------------------------------------- 界面 */
function buildRoster() {
  const host = $('cards');
  host.innerHTML = '';
  for (const def of ROSTER) {
    const btn = document.createElement('button');
    btn.className = `card${def.key === selectedKey ? ' on' : ''}`;
    btn.dataset.key = def.key;
    btn.style.setProperty('--c', def.color);
    btn.innerHTML = `<span class="avatar" style="--c:${def.color}">${def.name.slice(0, 1)}</span>`
      + `<span><span class="n">${def.name}<em>${def.age}</em></span>`
      + `<span class="s" data-slot="state">—</span></span>`
      + '<span class="dot"></span>';
    btn.addEventListener('click', () => selectActor(def.key));
    host.appendChild(btn);
  }
  // 时间轴上的事件刻度：每个角色一个点，位置是他最近一条事件的时间
  const ticks = $('ticks');
  if (ticks) {
    ticks.innerHTML = '';
    for (const def of ROSTER) {
      const i = document.createElement('i');
      i.dataset.key = def.key;
      i.style.background = def.color;
      i.style.left = '0%';
      ticks.appendChild(i);
    }
  }
}

function selectActor(key) {
  selectedKey = key;
  const def = ROSTER.find((d) => d.key === key);
  if (def) {
    const av = $('dAvatar');
    if (av) { av.textContent = def.name.slice(0, 1); av.style.background = def.color; }
  }
  document.querySelectorAll('#cards .card').forEach((el) => el.classList.toggle('on', el.dataset.key === key));
  // 已经在自由视角时换人，不要粗暴地拽回跟随——把自由镜头挪到新角色身边就行
  if (viewMode === 'free') {
    focusFreeCamera(key);
  } else {
    viewMode = 'follow';
    document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('on', b.dataset.view === 'follow'));
    controls.enabled = false;
    updateCamera(true);
  }
  syncDetail(true);
}

function clockText(tMin) {
  const total = Math.floor(17 * 3600 + tMin * 60);
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function storyView(story) {
  const pos = story.position;
  return {
    state: story.state,
    floor: story.floor,
    speed: story.speed || 0,
    depth: story.depth || 0,
    pathLength: story.path ? story.path.length : 0,
    onStairs: !!(story.path && story.path[story.pathIndex] && story.path[story.pathIndex].kind === 'stairs'),
    position: pos,
    reason: story.reason || '',
    tMin: story.tMin,
  };
}

function syncDetail(force = false) {
  const now = performance.now();
  if (!force && now - detailStamp < 140) return;
  detailStamp = now;
  const a = actors.get(selectedKey);
  if (!a || !a.story) return;
  const s = a.story;
  const snap = s.snapshot ? s.snapshot() : null;
  const def = a.def;
  $('dName').textContent = def.name;
  $('dSub').textContent = `${def.age} 岁 · ${def.occupation}`;
  $('dState').textContent = STATE_CN[s.state] || s.state;
  $('dReason').textContent = s.reason || '—';
  const floorTxt = s.floor > 1 ? `${s.floor}F` : '地面层';
  $('dWhere').textContent = `${floorTxt} · ${s.position.x.toFixed(0)}, ${s.position.z.toFixed(0)}`;
  $('dDepth').textContent = `${(s.depth || 0).toFixed(2)} m`;
  $('dSpeed').textContent = `${(s.speed || 0).toFixed(2)} m/s`;
  $('dTime').textContent = clockText(s.tMin);
  const info = (snap && snap.info) || [];
  $('dInfo').innerHTML = info.length
    ? info.slice(-4).reverse().map((m) => `<li><time>${clockText(m.t).slice(0, 5)}</time><span><b>${m.source}</b> · ${m.content}</span></li>`).join('')
    : '<li><time>—</time><span>还没有收到任何信息</span></li>';
  const ev = (snap && snap.events) || [];
  $('dEvents').innerHTML = ev.slice(-5).reverse().map((e) => `<li><time>${clockText(e.t).slice(0, 5)}</time><span>${e.title}</span></li>`).join('')
    || '<li><time>—</time><span>—</span></li>';
}

function syncRoster() {
  for (const def of ROSTER) {
    const el = document.querySelector(`#cards .card[data-key="${def.key}"]`);
    if (!el) continue;
    const a = actors.get(def.key);
    const s = a && a.story;
    const slot = el.querySelector('[data-slot="state"]');
    if (!s) { slot.textContent = '模型未加载'; continue; }
    const floor = s.floor > 1 ? ` ${s.floor}F` : '';
    slot.textContent = `${clockText(s.tMin).slice(0, 5)} · ${STATE_CN[s.state] || s.state}${floor}`;
    el.classList.toggle('done', !!s.finished);
  }
}

const tmpVec = new THREE.Vector3();
function updateBubbles() {
  const placed = [];
  const order = [selectedKey, ...ROSTER.map((d) => d.key).filter((k) => k !== selectedKey)];
  for (const key of order) {
    const def = ROSTER.find((d) => d.key === key);
    const a = actors.get(key);
    if (!def) continue;
    if (!a || !a.story) { if (a) a.bubble.style.display = 'none'; continue; }
    const s = a.story;
    const focus = actors.get(selectedKey);
    let hide = false;
    if (focus && focus.story) {
      const d = focus.story.position.distanceTo(s.position);
      hide = d > 30 || spaceOf(focus.story.position) !== spaceOf(s.position);
    }
    if (hide) { a.bubble.style.display = 'none'; continue; }
    tmpVec.set(s.position.x, s.position.y + (def.height + 0.55), s.position.z).project(camera);
    const visible = tmpVec.z > -1 && tmpVec.z < 1 && Math.abs(tmpVec.x) < 1.15 && Math.abs(tmpVec.y) < 1.15;
    if (!visible) { a.bubble.style.display = 'none'; continue; }

    // 两个角色的气泡叠在一起会互相盖住（咖啡馆门口就是这样）。
    // 依次摆放，撞上了就往上错开 26 px，最多错三次。
    const w = 128; const hgt = 26;
    let x = (tmpVec.x * 0.5 + 0.5) * innerWidth;
    let y = (-tmpVec.y * 0.5 + 0.5) * innerHeight - 6;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const clash = placed.some((p) => Math.abs(p.x - x) < w && Math.abs(p.y - y) < hgt);
      if (!clash) break;
      y -= hgt;
    }
    placed.push({ x, y });

    a.bubble.style.display = 'block';
    a.bubble.style.left = `${x}px`;
    a.bubble.style.top = `${y}px`;
    const floor = s.floor > 1 ? ` · ${s.floor}F` : '';
    a.bubble.innerHTML = `<b>${def.name.slice(0, 3)}</b>${STATE_CN[s.state] || s.state}${floor}`;
    a.bubble.style.opacity = s.finished ? '0.65' : '1';
  }
}

/**
 * 把自由镜头放到“这个人周围”：侧后方 45°、约 5 m 远，看向胸口高度。
 * 上一版切自由只是把控制器打开，相机还停在跟随的最后一帧、target 也是旧的，
 * 拖一下鼠标就绕着几百米外的点乱转，等于没法用。
 */
function focusFreeCamera(key = selectedKey, dist = 5.2) {
  const a = actors.get(key);
  if (!a || !a.story) return;
  const s = a.story;
  const p = s.position;
  const hh = a.def.height || 1.8;
  const indoor = isIndoors(p);
  const target = p.clone().add(new THREE.Vector3(0, Math.max(0.9, hh * 0.62), 0));
  const d = indoor ? Math.min(dist, 3.6) : dist;
  const ang = (s.heading || 0) + Math.PI * 0.72;
  const desired = target.clone().add(new THREE.Vector3(
    Math.sin(ang) * d,
    indoor ? hh * 0.45 + 0.5 : d * 0.42 + 0.7,
    Math.cos(ang) * d,
  ));
  // 别把自由镜头塞进墙里：沿 target→desired 采样，撞到就停
  const safe = resolveCamera(target, desired, 1.1);
  camera.position.copy(safe);
  controls.target.copy(target);
  controls.update();
}

function setView(name) {
  viewMode = name;
  document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  controls.enabled = name !== 'follow';
  if (name === 'overview') {
    // 区域视角要框住“咖啡馆 → 办公楼 → 诊所 → 学校”这条走廊，
    // 抬太高会把没有铺路的外围草地全拍进来，看着像郊外。
    camera.position.set(OFFICE.cx + 40, OFFICE.baseY + 128, OFFICE.cz + 240);
    controls.target.set(OFFICE.cx - 150, OFFICE.baseY + 4, OFFICE.cz - 240);
    controls.update();
  } else if (name === 'follow') {
    updateCamera(true);
  } else if (name === 'free') {
    focusFreeCamera(selectedKey);
  }
}

function updateCamera(immediate = false) {
  if (viewMode !== 'follow') return;
  const a = actors.get(selectedKey);
  if (!a || !a.story) return;
  const s = a.story;
  const indoor = isIndoors(s.position);
  const dir = new THREE.Vector3(Math.sin(s.heading || 0), 0, Math.cos(s.heading || 0));
  // 按各自身高定机位：小女孩 1.47 m，老板 1.99 m，用同一套参数一定有一个不对。
  const hh = a.def.height;
  const onStairs = !!(s.path && s.path[s.pathIndex] && s.path[s.pathIndex].kind === 'stairs');
  // 室外跟随机位：骑车要贴近一点，否则人在画面里只有几十像素
  const riding = s.state === 'riding';
  const inVehicle = ['driving', 'carblocked', 'parking', 'boarding'].includes(s.state);
  // 车比人大得多：跟车必须退到 9.5 m、抬到 4.6 m，否则车尾直接糊满画面
  const baseDist = indoor ? (onStairs ? 2.2 : s.floor > 1 ? 3.4 : 4.4)
    : inVehicle ? 9.5 : riding ? 5.0 : 6.6;
  const baseH = indoor ? (onStairs ? 2.5 : hh * 1.05)
    : inVehicle ? 4.6 : riding ? 2.3 : 3.0;
  const target = s.position.clone().add(new THREE.Vector3(0, indoor ? hh * 0.62 : 1.1, 0));
  const side = new THREE.Vector3(Math.cos(s.heading || 0), 0, -Math.sin(s.heading || 0));

  // 机位候选：室内不能被挡就“一直往人身上缩”，那样会贴脸。
  // 改成绕着人转一圈找空位：先试正后方，再左右偏 35°/70°/110°，最后才拉近。
  const target2 = target;
  const ring = indoor
    ? [
      // 窄走廊里退不开，就抬高俯视——比贴在后脑勺上强
      // 先试 3/4 侧后方：正后方只能看到后脑勺，房间的进深全丢了
      { a: 30, d: 1.0, h: 0.3 }, { a: -30, d: 1.0, h: 0.3 }, { a: 0, d: 1.0, h: 0.3 },
      { a: 64, d: 0.95, h: 0.5 }, { a: -64, d: 0.95, h: 0.5 },
      { a: 0, d: 0.82, h: 1.2 }, { a: 0, d: 0.72, h: 1.8 }, { a: 0, d: 0.60, h: 2.4 },
      { a: 100, d: 0.9, h: 0.6 }, { a: -100, d: 0.9, h: 0.6 },
      { a: 0, d: 0.5, h: 0.3 }, { a: 45, d: 0.5, h: 0.6 },
    ]
    : riding
      // 骑车从正后方看，只剩人背 + 后箱，车完全看不见；优先侧后方看整车侧影
      ? [
        { a: 46, d: 1.12, h: 0.35 }, { a: -46, d: 1.12, h: 0.35 },
        { a: 34, d: 1.1, h: 0.45 }, { a: -34, d: 1.1, h: 0.45 },
        { a: 0, d: 1.0, h: 0.4 }, { a: 0, d: 0.8, h: 1.2 },
      ]
      : [
        { a: 0, d: 1.0, h: 0 }, { a: 22, d: 1.0, h: 0 }, { a: -22, d: 1.0, h: 0 },
        { a: 0, d: 0.85, h: 0.8 }, { a: 0, d: 0.7, h: 1.6 },
      ];
  // 室外被挡时宁可抬高也不要贴到车上：要求达到目标距离的 72%
  const need = indoor ? Math.min(2.4, baseDist * 0.8) : baseDist * 0.72;
  let chosen = null;
  for (const c of ring) {
    const ang = (s.heading || 0) + Math.PI + c.a * Math.PI / 180;
    const back = new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang));
    const desired = s.position.clone()
      .addScaledVector(back, c.d * baseDist)
      .add(new THREE.Vector3(0, baseH + c.h, 0));
    const safe = resolveCamera(target2, desired);
    const got = safe.distanceTo(target2);
    if (got >= need) { chosen = safe; break; }
    if (!chosen || got > chosen.distanceTo(target2)) chosen = safe;
  }
  const finalPos = chosen || target2.clone().addScaledVector(dir, -baseDist).add(new THREE.Vector3(0, baseH, 0));
  if (immediate) camera.position.copy(finalPos);
  else camera.position.lerp(finalPos, 0.16);
  camera.lookAt(target);
}

/* ------------------------------------------------------------- 主循环 */
function syncFlood() {
  if (!floodManifest) return;
  let best = 0;
  for (let i = 0; i < floodManifest.frames.length; i += 1) {
    if (floodManifest.frames[i].t_min <= clockMin) best = i;
    else break;
  }
  if (best !== currentFloodIndex) {
    currentFloodIndex = best;
    flood.showFrame(best);
  }
}

function syncMarkCar() {
  if (!markCar) return;
  const a = actors.get('mark');
  if (!a || !a.story) return;
  const s = a.story;
  const driving = ['driving', 'carblocked', 'parking'].includes(s.state);
  markCar.visible = driving || s.state === 'boarding';
  if (driving) {
    markCar.position.set(s.position.x, s.position.y + (markCar.userData.yOffset || 0), s.position.z);
    markCar.rotation.y = s.heading || 0;
  }
  const model = a.root;
  model.visible = !['driving', 'carblocked', 'parking'].includes(s.state);
}

/**
 * 世界空间“瞄准”一根骨头：把它指向指定方向。
 * 不同角色的 Mixamo 骨骼 roll 不一样，同一个局部旋转在 A 身上是抬腿、在 B 身上就是劈叉
 * ——所以不猜局部轴，直接算世界方向再换算回局部。
 */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

function aimBone(bone, child, targetDir) {
  if (!bone || !child) return;
  const a = bone.getWorldPosition(_v1).clone();
  const b = child.getWorldPosition(_v2).clone();
  const cur = b.sub(a);
  if (cur.lengthSq() < 1e-8) return;
  cur.normalize();
  const want = targetDir.clone().normalize();
  const world = _q1.setFromUnitVectors(cur, want);
  const parentQ = bone.parent.getWorldQuaternion(_q2).clone();
  const delta = parentQ.clone().invert().multiply(world).multiply(parentQ);
  bone.quaternion.premultiply(delta);
  bone.updateMatrixWorld(true);
}

/**
 * 骑手骑跨姿势：不播 sit 片段（批量导出的角色上会劈叉），
 * 而是从 idle 基础上按世界方向摆腿和手臂。
 */
// 髋骨原点是骨盆中心，实测抬到 0.94 会明显“悬”在座垫上方，0.85 贴合
const RIDE = { seatY: 0.85, seatZ: -0.24 };

function seatRiderOnScooter(a) {
  if (!scooter || !a.bones || !a.bones.hips) return;
  const B = a.bones;
  a.model.updateMatrixWorld(true);
  scooter.updateMatrixWorld(true);

  const h = a.root.rotation.y;
  const fwd = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
  const right = new THREE.Vector3(Math.cos(h), 0, -Math.sin(h));
  const up = new THREE.Vector3(0, 1, 0);

  // 大腿：往前下方，并朝两侧张开一点，跨在车身上
  for (const [side, upLeg, leg] of [[-1, B.leftUpLeg, B.leftLeg], [1, B.rightUpLeg, B.rightLeg]]) {
    // 大腿接近水平、小腿前下方：脚才会落在踏板上，而不是一直伸到地面
    const thigh = fwd.clone().multiplyScalar(0.88)
      .addScaledVector(up, -0.42)
      .addScaledVector(right, side * 0.30);
    aimBone(upLeg, leg, thigh);
    const shin = fwd.clone().multiplyScalar(0.52)
      .addScaledVector(up, -0.84)
      .addScaledVector(right, side * 0.06);
    const foot = side < 0 ? B.leftFoot : B.rightFoot;
    aimBone(leg, foot || leg, shin);
  }

  // 手：伸向车把两端
  const gripL = new THREE.Vector3(-0.30, 1.12, 0.56).applyMatrix4(scooter.matrixWorld);
  const gripR = new THREE.Vector3(0.30, 1.12, 0.56).applyMatrix4(scooter.matrixWorld);
  for (const [arm, foreArm, grip] of [[B.leftArm, B.leftForeArm, gripL], [B.rightArm, B.rightForeArm, gripR]]) {
    if (!arm || !foreArm) continue;
    const shoulder = arm.getWorldPosition(new THREE.Vector3());
    const toGrip = grip.clone().sub(shoulder);
    // 上臂只走一半路，剩下交给前臂，否则整条手臂拉直会僵
    const elbowHint = shoulder.clone().addScaledVector(toGrip, 0.5).addScaledVector(up, -0.12);
    aimBone(arm, foreArm, elbowHint.sub(shoulder));
    aimBone(foreArm, foreArm.children[0] || foreArm, grip.clone().sub(foreArm.getWorldPosition(new THREE.Vector3())));
  }
  a.model.updateMatrixWorld(true);

  // 髋部对齐座垫：量出来再平移，不写死高度
  const hips = B.hips.getWorldPosition(new THREE.Vector3());
  const seat = new THREE.Vector3(0, RIDE.seatY, RIDE.seatZ).applyMatrix4(scooter.matrixWorld);
  a.root.position.x += seat.x - hips.x;
  a.root.position.z += seat.z - hips.z;
  a.root.position.y += seat.y - hips.y;
  a.model.updateMatrixWorld(true);
}

let scooterPrev = null;

function syncScooter() {
  if (!scooter) return;
  const a = actors.get('rider');
  if (!a || !a.story) return;
  const st = a.story;
  const onBike = ['idle', 'notice', 'riding', 'blocked'].includes(st.state);
  if (onBike) {
    scooter.visible = true;
    scooterPlaced = true;
    scooter.position.set(st.position.x, st.position.y + 0.02, st.position.z);
    scooter.rotation.y = st.heading || 0;

    // 车轮按实际位移滚动：滚动半径 0.255 m
    if (scooterPrev) {
      const d = Math.hypot(st.position.x - scooterPrev.x, st.position.z - scooterPrev.z);
      if (d > 0.0005 && d < 5) {
        const spin = d / 0.255;
        for (const w of scooter.userData.wheels || []) w.rotation.x += spin;
      }
    }
    scooterPrev = { x: st.position.x, z: st.position.z };
  } else if (scooterPlaced) {
    scooter.visible = true;   // 车被丢在路边，留在最后的位置
    scooterPrev = null;
  }
}

/** 基坑水面：只有工人还在坑里、且汇水到一定高度时才出现。 */
function syncSiteWater() {
  if (!site || !site.water) return;
  const a = actors.get('worker');
  const inside = a && a.story
    && Math.abs(a.story.position.x - SITE.cx) < SITE.width / 2
    && Math.abs(a.story.position.z - SITE.cz) < SITE.depth / 2;
  const d = inside ? (a.story.depth || 0) : 0;
  // 只有积到 30 cm 以上才铺水面：太浅时一整片水面会像泳池内衬，把坑底盖掉
  site.water.visible = d > 0.30;
  if (site.water.visible) site.water.position.y = SITE.baseY + 0.09 + d * 0.85;
}

function resetAll() {
  clockMin = START_MIN;
  currentFloodIndex = -1;
  for (const def of ROSTER) {
    const a = actors.get(def.key);
    if (!a || !a.story) continue;
    a.story.reset();
    a.story.tMin = START_MIN;
    if (a.mixer) { a.mixer.stopAllAction(); a.current = null; a.motion = 'idle'; a.pending = null; a.trans = null; a.poseKey = null; }
  }
  syncFlood();
  syncAll(0, true);
}

function seekTo(target) {
  const t = Math.max(START_MIN, Math.min(END_MIN, Number(target)));
  playing = false;
  $('playBtn').textContent = '继续';
  for (const def of ROSTER) {
    const a = actors.get(def.key);
    if (!a || !a.story) continue;
    a.story.reset();
    a.story.tMin = START_MIN;
    if (a.mixer) { a.mixer.stopAllAction(); a.current = null; a.motion = 'idle'; a.pending = null; a.trans = null; a.poseKey = null; }
  }
  clockMin = START_MIN;
  let guard = 0;
  while (clockMin < t && guard++ < 60000) {
    const dt = Math.min(0.25, (t - clockMin) * 60);
    stepAll(dt);
    clockMin += dt / 60;
  }
  syncFlood();
  syncAll(0, true);
}

function stepAll(simSeconds) {
  for (const def of ROSTER) {
    const a = actors.get(def.key);
    if (!a || !a.story) continue;
    // 马克比别人晚 0 秒开始，但单人版内部起点是 17:52，和这里一致
    a.story.step(simSeconds);
  }
}

function syncAll(dt, immediate = false) {
  for (const def of ROSTER) {
    const a = actors.get(def.key);
    if (!a || !a.story) continue;
    a.root.position.set(a.story.position.x, a.story.position.y, a.story.position.z);
    if (a.blob) {
      const seated = a.def.key === 'rider' && a.story.state === 'riding';
      a.blob.position.set(a.story.position.x, a.story.position.y + (seated ? 0.16 : 0.03), a.story.position.z);
      a.blob.scale.setScalar(seated ? 1.5 : 1);
      a.blob.visible = a.root.visible;
    }
    a.root.rotation.y = a.story.heading || 0;
    if (a.mixer) a.mixer.update(dt);
    updateActorAnim(a, storyView(a.story));
    if (a.mixer) finishTransition(a);
    if (a.def.key === 'rider' && a.story.state === 'riding') seatRiderOnScooter(a);
  }
  syncMarkCar();
  syncScooter();
  syncSiteWater();
  const focus = actors.get(selectedKey);
  if (focus) {
    followLight.position.set(focus.story.position.x + 0.6, focus.story.position.y + 2.6, focus.story.position.z);
  }
  updateCamera(immediate);
  updateBubbles();
  syncRoster();
  syncDetail();
  updateRain(dt);
  $('timeRange').value = String(clockMin);
  $('timeLabel').textContent = clockText(clockMin);
  const ticks = $('ticks');
  if (ticks) {
    for (const def of ROSTER) {
      const a2 = actors.get(def.key);
      const i = ticks.querySelector(`i[data-key="${def.key}"]`);
      if (!a2 || !a2.story || !i) continue;
      const evs = a2.story.events;
      const lastT = evs.length ? evs[evs.length - 1].t : START_MIN;
      i.style.left = `${Math.min(100, Math.max(0, ((lastT - START_MIN) / (END_MIN - START_MIN)) * 100))}%`;
    }
  }
  const done = ROSTER.filter((d) => actors.get(d.key)?.story?.finished).length;
  $('stat').textContent = `统一时钟 · 0.25 秒子步 · ${done}/7 已到结局`;
}

function loop(now) {
  requestAnimationFrame(loop);
  const realDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const simDt = playing ? realDt * speed : 0;
  if (playing) {
    clockMin = Math.min(END_MIN, clockMin + simDt / 60);
    if (clockMin >= END_MIN) { playing = false; $('playBtn').textContent = '播放'; }
    stepAll(simDt);
    syncFlood();
  }
  syncAll(simDt);
  // 跟随镜头时不能无条件 update()：OrbitControls 会按自己的球坐标把相机拉回去，
  // 画面就会飘到几百米外。只在自由/俯视模式更新控制器。
  if (controls.enabled) controls.update();
  renderer.render(scene, camera);
}

/* ------------------------------------------------------------- 事件 */
function bindUi() {
  $('playBtn').addEventListener('click', () => {
    playing = !playing;
    $('playBtn').textContent = playing ? '暂停' : '继续';
  });
  $('resetBtn').addEventListener('click', () => { resetAll(); playing = true; $('playBtn').textContent = '暂停'; });
  $('speeds').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-speed]');
    if (!b) return;
    speed = Number(b.dataset.speed);
    document.querySelectorAll('#speeds button').forEach((x) => x.classList.toggle('on', x === b));
  });
  $('timeRange').addEventListener('input', (e) => seekTo(e.target.value));
  document.querySelectorAll('#views button').forEach((b) => {
    b.addEventListener('click', () => { setView(b.dataset.view); if (b.dataset.view === 'follow') updateCamera(true); });
  });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); $('playBtn').click(); }
    const idx = ['1', '2', '3', '4', '5', '6', '7'].indexOf(e.key);
    if (idx >= 0 && ROSTER[idx]) selectActor(ROSTER[idx].key);
  });
}

bindUi();
init().then(() => {
  // 首帧同步一次，避免开场位置错位
  syncFlood();
  syncAll(0, true);
  requestAnimationFrame((t) => { last = t; loop(t); });
}).catch((e) => {
  console.error('[district] 初始化失败', e);
  const el = $('loading');
  if (el) el.innerHTML = `初始化失败：${e?.message || e}<small style="white-space:pre-wrap;text-align:left">${(e?.stack || '').slice(0, 700)}</small>`;
});
