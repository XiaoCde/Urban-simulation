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
import { createFloodLayer } from './flood.js';
import { createRain, rainRateAt } from './rain.js';
import { CLOCK, toStoryMin, STORY_OFFSET } from './clock.js';
import { setTimeLayer, publishMinOf } from './kernel/warning.js';
import { setSweptMode } from './kernel/flow-hazard.js';
import { setExperienceLink, setExperienceKappa, setDecideMode, setSingleVariant } from './kernel/choice-model.js';
import { setCasualtyScale } from './kernel/thresholds.js';
import { setPeerMode, setPeerParams } from './kernel/peer-network.js';
import { setCrowdMode } from './kernel/crowd-threshold.js';
import { setSlipMode, setSlipLower, setSlipUpper } from './incidents.js';
import { setReceptionChannel, setDutyMissionRatio } from './kernel/reception-channel.js';
// 【2026-11-21 个体追溯】`?trace=<人序号>` 打开后，页面把那个人的逐分钟记录攒起来，
// 跑完由 sim-day.mjs 取走写成 JSON（也留在 window.__trace 里供控制台查看）。
import { traceDump } from './trace.js';

// 模块级参数入口：路网装配早于 buildCity 里的 QS0，单独留一份。
const QS_ROAD = new URLSearchParams(location.search);
// 【§5 时间层 2026-11-20】默认关闭；`?timelayer=1` 打开「发布/收到/动身」三钟。
// 打开会改全部工况的决策时间轴，必须整族重跑才算数（docs/时间层设计_2026-11-20.md）。
const TIME_LAYER_ON = QS_ROAD.has('timelayer');
if (TIME_LAYER_ON) setTimeLayer(true);
// 【2026-11-21 冲走判据】默认关闭；`?swept=unstable` 打开「D·V 达失稳上限即判被冲走」。
// 这是把危险度读成伤亡的上界口径，主结果不用它，两版之差单独报（docs/冲走判据改法_2026-11-21.md）。
if ((QS_ROAD.get('swept') || '').toLowerCase() === 'unstable') setSweptMode(true);
// 【2026-11-21 经验修正】默认开启；`?exp=off` 关闭，用于 A/B 看「经验 → 多快动员」这一条的贡献。
// 经验系数来自 Thieken 2023 Table S2/S3，唯一自由标量是 EXPERIENCE_LINK.kappa（λ=1 假设）。
if ((QS_ROAD.get('exp') || '').toLowerCase() === 'off') setExperienceLink(false);
// 【2026-11-21 敏感性 · 一次只动一处】这四个开关专为单变量分解准备，
// 每个只改一条判据/一个标量，其余全部保持口径表那一版：
//   ?kappa=0.5|2              经验 → 门3 的跨论文尺度比（唯一自由标量）
//   ?crowd=coefficient|off    从众渠道：Borowski 加性系数 / 全关
//   ?slip=off                 关掉 D·V 受伤判据（看受伤数里有多少是它贡献的）
//   ?sliplo=0.35|1.4          受伤判据的成人下界（Keller & Mitsch 实测区间端点）
{
  const K = QS_ROAD.get('kappa'); if (K) setExperienceKappa(K);
  const CM = QS_ROAD.get('crowd'); if (CM) setCrowdMode(CM);
  const SP = QS_ROAD.get('slip'); if (SP) setSlipMode(SP);
  const SL = QS_ROAD.get('sliplo'); if (SL) setSlipLower(SL);
  const SH = QS_ROAD.get('sliphi'); if (SH) setSlipUpper(SH);
  // 暴露时长整体倍数（伤亡链里最没依据的两个数：成人 150 s / 儿童 80 s）
  const CS = QS_ROAD.get('casscale'); if (CS) setCasualtyScale(CS);
  // 【2026-11-22】参照群体生成器：模式与两个结构参数（可现场扫，见 kernel/peer-network.js）
  const PM = QS_ROAD.get('peer'); if (PM) setPeerMode(PM);
  const PR = QS_ROAD.get('peerR'); if (PR) setPeerParams({ shortRangeM: PR });
  const PQ = QS_ROAD.get('peerQ'); if (PQ) setPeerParams({ longRangeQ: PQ });
  // 【2026-11-22 消融】决策结构：gate = 五道门（默认），single = 单式效用基线。
  // ?single=merge|raw 选单式基线的两种合并方式（见 kernel/choice-model.js 的 SINGLE_UTILITY）。
  const DM = QS_ROAD.get('decide'); if (DM) setDecideMode(DM);
  const SV = QS_ROAD.get('single'); if (SV) setSingleVariant(SV);
}
// 【2026-11-21 门1】接收渠道重分配：默认中性（ratio=1 与关闭逐位相同）。
if ((QS_ROAD.get('recv') || '').toLowerCase() === 'off') setReceptionChannel(false);
{
  const rr = Number(QS_ROAD.get('recvratio'));
  if (Number.isFinite(rr) && rr > 0) setDutyMissionRatio(rr);
}

/** 积涝叠层（可选，数据缺失时保持 null） */
let FLOOD = null;
let RAIN = null;          // 降雨层（跟着时钟走，全天可见）
let STORY = null;         // 全天剧本（day_full.json）
let LIFE = null;          // 按剧本补建的生活场景 3D 道具
let DAYMOTION = null;     // 7 人 24h 连续轨迹（时刻 → 位置 / 动作 / 室内外）
let CROWD_LIFE = null;    // 随机行人的身份 / 脑子 / 生理 / 场景（不进展示面板）
/** HUD 上直接核对「这个人在做什么」的中文动作名，与 day-motion 的 kind 对齐。 */
const KIND_CN = {
  sleep: '睡卧', home: '坐卧', meal: '用餐', desk: '办公', medical: '手术',
  teach: '授课', serve: '服务', talk: '交谈', wait: '等候', manual: '作业',
  evacuate: '撤离', drive: '乘车', ride: '跑单',
  travel: '赶路', approach: '走动',
};
/** 暴雨窗口里 story 引擎直接给 clip 名（没有 kind），也要显示中文动作。 */
const CLIP_CN = {
  idle: '待命', idle2: '休息', sit: '坐卧', walk: '走动', run: '快走',
  look: '张望', stairs_up: '上楼', stairs_down: '下楼', door: '开门',
  crouch: '蹲下', crawl: '低姿', start: '起步', stop: '停步',
  run_stop: '急停', back: '后退', side_l: '侧移', side_r: '侧移',
  turn180: '转身', evacuate: '撤离',
};
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
  loadTerrain, buildTerrainMesh, loadBuildings, buildBuildingMesh, loadRoadCut, LANDMARK,
} from './terrain.js';
import {
  loadCityTextures, prepareFacades,
  wallMaterial, roofMaterial, roadMaterial, terrainMaterial, marbleMaterial,
} from './citytex.js';
import { loadRoads, buildRoadGroup, makeMarkMaterials, makeRoadSurf } from './roads.js';
import { setRoadCut } from './roadmesh.js';
import { buildBridgeStyles } from './bridges.js';
import { buildRoadNetwork, clipOldRoads } from './roadnet.js';
import { SITE } from './district-buildings.js';
import { createTraffic } from './traffic.js';
import { buildRoadProps } from './roadprops.js';
import { createCollision, collectSolids } from './collision.js';
import { buildPlazas } from './plazas.js';
import { buildCapitol } from './landmarks.js';
import { loadTrees, buildTreeField, buildShrubField } from './trees.js';
import { makeRoadCorridorTest } from './street-route.js';
import {
  loadWater, buildWaterMesh, excavateTerrain, setWaterDesignLevel, paintShoreWet,
} from './water.js';
import { loadPedAssets, buildPedestrians, nextState, loadPedSurface, setPublishMin } from './ped.js';
import { loadLdt } from './ldt.js';

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
  // 只在 ?capture=1（自动验收）时保留绘制缓冲，否则 canvas.toDataURL 拿到的是空白。
  // 正常浏览没有这个开销。
  preserveDrawingBuffer: new URLSearchParams(location.search).has('capture'),
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// 电影感：ACES 色调映射 + 轻微曝光
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

