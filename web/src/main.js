/**
 * 华盛顿 · 程序化 three.js 城市场景 —— 主入口。
 *
 * 一切几何在代码里生成：没有任何 .glb / .png / .hdr 外部资源（§9 第 10 条）。
 * 地形与下垫面来自 data/derived（USGS 3DEP 1 m DEM + DCGIS 2025），
 * 由 tools/terrain/export_web_*.py 转成 web/assets/ 下的二进制高度场。
 *
 * 图层（§10）：L0_terrain / L1_water / L2_road / L3_building / L4_vegetation
 *             / L5_furniture / L6_agents
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import {
  textureWhiteHouseWall, textureSlateRoof, textureWindowGlass,
  textureLawn, textureSoil, textureBrickPaving,
  textureWaterNormal, textureBark, textureGranitePaving, rng, jitter,
} from './textures.js';
import { buildWhiteHouse, DIM } from './whitehouse.js';
import {
  buildFountain, updateFountain,
  buildTree, buildLeafMeshes, resetLeafCollector,
  buildFlowerBed, buildHedge,
} from './grounds.js';
import {
  loadTerrain, buildTerrainMesh, loadBuildings, buildBuildingMesh, loadRoadCut,
} from './terrain.js';
import {
  loadCityTextures, prepareFacades,
  wallMaterial, roofMaterial, roadMaterial, terrainMaterial, marbleMaterial,
} from './citytex.js';
import { loadRoads, buildRoadGroup, makeMarkMaterials, makeRoadSurf } from './roads.js';
import { setRoadCut } from './roadmesh.js';
import { buildBridgeStyles } from './bridges.js';
import { buildPlazas } from './plazas.js';
import { buildCapitol } from './landmarks.js';
import { loadTrees, buildTreeField } from './trees.js';
import {
  loadWater, buildWaterMesh, excavateTerrain, setWaterDesignLevel, paintShoreWet,
} from './water.js';
import { loadPedAssets, buildPedestrians, nextState, loadPedSurface } from './ped.js';

// 白宫在建筑基底里的 id（data/derived/buildings_footprints.json）。
// 它由 whitehouse.js 的高模重建替代，所以要从建筑体块里剔掉，避免两个盒子打架。
const WH_ID = '19761182';
// 白宫中心（场景米制，planY 取负后即 three 的 z）
const WH_PLAN = { x: 1144.0, y: 815.0 };

// ---------------------------------------------------------------- 渲染器
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// 电影感：ACES 色调映射 + 轻微曝光
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

// ---------------------------------------------------------------- 场景 & 雾
const scene = new THREE.Scene();
// 天空：一个巨大的球内壁，用着色器做真实的天光渐变（不是纯色背景）
scene.add(buildSky());

// ---------------------------------------------------------------- 环境光照贴图（IBL）
// 【关键】没有 environment map 时，玻璃/水面/金属一律是黑的或纯色的，
// 一眼就假。这里把刚建好的天空球用 PMREM 烘成环境贴图，
// 之后所有 metalness>0 的材质都会真实反射天光。
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const skyScene = new THREE.Scene();
  const skyProbe = buildSky();
  skyScene.add(skyProbe);
  // 加一块临时的地面反射（草地绿），让朝下的面不至于纯黑
  const gndProbe = new THREE.Mesh(
    new THREE.SphereGeometry(880, 16, 8, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5),
    new THREE.MeshBasicMaterial({ color: 0x4a6b38, side: THREE.BackSide })
  );
  skyScene.add(gndProbe);
  const envRT = pmrem.fromScene(skyScene, 0.02);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.80;
  pmrem.dispose();
}

// ---------------------------------------------------------------- 城市范围
// 与 data/derived/terrain_dtm.tif 完全一致（场景米制 planX/planY）。
// three 里 z = -planY，所以 z 的正负号要翻。
const CITY = { x0: -1277, x1: 4701, y0: -931, y1: 4189 };
const CITY_CX = (CITY.x0 + CITY.x1) / 2;    // 1712
const CITY_CZ = -(CITY.y0 + CITY.y1) / 2;   // -1629
const CITY_W = CITY.x1 - CITY.x0;           // 5978
const CITY_H = CITY.y1 - CITY.y0;           // 5120

// 相机：城市尺度。far 必须覆盖 6 km 对角（约 7.9 km）+ 天球
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 1.0, 26000);
// 初始机位：拉斐特广场（白宫北侧）低空平视。
// 【坑】原来是从 4 km 外 1900 m 高空俯瞰全城：那个高度上一个人只有 1~2 像素，
//       行人系统明明在跑（3000 人 / 16605 条可走链），画面里却等于空城。
//       首屏必须落在「看得见人」的尺度上——实测这个机位视锥内有 84 个行人、
//       19 个超过 20 像素高，且能同时看到白宫立面和广场行道树。
camera.position.set(1018, 24, -636);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(1150, 22, -828);
controls.enableDamping = true;
controls.dampingFactor = 0.055;
controls.maxPolarAngle = Math.PI * 0.495;   // 不许钻到地下
controls.minDistance = 12;
controls.maxDistance = 7000;
controls.autoRotate = false;

// ---------------------------------------------------------------- 材质
const mats = buildMaterials();

// ---------------------------------------------------------------- 装配
const world = new THREE.Group();
scene.add(world);

// 地形 + 下垫面 + 城市建筑：异步加载二进制高度场（§12.2 第 3 步）。
// 注意：地形网格要等它，但白宫/园林可以在同一帧先挂上。
let TERRAIN = null;     // loadTerrain() 的返回，全局唯一的地面高程查询入口
let PED = null;         // L6 行人系统（buildCity 里装配，animate 里每帧推进）

async function buildCity() {
  const t0 = performance.now();
  TERRAIN = await loadTerrain();

  // 城市贴图库（ambientCG CC0，tools/terrain/make_web_tex.py 压到 512px）。
  // 拿不到就退回纯顶点色 —— 场景必须还能跑，不能因为一张 jpg 白屏。
  let TEX = null;
  try {
    TEX = await loadCityTextures();
    await prepareFacades(TEX);
  } catch (e) {
    console.warn('[tex] 贴图加载失败，退回顶点色：', e);
  }

  // L0：地形网格（真实 DTM，不是平面）。有贴图就把草地/铺装混进去。
  // 路廊下切栅格必须在建地形网格**之前**读到（buildTerrainMesh 会拿它压低顶点）
  try {
    TERRAIN.roadCut = await loadRoadCut();
    setRoadCut(TERRAIN.roadCut);   // 路面读同一条下切栅格，才能和可见地面贴合
  } catch (e) {
    console.warn('[terrain] cut.i16 读取失败，路面可能出现穿模：', e.message);
  }
  const terr = buildTerrainMesh(TERRAIN, TEX ? { material: terrainMaterial(TEX) } : {});
  world.add(terr);

  // L1：水体（任务书 §5.3）。先把地形挖成河槽，再铺水面 + 岸线湿滩带。
  // 顺序不能反：水面高程要读 normal_water_level_m，而河槽要把地形压到 bed.i16。
  let WATER = null, waterGrp = null, dug = 0, wetPainted = 0;
  try {
    WATER = await loadWater();
    dug = excavateTerrain(terr, WATER);
    waterGrp = buildWaterMesh(WATER, TERRAIN);
    world.add(waterGrp);
    // 岸线湿泥晕染：把水面外 12 m 内的陆地顶点往湿泥色靠，让 6 m 网格的
    // 水线台阶读成「潮湿河滩」而不是硬边（§9 第 6 条）。必须在挖槽之后调，
    // 因为 paintShoreWet 用的是 bed.i16 的水面掩膜。
    wetPainted = paintShoreWet(terr, WATER);
  } catch (e) {
    console.error('[water] 加载失败：', e);
  }

  // L2：道路（OSM 24,660 条 way 的真实带子，高程按 DTM 采样）
  // 必须在挖槽之后建，因为要读被压低的河床来夹住跨河桥面。
  let roadGrp = null;
  if (TEX) {
    try {
      const R = await loadRoads();
      const marks = makeMarkMaterials();
      // 桥栏/桥墩的材质：比墙体略冷的混凝土，roughness 高一点
      // 桥栏/桥墩/路缘立面的材质。
      // 【必须偏暗】这块材质同时用在 road_ways_struct 上（每段路两侧的 0.45 m
      // 路缘立面 + 0.15 m 路缘石），原来 0x9a958c 是浅暖灰，从空中看就是沿路
      // 一条条亮线 —— 用户说的「蜘蛛丝」。压到 0x6b6a64 之后，这些立面读成
      // 路缘的背光阴影线，不再抢画面。
      const pierMat = new THREE.MeshStandardMaterial({
        color: 0x6b6a64, roughness: 0.94, metalness: 0.0,
      });
      roadGrp = buildRoadGroup(R, TERRAIN, {
        // 沥青是**冷灰**不是暖灰：0xb5b0a8 那种带黄的浅灰乘上 AI 沥青图，
        // 整条街读起来像压实的土路（用户原话「灰色的土路的感觉」）。
        // 冷灰 + 略低粗糙度，才读成柏油。
        road: roadMaterial(TEX, 'asphalt', { color: 0x82878d, roughness: 0.84 }),
        // 人行道/步道是**浅**冷灰混凝土。
        //
        // 【必须浅】原来这里是 0x86898d（深冷灰），乘上 pave 图（meanL 135.8）
        // 之后整条带比草坪暗一档，于是在浅绿草坪上读成一圈深色描边 —— 这正是
        // 用户反复投诉的「草地上纵横交错的蜘蛛网细线」。实测（正俯视 900×900，
        // 5×5 邻域亮度差找暗线）：0x86898d → 暗线像素 1.89%；0xd2d0c6 → 1.19%；
        // 0xe6e4da → 0.32%；0xffffff → 0.15%。取 0xe8e6dc，暗线降到 0.3% 量级。
        // 只提亮 path 不够（walk 也一起画，两层的边界都在草坪上留描边），
        // 所以 mats.path 由 walk_ways 与 path_ways 共用，一改两层都变。
        path: roadMaterial(TEX, 'pave', { color: 0xe8e6dc, roughness: 0.95 }),
        markw: marks.markw,
        marky: marks.marky,
        pier: pierMat,
        // 立缘石（人行道侧沿）：暖浅灰石材，粗糙高 —— 只用在人行道立面上，
        // 给「车道 / 路缘 / 人行道」三层高差，又不至于变成压在全城的暗线。
        curb: new THREE.MeshStandardMaterial({ color: 0xb6b1a6, roughness: 0.93, metalness: 0.0 }),
      }, WATER ? WATER.levels.MSL_m : 0.046, WATER);
      world.add(roadGrp);

      // ---- 桥型：**已重新启用**（2026-10-24）
      //
      // 历史：noDeck:true 时期这里只画拱圈/吊杆/主缆，桥面被 roads 层拿走，于是
      // 江面上一堆悬空的细丝（用户说的「蜘蛛丝」）→ 当时被整体 if (false) 停用。
      //
      // 现在的前提变了：roadmesh.js 不再自己造桥（涉水断面一律 dead），路面在
      // 岸边就断开了；跨河必须由这里补一整座**带桥面**的桥，否则两岸路接不上
      // （用户：「他们都是一节一节的都是断头的，我希望你把它们整合成一个整体」）。
      // 所以：noDeck 关掉（画桥面 + 桥面板 + 缘石 + 栏杆 + 桥墩 + 拱圈），
      // surf 仍传进去 —— 桥头能吸到已建好的路面高程，引道与路面严丝合缝；
      // 江心段 surf 返回 null，桥面按两岸地面插值 + 起拱，是连续的一整条。
      {
        const bdoc = await (await fetch('assets/roads/bridges.json')).json();
        const roadMesh = roadGrp.getObjectByName('road_ways');
        const surf = roadMesh ? makeRoadSurf(roadMesh) : null;
        const stoneMat = new THREE.MeshStandardMaterial({
          color: 0xcdc7b8, roughness: 0.86, metalness: 0.0,
          side: THREE.DoubleSide, dithering: true,
        });
        const steelMat = new THREE.MeshStandardMaterial({
          color: 0x8e949a, roughness: 0.55, metalness: 0.55,
          side: THREE.DoubleSide,
        });
        const deckMat = new THREE.MeshStandardMaterial({
          color: 0x9a958a, roughness: 0.82, metalness: 0.04,
          side: THREE.DoubleSide,
        });
        const bg = buildBridgeStyles(bdoc,
          { stone: stoneMat, steel: steelMat, deck: deckMat }, surf, TERRAIN,
          { noDeck: false });
        roadGrp.add(bg);
        console.log('[bridges] 已生成', bg.children.length, '个网格');
      }
    } catch (e) {
      console.error('[roads] 加载失败：', e);
    }
  }

  // L3：建筑体块（每栋底面 = 各自 DTM 高程）。
  // 有贴图时按「立面材质桶」拆成约 10 个 mesh，换取砖缝/窗格的真实尺度。
  const B = await loadBuildings();
  // 国会大厦不走「4 点矩形拉伸」的通用管线 —— buildings_footprints.json 每条轮廓
  // 只有 4 个点，做成 87 m 高的方板完全不像国会山（没有两翼、没有柱廊）。
  // 这里排除掉它，改用 landmarks.js 里的专用模型。
  const EXCLUDE = new Set([WH_ID, '66418809']);
  // 地标共用一份大理石材质（一个 program，几万三角面，不值得每栋 new 一个）
  const MARBLE = marbleMaterial();
  const blocks = buildBuildingMesh(B, TEX ? {
    excludeIds: EXCLUDE,
    materials: {
      wall: (k) => (k === 'marble' ? MARBLE : wallMaterial(TEX, k)),
      roof: (k) => (k === 'marble' ? MARBLE : roofMaterial(TEX, k)),
    },
  } : { excludeIds: EXCLUDE });
  world.add(blocks);

  // L2_plaza：国会山东西广场 / 纪念碑场地 / 林肯堂前广场
  //
  // 这些地方在真实 DC 是整块花岗岩铺装 + 立缘石，现在只是 landcover 的
  // 硬化顶点色，站上去看不出是广场。锚点取地标自己的 footprint，
  // 所以地形一改广场跟着走。
  try {
    // 花岗岩板铺装：用程序化生成的板缝贴图（无外部素材，符合任务书 §10）
    const granite = textureGranitePaving(512, 6);
    granite.wrapS = granite.wrapT = THREE.RepeatWrapping;
    granite.anisotropy = 8;
    granite.colorSpace = THREE.SRGBColorSpace;
    const plazaMat = new THREE.MeshStandardMaterial({
      map: granite, color: 0xcfccc4, roughness: 0.90, metalness: 0.0,
    });
    if (plazaMat) {
      // 广场用「铺装分格」顶点色（见 plazas.js），必须开 vertexColors
      plazaMat.vertexColors = true;
      plazaMat.polygonOffset = true;
      plazaMat.polygonOffsetFactor = -1;
      plazaMat.polygonOffsetUnits = -2;
    }
    world.add(buildPlazas(TERRAIN, B, plazaMat));
  } catch (e) {
    console.error('[plaza] 建广场失败：', e);
  }

  // 国会大厦（专用模型）
  try {
    const CAP = { x: 3527, z: -48 };
    const cap = buildCapitol(mats);
    cap.position.set(CAP.x, TERRAIN.sampleHeight(CAP.x, CAP.z), CAP.z);
    world.add(cap);
    window.__capitol = cap;
  } catch (e) {
    console.error('[capitol] 建模失败：', e && (e.stack || e.message));
  }

  const ms = Math.round(performance.now() - t0);
  console.log(`[terrain] ${TERRAIN.cols}×${TERRAIN.rows} @ ${TERRAIN.step} m, `
    + `z ${TERRAIN.zMin.toFixed(2)}..${TERRAIN.zMax.toFixed(2)} m, `
    + `${B.buildings.length} 栋, ${ms} ms`);
  if (blocks.userData.roofStats) {
    const rs = blocks.userData.roofStats;
    console.log('[roof] ' + Object.entries(rs).map(([k, v]) => `${k} ${v}`).join(' / ')
      + ` · ${blocks.userData.triCount} 三角 / ${blocks.userData.meshCount} 桶`);
  }
  if (WATER) {
    console.log(`[water] ${WATER.bodies.length} 水体, 挖槽顶点 ${dug}, 湿泥顶点 ${wetPainted}`);
  }

  // L4：全城实测树冠（DCGIS Urban Tree Canopy 2023，35k 棵）。
  // 之前这一层压根没接进来，城里除了白宫园林一棵树都没有 —— 这就是
  // 「绿化做得很烂」的原因。位置/树高/冠幅都是实测值，不用猜。
  try {
    const TL = await loadTrees();
    const field = buildTreeField(TL, {
      T: TERRAIN,
      // 白宫园林那 240 棵树是自己的高模，半径 200 m 内不重复种，免得重影
      skipNear: { x: WH_PLAN.x, z: -WH_PLAN.y, r: 200 },
    });
    world.add(field);
    window.__trees = field;
  } catch (e) {
    console.error('[trees] 加载失败：', e && (e.stack || e.message || e));
  }

  // L6：行人（用户 m10520「我们先把人加进去」）。
  // 走在 walknet 的人行道中心线上，状态机主动切动作，遇建筑/水/人自动让行。
  try {
    const pa = await loadPedAssets();
    // ?pedhi=1 用高模（55k 三角）出特写，默认 LOD（~3k），600 人才跑得动
    const detail = /[?&]pedhi=1/.test(location.search) ? 'hi' : 'lod';
    // 铺装顶面栅格：人必须站在人行道板面上，不是地形上（否则脚陷 0.46 m）。
    let PSURF = null;
    try {
      PSURF = await loadPedSurface();
      console.log('[ped] 站立面 surf.i16 已载入（人行道 +0.30 / 步道 +0.02 叠加 LIFT）');
    } catch (e) {
      console.warn('[ped] surf.i16 载入失败，人可能陷进铺装 0.46 m：', e.message);
    }
    PED = buildPedestrians(pa, { T: TERRAIN, B, count: 3000, seed: 20261024, detail, SURF: PSURF });
    world.add(PED.group);
    window.__ped = PED;
    window.__pedSurf = PSURF;
    console.log(`[ped] ${PED.stats.count} 人 / 可走链 ${PED.stats.usable} 条`
      + `（共 ${PED.stats.total}，短链 ${PED.stats.dropped.short}`
      + ` / 压建筑 ${PED.stats.dropped.blocked} / 压水 ${PED.stats.dropped.water}）`);
  } catch (e) {
    console.error('[ped] 行人加载失败：', e && (e.stack || e.message || e));
  }

  // 调试出口：校验建筑底面是否真的落在 DTM 上
  window.__buildings = B;
  window.__buildingMesh = blocks;
  window.__water = WATER;
  window.__waterGroup = waterGrp;
  // 内涝仿真用：把水面抬到 design_water_level_m（1% 年超越洪水位）
  window.__setFlood = (on) => {
    if (WATER && waterGrp) setWaterDesignLevel(WATER, waterGrp, !!on);
  };

  return { terr, blocks, B, waterGrp };
}

// 白宫主体：坐标从场景米制搬到 three（planY 取负），底面落在该点 DTM 高程上
const WH_GROUND = { y: 0 };

{
  // 高模白宫的局部坐标原点在楼中心地面。它自带 L=51.2 × D=25.9，
  // 而基底轮廓是 52.2 × 46.45（含南北两翼/门廊），所以直接按中心对齐即可。
  const house = buildWhiteHouse(mats);
  house.name = 'WhiteHouse';
  WH_GROUND.house = house;
  world.add(house);
}

// 白宫南草坪这一带的园林细节（喷泉/绿篱/花坛/树）属于 L4，
// 位置相对白宫中心，统一放到 WH_ANCHOR 组里，落地高程由 DTM 决定。
const WH_ANCHOR = new THREE.Group();
WH_ANCHOR.name = 'L4_vegetation';
world.add(WH_ANCHOR);

function anchorWhiteHouseGrounds() {
  if (!TERRAIN) return;
  const wx = WH_PLAN.x;
  const wz = -WH_PLAN.y;
  const gy = TERRAIN.sampleHeight(wx, wz);
  WH_GROUND.y = gy;

  WH_GROUND.house.position.set(wx, gy, wz);
  WH_ANCHOR.position.set(wx, gy, wz);

  // 喷泉（南草坪中央，房子正南约 34 m —— 与照片构图一致）
  const fountain = buildFountain(mats, new THREE.Vector3(0, 0, 34), 1.0);
  WH_ANCHOR.add(fountain);
  WH_GROUND.fountain = fountain;

  // 绿篱（喷泉前那道横贯的矮绿墙）
  WH_ANCHOR.add(buildHedge(mats, new THREE.Vector3(0, 0, 46.5), 96, 1.55, 2.4, 3311));

  // 花坛（绿篱前，红+蓝两色带）
  WH_ANCHOR.add(buildFlowerBed(mats, new THREE.Vector3(0, 0, 52.5), 104, 3.6, 5521));

  // 树：按蓝噪声撒，避开建筑和喷泉
  const r = rng(90211);
  const placed = [];
  const minDist = 7.2;

  function tryPlace(x, z, kind) {
    if (Math.abs(x) < 62 && Math.abs(z) < 22) return false;
    if (Math.hypot(x, z - 34) < 11.5) return false;
    if (Math.abs(z - 50) < 5.5 && Math.abs(x) < 54) return false;
    for (const p of placed) {
      if (Math.hypot(p[0] - x, p[1] - z) < minDist) return false;
    }
    placed.push([x, z]);
    const seed = Math.floor(r() * 1e9);
    const tr = buildTree(mats, kind, seed, x, z);
    tr.rotation.y = r() * Math.PI * 2;
    WH_ANCHOR.add(tr);
    return true;
  }

  for (let i = 0; i < 150; i++) {
    const x = (r() - 0.5) * 340;
    const z = (r() - 0.5) * 300 - 10;
    const d = Math.abs(x);
    let kind;
    if (d < 34) kind = 'magnolia';
    else if (d < 90) kind = 'elm';
    else kind = r() > 0.72 ? 'conifer' : 'elm';
    tryPlace(x, z, kind);
  }
  for (let i = 0; i < 90; i++) {
    const x = (r() - 0.5) * 300;
    const z = 20 + r() * 150;
    tryPlace(x, z, 'shrub');
  }

  // 【关键】把所有树的叶卡片合并成 4 个 mesh（按材质分桶）
  // 否则 240 棵树 × 几十张卡片 = 上千次 draw call，只有 3 fps
  for (const m of buildLeafMeshes()) WH_ANCHOR.add(m);
}

// ---------------------------------------------------------------- 灯光
// 下午的阳光：暖、偏低、长阴影（照片里是下午）
//
// 【关键坑】阴影相机不能一次性覆盖整个 6×5.2 km。试过 S=3000 + 4096 贴图：
// 一个阴影贴图像素 ≈ 1.5 m，bias/normalBias 再怎么调都压不住自阴影，
// 结果是整块地面被"自己"遮住，渲染出来是一片死蓝灰（看起来像没地形）。
// 正确做法：阴影相机只覆盖相机附近 ~1.4 km，每帧跟着观察点平移。
const SHADOW_S = 700;
// 太阳方位：仰角 33°（原来 49°）。DC 的纬度 38.9°N，春秋分正午仰角约 51°，
// 但 49° 的投影太短、几乎全被楼体自己挡住，俯视时城市读成「没影子」。
// 33° 是下午三四点的角度：影子约为楼高的 1.5 倍，街区才立得起来。
const SUN_DIR = new THREE.Vector3(-0.60, 0.55, 0.58).normalize();  // 光来的方向

const sun = new THREE.DirectionalLight(0xfff4e2, 2.55);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.near = 80;
sun.shadow.camera.far = 3000;
sun.shadow.camera.left = -SHADOW_S;
sun.shadow.camera.right = SHADOW_S;
sun.shadow.camera.top = SHADOW_S;
sun.shadow.camera.bottom = -SHADOW_S;
sun.shadow.bias = -0.0012;
// 【坑·本轮真凶】normalBias 只有 0.04 m，而城市视野下阴影贴图的一个 texel
// 有 1.5 m 宽 —— 深度比较误差远大于偏置，整个地面布满同心弧线与细黑线，
// 用户看到的「整个平面多了很多蜘蛛网一样的线条」就是阴影自遮挡（shadow acne）。
// normalBias 必须随阴影视锥一起缩放（见 followShadow 里的赋值）。
sun.shadow.normalBias = 0.4;
// 【坑】改了 shadow.camera 的 left/right/top/bottom/near/far 之后必须手动
// updateProjectionMatrix()。DirectionalLightShadow 的默认正交视锥是 ±5，
// 不刷新的话阴影相机只有 10 m 见方，全城几乎看不到投影（画面发平的元凶之一）。
sun.shadow.camera.updateProjectionMatrix();
scene.add(sun);
scene.add(sun.target);

/**
 * 把阴影相机挪到观察点上方，并按相机距离伸缩阴影视锥（每帧调用，很便宜）。
 *
 * 【坑】原来 shadow.camera 固定 ±SHADOW_S(700 m)，只覆盖城市中心的 1.4 km，
 * 而城市是 6.0×5.1 km。视点一离开中心（比如白宫在马里兰一侧 1 km 外），
 * 那块地就不在阴影相机里，于是「有阳光、没投影」，画面发平，看着像纸糊的。
 * 这里改成：视锥半径跟着相机到观察点的距离走，近处保持 2 cm/texel 的锐利，
 * 远处放大到能覆盖全城。只在半径变化超过 8% 时重算投影矩阵，避免每帧刷。
 */
let shadowS = 0;
function followShadow(focus) {
  sun.target.position.set(focus.x, 0, focus.z);
  sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 1600);
  sun.target.updateMatrixWorld();
  sun.updateMatrixWorld();

  const eye = camera.position;
  const dist = Math.hypot(eye.x - focus.x, eye.z - focus.z);
  // 上限从 3200 收到 2000：6400 m 视锥在 4096 贴图上等于 1.56 m/texel，
  // 这个精度下任何偏置都压不住 acne；4000 m 视锥是 0.98 m/texel，配合
  // 动态 normalBias 才干净。
  const want = Math.min(2000, Math.max(240, dist * 1.15 + 90));
  if (Math.abs(want - shadowS) > shadowS * 0.08) {
    shadowS = want;
    const c = sun.shadow.camera;
    c.left = -shadowS; c.right = shadowS;
    c.top = shadowS; c.bottom = -shadowS;
    c.near = 20; c.far = 4200;
    c.updateProjectionMatrix();
    // 每个 texel 覆盖多少米，偏置就跟着走（1.5 texel 是经验上的安全值）。
    sun.shadow.normalBias = Math.max(0.08, (shadowS * 2 / 4096) * 1.5);
  }
}

// 天光（半球光）：上蓝下绿，模拟草地反光
const hemi = new THREE.HemisphereLight(0xbcd0e6, 0x6a7358, 0.62);
scene.add(hemi);