// ---------------------------------------------------------------- 场景 & 雾
const scene = new THREE.Scene();
// 【空中透视】没有雾时，3 km 外的街区仍然「黑得发青」，城市边缘是硬切；
// 加一层淡蓝雾后远景自然退灰，天际线才有大气深度（用户说「丑」的一大来源）。
// 近端 3.2 km 以外才开始起雾，避免近景发灰、贴图糊掉。
scene.fog = new THREE.Fog(0xd3e2f0, 3200, 16000);
// 天空：一个巨大的球内壁，用着色器做真实的天光渐变（不是纯色背景）
const SKY_MESH = buildSky();
scene.add(SKY_MESH);

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
// 旧单人 demo 迁进主场景后的四件东西：精细楼、公寓、停车场、以及故事控制器。
// 都建在 buildCity() 里，但要跨到行人装配段才能用，所以提到模块级。
let MARK = null, MK_OFFICE = null, MK_HOME = null, MK_LOT = null;
let PEOPLE = null;      // 2026-11-13 起演示人只剩马克，此系统退役（引用保留空值保护）
// 新路网（模块化瓦片）+ 沿图行驶的车流；模块级是为了 animate 里能推进。
let ROADNET = null, TRAFFIC = null;
let BIDX = null;          // 建筑占位索引（街区路网建好后装配，跟拍避墙也要用）
let COLLIDE = null;       // 统一实体碰撞层（建筑 + 家具 + 街具 + 树 + 停放车）
let CONTROL = null;     // 统一控制栏目（雨强 / 24h 时间轴 / 增水）
window.__THREE = THREE;           // 调试/验收脚本量 bbox 用（只读）
window.__terrY = (x, z) => (TERRAIN ? TERRAIN.sampleHeight(x, z) : null);
window.__camNow = () => camera;
window.__insideNow = () => cameraInsideBuilding();
window.__roadnet = () => ROADNET;
window.__traffic = () => TRAFFIC;
// 【2026-11-21 个体追溯】同 `?trace=<i>`：返回被追那人的 identity/tick/judge/事件链。
window.__trace = () => traceDump();

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
        path: (() => {
          // 【色偏校正】pave.jpg 实测平均 RGB = (144,136,115)，本身是暖米黄；
          // 乘上暖阳光后整片人行道/广场读成「黄土」，这是街景最大的败笔。
          // 用线性空间的乘色把它拉回中性冷灰混凝土（分量 >1 合法）。
          const m = roadMaterial(TEX, 'pave', { color: 0xffffff, roughness: 0.95 });
          m.color.setRGB(1.12, 1.25, 1.58);
          return m;
        })(),
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

  // ---- 用用户最新给的道路模型重铺核心街区（2026-11-06）----
  // 用户原话：「把路重新铺一遍，用我给你的最新的道路模型，旧的和多余的删掉，
  // 保证没有断头和多边形路面，还有路灯和红绿灯的位置你全都是铺错了的」。
  // 旧 L2_road 是 5 层共面带子 + 未吸附路口表 + 固定 ±6 m 摆灯；现在这一整片
  // 改由 roadnet.js 的模块化瓦片接管：按图连通性选瓦片（不可能断头）、
  // 一格一块（不可能重叠）、旧带子在矩形内几何裁除（不可能两层共面）。
  if (!QS_ROAD.has('noroadnet')) {
    try {
      const R = { x0: 2150, x1: 2690, z0: -620, z1: 470 };
      // 所有真实楼 footprint 都当「禁铺区」，瓦片和灯杆都不许压进楼里 ——
      // 这是用户说的「有的和别的路面，房屋卡膜重叠了」的根治办法。
      const allFootprints = [];   // 灯杆/车位避让用：所有真实楼
      const roadFootprints = []; // 路网禁铺用：只给真正有 3D 楼体的
      for (const bd of B.buildings) {
        let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
        for (let k = 0; k < bd.vc; k++) {
          const a = (bd.v0 + k) * 4;
          const x = B.verts[a], z = B.verts[a + 1];
          if (x < minx) minx = x; if (x > maxx) maxx = x;
          if (z < minz) minz = z; if (z > maxz) maxz = z;
        }
        const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2;
        if (cx < R.x0 - 40 || cx > R.x1 + 40 || cz < R.z0 - 40 || cz > R.z1 + 40) continue;
        const box = [cx, cz, maxx - minx, maxz - minz];
        allFootprints.push(box);
        // 【别把 126 栋普通楼全塞进路网禁铺】实测会把 161/495 = 33% 的格子
        // 变成空地块，路网看着像被啃掉三分之一。低矮纸壳子贴街是正常街景；
        // 真正会穿模的是 MegaKit 接管的 3D 楼（判定条件与下面 MK_IDS 一致）。
        if (bd.height_m > 3 && bd.height_m <= 90 && bd.vc >= 3
          && Math.hypot(cx - 2501, cz - 355) <= 460) roadFootprints.push(box);
      }
      // 【工地的隐藏 footprint】buildSite() 自己铺了一块场坪，它不在
      // buildings.json 里（虚构场地），旧代码完全没避让它 —— 这就是用户说的
      // 「建筑工地跟路面重合」。把围挡内的作业区作为真实占位加进禁铺。
      roadFootprints.push([SITE.cx, SITE.cz, 34, 24]);
      allFootprints.push([SITE.cx, SITE.cz, 34, 24]);
      const canPlace = (x, z) => !allFootprints.some(([cx, cz, w, d]) =>
        Math.abs(x - cx) < w / 2 + 2.5 && Math.abs(z - cz) < d / 2 + 2.5);

      ROADNET = await buildRoadNetwork({ terrain: TERRAIN, rect: R, footprints: roadFootprints });
      world.add(ROADNET.group);
      // 【裁旧路要用并集】相位对齐会把瓦片推到 R 之外（实测 z 到 532 > R.z1 470），
      // 只裁传入的 R 会留下 72 m 旧多边形带子；只裁 ROADNET.rect 又会多裁一片。
      if (roadGrp) clipOldRoads(roadGrp, {
        x0: Math.min(R.x0, ROADNET.rect.x0), x1: Math.max(R.x1, ROADNET.rect.x1),
        z0: Math.min(R.z0, ROADNET.rect.z0), z1: Math.max(R.z1, ROADNET.rect.z1),
      });
      // 路面走廊测试（5 m 内算「在路上」）：灯杆、信号灯、植被都靠它避开车道。
      // 必须在 props 之前建，灯和杆也要用。
      const onRoad = makeRoadCorridorTest(ROADNET, 5.0);
      window.__roadCorridor = onRoad;
      const props = await buildRoadProps({
        net: ROADNET, world, canPlace, parkCount: 70, onRoadTest: onRoad,
        // 车位专用：比灯杆更宽的走廊，防止停车横在十字路口的另一条路上
        parkAvoid: makeRoadCorridorTest(ROADNET, 7.5),
      });
      LAMP_POSITIONS = props.lampPositions || [];
      window.__lampPositions = LAMP_POSITIONS;
      // ---- 统一实体碰撞层（第一批：灯杆 / 信号灯 / 停放车）----
      // 以前这些东西只有视觉，没有体积：行人从灯杆里穿过去，车也停在人身上。
      COLLIDE = createCollision();
      window.__collide = COLLIDE;
      COLLIDE.nStreet = collectSolids(props.group, COLLIDE, { tag: 'street', THREE });
      // ---- 建筑占位索引：一次建好，两处用 ----
      // ① 压路剔除：路中线采样点落进哪栋低模楼的包围盒，就把那栋楼剔掉；
      // ② 跟拍避墙：机位如果落在某栋楼体内部（x,z 在轮廓内且高度不够），
      //    就往后退/抬高，别把镜头塞进墙里。
      // 【为什么必须做】路网是规整棋盘、楼是真实轮廓，两套几何天生打架 ——
      // 实测 560 条路段里 185 条的中点落在某栋楼的包围盒内，用户看到的
      // 「楼横在马路中间」就是这批。
      BIDX = (() => {
        const CELL = 64;
        const hashAt = (x, z) => (Math.floor(x / CELL) * 73856093) ^ (Math.floor(z / CELL) * 19349663);
        const buckets = new Map();
        const rects = [];
        for (const bd of B.buildings) {
          if (!(bd.height_m > 3)) continue;
          let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
          for (let k = 0; k < bd.vc; k++) {
            const a = (bd.v0 + k) * 4;
            const x = B.verts[a], z = B.verts[a + 1];
            if (x < minx) minx = x; if (x > maxx) maxx = x;
            if (z < minz) minz = z; if (z > maxz) maxz = z;
          }
          // 【2026-11-21】把建筑的 function（office/apartments/house/university…
          // 见 buildings.json）与名称一起带出去：工作场所要按职能挑真实楼栋，
          // 否则上班的人只能分到池化门牌、没有楼层，白天按地面水深判死。
          const r = { id: bd.id, fn: bd.function || '', name: bd.name || '',
            minx, maxx, minz, maxz, h: bd.height_m,
            // 【修 2026-11-17】把真实占地面积传下去。此前楼层容量用外接矩形
            // (maxx-minx)×(maxz-minz)，L 形／细长楼会高估每层能站多少人。
            area_m2: bd.area_m2, alive: true };
          rects.push(r);
          for (let gx = Math.floor(minx / CELL); gx <= Math.floor(maxx / CELL); gx++) {
            for (let gz = Math.floor(minz / CELL); gz <= Math.floor(maxz / CELL); gz++) {
              const k = (gx * 73856093) ^ (gz * 19349663);
              let arr = buckets.get(k);
              if (!arr) buckets.set(k, arr = []);
              arr.push(r);
            }
          }
        }
        return {
          rects, buckets, hashAt,
          /** 渲染层把某些楼整栋剔除后，这里同步注销它们的占位。 */
          setAlive(deadIds) {
            for (const r of rects) r.alive = !deadIds.has(r.id);
          },
          /** 该点 (x,y,z) 是否在某栋楼的实体内部（留 0.8 m 余量） */
          blocked(x, y, z) {
            const arr = buckets.get(hashAt(x, z));
            if (!arr) return false;
            for (const r of arr) {
              if (!r.alive) continue;               // 已从渲染管线删掉的幽灵楼
              if (x > r.minx + 0.8 && x < r.maxx - 0.8
                && z > r.minz + 0.8 && z < r.maxz - 0.8 && y < r.h) return true;
            }
            return false;
          },
        };
      })();
      window.__bIdx = BIDX;
      // 建筑也进统一碰撞层（tag='building'）：相机/出生点/道具都用同一套查询。
      // 行人查询时忽略这个标签 —— 人本来就该待在楼里。
      if (COLLIDE) {
        for (const r of BIDX.rects) {
          const it = COLLIDE.addBox((r.minx + r.maxx) / 2, (r.minz + r.maxz) / 2,
            (r.maxx - r.minx) / 2, (r.maxz - r.minz) / 2, -60, r.h, 'building');
          r.collideId = it ? it.id : null;
        }
      }
      // 【全城车行图】roadnet 的瓦片只铺中心 540×1090 m（实测 96 辆车 100%
      // 挤在 8 个 500m 网格里）。这里把真实 OSM 机动车道补进同一张逻辑图，
      // 车才能沿全城道路跑；瓦片实例一块都不新增。
      try {
        const { attachCityDriveNet } = await import('./city-drive-net.js');
        window.__cityNet = await attachCityDriveNet(ROADNET, {
          terrain: TERRAIN, world,
          // QS0 在文件末尾才定义，这里处于 TDZ，必须直接读 location.search
          draw: new URLSearchParams(location.search).has('drawcitynet'),
        });
      } catch (e) {
        console.warn('[city] 全城车行图接入失败，车辆仍只在核心区：', e && (e.message || e));
      }
      TRAFFIC = await createTraffic({
        net: ROADNET, world, clock: CLOCK, count: 240,
        // 【时间维】t 是「一天分钟」，由 traffic.js 从 CLOCK 传下来；旧版这里
        // 只写 (x,z)，第三参被丢掉，车永远按「当前帧」判水 —— 跨帧那一下
        // 水深会从 0.4 m 直接跳到 0，车猛地一脚油冲进深水。
        depthAt: (x, z, t) => (FLOOD && FLOOD.group.visible && FLOOD.depthAt)
          ? (FLOOD.depthAt(x, z, t) || 0) : 0,
      });
      window.__street = {
        tiles: ROADNET.stats.tiles, edges: ROADNET.stats.edges,
        junctions: ROADNET.stats.junctions,
        lamps: props.stats.lamps, signals: props.stats.signals,
        parked: props.stats.parked, moving: TRAFFIC.stats.count,
      };
      console.info('[city] 新路网 + 交通流 + 路灯/信号灯/停车已接管核心区');
    } catch (e) {
      console.warn('[city] 新路网接入失败：', e && (e.stack || e.message));
    }
  }
  // 国会大厦不走「4 点矩形拉伸」的通用管线 —— buildings_footprints.json 每条轮廓
  // 只有 4 个点，做成 87 m 高的方板完全不像国会山（没有两翼、没有柱廊）。
  // 这里排除掉它，改用 landmarks.js 里的专用模型。
  // 【纸壳子必须真的剔掉】'48037641' = FAA 办公楼、'1207911106' = 565 Penn 公寓。
  // 这两栋由 office-building.js / home-building.js 出精细可进入模型；下面的 keep
  // 集合会故意把它们排除在 MegaKit 接管名单之外，但通用管线 buildBuildingMesh
  // 只认 EXCLUDE —— 不在这里加，精细模型就会和原纸壳子叠在一起（旧注释声称
  // 已经剔了，代码其实没做）。
  // 再加三座由 district-buildings.js 出精细模型的建筑（咖啡馆 / 诊所 / 学校），
  // 否则 6 个具名角色的室内路线会悬在纸壳子外面。
  const EXCLUDE = new Set([
    WH_ID, '66418809', '48037641', '1207911106',
    '574897355', '48041424', '48041308',
    // 【实测补漏】学校 bbox (2298.2, -517.94) 与这栋真实楼也相交 624 m²，
    // 旧 EXCLUDE 漏了它，精细学校和纸壳子叠在一起（用户「房屋卡膜重叠」）。
    '48041293',
  ]);
  // 【哪些「被 EXCLUDE 剔除的纸壳子」在原地仍有可见替代物】
  // MegaKit / 地标接管的楼虽然也不走通用管线，但会重新渲染出来，占位必须
  // 保留；只有彻底删掉、没有任何替代的才是幽灵，该从 BIDX/COLLIDE 注销。
  const REPLACED = new Set();
  // 压路判定结果要传给后面的 MegaKit 接管名单：压路的楼谁都不许再画出来。
  let ROAD_GHOSTS = new Set();

  // ---- 压路的低模楼：整片剔除（必须在 EXCLUDE 建好之后跑）----
  {
        const killed = new Set();
        // 【只放过真正的精细楼】旧版用 `EXCLUDE.has(id) → 不动`，而 EXCLUDE 里
        // 除了白宫/办公楼/公寓，还混着 4 栋「被精细模型替代的普通楼」。结果
        // 那 4 栋加上 90 m 以上的高楼全部留在原地压着路 —— 实测 2800 个路中线
        // 采样点里有 869 个落在楼体内部、涉及 47 栋（用户 2026-11-06 反复说
        // 「有的楼横在马路中间」）。现在改成白名单：只有下面这 8 个 id 不删。
        const hit = (x, z) => {
          const arr = BIDX.buckets.get(BIDX.hashAt(x, z));
          if (!arr) return;
          for (const r of arr) {
            if (r.h > 250) continue;                   // 250 m 以上只可能是纪念碑一类
            if (EXCLUDE.has(r.id)) continue;           // 精细楼：删了会露出空洞
            if (x > r.minx && x < r.maxx && z > r.minz && z < r.maxz) killed.add(r.id);
          }
        };
        // 【采样步长 4 m】6 m 会漏掉只有 2–8 m 宽、正好卡在两个采样点之间的
        // 窄楼；实测社会车辆就是从这类窄楼里穿过去的（66418828 / 908734108）。
        for (const e of ROADNET.edges) {
          const len = Math.hypot(e.b.x - e.a.x, e.b.z - e.a.z);
          const n = Math.max(3, Math.ceil(len / 4));
          for (let i = 0; i <= n; i++) {
            hit(e.a.x + (e.b.x - e.a.x) * i / n, e.a.z + (e.b.z - e.a.z) * i / n);
          }
        }
        for (const id of killed) EXCLUDE.add(id);
        ROAD_GHOSTS = new Set(killed);
        // 剔完再扫一遍：剩下的才是真的还压着路的楼。
        // 【口径修正】旧版这里 `if (EXCLUDE.has(r.id)) continue` 把 8 栋精细模型
        // 替代楼也一起跳过了，于是日志永远是「剩余 0 点」—— 可 FAA 办公楼 /
        // 565 Penn 公寓的可见实体仍然横跨在马路上（实测 26 个路中线采样点），
        // 车就是沿这些点开进楼里的。统计只该跳过「已删除的幽灵」，其余如实报。
        let leftPts = 0;
        let total = 0;
        const leftIds = new Set();
        for (const e of ROADNET.edges) {
          const len = Math.hypot(e.b.x - e.a.x, e.b.z - e.a.z);
          const n = Math.max(3, Math.ceil(len / 4));
          for (let i = 0; i <= n; i++) {
            const x = e.a.x + (e.b.x - e.a.x) * i / n;
            const z = e.a.z + (e.b.z - e.a.z) * i / n;
            total++;
            const arr = BIDX.buckets.get(BIDX.hashAt(x, z));
            if (!arr) continue;
            for (const r of arr) {
              // 只跳过真的从渲染里删掉的那批；可见的精细楼压路必须如实统计
              if (killed.has(r.id)) continue;
              if (x > r.minx + 1 && x < r.maxx - 1 && z > r.minz + 1 && z < r.maxz - 1) {
                leftPts++; leftIds.add(r.id); break;
              }
            }
          }
        }
        window.__roadKill = {
          buildings: killed.size, edges: ROADNET.edges.length,
          leftPts, totalPts: total, leftBuildings: leftIds.size, leftIds: [...leftIds],
          ghostIds: [...killed],
        };
        window.__exclude = EXCLUDE;
        console.info(`[roadnet] 剔除压路的低模楼 ${killed.size} 栋`
          + ` · 剩余压路点 ${leftPts}/${total}（${leftIds.size} 栋：精细模型/地标）`);
  }

  // ---- 用 MegaKit 真正替换掉一片街区（?megakit=1）----
  // 【为什么不套壳】第一版把 MegaKit 楼包在原楼外面（放大 1.5%），原楼还在里面：
  // 既有 z-fighting，也没有门洞可进 —— 用户原话「纸壳子」。正确做法是
  // 先把范围内的楼 id 从通用管线里剔掉，再让 MegaKit 接管；两边用同一个集合，
  // 保证不重叠、也不漏空。
  const QS0 = new URLSearchParams(location.search);
  // 城市时钟的参数入口：?markpause=1 暂停、?markspeed=N 倍速、?markt=一天分钟 跳时刻
  // 【24h 统一口径】minute = 一天中的分钟，0=00:00、1440=24:00；
  // 默认从 00:00 连续仿真。旧演示入口写死 17:00，导致用户一打开就是傍晚，
  // 看起来像只有暴雨片段。要看指定时刻仍可显式用 ?markt=一天分钟（含 0）。
  CLOCK.minute = 0;
  if (QS0.has('markpause')) CLOCK.setPlaying(false);
  if (QS0.has('markspeed')) CLOCK.setSpeed(Number(QS0.get('markspeed')) || 6);
  const mt = Number(QS0.get('markt'));
  if (QS0.has('markt') && Number.isFinite(mt)) CLOCK.minute = mt;
  window.__clock = CLOCK;
  // 【默认开启】城市的第一性就是「楼要像楼、门要能进」。旧版要手动加 ?megakit=1，
  // 结果用户每次打开看到的都是纸壳子。现在默认接管，`?nomk=1` 才回退。
  const MK_ON = !QS0.has('nomk');
  const MK_CX = 2501, MK_CZ = 355;              // FAA 办公楼（plan y=-355 → three z=355）
  const MK_R = Number(QS0.get('mkr')) || 460;
  const MK_IDS = new Set();
  if (MK_ON) {
    const keep = new Set([WH_ID, '66418809', '48037641', '1207911106', ...Object.keys(LANDMARK)]);
    for (const bd of B.buildings) {
      if (keep.has(bd.id)) continue;
      if (!(bd.height_m > 3) || bd.height_m > 90 || bd.vc < 3) continue;
      let cx = 0, cz = 0;
      for (let k = 0; k < bd.vc; k++) {
        const a = (bd.v0 + k) * 4;
        cx += B.verts[a]; cz += B.verts[a + 1];
      }
      cx /= bd.vc; cz /= bd.vc;
      if (Math.hypot(cx - MK_CX, cz - MK_CZ) > MK_R) continue;
      // 【压路的楼 MegaKit 也不接管】前一步刚判定这些楼横在路中线上、从通用
      // 管线里剔除；若这里又把它们加进 MK_IDS，MegaKit 会原地把它们重新画出来
      // —— 路面依旧被楼盖住（实测 16159112 一栋就压住 95 个路中点）。
      // 正是用户说的「你那个楼就在路面上啊」。
      if (ROAD_GHOSTS.has(bd.id)) continue;
      MK_IDS.add(bd.id);
    }
    for (const id of MK_IDS) { EXCLUDE.add(id); REPLACED.add(id); }
    console.info(`[megakit] 从通用管线剔除 ${MK_IDS.size} 栋（半径 ${MK_R} m）`);
  }

  // ---- 地标缓冲区：去掉「插进地标身体里」的普通楼 ----
  // 【这是穿模的根源】landmarks.js 按真实尺寸重建了国会山（187×266 m）、白宫等，
  // 但 buildings.json 里这些 footprint 内部/紧邻还散着若干普通楼 —— 它们照样被
  // 挤出成方块，于是「一栋楼插进圆顶建筑」。之前只按 id 排了 2 栋，远远不够。
  // 这里按地标自身 footprint 的包围盒外扩 8 m 做剔除，不看 id 只看位置。
  {
    const boxes = [];
    for (const id of Object.keys(LANDMARK)) {
      const bd = B.buildings.find((x) => x.id === id);
      if (!bd || bd.vc < 3) continue;
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (let k = 0; k < bd.vc; k++) {
        const a = (bd.v0 + k) * 4;
        const x = B.verts[a], z = B.verts[a + 1];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      boxes.push([x0 - 8, x1 + 8, z0 - 8, z1 + 8]);
    }
    // 【白宫要单独给大缓冲】它不在 LANDMARK 表里（用 whitehouse.js 的专用模型），
    // 但左右两侧的财政部 / 艾森豪威尔楼被整栋挤出后直接贴到外墙根，
    // 看起来像「白宫卡在两栋楼中间」（用户 2026-11-04「白宫也卡模了」）。
    // 真实白宫北草坪/南草坪都是开阔的，这里清 45 m。
    {
      const wh = B.buildings.find((x) => x.id === WH_ID);
      if (wh && wh.vc >= 3) {
        let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
        for (let k = 0; k < wh.vc; k++) {
          const a = (wh.v0 + k) * 4;
          const x = B.verts[a], z = B.verts[a + 1];
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
        boxes.push([x0 - 45, x1 + 45, z0 - 45, z1 + 45]);
      }
    }
    let cut = 0;
    const lmIds = new Set(Object.keys(LANDMARK));
    for (const bd of B.buildings) {
      // 【绝不能剔地标自己】华盛顿纪念碑的 footprint 只有 17×17 m，它当然落在
      // 自己的包围盒里 —— 上一版没跳过，结果方尖碑连同它脚下的楼一起被删掉，
      // 用户一眼就发现「纪念碑不见了」。
      if (EXCLUDE.has(bd.id) || lmIds.has(bd.id) || bd.vc < 3) continue;
      let cx = 0, cz = 0;
      for (let k = 0; k < bd.vc; k++) {
        const a = (bd.v0 + k) * 4;
        cx += B.verts[a]; cz += B.verts[a + 1];
      }
      cx /= bd.vc; cz /= bd.vc;
      for (const [x0, x1, z0, z1] of boxes) {
        if (cx > x0 && cx < x1 && cz > z0 && cz < z1) {
          EXCLUDE.add(bd.id); REPLACED.add(bd.id); cut++; break;
        }
      }
    }
    if (cut) console.info(`[landmark] 剔除落在地标范围内的普通楼 ${cut} 栋（${boxes.length} 个地标）`);
  }

  // 地标共用一份大理石材质（一个 program，几万三角面，不值得每栋 new 一个）
  const MARBLE = marbleMaterial();
  const blocks = buildBuildingMesh(B, TEX ? {
    excludeIds: EXCLUDE,
    materials: {
      wall: (k) => (k === 'marble' ? MARBLE : wallMaterial(TEX, k)),
      roof: (k) => (k === 'marble' ? MARBLE : roofMaterial(TEX, k)),
    },
  } : { excludeIds: EXCLUDE });
  if (QS0.has('noblocks')) blocks.visible = false;   // 调试：隐藏原建筑，看某面墙归谁
  world.add(blocks);

  // ---- 权威「可见实体」表：车 / 人寻路只认这份，不认被删掉的幽灵楼 ----
  // 用户 2026-11-08：「马克的车会直接穿过楼，那个楼就在路面上」。
  // 根因之一是 BIDX 在 EXCLUDE 之前装配，50 栋压路楼虽然已从渲染网格里
  // 整栋剔除，占位却还留在 BIDX/COLLIDE —— 视觉与碰撞不是同一个世界。
  // 这里在 EXCLUDE 全部确定后统一收口：幽灵注销，可见楼进一张带空间哈希的
  // 表，供 day-motion 的避障寻路与车轨迹清扫使用。
  const SOLIDS = (() => {
    // 只注销「真的从世界里消失」的楼。MegaKit / 地标 / 精细模型接管的纸壳子
    // 虽然也从通用管线剔除，但原地会重新渲染出可见建筑，占位必须保留 ——
    // 否则车会大摇大摆穿过一栋看得见的 MegaKit 楼。
    const ghosts = new Set(((window.__roadKill && window.__roadKill.ghostIds) || [])
      .filter((id) => !REPLACED.has(id)));
    BIDX.setAlive(ghosts);
    window.__roadKill.ghostIds = [...ghosts];
    if (COLLIDE) for (const r of BIDX.rects) {
      if (ghosts.has(r.id) && r.collideId != null) COLLIDE.drop(r.collideId);
    }
    const CELL = 64;
    const hashAt = (x, z) => (Math.floor(x / CELL) * 73856093) ^ (Math.floor(z / CELL) * 19349663);
    const buckets = new Map();
    const rects = [];
    const push = (r) => {
      rects.push(r);
      for (let gx = Math.floor(r.minx / CELL); gx <= Math.floor(r.maxx / CELL); gx++) {
        for (let gz = Math.floor(r.minz / CELL); gz <= Math.floor(r.maxz / CELL); gz++) {
          const k = (gx * 73856093) ^ (gz * 19349663);
          let arr = buckets.get(k);
          if (!arr) buckets.set(k, arr = []);
          arr.push(r);
        }
      }
    };
    for (const r of BIDX.rects) if (r.alive) push(r);
    const hit = (x, z, pad = 0) => {
      const arr = buckets.get(hashAt(x, z));
      if (!arr) return null;
      for (const r of arr) {
        if (x > r.minx - pad && x < r.maxx + pad
          && z > r.minz - pad && z < r.maxz + pad) return r;
      }
      return null;
    };
    /** 把一个点推出实体：沿最近的矩形边外扩 pad，返回修正后的坐标。 */
    const snapOut = (x, z, pad = 2.2) => {
      for (let pass = 0; pass < 4; pass++) {
        const r = hit(x, z, pad);
        if (!r) break;
        const dl = x - (r.minx - pad), dr = (r.maxx + pad) - x;
        const db = z - (r.minz - pad), df = (r.maxz + pad) - z;
        const m = Math.min(dl, dr, db, df);
        if (m === dl) x = r.minx - pad - 0.05;
        else if (m === dr) x = r.maxx + pad + 0.05;
        else if (m === db) z = r.minz - pad - 0.05;
        else z = r.maxz + pad + 0.05;
      }
      return { x, z, clear: !hit(x, z, pad) };
    };
    // 如实统计「仍压在路面上的可见楼」：不再像旧版那样把 EXCLUDE 里的楼
    // 全部跳过，FAA 办公楼 / 565 Penn 公寓这些剧情楼压路必须看得见数字。
    let blockPts = 0, blockTotal = 0;
    const blockIds = {};
    for (const e of ROADNET.edges) {
      const L = Math.hypot(e.b.x - e.a.x, e.b.z - e.a.z);
      const n = Math.max(3, Math.ceil(L / 4));
      for (let i = 0; i <= n; i++) {
        const x = e.a.x + (e.b.x - e.a.x) * i / n;
        const z = e.a.z + (e.b.z - e.a.z) * i / n;
        blockTotal++;
        const r = hit(x, z, 0.8);
        if (r) { blockPts++; blockIds[r.id] = (blockIds[r.id] || 0) + 1; }
      }
    }
    const roadBlocking = { pts: blockPts, total: blockTotal,
      ids: Object.entries(blockIds).sort((a, b) => b[1] - a[1])
        .map(([id, n]) => ({ id, n })) };
    return {
      rects, hashAt, hit, snapOut, roadBlocking,
      blocked: (x, z, pad = 0) => !!hit(x, z, pad),
      addRect: push,
      stats: () => ({ visible: rects.length, ghosts: ghosts.size, blockPts }),
    };
  })();
  window.__solids = SOLIDS;
  if (TRAFFIC && TRAFFIC.setSolids) TRAFFIC.setSolids(SOLIDS);
  if (TRAFFIC && TRAFFIC.setExternalCar) TRAFFIC.setExternalCar(() => {
    const D = window.__dayMotion, C = window.__clock;
    if (!D || !C || !D.carAt) return null;
    const q = D.carAt(C.minute);
    return q && q.moving ? q : null;
  });
  console.info(`[solids] 可见实体 ${SOLIDS.stats().visible} 栋 / 注销幽灵 ${SOLIDS.stats().ghosts} 栋`
    + ` · 仍压路可见楼 ${SOLIDS.roadBlocking.pts}/${SOLIDS.roadBlocking.total}`);

  // ---- 马克的办公楼 / 停车场 / 家（旧单人 demo 的整套底子）----
  // 用户 2026-11-04：「把当时马克的那个办公楼、停车场汽车、住所放到现在这个场景里，
  // 把对应的纸壳子全部删掉」。demo 用的就是这套全城世界坐标（OFFICE.cx=2501.37,
  // cz=354.69 正好是 MK_CX/MK_CZ），没有任何原点平移，所以可以直接搬。
  try {
    const { buildOfficeBuilding } = await import('./office-building.js');
    const { buildHomeBuilding, HOME } = await import('./home-building.js');
    const { buildParkingLot } = await import('./parking-lot.js');
    const off = buildOfficeBuilding();
    world.add(off.group);
    // 办公楼南侧的露天停车场：马克出门后先穿过场坪走到自己车边
    const lot = buildParkingLot((x, z) => TERRAIN.sampleHeight(x, z));
    world.add(lot.group);
    if (COLLIDE) COLLIDE.nLot = collectSolids(lot.group, COLLIDE, { tag: 'car', minH: 0.4, THREE, instFallback: { r: 0.9, h: 1.5 } });
    // 公寓底面：取四角 + 入口地形高程的最大值（和 office-main.js 同一算法）
    const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) =>
      [HOME.cx + sx * HOME.width / 2, HOME.cz + sz * HOME.depth / 2]);
    const hg = Math.max(
      ...corners.map(([x, z]) => TERRAIN.sampleHeight(x, z)),
      TERRAIN.sampleHeight(HOME.entryX, HOME.cz - HOME.depth / 2 - 1.5),
    );
    const hm = buildHomeBuilding(hg + 0.25);
    world.add(hm.group);
    MK_OFFICE = off; MK_HOME = hm; MK_LOT = lot;
    window.__officeBuilding = off;
    window.__homeBuilding = hm;
    window.__parkingLot = lot;
    console.info('[building] 办公楼（可进入）+ 露天停车场 + 565 Penn 公寓已接入主场景');
  } catch (e) {
    console.warn('[building] 办公楼/停车场/公寓接入失败：', e && (e.message || e));
  }

  // 同机位对比用：?mkview=1 只摆镜头，不动建筑
  if (new URLSearchParams(location.search).has('mkview')) {
    const CXv = 2501, CZv = 355;
    const gy = (TERRAIN && TERRAIN.sampleHeight) ? TERRAIN.sampleHeight(CXv, CZv) : 10;
    camera.position.set(CXv - 300, gy + 235, CZv + 330);
    controls.target.set(CXv, gy + 12, CZv);
    controls.update();
  }

  // ---- MegaKit 接管街区 ----
  // 建筑本体已在上面的 EXCLUDE 里剔掉，这里只负责把接管的楼拼出来。
  if (MK_ON) {
    try {
      const t0 = performance.now();
      const { loadMegakit, collectBuilding, buildInstancedMeshes } = await import('./megakit.js');
      const mk = await loadMegakit();
      const sink = new Map();
      let n = 0;
      for (const bd of B.buildings) {
        if (!MK_IDS.has(bd.id)) continue;
        const poly = [];
        let baseY = 1e9, topY = -1e9;
        for (let k = 0; k < bd.vc; k++) {
          const a = (bd.v0 + k) * 4;
          poly.push([B.verts[a], B.verts[a + 1]]);
          topY = Math.max(topY, B.verts[a + 2]);
          baseY = Math.min(baseY, B.verts[a + 3]);
        }
        if (bd.vc < 3) continue;
        // 【高度必须用 top_y − base_y】bd.height_m 和实际渲染出来的高度并不相等
        // （前者是 DCGIS 的属性高度，后者还带屋顶）。第一版用 height_m，结果
        // MegaKit 楼比原楼矮一截。
        const hReal = Math.max(3, topY - baseY);
        // seed 用楼 id 的数字尾部：同一栋楼每次拼出来一样，便于对比和复现
        const seed = (parseInt(String(bd.id).slice(-6), 10) || n * 37) % 99991;
        // 【LOD 分级】窗是唯一的成本大头（190 面/个）。按离样板中心的距离分三档，
        // 近处全窗、远处稀窗且只开低层 —— 肉眼在中远距离分辨不出差别，
        // 面数却能砍一半以上。
        let d = 0;
        for (const p of poly) d += Math.hypot(p[0] - MK_CX, p[1] - MK_CZ);
        d /= poly.length;
        const lod = d < 170 ? 0 : d < 320 ? 1 : 2;
        collectBuilding(mk, poly, hReal + 0.6, baseY, sink, {
          seed,
          // 【LOD 只调窗间距，不再砍楼层】上一版远处楼「只开低层窗」，结果大片
          // 光墙 —— 那正是「墙面像胡弄的」观感来源。改成每层都开窗、只是间距稀一点。
          windowEvery: QS0.has('nowin') ? 9999 : (lod === 0 ? 3 : lod === 1 ? 5 : 7),
          winFloors: 999,
        });
        n++;
      }
      const g = buildInstancedMeshes(sink, { wallMats: mk.__mats, xray: QS0.get('xray') || '' });
      g.name = 'megakit';
      world.add(g);
      let tris = 0;
      for (const im of g.children) {
        const geo = im.geometry;
        const nt = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
        tris += nt * (im.isInstancedMesh ? im.count : 1);
      }
      console.info(`[megakit] ${n} 栋 / ${g.children.length} mesh / ${(tris / 1e3).toFixed(0)}k 面 / `
        + `平均 ${(tris / Math.max(n, 1) / 1e3).toFixed(1)}k 面/栋 / ${Math.round(performance.now() - t0)} ms`);
      const hipN = (sink.get('HIP#0@roof') || { mats: [] }).mats.length;
      console.info(`[megakit] 坡顶 ${hipN} 栋 / 平顶 ${n - hipN} 栋`);
      window.__megakit = { n, draw: g.children.length, tris, r: MK_R, hip: hipN };
      window.__mkview = () => {
        const gy = (TERRAIN && TERRAIN.sampleHeight) ? TERRAIN.sampleHeight(MK_CX, MK_CZ) : 10;
        camera.position.set(MK_CX - 300, gy + 235, MK_CZ + 330);
        controls.target.set(MK_CX, gy + 12, MK_CZ);
        controls.update();
      };
      if (!QS0.has('mkeye')) window.__mkview();
    } catch (e) {
      console.warn('[megakit] 失败：', e && (e.message || e));
    }
  }

  // ---- 旧街道设施（信号灯 / 路边停车）已整体退役 ----
  // 旧 street.js 用「未吸附的 junctions.json + 固定 ±6 m 对角偏移 + 原始 DTM 高度」
  // 摆杆，位置全错；路灯只加载模型、从未摆放。现在由 roadprops.js 按 roadnet
  // 的真实图节点 + 同一高度场重摆，车流由 traffic.js 沿图行驶。
  // 保留 ?nostreet 只是为了让老参数不报错，不再生成任何旧几何。
  if (QS0.has('nostreet')) console.info('[street] ?nostreet 已弃用（新路网统一由 ?noroadnet 控制）');

  // 街景机位（?mkeye=1）：把相机放到 1.7 m 的人眼高度，检查门洞、窗户、人行道
  if (QS0.has('mkeye')) {
    const ex = Number(QS0.get('mx')) || 2460;
    const ez = Number(QS0.get('mz')) || 300;
    const tx = Number(QS0.get('tx')) || ex + 20;
    const tz = Number(QS0.get('tz')) || ez - 50;
    const gh = (TERRAIN && TERRAIN.sampleHeight) ? TERRAIN.sampleHeight(ex, ez) : 10;
    const th = (TERRAIN && TERRAIN.sampleHeight) ? TERRAIN.sampleHeight(tx, tz) : 10;
    const eyeH = Number(QS0.get('mh')) || 1.7;   // 机位高度，默认人眼 1.7 m
    camera.position.set(ex, gh + eyeH, ez);
    controls.target.set(tx, th + (Number(QS0.get('th')) || 2.4), tz);
    controls.update();
    console.info(`[eye] ${ex},${ez} → ${tx},${tz}  地面 ${gh.toFixed(1)} m`);
  }

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
    // 路面走廊：车行道 + 路缘 5 m 内不种任何植被（测试函数在路网建好后已创建）
    const onRoad = window.__roadCorridor || (ROADNET ? makeRoadCorridorTest(ROADNET, 5.0) : null);
    const field = buildTreeField(TL, {
      T: TERRAIN,
      // 白宫园林那 240 棵树是自己的高模，半径 200 m 内不重复种，免得重影
      skipNear: { x: WH_PLAN.x, z: -WH_PLAN.y, r: 200 },
      // DCGIS 的树点没判「在不在路上」，而地是瓦片棋盘路 —— 不剔就会长在斑马线中间
      avoid: onRoad,
    });
    world.add(field);
    window.__trees = field;
    // 树也有体积：树干按包住实例的圆柱收进去（35k 棵，走空间哈希，查询是常数级）
    if (COLLIDE) COLLIDE.nTree = collectSolids(field, COLLIDE, { tag: 'tree', minH: 1.0, THREE });
  } catch (e) {
    console.error('[trees] 加载失败：', e && (e.stack || e.message || e));
  }

  // L4-b：草坪灌木（程序化簇状撒点，只长在草地/林地）。
  // 「空地绿化」把大块空地养成了草坪，但 6 m 栅格的绿仍是一张平贴图；
  // 撒一层低矮灌木/小树丛，远处才有「城市里的绿地」的体积感。
  try {
    world.add(buildShrubField(TERRAIN, {
      count: 11000, seed: 20261024,
      avoid: window.__roadCorridor || null,
    }));
  } catch (e) {
    console.error('[trees] 草坪灌木失败：', e && (e.stack || e.message || e));
  }

  // L7：统一内涝层。所有工况都由 tools/flood/shallow2d.py 的**唯一** inertial
  // 内核跑出，24h 时间轴、四条退水去路、增水/退潮过程线全部一致。
  // 参数矩阵在 assets/flood/u_p*_s*/，索引 unified_index.json；
  // 老的根级 manifest（旧 fill-and-spill 内核）不再加载。
  let floodReady = null;
  try {
    // 【回写增益】默认 1 = 真实量级。?fb=8 只用于敏感性试验（把毫米级放大到
    // 看得见），不要拿它当「效果开关」：那等于给一个人编 8 个人的排水量。
    const FB_GAIN = (() => {
      const m = /[?&]fb=([\d.]+)/.exec(location.search);
      return m ? Math.max(0.1, Math.min(50, Number(m[1]))) : 1;
    })();
    try {
      RAIN = createRain({
        scene, camera, count: 4200, span: 120, tall: 42,
        // 建筑实体遮挡：雨丝中点落在楼里就不画，室内不再下雨
        occlude: (x, y, z) => {
          // 【相机进了精细楼就整片收雨】办公室 / 公寓 / 咖啡馆不在 BIDX 的
          // 纸壳子索引里，逐雨丝遮挡查不到它们；而屋顶已剖成半透明，雨丝会
          // 从上方一路灌进屋里（0 点近景实测）。结果每帧只算一次，见 frame。
          if (rainIndoor) return true;
          return !!(BIDX && BIDX.blocked && BIDX.blocked(x, y, z));
        },
      });
      if (/[?&]norain=1/.test(location.search)) RAIN.setVisible(false);
      window.__rain = RAIN;
    } catch (e) { console.warn('[rain] 初始化失败：', e && e.message); }
    FLOOD = createFloodLayer(TERRAIN, { base: '/assets/flood/', clock: CLOCK, fbGain: FB_GAIN });
    // 【雨强口】行人避雨不该只看「在下雨」：u_p8 工况全天 raining=true，
    // 但清早只有 2.5 mm/h 毛毛雨。给行人一个「此刻真实雨强 mm/h」的读数，
    // 雨大才躲、雨小照常走（ped.js 的 RAIN_SHELTER_MMH 阈值）。
    FLOOD.rainRate = () => (FLOOD.raining
      ? rainRateAt(CLOCK.minute, (FLOOD.manifest && FLOOD.manifest.p_mm_h) || 8) : 0);
    world.add(FLOOD.group);
    FLOOD.bindHud();
    FLOOD.startClock();
    FLOOD.setVisible(true);                    // 水面默认开，统一面板常驻
    // 交通是在路网阶段建的（早于这里），回写口只能晚绑定
    if (TRAFFIC && TRAFFIC.setFeedback) TRAFFIC.setFeedback(FLOOD.fb);
    floodReady = FLOOD.load('u_p8_s0');   // 全天雨：8 mm/h（24 h 平均）· 无风暴增水
    floodReady.then(async () => {
      window.__flood = FLOOD;
      window.__fb = FLOOD.fb;
      // load() 已按 manifest 配好 0–1440 量程，这里让水、人、车对齐到此刻
      FLOOD.showMinute(CLOCK.minute);
      console.log('[flood] 统一 24h 工况 ' + FLOOD.frames + ' 帧就绪');
      const { createControl } = await import('./control.js');
      CONTROL = createControl({
        flood: FLOOD, clock: CLOCK, waterOn: true,
        onWater: (on) => { FLOOD.setVisible(on); },
      });
      window.__control = CONTROL;
    }).catch((err) => console.warn('[flood] 未启用：' + (err && err.message)));
    addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'f' || e.key === 'F') {
        // 统一面板是唯一入口，F 等价于点「水面」按钮，避免两套状态不同步
        const btn = document.getElementById('ctlWater');
        if (btn) btn.click(); else FLOOD.toggle();
      }
    });
  } catch (e) {
    console.warn('[flood] 初始化失败：', e && (e.message || e));
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
    // 【随机种子】用户 2026-10-29：「这些人难道不是随机出现在各个地方的吗？」
// 原来是写死的 20261024 —— 每次刷新都是同一批人站同一处，看着像「模拟好的」。
// 现在：默认每次加载换一个种子（真的是随机的一批人）；想看可复现的结果就加
// ?seed=123 固定下来。种子会打进 console，方便复现 / 截图归档。
const SEED = (() => {
  const m = /[?&]seed=(\d+)/.exec(location.search);
  if (m) return Number(m[1]) >>> 0;
  return ((Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0);
})();
// 【默认 3000 人（2026-11-12）】用户要求加到 3000，且每个人都能自主判断。
// 快判断是 O(1) 查表 + 噪声采样，不做按距离的「远处降频」；真正贵的 A*
// 由每仿真秒全局预算限流 + 个人错峰规划承载。住宅 / 岗位门牌按真实建筑
// 自适应容量分配，全城铺开而不是挤在几十个固定门口。
// ?ped=N 仍可覆盖（1–6000）；?ped=24 / 240 / 1000 回到小样本档位。
const PED_N = (() => {
  const m = /[?&]ped=(\d+)/.exec(location.search);
  return m ? Math.max(1, Math.min(6000, Number(m[1]))) : 3000;
})();
/**
 * 【缩小区域】?region=x0,z0,x1,z1（世界坐标，米），只推演登记住址在这一片的人。
 * 不传就是全城。用来跟着一个具体的人看受困／溺亡的全过程，
 * 不改判断公式、不改水情，只是少算一批人。
 */
const PED_REGION = (() => {
  // URLSearchParams 会把逗号编码成 %2C，手写地址栏则是字面逗号，两种都认。
  const qs = decodeURIComponent(location.search);
  const m = /[?&]region=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/.exec(qs);
  if (!m) return null;
  const [x0, z0, x1, z1] = m.slice(1, 5).map(Number);
  if (![x0, z0, x1, z1].every(Number.isFinite)) return null;
  return { x0: Math.min(x0, x1), x1: Math.max(x0, x1),
    z0: Math.min(z0, z1), z1: Math.max(z0, z1) };
})();
    // 【LDT 逃生余量表】2026-10-29 用户要求：人是一直在走的，所以除了
    // 「此刻通不通」还要有「还来不来得及」。表按工况存一份（tools/ped/export_ldt.py 生成），
    // 缺了不影响场景，只是 HUD 少一行。
    let LDT = null;
    try {
      if (floodReady) { try { await floodReady; } catch (e) { /* 没积水数据也不影响行人 */ } }
      const src = (FLOOD && FLOOD.manifest && FLOOD.manifest.source) || '';
      const cn = src ? src.split('/').filter(Boolean).pop() : (FLOOD && FLOOD.caseName) || '';
      // 统一 24h 工况是参数矩阵，没有（也不需要）旧工况逐帧预烘焙的 LDT 表；
      // 强行去 fetch 只会每次 404 刷警告。逃生判定改由实时水深栅格直接算。
      if (cn && !cn.startsWith('u_')) {
        LDT = await loadLdt(cn);
        window.__ldt = LDT;
        const s = LDT.summary();
        console.log(`[ldt] ${cn} 逃生余量表就绪：${s.nodes} 节点 / 会被淹 ${s.floodedNodes}`
          + ` / 开局已淹 ${s.wetAtT0} / 来得及 ${s.reachable} / 来不及 ${s.unreachable}`
          + ` / 中位富余 ${s.medianLdt} min`);
      } else {
        console.log('[ldt] 当前工况没有名字，跳过逃生余量表');
      }
    } catch (e) {
      console.warn('[ldt] 这个工况没有逃生余量表（' + (e && e.message) + '），HUD 只显示被困人数');
    }
    // ---- 随机行人的「社会层」：和 6 个具名角色共用 Brain / PersonState /
    // day-schedule / life-scenes，只是不做展示面板。必须在 buildPedestrians
    // 之前建好，作为 opt.crowdLife 传进去。
    try {
      const { createCrowdLife } = await import('./crowd-life.js');
      CROWD_LIFE = createCrowdLife({
        count: PED_N, seed: 20261110,   // 全城市民名册：年龄/经验分层，可复现
        minute: () => CLOCK.minute,
        depthAt: (x, z, t) => (FLOOD && FLOOD.depthAt)
          ? (FLOOD.depthAt(x, z, t) || 0) : 0,
      });
      window.__crowdLife = CROWD_LIFE;
    } catch (e) {
      console.warn('[crowd-life] 装配失败，路人回退到纯随机游走：', e && (e.message || e));
    }

    // 人少时收进 MegaKit 街区（MK_CX/MK_CZ），人多时铺全城
    const PED_CENTER = (PED_N <= 60) ? [MK_CX, MK_CZ, 340] : null;
    PED = buildPedestrians(pa, {
      T: TERRAIN, B, count: PED_N, seed: SEED, detail, SURF: PSURF, ldt: LDT,
      center: PED_CENTER,
      spread: PED_N > 60,     // 全城多中心：既铺满全城，每个片区又有一小群人
      // 默认 FAA/MegaKit 街区 + 官方「9 行人近景 / 0 行人俯视」的白宫-拉斐特
      // 广场街区，两处都要有人在，用户点任何机位都不会看到空街。
      focus: [[MK_CX, MK_CZ], [1060, -700]],
      hero: pa.hero,          // 马克专用高模（第 0 个人）
      collide: COLLIDE,       // 实体碰撞：行人不再穿过灯杆 / 树 / 停放车 / 家具
      crowdLife: CROWD_LIFE,
      // 【2026-11-13 分层决策装配】驾驶层要认领交通层的车、按同一个城市时钟
      // 推进；伤亡台账要读这一刻的积涝。三者都在这里注入，不另建独立时间线。
      traffic: TRAFFIC, clock: CLOCK, flood: FLOOD,
      // 决策寻路要读**当前帧真实水深流场**和城市时钟，才能算出「绕开积水的路」
      depthAt: (x, z, t) => (FLOOD && FLOOD.depthAt) ? (FLOOD.depthAt(x, z, t) || 0) : 0,
      minute: () => CLOCK.minute,
      // 镜头剖开了哪栋楼：楼里的人只在那一栋里显示，避免穿墙人影
      camPlace: () => window.__camPlace || null,
    });
    console.log(`[ped] 随机种子 ${SEED}（复现：?seed=${SEED}）· ${PED_N} 人`);
    // 片区回填：让每个片区内部也轮转 8 档作息，避免镜头所在片区恰好空街。
    if (CROWD_LIFE && CROWD_LIFE.setClusters && PED.clusterOf) {
      CROWD_LIFE.setClusters(PED.clusterOf);
    }
    // 住所与岗位跟真实建筑和出生片区绑定，普通市民绝不引用马克公寓。
    // 绑定后重建目标表，因为旧目标是在通用门牌阶段生成的。
    if (CROWD_LIFE && CROWD_LIFE.bindResidents) CROWD_LIFE.bindResidents(PED.peds, SOLIDS);
    // 行人的「室内豁免」穿楼检查要用与出生门牌同一份可见实体表。
    if (PED.setSolids) PED.setSolids(SOLIDS);
    if (PED.live) { PED.live.reset(CLOCK.minute, PED.peds); PED.live.restore(PED.peds); }
    // 【车有人才能开】车在 PED/CROWD_LIFE 之前创建，这里把每辆车绑定到一个
    // 真实居民（优先「有车通勤」圈层），并把车位摆到他家附近的路段上。
    if (TRAFFIC && TRAFFIC.bindCrews) {
      TRAFFIC.bindCrews(PED.peds, CROWD_LIFE, PED.circles);
    }
    world.add(PED.group);
    window.__ped = PED;
    window.__pedSurf = PSURF;
    if (PED_REGION && PED.setRegion) {
      const r = PED.setRegion(PED_REGION);
      console.log(`[ped] 缩小区域 ${JSON.stringify(PED_REGION)} → 推演 ${r.enabled}/${r.total} 人`);
    }
    // 交通层查「斑马线附近有没有行人」用行人层自己的空间索引，
    // 这样「行人优先」是拿真实人群算的，不是一个固定概率。
    if (TRAFFIC && TRAFFIC.setPedProbe && PED.pedNear) TRAFFIC.setPedProbe(PED.pedNear);
    window.__sim = () => (PED && PED.fullStats) ? PED.fullStats() : null;
    console.log(`[ped] ${PED.stats.count} 人 / 可走链 ${PED.stats.usable} 条`
      + `（共 ${PED.stats.total}，短链 ${PED.stats.dropped.short}`
      + ` / 压建筑 ${PED.stats.dropped.blocked} / 压水 ${PED.stats.dropped.water}`
      + ` / 开局已淹 ${PED.stats.dropped.ldt || 0}）`);

    // ---- 24h 连续轨迹层：必须在 createMark / createPeople 之前建好 ----
    // 旧版只有 HUD 读 22 段剧本，7 个具名角色仍按 10 段静态锚点摆位，
    // 结果「夜里在街上 / 买早餐原地跑 / 人物不动」。这一层把剧本编译成
    // 时刻的纯函数，两个角色系统共用，拖时间轴与实时播放完全同一套位置。
    try {
      const { createDayMotion } = await import('./day-motion.js');
      DAYMOTION = await createDayMotion({
        // 家具 / 街具 / 树的实体碰撞：锚点与漂移都要躲开
        collide: COLLIDE,
        roadnet: ROADNET,
        // 可见建筑实体：车/人的路网折线必须绕开，不能从楼里穿过去
        solids: SOLIDS,
        groundAt: (x, z) => (PED.graph.groundAt ? PED.graph.groundAt(x, z) : 0),
      });
      window.__dayMotion = DAYMOTION;
    } catch (e) {
      console.warn('[day-motion] 轨迹层装配失败，回退静态日程：', e && (e.message || e));
    }

    // ---- 把旧单人 demo 的「马克时间线」迁进全城 ----
    // 用户 2026-11-04：「最后要实时的动画效果，实时能看见他在哪个位置」。
    // 不是录好的轨迹视频：OfficeStory 每 0.25 仿真秒重算一次位置/状态/决策，
    // 马克由它驱动，在 6F 工位 → 楼梯 → 停车场取车 → 街道 → 公寓 9F 之间真实移动。
    if (MK_OFFICE && MK_HOME && PED.peds[0] && PED.peds[0].hero) {
      try {
        const { createMark } = await import('./mark.js');
        MARK = await createMark({
          world, office: MK_OFFICE, home: MK_HOME, lot: MK_LOT,
          groundAt: PED.graph.groundAt, flood: FLOOD, ped: PED, qs: QS0,
          camera, controls, clock: CLOCK,
          // 马克的旧街心线要在瓦片路网上重投影，必须给他 roadnet
          roadnet: ROADNET,
          dayMotion: DAYMOTION,
          // 车模型落地前的最后一道实体约束：任何情况下都不让车进楼
          solids: SOLIDS, collide: COLLIDE,
        });
        // 马克不再交给旧 OfficeStory 单独驱动；他和市民共用实时目标/路网/判断。
        // 旧故事对象只保留车辆与兼容 HUD，不写位置。
        if (MARK.bindLive) MARK.bindLive();
        window.__mark = MARK;
        console.info('[mark] 已绑定实时居民 #0（旧 17:52 轨迹不再驱动位置）');
      } catch (e) {
        console.warn('[mark] 时间线接入失败：', e && (e.stack || e.message));
      }
    }

    // ---- 演示人物只保留马克（2026-11-13）----
    // 用户：「只保留一个马克这样的情形就行了，剩下的其他都不用了，但是剩下的
    //  就是不要失去它的功能 —— 我们是要一个决策模型」。
    // 这里不再装配 6 个具名角色的换皮 / HUD / 旧故事，PEOPLE 保持 null，
    // 面板自然只剩马克一行（下面所有 PEOPLE 引用都带空值保护）。
    // 那 6 个行人并没有被删：crowd-life 的 CAST 缩到 1 之后，i=1..N 全部
    // 走普通市民完整链路 —— 真实住宅/岗位门牌、细粒度圈层、慢层目标、
    // 每 0.5~1 秒自主判断、开车通勤与接孩子、伤亡判定，一个都不少。
    PEOPLE = null;
    // 四座精细场景楼（咖啡馆 / 诊所 / 学校 / 工地）是**要演示的场景资产**，
    // 以前顺手搭在 people.js 里。取消 6 人演示后单独保留，不能跟着消失。
    try {
      const { buildCafe, buildClinic, buildSchool, buildSite,
        CAFE, CLINIC, SCHOOL, SITE } = await import('./district-buildings.js');
      const sh = (x, z) => TERRAIN.sampleHeight(x, z);
      const bCafe = buildCafe(sh(CAFE.cx, CAFE.cz));
      const bClinic = buildClinic(sh(CLINIC.cx, CLINIC.cz));
      const bSchool = buildSchool(sh(SCHOOL.cx, SCHOOL.cz));
      let siteY = -1e9;
      for (let i = -3; i <= 3; i++) for (let j = -4; j <= 4; j++) {
        siteY = Math.max(siteY, sh(SITE.cx + i * 2, SITE.cz + j * 2));
      }
      const bSite = buildSite(siteY + 0.12);
      for (const b of [bCafe, bClinic, bSchool, bSite]) world.add(b.group);
      // 剖切列表仍要认得这四栋楼（相机进楼时剖开外墙），不能因为
      // 取消 6 人演示就把它们从剖切系统里弄丢。
      window.__sceneBuildings = { cafe: bCafe, clinic: bClinic,
        school: bSchool, site: bSite };
    } catch (e) {
      console.warn('[scene] 四座精细楼装配失败：', e && (e.message || e));
    }

    // ---- 全城唯一时间源的 seek hook ----
    // 拖任意一根时间轴（积涝面板 / 马克面板）都走这里：水、马克、6 个具名角色、
    // 随机行人一起重放到同一分钟，不存在「这一帧的水 + 那一刻的人」错位。
    let lastSeekMin = CLOCK.minute;
    CLOCK.onSeek((m) => {
      // 故事脚本内部仍用「降雨开始后的相对分钟」（52 = 17:52），
      // 对外统一是「一天分钟」（1072 = 17:52），在这一个入口换算。
      // 具名角色不再把旧故事重放到 17:52；统一等下面 PED 重放完再同步。
      // 【回写场必须清零】扰动是「刚刚谁踩过水」的记忆，只对当前时刻有效。
      // 拖到 22:00 还留着 18:00 的负载，等于拿未来的记忆污染过去的水。
      if (FLOOD && FLOOD.fb) FLOOD.fb.reset();
      if (FLOOD) FLOOD.showMinute(m);
      if (PED) {
        const jump = m - lastSeekMin;
        // 【先重建目标与所处场景，再让当前这一刻的水对齐】
        if (PED.live) { PED.live.reset(m, PED.peds); PED.live.restore(PED.peds); }
        // 【24h 时间轴】一次可能跨十几个小时，不能真去补跑 8 万秒；
        // 补跑只用于让行人和当前水深对齐，步长 ≤0.2 仿真秒、总长 ≤12 秒。
        if (Math.abs(jump) > 1) PED.catchUp(Math.min(Math.abs(jump) * 60, 120), camera, FLOOD);
        // 【清执行层残留】旧版 restore 只重摆在家/在岗的人，p.route / holdT /
        // liveClip / 动画 clip 会跨时刻带过来；帧末瞬移保护还会把人收起后
        // 不再放出。这里统一清掉并从干净状态重新判断，人不会被隐藏。
        if (PED.resetAfterSeek) PED.resetAfterSeek();
      }
      // 【补跑之后要再清一次】catchUp 会把人瞬移过去、顺带按大 dt 往流场里
      // 记账；那些账没有对应的 fb.step 消费，会攒成一坨 40 步的位移体积，
      // 下一帧一次性糊到水面上。跳时刻本来就是「重新开始」，清掉最干净。
      if (FLOOD && FLOOD.fb) FLOOD.fb.reset();
      if (MARK && MARK.syncLive) MARK.syncLive();
      if (PEOPLE && PEOPLE.syncLive) PEOPLE.syncLive(0);
      lastSeekMin = m;
    });

    // 切工况时的表同步由 syncLdtCase() 轮询完成（见 updateTrapHud），
    // 不在 #flCase 的 change 上抢跑：那一刻 flood 的新 manifest 还没拿到。
    ldtCaseName = LDT ? LDT.caseName : null;

    // ---- 决策流面板 ----
    // A 档的意义不在「人数」，在「谁在想什么」。这里把每个人最近一条判断
    // 按时间倒序铺出来，一眼能看到「同一条街、同一场雨，八个人走八个方向」。
    const dcList = document.getElementById('dcList');
    const dcCount = document.getElementById('dcCount');
    let selIdx = -1;                         // 当前点选的人；-1 = 显示决策流

    // 【跟拍是开关，不是锁】用户 2026-11-04：「我能跟随还能看到周围的情况才行」。
    // 之前只要点过人，每帧都把相机硬拉回他身边 4 m，全城和周边全看不见。
    // 现在默认自由视角；只有显式点「跟拍」才持续跟随，且鼠标一拖就自动放开。
    let followCam = false, followKey = 'mark';
    const setFollow = (on, key) => {
      followCam = !!on;
      FOLLOW_ACTIVE = !!on;                 // 供 updateIndoorCutaway 放宽最小机位距离
      if (key) followKey = key;
      const btn = document.getElementById('mkFollow');
      if (btn) btn.textContent = followCam ? '停跟' : '跟拍';
      if (MARK) MARK.setFocus(followCam && followKey === 'mark');
      if (PEOPLE) {
        if (followCam && followKey !== 'mark') PEOPLE.select(followKey, camera, controls);
        else PEOPLE.clearFocus();
      }
      if (followCam && followKey === 'mark' && MARK) MARK.focusCamera();
    };
    window.__setFollow = setFollow;
    // 用户一碰鼠标（转/缩放/平移）就交还镜头控制权，不再抢相机
    controls.addEventListener('start', () => { if (followCam) setFollow(false); });
    const dcTitle = document.querySelector('#decide .hd b');

    /** 面板：某个人的真实状态（不是脚本，全部读当前运行值）。 */
    const renderDetail = () => {
      const p = PED.peds[selIdx];
      if (!p) return;
      const st = p.mode === 'flee' ? '正在跑' : p.mode === 'shelter' ? '已躲起来' : '照常走';
      const anim = p.cur ? String(p.cur.getClip().name) : '—';
      const x = p.obj.position.x, z = p.obj.position.z;
      const d = (FLOOD && FLOOD.depthAt) ? (FLOOD.depthAt(x, z) || 0) : 0;
      // 马克的故事状态：时刻 / 楼层 / 状态 / 理由，都是 story 这一帧算出来的实时值
      const mkLine = (p.hero && MARK) ? (() => {
        const h = MARK.hud();
        return `<div class="kv" style="color:#bfe0ff">${h.clock} · ${h.floor}F`
          + ` · <b>${h.stateText}</b></div><div class="at">${h.reason}</div>`;
      })() : '';
      // 【2026-11-11 实时决策流】点名跟拍一个人时显示他此刻的真实目标、
      // 所属群体和最近几次「现在该干什么」的判断 —— 全部由状态现算，
      // 不再是拖到某分钟弹出的一句预写台词。交互保持原样（点人 / 跟拍）。
      const live = (PED.live && PED.live.debug) ? PED.live.debug(selIdx) : null;
      const liveLine = live
        ? '<div class="kv" style="color:#bfe0ff">目标 <b>'
          + (live.goal ? live.goal.label : '暂时没有安排') + '</b>'
          + (live.goal ? ' · ' + live.goal.state : '') + ' · 群体 <b>' + live.cohort + '</b>'
          + ' · 职业 <b>' + live.role + '</b></div>'
          + '<div class="at">最近判断：'
          + (live.recent.slice(-3).map((r) => r.reason).join(' ｜ ') || '还没开始') + '</div>'
        : '';
      // 【状态值 / 今日经历 2026-11-12】每个数字都由真实位移、水深、生理量
      // 和已发生的动作累积，且会回头改变这个人后面的判断与步速。
      const ex = live && live.experience ? live.experience : null;
      const expLine = ex
        ? '<div class="kv" style="color:#9fe3c0">状态 体力 <b>' + ex.stamina
          + '</b> · 淋湿 <b>' + ex.wetnessPct + '%</b> · 饥饿 <b>' + ex.hunger
          + '</b> · 疲劳 <b>' + ex.fatigue + '</b> · 伞 <b>'
          + (ex.hasUmbrella ? (ex.umbrella === 'open' ? '撑着' : '收着') : '没带') + '</b></div>'
          + '<div class="at">' + ex.summary + '</div>'
          + '<div class="at">判断 ' + ex.judged + ' 次 · 归家倾向 ' + ex.homeBias
          + ' · 办事信心 ' + ex.confidence + '</div>'
        : '';
      const rows = (p.decisions || []).slice(-4).reverse().map((q) => {
        const cls = q.kind === 'flee' ? 'flee' : q.kind === 'wade' ? 'wade' : 'shelter';
        return `<div class="d"><span class="who ${cls}">${q.who}</span>`
          + `<span class="txt">${q.text}</span></div>`;
      }).join('') || '<div class="empty">还没遇到需要判断的事</div>';
      dcList.innerHTML = `<div class="d">`
        + `<div class="ttl"><b>${p.profile.label}</b>`
        + `<span class="at"> #${p.i}${p.hero ? ' · 高模' : ''}</span></div>`
        + `<div class="at">${p.profile.note}</div>`
        + `<div class="kv">涉水线 <b>${Math.round(p.profile.wade * 100)} cm</b>`
        + ` · 状态 <b>${st}</b> · 动作 <b>${anim}</b></div>`
        + `<div class="kv">脚下积水 <b>${Math.round(d * 100)} cm</b>`
        + ` · 位置 (${x.toFixed(0)}, ${z.toFixed(0)})</div>`
        + mkLine
        + liveLine
        + expLine
        + `</div>${rows}`
        + `<div class="at" style="margin-top:6px">点空白处返回决策流</div>`;
      if (dcCount) dcCount.textContent = `${PED.peds.length} 人`;
      if (dcTitle) dcTitle.textContent = '关于这个人';
    };

    // ---- 点选：点谁看谁 ----
    // 【为什么必须点得动】用户原话「点一下就能看到他们对应的动作，而不是臆想」。
    // 面板里每个数字都来自这个人此刻的运行状态：mode / 当前 clip / 脚下水深 / 决策记录。
    {
      const ray = new THREE.Raycaster();
      const ndc = new THREE.Vector2();
      // 【选中一个人】3D 里点人和点面板条目走同一条路。
      // 用户 2026-11-04：「点一下对应的人就可以看到在做什么」——面板里每一条也得能点。
      const selectPed = (idx) => {
        if (idx < 0 || idx >= PED.peds.length) return;
        selIdx = idx;
        // 点人只是「看一眼」：更新面板 + 摆一次中景机位，绝不锁镜头
        setFollow(false);
        const p = PED.peds[idx];
        const q = p.obj.position;
        // 【机位必须试几个方位】人常常贴着墙站，直接放「右后 3.4 m」会整台相机进到楼里
        // （实测截出来全是砖墙）。这里拿建筑合并 mesh 做遮挡检测，取第一个不被挡的机位。
        const eye = new THREE.Vector3(q.x, q.y + 1.25, q.z);
        const cands = [[2.6, 2.1, 3.4], [3.6, 2.6, -3.6], [-3.4, 2.2, 3.2],
                       [0, 3.4, -4.6], [4.8, 5.2, 4.8], [0, 9, 0.2]];
        let pickC = cands[0];
        for (const c of cands) {
          const cp = new THREE.Vector3(q.x + c[0], q.y + c[1], q.z + c[2]);
          const dir = cp.clone().sub(eye);
          const len = dir.length();
          ray.set(eye, dir.normalize());
          ray.far = len * 0.97;
          const blocked = blocks ? ray.intersectObject(blocks, false).length : 0;
          if (!blocked) { pickC = c; break; }
        }
        ray.far = Infinity;
        controls.target.set(q.x, q.y + 1.0, q.z);
        camera.position.set(q.x + pickC[0], q.y + pickC[1], q.z + pickC[2]);
        controls.update();
        // 马克在精细楼里时，那 6 个候选机位是按纸壳子算的，会贴到内墙上
        if (MARK && idx === 0) MARK.focusCamera();
        console.info(`[pick] #${idx} ${p.profile.label} mode=${p.mode} `
          + `anim=${p.cur ? p.cur.getClip().name : '-'}`);
        renderDetail();
      };
      window.__selectPed = selectPed;      // 调试/截图用

      renderer.domElement.addEventListener('pointerup', (ev) => {
        if (ev.button !== 0) return;
        const r = renderer.domElement.getBoundingClientRect();
        ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
        ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
        ray.setFromCamera(ndc, camera);
        const hits = ray.intersectObject(PED.group, true);
        let idx = -1;
        for (const h of hits) {
          const k = h.object.userData && h.object.userData.pedIndex;
          if (k !== undefined) { idx = k; break; }
        }
        if (idx < 0) {
          selIdx = -1;
          setFollow(false);
          if (dcTitle) dcTitle.textContent = '此刻的判断';
          return;
        }
        selectPed(idx);
      });

      // 面板条目也可点：事件委托绑在容器上，0.7 s 重绘不会丢
      if (dcList) {
        dcList.addEventListener('click', (ev) => {
          const el = ev.target.closest('[data-i]');
          if (!el) return;
          selectPed(Number(el.dataset.i));
        });
      }
    }

    // 【跟拍】只有显式开启才动相机；关闭时一帧都不碰 camera / controls，
    // 所以默认就是自由的全城视角。机位 12 m 中距离，周围街区仍在画面里。
    {
      const tgt = new THREE.Vector3();
      const eyeWant = new THREE.Vector3();
      const eyeFix = new THREE.Vector3();
      /**
       * 机位避墙：机位落在楼体里就往目标点方向收，收到贴脸还不行就抬高俯视。
       * 【为什么必须做】旧版只把人往镜头里放，不看中间有没有墙 —— 用户反馈
       * 「一跟拍就进楼里，看不到人」。这里用建筑占位索引（BIDX）做点测试，
       * 每帧最多 8 次查表，比 80 万三角面的 raycast 便宜两个数量级。
       */
      const fixEye = (target, want, out) => {
        if (!BIDX) return out.copy(want);
        // 先从「贴着目标往外收」到「原机位」扫一遍，取第一个不在楼里的
        const dx = want.x - target.x, dy = want.y - target.y, dz = want.z - target.z;
        for (let k = 10; k >= 3; k--) {
          const s = k / 10;
          const x = target.x + dx * s, y = target.y + dy * s, z = target.z + dz * s;
          if (!BIDX.blocked(x, y, z)) return out.set(x, y, z);
        }
        // 全是墙：抬到头顶俯视（室内/窄巷唯一稳的机位）
        return out.set(target.x + 0.6, target.y + 9.5, target.z + 2.2);
      };
      const follow = () => {
        if (followCam) {
          if (followKey === 'mark' && MARK) {
            const q = PED.peds[0].obj.position;
            tgt.set(q.x, q.y + 1.1, q.z);
            MARK.followEye(eyeWant);
            // 【BUG 修复】人在楼里时不要做 BIDX 越障：镜头进楼后整栋楼已经
            // 被隐藏，但 BIDX 仍把它当成实心，越障逻辑就会一路把相机推到
            // 楼外 11 m 处，于是「点人名只看到一堵墙 / 一片米色平面」。
            if (MARK.indoorNow && MARK.indoorNow()) {
              // 室内：放宽最小距离，否则 lerp 过去也会被控制器顶回 12 m
              controls.minDistance = 1.2;
              camera.position.lerp(eyeWant, 0.14);
            }
            else {
              fixEye(tgt, eyeWant, eyeFix);
              camera.position.lerp(eyeFix, 0.08);
            }
            controls.target.lerp(tgt, 0.1);
            controls.update();
          } else if (PEOPLE) {
            const q = PEOPLE.followEye(eyeWant);
            if (q) {
              tgt.set(q.x, q.y + 1.1, q.z);
              if (PEOPLE.indoorOf && PEOPLE.indoorOf()) {
                controls.minDistance = 1.2;
                camera.position.lerp(eyeWant, 0.14);
              }
              else {
                fixEye(tgt, eyeWant, eyeFix);
                camera.position.lerp(eyeFix, 0.08);
              }
              controls.target.lerp(tgt, 0.1);
              controls.update();
            }
          }
        }
        requestAnimationFrame(follow);
      };
      follow();
    }

    if (dcList) {
      const tick = () => {
        // 【2026-11-13 清理】#decide 是隐藏的兼容 DOM（决策流早已并入人物列表），
        // 旧版仍每 700 ms 扫 3000 人重排一次 HTML，纯空转。隐藏时直接不跑；
        // 将来若把面板改回可见，无需改代码自动恢复。
        if (dcList.offsetParent === null && selIdx < 0) return;
        if (selIdx >= 0) { renderDetail(); return; }
        let arr = [];
        for (const p of PED.peds) if (p.decision) arr.push(p.decision);
        arr.sort((a, b) => b.t - a.t);
        const seen = new Set();
        const top = [];
        for (const d of arr) {
          if (seen.has(d.i)) continue;
          seen.add(d.i);
          top.push(d);
          if (top.length >= 6) break;
        }
        if (dcCount) dcCount.textContent = `${PED.peds.length} 人 · ${arr.length} 条判断`;
        if (dcTitle) dcTitle.textContent = '此刻的判断';
        if (!top.length) {
          dcList.innerHTML = '<div class="empty">连续播放中，这里会实时出现每个人刚做的判断</div>';
          return;
        }
        dcList.innerHTML = top.map((d) => {
          const cls = d.kind === 'flee' ? 'flee' : d.kind === 'wade' ? 'wade' : 'shelter';
          return `<div class="d" data-i="${d.i}" title="点一下看他此刻在做什么">`
            + `<span class="who ${cls}">${d.who}</span>`
            + `<span class="txt">${d.text}</span> `
            + `<span class="at">${d.at[0]}, ${d.at[1]} ›</span></div>`;
        }).join('');
      };
      setInterval(tick, 700);
      tick();
    }

    // ---- 马克实时 HUD：不点也能看见他此刻在哪一层、在做什么 ----
    // 滑块每次 seek 都是从 17:52 重新跑 0.25 s 子步的确定性重放，不是查录像。
    {
      const panel = document.getElementById('markHud');
      if (panel) {
        if (!MARK) { panel.style.display = 'none'; }
        else {
          const $ = (id) => document.getElementById(id);
          // 时间轴统一由底部 24h 控件管理，这里只留马克的状态与镜头按钮。
          // 旧版马克面板里那根滑块是 52–95 分钟的故事进度遗留，与底部
          // 0–1440 分钟滑块控同一个时钟、步长还不一致，已退役。
          const followBtn = $('mkFollow');
          if (followBtn) followBtn.addEventListener('click', () => setFollow(!followCam, 'mark'));
          const cityBtn = $('mkCity');
          if (cityBtn) cityBtn.addEventListener('click', () => {
            setFollow(false);
            selIdx = -1;
            if (dcTitle) dcTitle.textContent = '此刻的判断';
            if (window.__setView) window.__setView('city');
          });
          const othersBox = $('mkOthers');
          const castBox = $('castDetail');
          let castKey = null;
          // 【2026-11-13】演示人收敛为马克一行；其余居民照常跑完整决策模型，
          // 只是不再各占一行、不再各挂一套旧故事剧本。
          const actOf = (q) => q.moving ? '走动'
            : (KIND_CN[q.kind] || CLIP_CN[String(q.clip || '').toLowerCase()]
              || q.stateText || q.clip || '—');
          let rowsBuilt = false;
          const upd = () => {
            const h = MARK.hud();
            $('mkClock').textContent = h.clock;
            const markRow = {
              key: 'mark', name: '马克·陈', stateText: h.stateText,
              floor: h.floor, clip: h.clip, kind: h.kind, moving: h.moving,
              placeName: h.placeName, mood: h.mood, stress: h.stress, reason: h.reason,
            };
            const rows = PEOPLE ? [markRow, ...PEOPLE.hud()] : [markRow];
            if (othersBox) {
              // 【DOM 只建一次】旧版每 400 ms 用 innerHTML 重建整张列表，
              // 元素被不断替换，鼠标点击/悬停根本落不上去（无头验收实测
              // click 一直等到超时）。之后只改文本与类名，元素保持稳定。
              if (!rowsBuilt) {
                othersBox.innerHTML = rows.map((q) => `<div class="prow" data-k="${q.key}">`
                  + `<span class="nm"></span><span class="st"></span>`
                  + `<span class="go"></span></div>`).join('');
                rowsBuilt = true;
              }
              const els = othersBox.querySelectorAll('.prow');
              rows.forEach((q, idx) => {
                const el = els[idx];
                if (!el) return;
                const sel = followCam && q.key === castKey;
                const where = String(q.placeName || '').slice(0, 9);
                el.querySelector('.nm').textContent = String(q.name).slice(0, 5);
                el.querySelector('.st').textContent =
                  `${q.floor || 1}F ${actOf(q)}${where ? ' · ' + where : ''}`;
                el.querySelector('.go').textContent = sel ? '自由' : '跟随';
                el.classList.toggle('sel', sel);
              });
            }
            // 顶部只留「时刻 · 当前关注的人 · 此刻在做什么」一行
            const cur = rows.find((r) => r.key === castKey) || rows[0];
            $('mkState').textContent = `${h.clock} · ${cur.name} · ${cur.floor || 1}F ${actOf(cur)}`;
            if ($('mkWhere')) $('mkWhere').textContent = cur.reason || '';
            if ($('mkWhy')) $('mkWhy').textContent = h.reason || '';
            if (castBox) castBox.style.display = 'none';
          };
          if (othersBox) {
            othersBox.addEventListener('click', (ev) => {
              const el = ev.target.closest('[data-k]');
              if (!el) return;
              const k = el.dataset.k;
              // 再点一次同一个人 = 交还镜头（自由视角）
              if (followCam && castKey === k) { setFollow(false); castKey = null; }
              else { castKey = k; setFollow(true, k); }
              upd();
            });
          }
          // 【2026-11-13】全城伤亡 / 驾驶 / 圈层统计，1.5 s 刷一次就够
          // （每次要扫 3000 人，不塞进 400 ms 的人物面板刷新里）。
          const updStats = () => {
            const box = $('incHud');
            if (!box || !PED || !PED.fullStats) return;
            const f = PED.fullStats();
            if (!f || !f.incidents) return;
            const I = f.incidents, D = f.driving || {}, C = f.circles || {};
            const n = (v) => Math.round(Number(v) || 0);
            const causes = Object.keys(I.deathsByCause || {});
            box.innerHTML = [
              `困死/溺亡 <b>${n(I.dead)}</b> · 累计被困 <b>${n(I.everStranded)}</b> · 累计受伤 <b>${n(I.everInjured)}</b> · 避险 <b>${n(I.evacuated)}</b>`,
              `熄火 <b>${n(I.stalled)}</b> · 弃车 <b>${n(I.abandonedCar)}</b> · 等红灯 <b>${n(I.redLightWaits)}</b> · 礼让 <b>${n(I.yields)}</b>`,
              `在开车 <b>${n(D.active)}</b> 人 · 行驶 <b>${n(D.carKm)}</b> km · 均速 <b>${n(D.avgSpeedKmh)}</b> km/h · 超速 <b>${n(D.speedViolations)}</b>`,
              `圈层 <b>${n(C.distinctCircles)}</b> 种 / ${n(C.people)} 人 · 有车 <b>${n(C.withCar)}</b> · 接送 <b>${n(C.withPickups)}</b>`,
              `判断 <b>${n(f.live && f.live.judged)}</b> 次 · 最深水 <b>${n((I.maxDepth || 0) * 100)}</b> cm`
                + (causes.length ? ` · ${causes.map((k) => `${k} ${I.deathsByCause[k]}`).join(' / ')}` : ' · 尚无死亡'),
            ].join('<br>');
          };
          setInterval(updStats, 1500);
          updStats();

          // ---- 事故个案逐帧回放 ----
          // 只输出事故台账里连续运行记下的真实状态：每 2 仿真秒的位置、
          // 水深、速度、当时的判断动作与理由。拖动时间轴会重建快照、清空
          // 经历，所以这里列出来的个案只对连续运行成立。
          const casePick = $('casePick'), caseFrame = $('caseFrame');
          const caseInfo = $('caseInfo'), caseFrameInfo = $('caseFrameInfo');
          let caseList = [], caseReplay = null;
          const hhmm = (m) => {
            const t = Math.max(0, Number(m) || 0);
            const h = Math.floor(t / 60), mi = Math.floor(t % 60);
            return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
          };

          // ---- 回放人偶：独立于实时行人 ----
          // 用户 2026-11-16 反馈「定位不到人、看不到人在哪」。根因是死者、车内、
          // 室内的人实时模型本来就是 visible=false，回放又只刷新文字从不动人。
          // 这里在场景里放一个高对比剪影，逐帧摆到历史坐标：被困/困死用醒目的
          // 红橙色，脱险绿色，其余青色——参考游戏里的目标高亮，一眼能找到。
          // 纯显示层：不改内核、不改事故台账、不改实时行人。
          const R3 = window.__THREE;
          let replayMarker = null, replayLock = false;
          const ensureReplayMarker = () => {
            if (replayMarker || !R3 || !window.__scene) return replayMarker;
            const g = new R3.Group();
            const solid = (col, op) => new R3.MeshBasicMaterial({
              color: col, transparent: true, opacity: op, depthTest: false });
            const body = new R3.Mesh(new R3.CylinderGeometry(0.3, 0.36, 1.15, 10), solid(0x00e5ff, 0.95));
            body.position.y = 0.95;
            const head = new R3.Mesh(new R3.SphereGeometry(0.25, 12, 10), solid(0x00e5ff, 0.95));
            head.position.y = 1.74;
            const ring = new R3.Mesh(new R3.RingGeometry(0.55, 0.85, 28),
              new R3.MeshBasicMaterial({ color: 0x00e5ff, side: R3.DoubleSide,
                transparent: true, opacity: 0.9, depthTest: false }));
            ring.rotation.x = -Math.PI / 2;
            ring.position.y = 0.05;
            // 竖直光柱：远处俯视也能一眼看到人在哪（不是只有贴地的圈）。
            const beam = new R3.Mesh(new R3.CylinderGeometry(0.06, 0.06, 14, 6), solid(0x00e5ff, 0.42));
            beam.position.y = 7;
            for (const m of [body, head, ring, beam]) m.renderOrder = 999;
            g.add(body, head, ring, beam);
            g.userData = { body, head, ring, beam };
            g.visible = false;
            window.__scene.add(g);
            replayMarker = g;
            return g;
          };
          const markerColor = (st, d) => {
            if (st === 'dead') return 0xff2020;        // 困死：鲜红
            if (st === 'stranded') return 0xff6a00;    // 被困：橙
            if (st === 'injured') return 0xffc400;     // 受伤：黄
            if (st === 'evacuated' || st === 'rescued') return 0x2ee66b; // 脱险：绿
            if ((d || 0) >= 0.35) return 0xffe14d;     // 涉水：浅黄
            return 0x00e5ff;                            // 常态：青
          };
          const placeMarker = (f) => {
            const g = ensureReplayMarker();
            if (!g || !f) return;
            // 【阶段3】室内帧用 trace 里记下的真实楼层高程（来自建筑高度派生），
            // 人偶出现在对应楼层，不再贴地显示在楼外；室外帧仍按地形贴地。
            // 【2026-11-17 地下室】地下层的 y 在地坪以下 2.2 m，人偶直接落进去
            // 会被地形埋掉——人偶是"指路标"，不是身体，所以夹到地面显示，
            // 由信息栏写明"地下层"。身体（人形模型）仍在真实的负高度上。
            const gy = window.__terrY ? window.__terrY(f.x, f.z) : null;
            const y = (f.indoor && Number.isFinite(f.y))
              ? (Number.isFinite(gy) ? Math.max(f.y, gy) : f.y)
              : (Number.isFinite(gy) ? gy : 0);
            g.position.set(f.x, y, f.z);
            const col = markerColor(f.st, f.d);
            for (const k of ['body', 'head', 'ring', 'beam']) g.userData[k].material.color.setHex(col);
            // 被困/困死放大一圈，进一步突出（游戏里目标高亮的做法）。
            const strong = f.st === 'dead' || f.st === 'stranded';
            const s = strong ? 1.3 : 1;
            g.scale.set(s, strong ? 1.15 : 1, s);
            g.visible = true;
          };
          const focusFrame = (f) => {
            const cam = window.__camera, ctl = window.__controls;
            if (!cam || !ctl || !f) return;
            const gy = window.__terrY ? window.__terrY(f.x, f.z) : null;
            const ground = Number.isFinite(gy) ? gy : 0;
            const ty = ground + 1.2;
            ctl.target.set(f.x, ty, f.z);
            cam.position.set(f.x + 16, ty + 11, f.z + 16);
            ctl.update();
          };
          const showFrame = () => {
            if (!caseFrameInfo || !caseReplay || !caseReplay.trace.length) return;
            const idx = Math.max(0, Math.min(caseReplay.trace.length - 1,
              Number(caseFrame.value) || 0));
            const f = caseReplay.trace[idx];
            placeMarker(f);                 // 拖滑块就把剪影摆到那一帧，人始终可见
            if (replayLock) focusFrame(f);  // 点了「定位」后，拖滑块相机一起跟
            caseFrameInfo.innerHTML = [
              `${hhmm(f.t)} · 第 ${idx + 1}/${caseReplay.trace.length} 帧`,
              `位置 ${f.x}, ${f.z} · 水深 <b>${Math.round((f.d || 0) * 100)}</b> cm · 速度 ${f.v} m/s`,
              `状态 ${f.st}${f.car ? ' · 车内' : ''}${f.indoor ? (f.fl === 0 ? ' · 地下层（地下室）' : ` · 室内第 ${f.fl || 1} 层`) : ''}${f.shelter ? ' · 避险中' : ''}`,
              `判断 ${f.act || '—'}${f.goal ? ` · 目标「${f.goal}」` : ''}`,
              f.why ? `理由 ${f.why}` : '',
            ].filter(Boolean).join('<br>');
          };
          const loadCase = () => {
            if (!casePick || !PED || !PED.incidents) return;
            caseReplay = PED.incidents.snapshot(Number(casePick.value));
            if (!caseReplay) return;
            const c = caseList.find((x) => x.i === Number(casePick.value));
            const ev = caseReplay.events.length;
            caseInfo.innerHTML = c
              ? `#${c.i} · ${c.age != null ? c.age + ' 岁' : '—'} · ${c.circleLabel || '—'}<br>`
                + `结果 <b>${c.cause || c.status}</b> · ${ev} 条事件 · ${caseReplay.trace.length} 帧`
                + `<br>最深水 <b>${Math.round((c.maxDepth || 0) * 100)}</b> cm · 从 ${hhmm(c.firstMinute)} 起`
              : '—';
            const n = Math.max(0, caseReplay.trace.length - 1);
            caseFrame.max = String(n);
            caseFrame.value = String(n);   // 默认停在最后一帧，即出事那一刻
            showFrame();
          };
          const refreshCases = () => {
            if (!casePick || !PED || !PED.incidents || !PED.incidents.cases) return;
            const keep = casePick.value;
            caseList = PED.incidents.cases(200) || [];
            const label = (c) => `#${c.i} ${c.cause || c.status} · ${hhmm(c.minute)} · ${Math.round((c.maxDepth || 0) * 100)}cm`;
            casePick.innerHTML = caseList.length
              ? caseList.map((c) => `<option value="${c.i}">${label(c)}</option>`).join('')
              : '<option value="">连续运行后列出出过事的人</option>';
            if (keep && caseList.some((c) => String(c.i) === String(keep))) casePick.value = keep;
            loadCase();
          };
          if (casePick) casePick.addEventListener('change', loadCase);
          if (caseFrame) caseFrame.addEventListener('input', showFrame);
          const caseGo = $('caseGo');
          if (caseGo) caseGo.addEventListener('click', () => {
            // 兜底：下拉每 5 秒才刷新，用户刚跑出事故立刻点定位时 caseReplay
            // 可能还是空的。直接从已抓到的个案清单取，不依赖下拉是否已刷新。
            if (!caseReplay || !caseReplay.trace.length) {
              // 现取，不依赖 caseList 缓存（它也是每 5 秒才刷）。
              const fresh = (PED && PED.incidents && PED.incidents.cases)
                ? PED.incidents.cases(200) : caseList;
              const pickI = Number(casePick && casePick.value);
              const c = fresh.find((x) => x.i === pickI) || fresh[0];
              if (c && PED && PED.incidents) caseReplay = PED.incidents.snapshot(c.i);
            }
            if (!caseReplay || !caseReplay.trace.length) return;
            const f = caseReplay.trace[Math.max(0, Math.min(caseReplay.trace.length - 1,
              Number(caseFrame.value) || 0))];
            if (window.__setFollow) window.__setFollow(false);  // 先关跟拍，否则每帧被拉回去
            replayLock = true;
            placeMarker(f);
            focusFrame(f);
          });
          // 调试出口：浏览器验收读回放人偶是否摆到历史帧、颜色是否正确。
          window.__replayView = () => ({
            visible: !!(replayMarker && replayMarker.visible),
            x: replayMarker ? replayMarker.position.x : null,
            y: replayMarker ? replayMarker.position.y : null,
            z: replayMarker ? replayMarker.position.z : null,
            color: replayMarker ? replayMarker.userData.body.material.color.getHex() : null,
            frame: caseReplay && caseReplay.trace.length
              ? caseReplay.trace[Math.max(0, Math.min(caseReplay.trace.length - 1,
                  Number(caseFrame.value) || 0))] : null,
          });
          refreshCases();
          setInterval(refreshCases, 5000);

          setInterval(upd, 400);
          upd();
        }
      }
    }
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
  // 【只做水平对齐，竖直方向交给每一件自己采样】
  // 以前这里是 position.set(wx, gy, wz)，把整组抬到「白宫中心那一点」的地面高，
  // 组里所有子件的局部 y 都是 0 —— 等于假设整个南草坪是水平面。
  // 实际这一段地面往南要掉 4~5 m（中心 11.5 m，往南 34 m 处 10.1 m，140 m 处 6.8 m），
  // 于是喷泉浮 1.4 m、绿篱浮 1.6 m、花坛浮 2.0 m、一半的树浮在 0~7 m 的半空。
  // 现在组只对齐平面位置，每件按自己的落点取地形高程。
  WH_ANCHOR.position.set(wx, 0, wz);
  // 局部 (lx, lz) → 该点的地面高程（three 坐标，z = -planY）
  const yAt = (lx, lz) => TERRAIN.sampleHeight(wx + lx, wz + lz);

  // 喷泉（南草坪中央，房子正南约 34 m —— 与照片构图一致）
  const fountain = buildFountain(mats, new THREE.Vector3(0, yAt(0, 34), 34), 1.0);
  WH_ANCHOR.add(fountain);
  WH_GROUND.fountain = fountain;

  // 绿篱（喷泉前那道横贯的矮绿墙）
  WH_ANCHOR.add(buildHedge(
    mats, new THREE.Vector3(0, yAt(0, 46.5), 46.5), 96, 1.55, 2.4, 3311,
    (lx) => yAt(lx, 46.5) - yAt(0, 46.5),
  ));

  // 花坛（绿篱前，红+蓝两色带）
  WH_ANCHOR.add(buildFlowerBed(
    mats, new THREE.Vector3(0, yAt(0, 52.5), 52.5), 104, 3.6, 5521,
    (lx, lz) => yAt(lx, 52.5 + lz) - yAt(0, 52.5),
  ));

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
    // 树脚按落点取地面高（不是白宫中心那一点）
    const tr = buildTree(mats, kind, seed, x, z, yAt(x, z));
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
const hemi = new THREE.HemisphereLight(0xc6d8ea, 0x7c7a62, 0.86);
scene.add(hemi);

// 补充一盏很弱的反向补光，避免暗面死黑
const fill = new THREE.DirectionalLight(0xdfe9f7, 0.46);
fill.position.set(CITY_CX + 700, 500, CITY_CZ - 700);
scene.add(fill);

/**
 * 一天的光照曲线。
 *
 * 【为什么必须有】城市时钟能拖到 0:00–24:00，但太阳、天空、雾、曝光以前全是
 * 常量 —— 实测把时间轴从 01:00 拖到 10:00，渲出来的两张图**逐像素相同**
 * （用户 2026-11-06「24 小时到底是不是真的」）。有 24 h 的雨、24 h 的人和车，
 * 却没有 24 h 的天，一眼就穿帮。
 *
 * 做法：给 9 个关键帧（夜/日出/上午/正午/午后/日落/暮色/夜），逐帧线性插值，
 * 同时驱动 5 样东西 —— 太阳强度与色温、半球天光、补光、雾色、天空三段渐变、
 * 以及 toneMappingExposure。雨天再乘一个压暗系数，阴天没有强投影。
 */
const DAY_KEYS = [
  // m=一天分钟；sun/hemi/fill 是强度；sc 是阳光色；top/mid/bot 是天空三段
  { m: 0,    sun: 0.20, hemi: 0.60, fill: 0.34, sc: 0x5d7098, top: 0x1b2540, mid: 0x26334f, bot: 0x35435c, fog: 0x26334a, exp: 1.06 },
  { m: 300,  sun: 0.22, hemi: 0.62, fill: 0.35, sc: 0x61759c, top: 0x1d2743, mid: 0x283651, bot: 0x37455f, fog: 0x28364c, exp: 1.07 },
  { m: 378,  sun: 0.55, hemi: 0.34, fill: 0.16, sc: 0xff9a5c, top: 0x243c6a, mid: 0x7a6280, bot: 0xd89a6c, fog: 0x8e8088, exp: 0.94 },
  { m: 432,  sun: 1.85, hemi: 0.72, fill: 0.32, sc: 0xffd9b4, top: 0x3576c0, mid: 0x9fc0e0, bot: 0xdfe8f0, fog: 0xc6d6e6, exp: 1.10 },
  { m: 720,  sun: 2.55, hemi: 0.88, fill: 0.46, sc: 0xfff4e2, top: 0x3d84cc, mid: 0xa9cdec, bot: 0xe8eef2, fog: 0xd3e2f0, exp: 1.18 },
  { m: 990,  sun: 2.05, hemi: 0.80, fill: 0.42, sc: 0xffe8c8, top: 0x3a7cc4, mid: 0xa8c8e6, bot: 0xe6ecf0, fog: 0xd0dcea, exp: 1.13 },
  { m: 1074, sun: 1.55, hemi: 0.66, fill: 0.30, sc: 0xff9a55, top: 0x2a3c6c, mid: 0x8a5c74, bot: 0xd08a5c, fog: 0x86707c, exp: 0.93 },
  { m: 1146, sun: 0.38, hemi: 0.58, fill: 0.30, sc: 0x6b7fa4, top: 0x1a2440, mid: 0x2b3956, bot: 0x3b4a63, fog: 0x29374e, exp: 1.02 },
  { m: 1440, sun: 0.20, hemi: 0.60, fill: 0.34, sc: 0x5d7098, top: 0x1b2540, mid: 0x26334f, bot: 0x35435c, fog: 0x26334a, exp: 1.06 },
];

const _dc = new THREE.Color();
const _dc2 = new THREE.Color();
const _skyTop = new THREE.Color();
const _skyMid = new THREE.Color();
const _skyBot = new THREE.Color();
const _skySun = new THREE.Color();
let _lastDayMin = -1;

/** 按「一天分钟」调光；rain 是 0..1 的雨强归一值（用来压暗、去投影）。 */
function applyDaylight(minute, rain = 0) {
  const mm = Math.max(0, Math.min(1440, minute));
  let a = DAY_KEYS[0];
  let b = DAY_KEYS[DAY_KEYS.length - 1];
  for (let i = 1; i < DAY_KEYS.length; i++) {
    if (mm <= DAY_KEYS[i].m) { a = DAY_KEYS[i - 1]; b = DAY_KEYS[i]; break; }
  }
  const span = b.m - a.m || 1;
  const t = Math.max(0, Math.min(1, (mm - a.m) / span));
  const mix = (k) => a[k] + (b[k] - a[k]) * t;

  // 雨越大越暗、越灰。系数从 0.65 收到 0.48：0.65 时 18:00 暴雨那张图比
  // 凌晨 1 点还黑（日落关键帧本来就暗，再砍 65% 就到底了），完全看不出是傍晚。
  const dim = 1 - 0.34 * Math.min(1, rain);
  sun.intensity = mix('sun') * dim;
  hemi.intensity = mix('hemi') * (1 - 0.26 * Math.min(1, rain));
  fill.intensity = mix('fill') * (1 - 0.35 * Math.min(1, rain));
  _dc.setHex(a.sc); _dc2.setHex(b.sc);
  sun.color.copy(_dc).lerp(_dc2, t);

  _skyTop.setHex(a.top).lerp(_dc2.setHex(b.top), t);
  _skyMid.setHex(a.mid).lerp(_dc2.setHex(b.mid), t);
  _skyBot.setHex(a.bot).lerp(_dc2.setHex(b.bot), t);
  _skySun.setHex(a.sc).lerp(_dc2.setHex(b.sc), t);
  const u = SKY_MESH.material.uniforms;
  u.uTop.value.copy(_skyTop);
  u.uMid.value.copy(_skyMid);
  u.uBot.value.copy(_skyBot);
  u.uSunColor.value.copy(_skySun);
  // 阴雨天把云的对比压掉，天看起来是一整片灰
  if (u.uCloud !== undefined) u.uCloud.value = 1 - 0.55 * Math.min(1, rain);

  scene.fog.color.setHex(a.fog).lerp(_dc2.setHex(b.fog), t);
  // 暴雨时天不该是黑的，而是一片亮灰（雨幕散射）。往灰白方向推，不是压暗。
  scene.fog.color.lerp(_dc.setRGB(0.46, 0.50, 0.55), 0.45 * Math.min(1, rain));
  renderer.toneMappingExposure = mix('exp') * (1 - 0.12 * Math.min(1, rain));
  _lastDayMin = mm;
  // 返回 0..1 的环境亮度：水面着色器的颜色是硬编码的，不跟着压暗就会在
  // 夜里变成全场最亮的东西（18:00 那版看起来像一片发光的白雪）。
  return Math.max(0.16, Math.min(1, hemi.intensity / 0.88));
}

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
let lastCrowdCount = -1;      // 24h 人群数量，只在跨时段时改一次

function animate() {
  requestAnimationFrame(animate);
  frame(Math.min(clock.getDelta(), 0.05));
}

/** 一帧的全部逻辑 + 渲染。抽出来是为了让无头浏览器也能手动驱动（见 __frame）。 */
function frame(dt, skipRender = false) {
  elapsed += dt;

  controls.update();

  // 阴影相机跟着观察点走（否则 6 km 范围里根本没有阴影）
  followShadow(controls.target);

  if (WH_GROUND.fountain) updateFountain(WH_GROUND.fountain, dt);

  // 水面法线缓慢漂移（氛围；静止的河面看着像塑料）
  const wg = window.__waterGroup;
  if (wg && wg.userData.update) wg.userData.update(elapsed);

  // L6 行人：状态机 + 动画（必须在相机更新之后，距离裁剪才准）。
  // 积涝叠层打开时把 FLOOD 传进去 —— 人脚下 12 cm 水深就转「逃难」，跑向最近的高地/高楼。
  // 【统一时钟】这一帧的仿真秒由 CLOCK 给出，水、马克、具名角色、随机行人
  // 全部按同一个 simSec 推进；暂停时 simSec=0，全城一起停。
  // 【统一时间层 2026-11-11】一帧的仿真预算拆成 ≤0.2 仿真秒的子步，
  // 每个子步内：时钟 → 故事/具名角色/车 → 行人判断与真实位移 → 人车涉水回写。
  // 倍率只改变子步数量，判断频率、动作速度、积水、退水全部按同一个仿真秒推进；
  // 暂停时 steps=0，全城一起停。子步内 CLOCK.minute 是**中间时刻**，所以
  // 水深采样、目标时间窗、雨强判定读到的都是这一子步真正的时间。
  // skipRender 只给离线 24h 验收：允许更稀的子步采样，实时播放仍按 0.2 秒。
  const sim = CLOCK.beginFrame(dt, skipRender);
  // 【相机解耦 2026-11-20】旧版这里是 `FLOOD.group.visible ? FLOOD : null`，
  // 面板上点一下「水面」把水层关掉，一千人就同时失去水深（不再涉水、不再被困、
  // 不再淹死）——水层可见性是渲染开关，不能当模型开关。现在只要求水帧加载完成。
  const pedFlood = (FLOOD && FLOOD.frames > 0) ? FLOOD : null;
  // 【§5 时间层 2026-11-20】发布时刻是工况级的：脉冲族 = 雨前 30 分钟，全天族
  // 从 0 点起（发布也是 0 点）。只在开了 ?timelayer=1 时喂进去，默认不影响行为。
  if (TIME_LAYER_ON) setPublishMin(publishMinOf(FLOOD ? FLOOD.rainStart : 0));
  // 暂停 / 零 dt 时仍走一次「空步」：dt=0 不推进任何量，但要让行人状态机、
  // 可见性、场景摆位刷新（验收脚本常用 __frame(0,2) 做静态重放）。
  const nSteps = sim.steps || 1;
  for (let k = 1; k <= nSteps; k++) {
    if (sim.steps) CLOCK.stepTo(sim.startMinute + k * sim.h / 60);
    // 【子步同层】行人 LDT / 被困判定读 flood.tMin，旧版只在帧末 showMinute
    // 更新，子步期间一直返回上一帧末的时刻。这里用轻量接口同步分钟，
    // 不重绘纹理；水面选帧仍在帧末做一次。
    if (FLOOD && FLOOD.setClockMin) FLOOD.setClockMin(CLOCK.minute);
    const h = sim.steps ? sim.h : 0;
    if (TRAFFIC) TRAFFIC.update(h);
    // 先跑唯一的人系统，再把具名角色模型同步到同一个人身上。
    if (PED) PED.update(h, camera, pedFlood);
    if (MARK && MARK.syncLive) MARK.syncLive();
    if (PEOPLE && PEOPLE.syncLive) PEOPLE.syncLive(h);
    if (FLOOD && FLOOD.fb) FLOOD.fb.step(h);
  }
  if (sim.steps) CLOCK.endFrame();
  // 积涝选帧按分钟，一帧最多跨百分之几分钟（远小于 32 帧的间隔），
  // 帧末按最终时刻选一次即可，不必每个子步重画纹理。
  if (FLOOD) FLOOD.showMinute(CLOCK.minute);
  // ---- 降雨层 ----
  // 雨强不是常数，按内核同一个 `day` 雨型从时钟分钟算出来（凌晨毛毛雨、
  // 18:00 瓢泼）。用真实 dt 推进，不跟仿真倍速 —— 24× 时如果雨也跟着加
  // 24 倍速，画面就是一堵白墙。
  if (RAIN) {
    const pAvg = (FLOOD && FLOOD.manifest && FLOOD.manifest.p_mm_h) || 8;
    // 每帧只算一次（旧版同一函数跑两遍）
    const _cp = cameraInsideBuilding();
    rainIndoor = !!_cp;
    window.__camPlace = _cp;                      // 调试：当前镜头在哪栋楼里
    RAIN.update(dt, (FLOOD && FLOOD.raining) ? rainRateAt(CLOCK.minute, pAvg) : 0);
  }
  // ---- 一天的光照 ----
  // 太阳/天光/雾/曝光/天空渐变全部按时钟走。以前这些是常量，01:00 和 10:00
  // 渲出来逐像素相同 —— 24 h 的雨和人配一个不动的天，一眼假。
  // 雨强归一：day 雨型峰值约 3.2 倍均值，所以 /(p*3) 就是 0..1。
  {
    const pA = (FLOOD && FLOOD.manifest && FLOOD.manifest.p_mm_h) || 8;
    const rn = (FLOOD && FLOOD.raining)
      ? Math.max(0, Math.min(1, rainRateAt(CLOCK.minute, pA) / (pA * 3))) : 0;
    const lvl = applyDaylight(CLOCK.minute, rn);
    daylightLevel = lvl;
    if (FLOOD && FLOOD.setDaylight) FLOOD.setDaylight(lvl);
  }
  // 24h 故事 HUD：跟着同一个时钟，别让剧本只躺在 JSON 里
  renderStoryHud();
  // 24h 人群：街面人数现在由 crowd-life 逐人决定（谁在室内 / 谁在街上），
  // 并按片区轮转 8 档作息，任何时刻街上都有人。
  // 【2026-11-10 修复】旧版再用 crowdState().count 全局砍掉「前 N 个」行人：
  // setCount 只写 obj.visible、不写 p.visible，距离裁剪下一帧看到
  // vis === p.visible 就不会恢复，被砍的人永久隐身（实测 22:00 镜头街区 0 人）。
  // 现在全量启用，街面人口只交给社会层。
  if (PED && PED.peds) {
    const all = PED.peds.length;
    if (lastCrowdCount !== all) {
      PED.setCount(all);
      lastCrowdCount = all;
    }
  }
  // 行人已在上面的子步循环里按 sim.h 推进（真实位移 / 0.5 s 判断 / 水深采样
  // 都在同一时间层），此处不再重复调用 PED.update。
  // 室内有人时把楼外壳剖成半透明（放在所有角色更新之后，别被它们的
  // applyFocus 复位掉）。只在「谁在室内」变化时真正执行。
  updateIndoorCutaway();
  updateStreetLights();

  // 拖时间轴造成的大跳已经在 CLOCK.onSeek 里统一重放（故事 + 积涝帧 + 行人补跑），
  // 这里不再按洪水帧的跳变单独 catchUp，避免两套时钟互相打架。

  // 云影缓慢移动
  if (cloudShadow.material.map) {
    cloudShadow.material.map.offset.x += dt * 0.0042;
    cloudShadow.material.map.offset.y += dt * 0.0028;
  }

  if (!skipRender) {
    renderer.info.reset();
    renderer.render(scene, camera);
  }

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
    updateTrapHud();
  }
}

/**
 * 手动推帧。无头浏览器（SwiftShader）里 requestAnimationFrame 完全不触发，
 * 截图永远停在首帧 —— 验收时必须能主动驱动，否则改了什么都看不出来。
 */
/**
 * 手动推帧。无头浏览器（SwiftShader）里 requestAnimationFrame 完全不触发，
 * 截图永远停在首帧 —— 验收时必须能主动驱动，否则改了什么都看不出来。
 * 第三个参数 skipRender=true 时只跑仿真不渲染（web/sim/sim-day.mjs 连续跑 24h 用），
 * 倍率、判断、位移、积水的推进逻辑完全一样。
 */
window.__frame = (dt = 1 / 60, n = 1, skipRender = false) => {
  // 上限放到 0.1 真实秒：CLOCK.beginFrame 本来就按 0.1 夹，且倍率只增加
  // 子步数（单步 ≤0.2 仿真秒）。24h 连续验收用 0.1 可把帧数减半而不变粗糙。
  // 正常 rAF 的 dt≈0.016，实时播放完全不受影响。
  for (let i = 0; i < n; i++) frame(Math.min(dt, 0.1), skipRender);
};
// 自动验收要读绘制统计（判断某个物体到底有没有进 draw call）
window.__renderer = renderer;
window.__scene = scene;
window.__camera = camera;

// 被困人数：0.5 s 刷一次就够（连通域只在换帧时重算，人走得慢，数字不会跳）
let trapHudEls = null;
let lastFloodMin = -1;   // 上一次看到的积涝仿真时刻（分钟），用来判断是「播放」还是「拖滑块」
// 当前已经装配进 PED 的 LDT 表对应哪个工况（'' = 还没有）
let ldtCaseName = null;
let ldtLoading = false;

/**
 * 让 LDT 表跟着积涝工况走。
 * 【为什么用轮询而不是监听 #flCase 的 change】flood.js 的 load() 一进函数就先把
 * curDir 改掉，fetch 完才更新 manifest.source；在 change 里读 source 会读到**上一个**
 * 工况（实测就是这样：切到 p25_s4 却把 l2_1m_heavy 的表又装了一遍）。
 * 这里改成每 0.5 s 比对一次「manifest 里现在真正的 source」，变了才换表。
 */
function syncLdtCase() {
  if (ldtLoading || !PED || !PED.setLdt || !FLOOD) return;
  const cn = ((FLOOD.manifest && FLOOD.manifest.source) || '').split('/').filter(Boolean).pop();
  if (!cn || cn === ldtCaseName) return;
  // 统一工况用实时水深栅格判断，不加载旧 LDT 表（也别每 0.5 s 报一次 404）
  if (cn.startsWith('u_')) {
    ldtCaseName = cn;
    PED.setLdt(null);
    return;
  }
  ldtLoading = true;
  loadLdt(cn)
    .then((l) => {
      PED.setLdt(l);
      window.__ldt = l;
      ldtCaseName = cn;
      console.log(`[ldt] 换表 → ${cn}（${l.summary().reachable} 个节点来得及）`);
    })
    .catch((e) => {
      PED.setLdt(null);
      window.__ldt = null;
      ldtCaseName = cn;
      console.warn('[ldt] 这个工况没有逃生余量表：' + (e && e.message));
    })
    .finally(() => { ldtLoading = false; });
}

function updateTrapHud() {
  syncLdtCase();
  if (!PED || !FLOOD || !FLOOD.group.visible) return;
  if (!trapHudEls) {
    const root = document.getElementById('flood');
    if (!root) return;
    trapHudEls = {
      n: root.querySelector('#flTrapped'),
      sub: root.querySelector('#flTrapSub'),
      note: root.querySelector('#flTrapNote'),
      ldtRow: root.querySelector('#flLdtRow'),
      ldtNoteRow: root.querySelector('#flLdtNoteRow'),
      ldtDoom: root.querySelector('#flLdtDoom'),
      ldtSub: root.querySelector('#flLdtSub'),
      ldtNote: root.querySelector('#flLdtNote'),
    };
  }
  const s = PED.fleeStats();
  if (trapHudEls.n) {
    // 红/黄/绿分档：超过 10% 就是「成片困死」，直接标红
    const pct = s.total ? s.trapped / s.total : 0;
    trapHudEls.n.textContent = String(s.trapped);
    trapHudEls.n.style.color = pct > 0.10 ? '#ff5a48' : (s.trapped > 0 ? '#ff8b7a' : '#8ee6a0');
  }
  if (trapHudEls.sub) {
    const peak = s.trappedPeak > s.trapped ? ` · 峰值 ${s.trappedPeak}` : '';
    trapHudEls.sub.textContent = `/ ${s.total} 人 · 孤岛 ${s.stranded || 0}${peak}`;
  }
  if (trapHudEls.note) {
    // 说明这一串数字是怎么算出来的：可涉水 30 cm，判定标准是「能不能走回主城」
    // 累计口径：多少人被困了多久（人·分钟），第一次被困发生在第几分钟
    const pm = s.trappedPersonMin ? ` · 累计 ${s.trappedPersonMin} 人·分` : '';
    const first = s.firstTrapMin >= 0 ? ` · 首次 ${s.firstTrapMin | 0} min` : '';
    const rain = s.raining ? ` · 雨中避雨 ${s.rainShelter || 0} 人` : '';
    trapHudEls.note.textContent = s.comps
      ? `可涉水 ${(s.wadeMax * 100) | 0} cm · 干地 ${s.comps} 块，主城占 ${Math.round((s.mainlandPct || 0) * 100)}%${pm}${first}${rain}`
      : '可涉水 30 cm；走不回主城就算被困';
  }

  // ---- 逃生余量（LDT）：这一行回答「此刻再走还来不来得及」
  if (trapHudEls.ldtRow) {
    const on = !!s.ldtOn && s.ldtCovered > 0;
    trapHudEls.ldtRow.style.display = on ? '' : 'none';
    if (trapHudEls.ldtNoteRow) trapHudEls.ldtNoteRow.style.display = on ? '' : 'none';
    if (on) {
      const doom = s.ldtDoomed || 0;
      const pct = s.ldtCovered ? doom / s.ldtCovered : 0;
      if (trapHudEls.ldtDoom) {
        trapHudEls.ldtDoom.textContent = String(doom);
        trapHudEls.ldtDoom.style.color = pct > 0.10 ? '#ff5a48' : (doom > 0 ? '#ff8b7a' : '#8ee6a0');
      }
      if (trapHudEls.ldtSub) {
        const peak = s.ldtDoomPeak > doom ? ` · 峰值 ${s.ldtDoomPeak}` : '';
        trapHudEls.ldtSub.textContent = `/ ${s.ldtCovered} 人 · 余量<10min ${s.ldtTight || 0}${peak}`;
      }
      if (trapHudEls.ldtNote) {
        const med = s.ldtMedian === null || s.ldtMedian === undefined
          ? '—'
          : (s.ldtMedian > 1e5 ? '不会淹' : `${Math.round(s.ldtMedian)} min`);
        const min = s.ldtMin === null || s.ldtMin === undefined
          ? '—'
          : (s.ldtMin <= -1e5 ? '已在水里' : (s.ldtMin > 1e5 ? '不会淹' : `${Math.round(s.ldtMin)} min`));
        const first = s.ldtFirstDoomMin >= 0 ? ` · 首次来不及 ${s.ldtFirstDoomMin | 0} min` : '';
        trapHudEls.ldtNote.textContent =
          `最晚出发时刻 − 当前时刻 · 富余中位 ${med} · 最紧 ${min}${first}`;
      }
    }
  }
}

// ---------------------------------------------------------------- resize
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- 全天剧本
/**
 * 把 `assets/story/day_full.json` 接进来：
 *  ① HUD 左上「全天故事」面板按城市时钟显示此刻的幕、环境、7 人状态、台词；
 *  ② 按 scenes 清单补建真 3D 生活道具（life-scenes.js，全纯色几何、不贴贴图）。
 * 之前这份 JSON 没有任何消费方，故事写了等于没写。
 */
// ---------------------------------------------------------------- 室内灯 / 剖切复位
/**
 * 【2026-11-07 第二轮】上一版按「此刻谁在室内」把整栋楼**所有 mesh** 都
 * ghost 到 opacity 0.26 —— 楼板、工位、家具、内饰一起半透明，6 层叠成一团，
 * 用户原话「房子变成透明的了我就看不清」「办公楼搞得很抽象」。
 * 现在楼永远 100% 实心：这里只管两件事 —— ① 给有人的楼留一盏暖灯
 * （点人 / 跟拍把相机送进楼里时看得清）；② 把 crisis 期间 applyFocus
 * 留下的楼层剖切状态复位。室内人物位置仍由轨迹层摆准，HUD 可查在哪层。
 */
/** 相机钻进了哪栋精细楼（返回 place key / null；每帧算一次，雨丝回调直接读）。 */
let rainIndoor = false;
function cameraInsideBuilding(margin = 12) {
  const P = (STORY && STORY.ok && STORY.places) ? STORY.places : null;
  if (!P) return null;
  const c = camera.position;
  // 真实楼高（旧版按 FLOORS*3.6 估，公寓 42.6 m、学校 42.8 m 都算不准，
  // 站在 5F 教室会被判成「在楼外」，于是屋里不剖切、也不补光，一片黑）
  const TOP = { home: 43.3, office: 31.1, clinic: 20.0, school: 42.8, cafe: 5.45 };
  for (const [k, p] of Object.entries(P)) {
    if (!(k in TOP)) continue;          // 工地 / 街面本来就是露天的
    if (Math.abs(c.x - p.x) > (p.w || 20) / 2
      || Math.abs(c.z - p.z) > (p.d || 20) / 2) continue;
    const gy = TERRAIN ? TERRAIN.sampleHeight(p.x, p.z) : 0;
    // 门槛原来写 gy+3：1F 的咖啡馆（层高 3.3 m）跟拍机位在 +2 m，被判成
    // 「在街面上」→ 不剖切、不补光，屋里一片黑。构图里人已经站在这栋楼的
    // footprint 内，不可能是街面，门槛降到 +1 m。
    if (c.y > gy + 1 && c.y < gy + TOP[k] + margin) return k;
  }
  return null;
}

let hiddenGroup = null;                // 相机在楼里时被整体隐藏的那一栋（最多一栋）
let lastWallCam = '__init__';          // 剖面墙显示状态的上一次镜头所在楼
let FOLLOW_ACTIVE = false;             // 是否处于「点人名跟拍」状态（决定最小机位距离）
let daylightLevel = 1;                 // 由 applyDaylight 每帧回填：1 白天 / 0.16 深夜
let LAMP_POSITIONS = [];              // roadprops.js 回填的 358 个路灯灯头
let LIGHT_GRID = null;                // 全城灯网（light-grid.js）
// 初始值故意不是空串：首次调用必须执行一次「剖切复位」，把 crisis 段
// applyFocus 留下的楼层隐藏 / 半透明状态彻底清掉。
/**
 * 【2026-11-08】旧版这里只有 2 盏室内灯 + 2 盏路灯，全城 358 根灯杆只是
 * 模型，窗户全黑，夜里除了相机脚下那一小圈什么都看不见。现在统一交给
 * light-grid.js：358 片地面光斑 + 6 盏动态路灯 + 5 盏室内灯 + 全城逐窗
 * 亮灯，全部按同一条 24h 曲线、雨强、此刻哪栋楼有人来驱动。
 */
function updateStreetLights() {
  if (!LIGHT_GRID) return;
  const pA = (FLOOD && FLOOD.manifest && FLOOD.manifest.p_mm_h) || 8;
  const rain = (FLOOD && FLOOD.raining)
    ? Math.max(0, Math.min(1, rainRateAt(CLOCK.minute, pA) / (pA * 3))) : 0;
  LIGHT_GRID.update({
    minute: CLOCK.minute, rain, camera,
    camPlace: window.__camPlace || null,
    occupied: DAYMOTION ? DAYMOTION.occupiedIndoors(CLOCK.minute) : {},
    at: DAYMOTION ? (k, m) => DAYMOTION.at(k, m) : null,
    controls,
    placeCenters: (STORY && STORY.ok) ? STORY.places : {},
  });
}

let lastCutKey = '__init__';
function updateIndoorCutaway() {
  if (!DAYMOTION) return;
  // 夜里屋里亮灯 / 灯池分配已经统一交给 light-grid.js（全城灯网），
  // 这里只负责相机进楼时的「剖切 + 机位距离」。
  // 【严格判定】只在镜头真的进到楼体高度以内才隐藏那一栋。
  // 旧版连同 +12 m 的宽松余量一起用：镜头在楼顶上方 5 m 也被判「在楼里」，
  // 整栋楼一藏，9F 的厨房就变成「悬在马路上面的一间房」。
  const camPlace = cameraInsideBuilding(0.5);

  // 【BUG 修复 3】OrbitControls 的 minDistance 是 12 m（防止钻到模型里），
  // 但室内跟拍机位只有 3~4 m —— 于是无论 focusCamera 怎么算，controls.update()
  // 都会把相机顶回 12 m 外，正好在楼外/楼板之上，点人名只能看到一堵墙。
  // 镜头进楼时放宽到 1.2 m，出楼恢复 12 m。
  // 跟拍时也要放宽：跟拍机位本身就由代码摆，且室内只有 3~4 m。
  // 只按 camPlace 判断会死锁 —— 第一帧相机还在 12 m 外，miniDistance 就不放开，
  // controls.update() 又把刚摆好的 3.4 m 顶回 12 m，永远进不去。
  if (controls) controls.minDistance = (camPlace || FOLLOW_ACTIVE) ? 1.2 : 12;
  window.__camPlace = camPlace;            // 调试：镜头此刻在哪栋楼里
  window.__cutN = (window.__cutN || 0) + 1;
  // 【2026-11-08 实拍修正】镜头进楼时把 life-scenes 的剖面墙全部收起。
  // 跟拍机位在人物背后 4.6 m，房间按网格排开后总有一面矮墙/窗框正好
  // 怼在镜头前，整屏一堵墙。地板 / 家具 / 灯管保留，房间照样读得出。
  if (LIFE && LIFE.group && camPlace !== lastWallCam) {
    lastWallCam = camPlace;
    LIFE.group.traverse((o) => {
      if (o.userData && o.userData.tag === 'roomWall') o.visible = !camPlace;
    });
  }

  // 灯池（相机所在楼 + 有人的楼）、房间灯管亮度、全城亮窗都由
  // light-grid.js 的 update() 每帧驱动，此处不再重复建光。

  // 【只在相机进门时剖那一栋】默认整栋 100% 实心，用户看到的是正常楼；
  // 只有点人 / 跟拍把相机真的送进某栋精细楼，才把**那一栋**的外墙剖开。
  // 用的是楼自带的 setCutaway：office 只 ghost 外墙与屋顶、home 隐藏外墙
  // 保留楼板，内部工位 / 床 / 家具全是实心，不会像上一版叠成玻璃渣。
  const key = camPlace || '__none__';
  if (key === lastCutKey) return;
  lastCutKey = key;
  const all = { home: MK_HOME, office: MK_OFFICE };
  if (PEOPLE && PEOPLE.buildings) Object.assign(all, PEOPLE.buildings);
  if (window.__sceneBuildings) Object.assign(all, window.__sceneBuildings);
  // 先把所有楼自带的剖切复位（保留全部楼层、外墙实心），再把上一栋的
  // 半透明材质还回去，避免 crisis 段或上一次进门留下残影。
  for (const b of Object.values(all)) {
    if (!b || !b.group) continue;
    if (b.setActiveFloor) b.setActiveFloor(null);
    if (b.setCutaway) b.setCutaway(false);
  }
  if (hiddenGroup) { hiddenGroup.visible = true; hiddenGroup = null; }
  // 【2026-11-07 再修正】相机进楼时不再把整栋调成半透明。
  // 半透明有两个硬伤：① 楼板/内墙/外墙叠三四层，屋里被糊成一片灰，
  // 教室的桌椅看着像黑剪影（用户说的「场景离谱」有一半是这个）；
  // ② 从楼外看就是「房子变透明了看不清」。改成：镜头在楼里时把那一栋
  // 整个隐藏（真正的剖切），人 / 家具 / 房间地板都在 group 外，保持实心；
  // 镜头一离开立刻恢复。街上永远看到完整实心的楼。
  const target = camPlace && all[camPlace] ? all[camPlace].group : null;
  if (target) { target.visible = false; hiddenGroup = target; }
}

let lastStoryHud = -1;
function renderStoryHud() {
  // 全天故事面板已移除：预写剧本与实时决策模型无关，面板不在就整段跳过。
  if (!document.getElementById('storyAt')) return;
  if (!STORY || !STORY.ok) return;
  const now = performance.now();
  if (now - lastStoryHud < 240) return;
  lastStoryHud = now;
  const s = STORY.at(CLOCK.minute);
  const $ = (id) => document.getElementById(id);
  const at = $('storyAt'), beat = $('storyBeat'), env = $('storyEnv');
  const cast = $('storyCast'), lines = $('storyLines');
  if (!at || !cast) return;
  // 把轨迹层的实时统计摆进标题行：0 点应显示「0 人在动 / 7 人在室内」，
  // 通勤时段应显示「N 人在动」。这样人物到底动没动不用靠肉眼在城里找。
  const snap = DAYMOTION ? DAYMOTION.atAll(CLOCK.minute) : null;
  // 【2026-11-08 全天核对】17:52–18:35 这 43 分钟 DAYMOTION 让位给
  // story + Brain，旧代码把 crisis 的人直接 continue 掉，HUD 于是显示
  // 「0 人在动 / 0 人在室内」——暴雨高潮里最假的一行。改用故事层的
  // 真实 clip / 楼层 / 状态统计，和其余 23 小时口径一致。
  const crisisNow = CLOCK.minute >= 1072 && CLOCK.minute <= 1115;
  let nMove = 0, nIndoor = 0;
  if (PED && CROWD_LIFE) {
    // 城市场景里的人统一读实时层：此刻多少人在街面、多少人在自己家里/岗位。
    // 旧版这里读 DAYMOTION 的 7 条剧本，0 点会显示“0 人在动 / 7 人在室内”，
    // 和全城 1000 人的真实状态完全不是一回事。
    for (let i = 0; i < PED.peds.length; i++) {
      const q = CROWD_LIFE.at(i);
      if (!q) continue;
      if (q.indoor) nIndoor++;
      else {
        const clip = PED.peds[i].cur ? String(PED.peds[i].cur.getClip().name) : '';
        if (/walk|run/i.test(clip)) nMove++;
      }
    }
  } else if (crisisNow) {
    const ph = PEOPLE ? PEOPLE.hud() : [];
    const mh = MARK ? MARK.hud() : null;
    for (const h of (mh ? [mh, ...ph] : ph)) {
      const c = String(h.clip || '');
      if (/walk|run|stairs|evacuate|door|look/i.test(c)) nMove++;
      if ((h.floor || 1) > 1
        || /shelter|safe|work|operat|class|indoor|home|packing|continuing/i.test(String(h.state || ''))) nIndoor++;
    }
  } else if (snap) for (const q of Object.values(snap)) {
    if (!q || q.crisis) continue;
    if (q.moving) nMove++;
    if (q.indoor) nIndoor++;
  }
  // 【演示可读】把 Brain 决策直接摆到面板上。导师不需要翻开日志就能看到
  // 「人遇到险情真的在权衡」：累计多少条判断 + 最近一次选了什么。
  let brainN = 0, brainLast = '';
  const hs = [...(MARK ? [MARK.hud()] : []), ...(PEOPLE ? PEOPLE.hud() : [])];
  for (const h of hs) {
    const ds = h && h.decisions;
    if (Array.isArray(ds)) {
      brainN += ds.length;
      for (let i = ds.length - 1; i >= 0; i--) {
        const t = ds[i] && (ds[i].chosen || ds[i].text);
        if (t) { brainLast = t; break; }
      }
    } else if (Number.isFinite(ds)) brainN += ds;
  }
  const mkDec = (MARK && MARK.story && MARK.story.decisions) || [];
  for (let i = mkDec.length - 1; i >= 0; i--) {
    const t = mkDec[i] && mkDec[i].chosen;
    if (t) { brainLast = brainLast || t; break; }
  }
  at.textContent = s.clock
    + (snap || crisisNow ? ` · ${nMove} 人在动 / ${nIndoor} 人在室内` : '')
    + (s.nextBeat ? ` → ${STORY.clockText(s.nextBeat.at)}` : '');
  beat.textContent = (s.act || '')
    + ((PED && PED.routeStats)
      ? (() => { const rs = PED.routeStats();
        return rs.active ? ` · 路网行走 ${rs.active} 人 / 已到达 ${rs.finished} 趟` : ''; })()
      : '');
  // Brain 读数独立成一行，不塞进标题 —— 标题行宽 330px，加进去会被
  // 折叠按钮截断（实拍 17:55 只剩「· Brain」四个字）。
  env.textContent = (brainN
    ? `Brain ${brainN} 次判断` + (brainLast ? ` · 最近「${String(brainLast).slice(0, 12)}」` : '') + ' ｜ '
    : '') + (s.environment || '').slice(0, 48);
  const placeName = (k) => {
    const p = STORY.places[k];
    return p ? (p.name || p.label || k) : (k || '路上');
  };
  cast.innerHTML = Object.entries(s.cast).map(([k, seg]) => {
    const meta = STORY.cast[k] || {};
    const who = (meta.name || k).slice(0, 4);
    // 剧本里 activity 常带一大串细节，全塞进去会把 7 行撑成 20 行，
    // 面板直接盖住左下的判断列表。单行省略，完整内容在 md 里看。
    const raw = seg.activity || seg.note || '—';
    const what = raw.length > 22 ? raw.slice(0, 21) + '…' : raw;
    // 右列改成「楼层 + 此刻真实动作」，取自轨迹层而不是剧本文字：
    // 医生在手术室就该显示「2F 手术」，不该显示一段看不出动作的地点名。
    const q = snap && snap[k];
    const where = q && !q.crisis
      ? `${q.floor}F ${q.moving ? '走动' : (KIND_CN[q.kind] || q.clip)}`
      : (seg.spot || placeName(seg.place) || '').slice(0, 6);
    return `<div class="row"><span class="who">${who}</span>`
      + `<span class="what">${what}</span><span class="where">${where}</span></div>`;
  }).join('');
  lines.innerHTML = s.lines.slice(0, 2).map((l) =>
    `<div class="line"><b>${l.who}</b>：${l.text}</div>`).join('');
}

async function attachStory() {
  try {
    const { createStory } = await import('./story-engine.js');
    STORY = await createStory();
    window.__story = STORY;
    if (!STORY.ok) return;
    const { buildLifeScenes } = await import('./life-scenes.js');
    const groundAt = (x, z) => (PED && PED.graph && PED.graph.groundAt)
      ? PED.graph.groundAt(x, z) : 0;
    // 【2026-11-07】每栋楼的真实首层高 + 层高。旧版一律按 3.6 m 从地面算，
    // 办公楼 6F（5.0 m 层高）就矮了 7 米，人整层站在楼板里；公寓 9F 高 1.7 米浮空。
    const placeFit = {};
    try {
      const { HOME } = await import('./home-building.js');
      placeFit.home = { baseY: (MK_HOME && MK_HOME.baseY) || HOME.baseY, floorH: HOME.floorH };
    } catch (e) { /* 用 life-scenes 里兜底值 */ }
    try {
      const { OFFICE } = await import('./office-building.js');
      placeFit.office = { baseY: OFFICE.baseY, floorH: OFFICE.floorH };
    } catch (e) { /* ignore */ }
    try {
      const D = await import('./district-buildings.js');
      const t = (c) => TERRAIN.sampleHeight(c.cx, c.cz);
      placeFit.clinic = { baseY: t(D.CLINIC), floorH: D.CLINIC.floorH };
      placeFit.school = { baseY: t(D.SCHOOL), floorH: D.SCHOOL.floorH };
      placeFit.cafe = { baseY: t(D.CAFE), floorH: D.CAFE.floorH };
    } catch (e) { /* ignore */ }
    window.__placeFit = placeFit;
    LIFE = await buildLifeScenes({
      world,
      places: STORY.places,
      scenes: STORY.scenes,
      groundAt,
      // 候车亭 / 电动车 / 校门这些室外道具不能压在车行道上
      onRoad: window.__roadCorridor || null,
      placeFit,
      quality: 'full',
    });
    window.__life = LIFE;
    // ---- 全城灯网：358 根路灯光斑 + 动态光池 + 全城逐窗亮灯 + 室内灯池。
    // 必须等 life-scenes 建好（房间灯材质）和 roadprops 回填灯头坐标之后。
    try {
      const { createLightGrid } = await import('./light-grid.js');
      LIGHT_GRID = createLightGrid({
        THREE, world, camera, scene,
        lampPositions: LAMP_POSITIONS,
        lifeGroup: LIFE.group,
        placeCenters: STORY.places,
      });
      console.info('[light-grid]', JSON.stringify(LIGHT_GRID.stats()));
    } catch (e) {
      console.warn('[light-grid] 装配失败：', e && (e.message || e));
    }
    // 690 件家具（床 / 吧台 / 课桌 / 储物柜 / 货架）全部登记为实体，
    // 行人不再从桌子里穿过去，人物锚点也会被推出家具外。
    if (COLLIDE) {
      COLLIDE.nProp = collectSolids(LIFE.group, COLLIDE, {
        tag: 'prop', minH: 0.22, THREE,
        // 房间地板 / 地毯 / 踢脚线是「地面」，不是障碍
        skip: (o) => (o.userData && o.userData.tag === 'floor'),
      });
      console.info('[collide]', JSON.stringify(COLLIDE.stats()));
    }
    // 【锚点对齐】把 27 个生活场景的真实房间坐标喂给轨迹层，人就会站到
    // 床 / 餐桌 / 工位旁边，而不是落在楼外人行道上（旧版 0 点的 bug）。
    if (DAYMOTION) DAYMOTION.setAnchors(LIFE.group);
    // 路人的家 / 岗位也落在同一批真实 3D 场景里，不是虚构坐标
    if (CROWD_LIFE) CROWD_LIFE.setAnchors(LIFE.group);
    console.info('[crowd-life]', JSON.stringify(CROWD_LIFE ? CROWD_LIFE.stats() : {}));
  } catch (e) {
    console.warn('[story] 剧本 / 生活场景装配失败：', e && (e.message || e));
  }
}

// ---------------------------------------------------------------- 启动
// 先把城市（地形 + 建筑）加载出来，再挂白宫的园林细节 ——
// 园林的落地高程要用 TERRAIN.sampleHeight()，必须等地形就位。
document.getElementById('loading').classList.add('done');
// 无头浏览器（SwiftShader）里 requestAnimationFrame 完全不触发，页面只有首帧。
// ?capture=1 时改用定时器驱动，自动化验收才能看到真实的动态画面。
if (new URLSearchParams(location.search).has('capture')) {
  // 城市还没装配完时不能推帧（MARK/PEOPLE 都是 null）。
  // 【手动驱动优先】离线验收脚本用 window.__frame 精确推 N 帧；若定时器
  // 同时在后台插帧，时钟会被偷偷多推进，24h 数据对不上推帧数。验收脚本
  // 置 window.__manualDrive = true 后，这里完全让出时间轴。
  setInterval(() => {
    if (window.__ready && !window.__manualDrive) frame(1 / 30);
  }, 33);
} else {
  animate();
}

buildCity().then(async () => {
  anchorWhiteHouseGrounds();
  // 城市尺度下相机的远近范围要放大，否则只能看白宫那 300 m
  controls.maxDistance = 7000;
  // 全天剧本 + 生活场景（放在所有建筑/行人就位之后，地面高程才拿得到）
  await attachStory();
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
    // 【坑】旧版 dy=30 正好落在树冠里整屏树叶；target 指向 (1144,-815)
    // 又正好怼上白宫主体。现在朝「行人近景」同一个方向俯视广场街口。
    crowdTop:   { pos: [1060, 0, -700], target: [1090, 0, -760], dy: 46, tdy: 0 },
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
      uTop: { value: new THREE.Color(0x3d84cc) },
      uMid: { value: new THREE.Color(0xa9cdec) },
      uBot: { value: new THREE.Color(0xe8eef2) },
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

      // 廉价值噪声 + 三倍频 FBM —— 云层只要「有形状」就够了，不需要真 VT 噪声。
      float h21( vec2 p ) {
        p = fract( p * vec2( 233.34, 851.73 ) );
        p += dot( p, p + 23.45 );
        return fract( p.x * p.y );
      }
      float vnoise( vec2 p ) {
        vec2 i = floor( p ), f = fract( p );
        f = f * f * ( 3.0 - 2.0 * f );
        return mix( mix( h21( i ), h21( i + vec2( 1, 0 ) ), f.x ),
                    mix( h21( i + vec2( 0, 1 ) ), h21( i + vec2( 1, 1 ) ), f.x ), f.y );
      }
      float fbm( vec2 p ) {
        float s = 0.0, a = 0.5;
        for ( int k = 0; k < 4; k++ ) { s += a * vnoise( p ); p *= 2.03; a *= 0.5; }
        return s;
      }

      void main() {
        float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
        // 三段渐变：地平线偏白，仰角 30° 附近过渡到中蓝，天顶深蓝
        vec3 col;
        if (h < 0.5) {
          col = mix(uBot, uMid, smoothstep(0.30, 0.52, h));
        } else {
          col = mix(uMid, uTop, smoothstep(0.52, 0.95, h));
        }
        // —— 云层：把方向投到一个无限远的平面上，仰角越低越密
        vec3 d = normalize(vDir);
        float up = max(d.y, 0.045);
        vec2 pp = d.xz / up * 1.15;            // 投影平面坐标
        float c1 = fbm( pp * 1.35 + vec2( 12.0, 4.0 ) );
        float c2 = fbm( pp * 3.30 + vec2( 2.0, 9.0 ) );
        float cloud = smoothstep( 0.50, 0.86, c1 * 0.72 + c2 * 0.38 );
        // 地平线附近压低（避免云在墙根处拉成条），天顶也淡化
        cloud *= smoothstep( 0.02, 0.18, d.y ) * ( 1.0 - 0.45 * smoothstep( 0.55, 0.95, d.y ) );
        // 云的明暗：受光面偏暖白，背光面偏蓝灰
        float lit = smoothstep( 0.35, 0.9, c2 );
        vec3 cloudCol = mix( vec3( 0.62, 0.66, 0.72 ), vec3( 1.02, 0.99, 0.94 ), lit );
        col = mix( col, cloudCol, cloud * 0.85 );

        // 太阳周围的辉光（Mie 散射的粗略近似）
        float sd = max(dot(normalize(vDir), normalize(uSunDir)), 0.0);
        col += uSunColor * pow(sd, 24.0) * 0.42;
        col += uSunColor * pow(sd, 4.0) * 0.06;
        // 地平线以下压暗（避免穿帮）
        col = mix(col * 0.74, col, smoothstep(-0.04, 0.10, vDir.y));
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