// 补充一盏很弱的反向补光，避免暗面死黑
const fill = new THREE.DirectionalLight(0xdfe9f7, 0.38);
fill.position.set(CITY_CX + 700, 500, CITY_CZ - 700);
scene.add(fill);

// ---------------------------------------------------------------- 云影
// 用一个缓慢移动的大噪声贴图做地面明暗斑，模拟云影流过草地
const cloudShadow = buildCloudShadow(9000);
scene.add(cloudShadow);
cloudShadow.position.set(CITY_CX, 0.05, CITY_CZ);

// ---------------------------------------------------------------- HUD
const statEl = document.getElementById('stat');
let triCount = 0;
renderer.info.autoReset = false;

// ---------------------------------------------------------------- fps
// 【坑】之前用 setInterval(250) 里算 1/(now-last) —— 那量的是**定时器回调间隔**
// （0.25 s → 恒等于 4~5 fps），跟真实帧率毫无关系，所以 HUD 永远显示 5。
// 正确做法：在渲染循环里数帧，每满 0.5 s 用「帧数 / 实际耗时」结算一次。
let fps = 60;
let fpsFrames = 0;
let fpsT0 = performance.now();

// ---------------------------------------------------------------- 循环
const clock = new THREE.Clock();
let elapsed = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;

  controls.update();

  // 阴影相机跟着观察点走（否则 6 km 范围里根本没有阴影）
  followShadow(controls.target);

  if (WH_GROUND.fountain) updateFountain(WH_GROUND.fountain, dt);

  // L6 行人：状态机 + 动画（必须在相机更新之后，距离裁剪才准）
  if (PED) PED.update(dt, camera);

  // 云影缓慢移动
  if (cloudShadow.material.map) {
    cloudShadow.material.map.offset.x += dt * 0.0042;
    cloudShadow.material.map.offset.y += dt * 0.0028;
  }

  renderer.info.reset();
  renderer.render(scene, camera);

  // fps：累计 0.5 s 再结算，读数稳定且是真实帧率
  fpsFrames++;
  const nowMs = performance.now();
  if (nowMs - fpsT0 >= 500) {
    fps = fpsFrames * 1000 / (nowMs - fpsT0);
    fpsFrames = 0;
    fpsT0 = nowMs;
    const info = renderer.info.render;
    statEl.textContent =
      `三角形 ${info.triangles.toLocaleString()} · 绘制 ${info.calls} 次 · ${fps.toFixed(0)} fps`;
  }
}

// ---------------------------------------------------------------- resize
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- 启动
// 先把城市（地形 + 建筑）加载出来，再挂白宫的园林细节 ——
// 园林的落地高程要用 TERRAIN.sampleHeight()，必须等地形就位。
document.getElementById('loading').classList.add('done');
animate();

buildCity().then(() => {
  anchorWhiteHouseGrounds();
  // 城市尺度下相机的远近范围要放大，否则只能看白宫那 300 m
  controls.maxDistance = 7000;
  // 给 shot.js 的完成信号：地形+建筑+园林全部就位
  window.__ready = true;  console.log('[ready] 城市地形 + 建筑就位');
}).catch((e) => {
  console.error('[fatal] 城市加载失败', e);
  const el = document.getElementById('loading');
  el.classList.remove('done');
  el.textContent = '地形数据加载失败：' + e.message;
});

// ---------------------------------------------------------------- 供外部截图/调试用
// shot.js 通过这个函数切相机预设（无头截图与人工查看用同一套机位）
// 【城市尺度】presets 全部改成场景绝对坐标：白宫在 (1144, -815)。
// 老的白宫局部机位保留成 *-house 版本，方便对照细节。
const WH = { x: WH_PLAN.x, z: -WH_PLAN.y };   // (1144, -815)

window.__setView = function (name) {
  const presets = {
    // 城市总览：从东南上空看整块 6×5.2 km
    city:      { pos: [CITY_CX + 2600, 1900, CITY_CZ + 3000], target: [CITY_CX, 0, CITY_CZ] },
    // 国家广场轴线：华盛顿纪念碑 → 国会山
    mall:      { pos: [1258, 190, 1150],  target: [2600, 20, -300] },
    // 波托马克河岸：看低洼区与高地街区的落差
    river:     { pos: [-560, 120, 620],   target: [900, 0, -600] },
    // 水面近景：贴着波托马克水面看对岸 Georgetown 崖（验收岸线湿滩带）
    waterlow:  { pos: [-760, 12, 1150],   target: [-300, 6, 700] },
    // Anacostia 河口 + Tidal Basin
    tidal:     { pos: [1400, 90, -60],    target: [820, 0, -820] },
    // 岸线近景：验收「1~3 m 干湿过渡带、无可辨直线边界」（任务书 §9 第 6 条）。
    // Georgetown 岸的水陆分界在 planY 1000 的 x≈-610（见 build_water 的横断面），
    // three 里 z = -planY，所以岸线在 (x=-610, z=-1000)。站在岸上往西南斜看水陆。
    shore:     { pos: [-520, 13, -985],   target: [-760, -3, -1105] },
    // Tidal Basin 岸线近景
    basin:     { pos: [1130, 18, -560],   target: [980, 0, -700] },
    // 白宫（城市里的一栋）
    // 【坑】OSM 把东翼「State Ballroom」在建工地画成一栋 x 1170..1251 / z -822..-722、
    //       高 16.8 m 的实心盒子（id 1536631257，function=construction）。
    //       机位只要落在 x > 1170 就直接怼进这堵墙里，前景是一整片灰面。
    //       所以白宫的几个广角机位一律从**西侧**看，别放回 +x。
    whitehouse: { pos: [WH.x - 108, 44, WH.z + 122], target: [WH.x, 20, WH.z] },
    // 白宫近景（沿用老的局部机位，换算到绝对坐标）
    south:     { pos: [WH.x - 44, 26, WH.z + 96],  target: [WH.x, 22, WH.z] },
    north:     { pos: [WH.x - 16, 25, WH.z - 86],  target: [WH.x, 23, WH.z] },
    aerial:    { pos: [WH.x - 76, 82, WH.z + 132], target: [WH.x, 20, WH.z + 6] },
    closeup:   { pos: [WH.x + 16, 21, WH.z + 40],  target: [WH.x, 22, WH.z + 20] },
    portico:   { pos: [WH.x, 20, WH.z + 46],       target: [WH.x, 21, WH.z + 13] },

    // ---- 屋面与街道验收机位（这轮加的）----
    // 【坑】上一版机位放在 (3352,148,258)，实际落在西南侧一栋 60 m 办公楼的正上方，
    //       国会山只在远处背景里露出一个灰穹顶 —— 于是「国会山没做对」的观感
    //       全部来自那栋素盒子，不是国会山本身。
    //       国会山体量中心在 (3527, -48)，主体高 87.6 m + 穹顶再高约 40 m，
    //       机位要退到 300 m 外、仰角 25°，才能看全穹顶 + 两翼 + 东侧广场。
    capitol:    { pos: [3862, 128, 268],  target: [3500, 52, -48] },
    // 连排屋街区：capitol hill 以东，全城坡屋顶最密的一片（约 80% 两坡/四坡）
    rowhouses:  { pos: [3430, 121, -2620], target: [3300, 35, -2750] },
    // 街道平视：1st Street NW，眼高 1.7 m —— 看路缘石、人行道、门廊台阶
    // 街道平视：站在 Georgetown 30th Street NW 的车行道中央，眼高 1.7 m。
    // 旧机位 (3256,-2500) 实际落在一条 2 m 宽的人行步道上，所以整条「街道」
    // 渲染出来是被 pave 贴图糊住的步道带，看不到任何标线。
    // 沿街看过去要「抬头」：30th St NW 在 45 m 内升高 2.1 m。之前的 target y
    // 设在地面以下，相机等于对着地面看，整屏都是同一块路面。
    // dy / tdy = 相对地面的高程偏移。用它们代替硬编码 y。
    street:     { pos: [-792.0, 0, -3429.1], target: [-780.5, 0, -3384.6], dy: 1.7, tdy: 1.9 },
    // 行人近景：站在拉斐特广场南侧人行道（白宫前方），看人流从身边走过。
    // 【坑 1】机位必须落在步行网（walknet）附近：人行道中心线离车行道中心 8~9 m，
    //       放在车行道正中会隔着两条车道看人，人只有十几个像素。
    // 【坑 2】热点集中在 (1144,-815) 半径 230 m 内 —— 这里 60 m 内实测 41 人、
    //       12 m 内 5 人，是全城最密的看点。
    crowd:      { pos: [1060, 0, -700], target: [1090, 0, -760], dy: 1.75, tdy: 1.2 },
    // 行人俯视：正上方 30 m 俯瞰白宫/拉斐特广场的行人流
    crowdTop:   { pos: [1060, 0, -700], target: [1075, 0, -720], dy: 30, tdy: 0 },
  };
  const p = presets[name] || presets.city;
  // 【为什么不用硬编码 y】地形/路面每次重导出，地面高程都会变几个米；写死的
  // y 会立刻失效（2026-10-24 就发生过：地面从 36.9 抬到 39.14，机位 y=38.6
  // 直接埋进土里，画面整屏是地形剖面 + 水面）。dy/tdy 让机位永远贴着当地地面。
  const px = p.pos[0], pz = p.pos[2], tx = p.target[0], tz = p.target[2];
  const py = p.dy != null && TERRAIN ? TERRAIN.sampleHeight(px, pz) + p.dy : p.pos[1];
  const ty = p.tdy != null && TERRAIN ? TERRAIN.sampleHeight(tx, tz) + p.tdy : p.target[1];
  camera.position.set(px, py, pz);
  controls.target.set(tx, ty, tz);
  controls.update();
  const btns = document.querySelectorAll('#views button');
  btns.forEach((b) => b.classList.toggle('on', b.dataset.v === name));
  console.log('[view] ' + name);
};

// ---------------------------------------------------------------- 机位快捷入口
// 让预览页面能自己切机位：右上角按钮点 + 数字键 1–9 / 0，不用开控制台
(() => {
  const order = ['city', 'mall', 'capitol', 'rowhouses', 'street', 'river', 'whitehouse', 'tidal', 'crowd', 'crowdTop'];
  const btns = document.querySelectorAll('#views button');
  btns.forEach((b) => {
    if (!order.includes(b.dataset.v)) order.push(b.dataset.v);
    b.addEventListener('click', () => window.__setView(b.dataset.v));
  });
  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // 0 键对应第 10 个机位（行人俯视）
    const idx = e.key === '0' ? 9 : Number(e.key) - 1;
    if (idx >= 0 && idx < order.length) window.__setView(order[idx]);
  });
})();

// ---------------------------------------------------------------- 调试入口
window.__scene = scene;
window.__renderer = renderer;
window.__camera = camera;
window.__controls = controls;
window.__world = world;
window.__terrain = () => TERRAIN;
window.__sun = sun;
window.__hemi = hemi;
window.__THREE = THREE;

// ==================================================================== 材质
function buildMaterials() {
  const wallTex = textureWhiteHouseWall(512);
  wallTex.repeat.set(6, 3);
  const slateTex = textureSlateRoof(256);
  slateTex.repeat.set(8, 4);
  const glassTex = textureWindowGlass(256);
  glassTex.repeat.set(1, 1);

  const lawnTex = textureLawn(512, false);
  lawnTex.repeat.set(124, 124);
  const soilTex = textureSoil(256);
  soilTex.repeat.set(10, 2);
  const pavingTex = textureBrickPaving(512);
  pavingTex.repeat.set(10, 10);
  const barkTex = textureBark(128);
  barkTex.repeat.set(1, 3);
  const waterNrm = textureWaterNormal(256);
  waterNrm.repeat.set(3, 3);

  return {
    // 白宫墙体：刷白的砂岩，粗糙、无金属
    wall: new THREE.MeshStandardMaterial({
      map: wallTex, color: 0xffffff, roughness: 0.86, metalness: 0.0,
    }),
    // 石灰岩装饰线脚（檐口、窗楣、栏杆）：比墙略白、略光滑
    trim: new THREE.MeshStandardMaterial({
      color: 0xf2efe8, roughness: 0.72, metalness: 0.0,
    }),
    stone: new THREE.MeshStandardMaterial({
      color: 0xe6e2da, roughness: 0.78, metalness: 0.0,
    }),
    column: new THREE.MeshStandardMaterial({
      color: 0xf4f1ea, roughness: 0.68, metalness: 0.0,
    }),
    chimney: new THREE.MeshStandardMaterial({
      color: 0xe8e4dc, roughness: 0.88, metalness: 0.0,
    }),
    roof: new THREE.MeshStandardMaterial({
      map: slateTex, color: 0xffffff, roughness: 0.9, metalness: 0.02,
    }),
    glass: new THREE.MeshStandardMaterial({
      // 【重要】不用 metalness+envMap 做玻璃 —— 无头/软件渲染下 envMap 常常拿不到，
      // 玻璃会变成死黑的洞（实测就是这个结果）。改成"贴图里烘好了天空反射"，
      // 材质保持低金属度，亮度完全由贴图决定，任何环境下都稳定。
      map: glassTex,
      color: 0xffffff,
      roughness: 0.18,
      metalness: 0.05,
      emissive: 0x1a2630,
      emissiveIntensity: 0.22,
    }),
    door: new THREE.MeshStandardMaterial({
      color: 0x2a2f33, roughness: 0.5, metalness: 0.1,
    }),
    // 草坪：略粗糙，带一点法线感（用 roughnessMap 也可以，这里省）
    lawn: new THREE.MeshStandardMaterial({
      map: lawnTex, color: 0xffffff, roughness: 0.97, metalness: 0.0,
    }),
    soil: new THREE.MeshStandardMaterial({
      map: soilTex, color: 0xffffff, roughness: 1.0,
    }),
    paving: new THREE.MeshStandardMaterial({
      map: pavingTex, color: 0xffffff, roughness: 0.92,
    }),
    bark: new THREE.MeshStandardMaterial({
      map: barkTex, color: 0xffffff, roughness: 0.96,
    }),
    hedge: new THREE.MeshStandardMaterial({
      // 绿篱用一点 emissive 兜底：软件渲染/无 IBL 时侧面不会死黑
      color: 0x33502a, roughness: 0.97, metalness: 0.0,
      emissive: 0x111d0d, emissiveIntensity: 1.0,
    }),
    metal: new THREE.MeshStandardMaterial({
      color: 0xd8d4cc, roughness: 0.32, metalness: 0.85,
    }),
    // 水面：法线扰动 + 高金属度模拟反射
    water: new THREE.MeshStandardMaterial({
      color: 0x2b4f5e,
      normalMap: waterNrm,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughness: 0.06,
      metalness: 0.72,
      transparent: true,
      opacity: 0.93,
      envMapIntensity: 1.8,
    }),
    // 水柱：半透明白蓝，additive 更透亮
    waterJet: new THREE.MeshStandardMaterial({
      color: 0xdff0fa,
      roughness: 0.02,
      metalness: 0.0,
      transparent: true,
      opacity: 0.26,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  };
}

// ==================================================================== 天空
/**
 * 天空不是一个纯色背景，而是一个内壁球：
 * 天顶深蓝 → 地平线暖白，加一层极淡的太阳辉光。
 * 这样建筑和草坪的反射才有东西可反。
 */
function buildSky(radius = 18000) {
  // 半径要大于相机 far，否则从 6 km 外看会切掉天球；
  // 但 PMREM 烘环境贴图时用的是小视野，传小半径即可。
  const geo = new THREE.SphereGeometry(radius, 48, 28);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x2f6fb5) },
      uMid: { value: new THREE.Color(0x9cc3e8) },
      uBot: { value: new THREE.Color(0xdfe8ee) },
      // 太阳方向与 DirectionalLight 一致（城市尺度的那一盏）
      uSunDir: { value: new THREE.Vector3(-620, 900, 520).normalize() },
      uSunColor: { value: new THREE.Color(0xfff4e2) },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vDir;
      uniform vec3 uTop, uMid, uBot, uSunColor, uSunDir;
      void main() {
        float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
        // 三段渐变：地平线偏白，仰角 30° 附近过渡到中蓝，天顶深蓝
        vec3 col;
        if (h < 0.5) {
          col = mix(uBot, uMid, smoothstep(0.30, 0.52, h));
        } else {
          col = mix(uMid, uTop, smoothstep(0.52, 0.95, h));
        }
        // 太阳周围的辉光（Mie 散射的粗略近似）
        float sd = max(dot(normalize(vDir), normalize(uSunDir)), 0.0);
        col += uSunColor * pow(sd, 24.0) * 0.42;
        col += uSunColor * pow(sd, 4.0) * 0.06;
        // 地平线以下压暗（避免穿帮）
        col = mix(col * 0.55, col, smoothstep(-0.08, 0.02, vDir.y));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.frustumCulled = false;
  return sky;
}

// ==================================================================== 云影
function buildCloudShadow(span = 9000) {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  // 【坑】底必须是全透明。第一版 fillRect 黑 → 整块 9 km 平面全部是 42% 黑，
  // 地形、建筑、白宫全被压成一片深蓝灰（看起来像"地形没出来"）。
  g.clearRect(0, 0, size, size);
  // 几团柔和的黑斑
  const r = rng(4242);
  for (let i = 0; i < 9; i++) {
    const x = r() * size, y = r() * size;
    const rad = 60 + r() * 130;
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, `rgba(0,0,0,${0.16 + r() * 0.12})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  const mat = new THREE.MeshBasicMaterial({
    map: t, transparent: true, opacity: 0.42,
    depthWrite: false, depthTest: false,
    blending: THREE.NormalBlending,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(span, span), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.05;
  m.renderOrder = 2;
  // 9 km 平面无法贴合 89 m 高差的地形（会切进山丘里），城市尺度下先关掉。
  // 需要时改为跟随相机的 1~2 km 局部云影。
  m.visible = false;
  return m;
}







