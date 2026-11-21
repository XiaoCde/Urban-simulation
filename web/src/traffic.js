/**
 * traffic.js — 城市交通网：车辆沿 roadnet 的图行驶。
 *
 * 【为什么现在是真交通网】之前街上只有 46 辆「停车位上的静车」，没有一辆在动。
 * 这里把 roadnet 的双向边当成车道图：每辆车记住自己在哪条边、走了多远、
 * 朝哪个方向；到路口后按「优先直行、不走回头路」选下一条边，遇红灯停在停止线。
 * 车流速度由 CLOCK 的 simSec 推进，和积涝 / 马克 / 6 人共用同一分钟。
 *
 * 车模型来自用户给的 generic-passenger-car-pack（离线拆成 3 个单车 glb）。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CAR, kmh } from './motion-units.js';

const CAR_FILES = {
  sedan: '/assets/street/car_sedan.glb',
  suv: '/assets/street/car_suv.glb',
  compact: '/assets/street/car_compact.glb',
};
/**
 * 【2026-11-07】三辆 street 车 glb 的车身长轴本来就各不相同（顶点 PCA 实测）：
 *   sedan   -0.1°（车头在 +主轴）→ 补 0°
 *   suv    -72.0°（车灯在 -主轴，车头反向）→ 补 -108°
 *   compact -36.8°（车头在 +主轴）→ 补 +36.8°
 * 旧版一律按「车头朝 +Z」摆放，于是 suv / compact 斜着开、sedan 偶尔倒着开，
 * 就是用户说的「好多模型车有问题、有的车侧身位移」。roadprops 的停放车
 * 用同一套 glb，所以也 import 这份补偿，两边永远一致。
 */
export const CAR_YAW = {
  sedan: 0,
  suv: (-108) * Math.PI / 180,
  compact: (36.8) * Math.PI / 180,
};
// 【速度单一真值】车道右偏、停止线、限速、信号周期一律读 motion-units.js，
// 不再各写一份 magic number（2026-11-13 用户指出速度不一致）。
const LANE_OFF = CAR.LANE_OFF;   // 右侧通行：车道中心离路中线右偏 2.0 m
const STOP_T = CAR.STOP_LINE;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function loadParts() {
  const loader = new GLTFLoader();
  const out = {};
  for (const [k, url] of Object.entries(CAR_FILES)) {
    try {
      const g = await loader.loadAsync(url);
      g.scene.updateMatrixWorld(true);
      const parts = [];
      g.scene.traverse((o) => {
        if (!o.isMesh) return;
        const geo = o.geometry.clone();
        geo.applyMatrix4(o.matrixWorld);
        parts.push({ geo, mat: o.material });
      });
      out[k] = parts;
    } catch (e) {
      console.warn('[traffic] 车模型未加载', k, e && e.message);
    }
  }
  return out;
}

/**
 * @param {object} o { net, world, count=90, clock }
 */
export async function createTraffic(o) {
  const { net, world, clock, count = 90 } = o;
  let fb = o.feedback || null;        // 回写口：泡在水里的车也要给流场记账
  // 可见建筑实体表由 main.js 晚绑定（SOLIDS 要等 EXCLUDE 全部确定才能装配，
  // 而交通层比它更早创建）。实测 96 辆车里有 2 辆沿压楼路段开进了楼体。
  let solids = o.solids || null;
  // 马克的车不在 cars 数组里（由 day-motion 独立驱动），交通层的跟车算法
  // 看不见它 —— 实拍 07:35 / 07:55 两车在同一条车道上贴到了一起。
  // 由 main.js 晚绑定一个「外部前车」查询，行驶中的马克车也要被跟车。
  let externalCar = null;
  const clearCache = new Map();
  const edgeClear = (e) => {
    if (!solids) return true;
    let v = clearCache.get(e);
    if (v !== undefined) return v;
    v = true;
    const L = Math.hypot(e.b.x - e.a.x, e.b.z - e.a.z) || 1;
    const n = Math.max(3, Math.ceil(L / 4));
    for (let i = 0; i <= n; i++) {
      const x = e.a.x + (e.b.x - e.a.x) * i / n;
      const z = e.a.z + (e.b.z - e.a.z) * i / n;
      if (solids.hit(x, z, 2.0)) { v = false; break; }
    }
    clearCache.set(e, v);
    return v;
  };
  const parts = await loadParts();
  const kinds = Object.keys(parts).filter((k) => parts[k] && parts[k].length);
  if (!kinds.length || !net.edges.length) {
    console.warn('[traffic] 没有车模型或路网，跳过');
    return { advance() {}, cars: [], group: new THREE.Group(), stats: { count: 0 } };
  }

  // ---- 邻接表：节点 -> 相连的边 ----
  const adj = new Map();
  const nid = (n) => `${n.i}_${n.j}`;
  for (const e of net.edges) {
    if (!adj.has(nid(e.a))) adj.set(nid(e.a), []);
    if (!adj.has(nid(e.b))) adj.set(nid(e.b), []);
    adj.get(nid(e.a)).push(e);
    adj.get(nid(e.b)).push(e);
  }

  const rand = mulberry32(771103);
  const group = new THREE.Group();
  group.name = 'L6_traffic';
  world.add(group);

  // 每种车型的每个部件一个 InstancedMesh
  const buckets = {};
  const cars = [];
  for (const kind of kinds) {
    buckets[kind] = [];
    for (let p = 0; p < parts[kind].length; p++) {
      const im = new THREE.InstancedMesh(parts[kind][p].geo, parts[kind][p].mat, 0);
      im.frustumCulled = false;
      im.castShadow = true;
      im.name = `car_${kind}_${p}`;
      group.add(im);
      buckets[kind].push(im);
    }
  }

  // 【车不要开进楼】压到楼的格子铺的是 Street_Empty 地块，但图仍连通；
  // 车若沿这些边走就会从楼体里穿过去。出生边只在「两端都不是楼」的边里选。
  const drivable = net.edges.filter((e) => !e.a.underBuilding && !e.b.underBuilding && edgeClear(e));
  const spawnEdges = drivable.length ? drivable : net.edges;
  const N = Math.min(count, spawnEdges.length * 3);
  // 【全城配额撒点】旧版 96 辆全从同一批边里随机抽，实测 100% 落在中心
  // 8 个 500m 网格。现在按 500m 片区轮转取边，保证外围每个有路的片区
  // 都有车停放（之后 bindCrews 再把车摆到车主家附近）。
  const zone = (e) => Math.floor(e.a.x / 500) + ':' + Math.floor(e.a.z / 500);
  const byZone = new Map();
  for (const e of spawnEdges) {
    const k = zone(e);
    if (!byZone.has(k)) byZone.set(k, []);
    byZone.get(k).push(e);
  }
  const zoneLists = [...byZone.values()];
  for (let i = 0; i < N; i++) {
    const list = zoneLists[i % zoneLists.length] || spawnEdges;
    const e = list[Math.floor(rand() * list.length)];
    cars.push({
      kind: kinds[i % kinds.length],
      e, t: rand(), dir: rand() < 0.5 ? 1 : -1,
      // 背景车流速度上限 = 城市道路限速，绝不超过 URBAN_LIMIT
      speed: CAR.SPAWN_MIN + rand() * (CAR.SPAWN_MAX - CAR.SPAWN_MIN),
      seed: rand() * 1000,
      wait: 0,
      // ---- 居民认领车（drive-layer）需要的运行态 ----
      // 【车是代步工具，不是背景动画】每辆车必须有真实车主(crew)才允许
      // 上路；owner=null 的车一律停在自己的车位上，绝不自己空跑。
      owner: null, lastOwner: null, crew: null,
      route: null, dest: null, driver: null,
      parked: true, arrived: false, stalled: false, yielding: false,
      yieldWhy: '', waitingRed: false, waitSec: 0, probeT: 0,
      pedNear: 0, leadGap: 0, depth: 0, distToDest: Infinity,
    });
  }

  // 重建 InstancedMesh 的容量（按车型分配）
  for (const kind of kinds) {
    const n = cars.filter((c) => c.kind === kind).length;
    for (let p = 0; p < parts[kind].length; p++) {
      const old = buckets[kind][p];
      group.remove(old);
      const im = new THREE.InstancedMesh(parts[kind][p].geo, parts[kind][p].mat, Math.max(1, n));
      im.frustumCulled = false;
      im.castShadow = true;
      im.name = `car_${kind}_${p}`;
      im.count = n;
      group.add(im);
      buckets[kind][p] = im;
    }
  }

  const M = new THREE.Matrix4();
  const P = new THREE.Vector3();
  const Q = new THREE.Quaternion();
  const ONE = new THREE.Vector3(1, 1, 1);
  const UP = new THREE.Vector3(0, 1, 0);

  // ============ 居民驾车：认领车 / 真实路网规划 / 交规状态 ============
  // 车不再是「和人不相干的背景车流」：drive-layer 让居民认领一辆车，人的
  // 位置、水深、经历、伤亡全部按这辆车的真实位置计。未认领的车继续当背景流。
  const nodeList = [...(net.nodes instanceof Map ? net.nodes.values() : (net.nodes || []))];
  // 【信号灯不是每个路口都有】全城真实路网有近 7000 个节点，度数≥3 的
  // 小路口上千个；每个都设灯，车每 4 秒就要停一次。真实城市只在主干
  // 交叉口布灯，这里按 300 m 网格最多布一盏（优先度数大的路口）。
  const signalCells = new Set();
  for (const n of nodeList) {
    if (n.signal !== undefined) continue;
    const deg = (adj.get(nid(n)) || []).length;
    const k = Math.floor(n.x / 300) + ':' + Math.floor(n.z / 300);
    n.signal = deg >= 3 && !signalCells.has(k);
    if (n.signal) signalCells.add(k);
  }
  let pedProbe = null;                 // (x,z,r)=>附近行人数，晚绑定
  function setPedProbe(fn) { pedProbe = fn || null; }

  /**
   * 【车是代步工具】给每辆车绑定一个真实居民作为固定车主，并把车位摆到
   * 车主家附近的路段上。没有车主的车一律停着，保证画面上不会出现「空车
   * 自己绕圈跑」。main.js 在 PED / CROWD_LIFE 建好后晚绑定调用。
   */
  /**
   * 【车是代步工具】给每辆车绑定一个真实居民作为固定车主，并把车位摆到
   * 车主家附近的路段上。没有车主的车一律停着，保证画面上不会出现「空车
   * 自己绕圈跑」。main.js 在 PED / CROWD_LIFE 建好后晚绑定调用。
   *
   * 【2026-11-21 只给「真的有车且能开」的人配车】旧版第一轮给
   * commute==='drive'||hasCar 的人配车，第二轮 `if (!used.has(i))` 无条件
   * 补足——于是 ACS 户车数为 0、未成年的居民也拿到了车主身份，
   * traffic.hasCrewCar(i) 为 true，身份层和 ACS 打架。现在只看
   * circle.hasCar && circle.license（social-circles.js 里两者都由真实
   * ACS 户车数与年龄推出来），补车那一轮直接取消：车比能开的人多时，
   * 多出来的车就是无主车、停着，不再硬塞给不能开的人。
   */
  function bindCrews(peds, crowd, circles) {
    if (!peds || !peds.length) return 0;
    const min = clock ? clock.minute : 0;
    const used = new Set();
    const owners = [];
    // 一车一人、不重复：只给「家里有车 + 有驾照（18≤age<88）+ 不是未成年」的人
    for (let i = 0; i < peds.length && owners.length < cars.length; i++) {
      const c = circles && circles[i];
      if (!c || !c.hasCar || !c.license || used.has(i)) continue;
      used.add(i); owners.push(i);
    }
    if (!owners.length) {
      console.info('[traffic] 没有「有车且有驾照」的居民，全部车保持停放');
      return 0;
    }
    // 一车一人：车比能开的人多时，多出来的车不硬塞（真人只有一辆车，
    // 同一个人被绑到 4 辆车上，claim 只会认第一辆，其余永远停在原地看着像空车）
    for (let k = 0; k < cars.length && k < owners.length; k++) {
      const i = owners[k];
      const q = crowd && crowd.at ? crowd.at(i, min) : null;
      const h = q && q.doors ? q.doors.home : null;
      const w = q && q.doors ? q.doors.work : null;
      const c = cars[k];
      c.crew = {
        i,
        home: h && Number.isFinite(h.x) ? { x: h.x, z: h.z } : null,
        work: w && Number.isFinite(w.x) ? { x: w.x, z: w.z } : null,
      };
      if (c.crew.home) {
        const e = nearestEdge(c.crew.home.x, c.crew.home.z);
        if (e) { c.e = e; c.t = 0.5; }
      }
      c.owner = null; c.parked = true; c.vLast = 0;
    }
    console.info(`[traffic] ${cars.length} 辆车已绑定 ${owners.length} 位真实车主，`
      + '无主车一律停放');
    return owners.length;
  }
  function crewStats() {
    let moving = 0, parked = 0, bound = 0;
    for (const c of cars) {
      if (c.crew) bound++;
      if (c.owner !== null && !c.parked) moving++;
      else parked++;
    }
    return { cars: cars.length, bound, moving, parked };
  }

  function nearestNode(x, z) {
    let best = null, bd = Infinity;
    for (const n of nodeList) {
      if (n.underBuilding) continue;
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    return best || nodeList[0] || null;
  }
  function nearestEdge(x, z) {
    const pool = drivable.length ? drivable : net.edges;
    let best = pool[0] || net.edges[0], bd = Infinity;
    for (const e of pool) {
      const mx = (e.a.x + e.b.x) / 2, mz = (e.a.z + e.b.z) / 2;
      const d = (mx - x) ** 2 + (mz - z) ** 2;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }
  /** 在真实路网上 BFS 出一条边序列。压楼 / 穿楼的路段直接排除。 */
  function planRoute(A, B) {
    if (!A || !B || nid(A) === nid(B)) return [];
    const seen = new Map([[nid(A), null]]);
    const q = [A];
    let head = 0;
    while (head < q.length && q.length < 4000) {
      const n = q[head++];
      if (nid(n) === nid(B)) break;
      for (const e of (adj.get(nid(n)) || [])) {
        if (e.a.underBuilding || e.b.underBuilding || !edgeClear(e)) continue;
        const other = e.a === n ? e.b : e.a;
        const k = nid(other);
        if (seen.has(k)) continue;
        seen.set(k, { prev: n, edge: e });
        q.push(other);
      }
    }
    if (!seen.has(nid(B))) return null;
    const out = [];
    let cur = B, guard = 0;
    while (nid(cur) !== nid(A) && guard++ < 4000) {
      const st = seen.get(nid(cur));
      if (!st) return null;
      out.push(st.edge);
      cur = st.prev;
    }
    return out.reverse();
  }
  function carOf(i) {
    for (const c of cars) if (c.owner === i) return c;
    return null;
  }
  /** 认领自己的车并给它一条到目的地的真实路网路线。返回车序号，不可用车返回 -1。 */
  function claim(i, from, dest, driver) {
    if (!dest || !Number.isFinite(dest.x)) return -1;
    // 【车是代步工具，只能开自己的车】旧版从「空车池」随便挑一辆，于是
    // 96 辆没有司机的车在城里自己绕圈。现在每辆车有固定车主；没车的人
    // 本来就该步行/公交，车正忙的时候也不能把第二个人叠上去。
    let car = null, idx = -1;
    for (let k = 0; k < cars.length; k++) {
      if (cars[k].crew && cars[k].crew.i === i) { car = cars[k]; idx = k; break; }
    }
    if (!car || car.owner !== null) return -1;
    net.lanePoint(car.e, Math.min(1, Math.max(0, car.t)), car.dir, LANE_OFF, P);
    // 车停在车主家附近；这一趟若从很远的岗位出发，等于「车不在身边」，改步行
    const jump = Math.hypot(P.x - from.x, P.z - from.z);
    if (jump > CAR.CLAIM_RADIUS) return -1;
    car.claimJump = jump;
    const A = nearestNode(from.x, from.z), B = nearestNode(dest.x, dest.z);
    // 【路网不连通仍可认领】全城被压楼路段切成多块，BFS 到不了目的地时
    // 上轮的做法是车沿常规车流尽量靠近、人下车走完最后一截（实测 83/91
    // 能到达）。改成「规划不出路线就拒绝」后 24h 开车数从 91 掉到 5，
    // 等于把驾驶能力关掉了。现在保留认领，并让 pickNext 每个路口重试 BFS。
    const route = planRoute(A, B) || [];
    const first = route[0] || nearestEdge(from.x, from.z);
    // dir 决定行进方向；右侧通行由 lanePoint 统一右偏，绝不靠 dir 造逆行
    const forward = route.length ? nid(first.a) === nid(A) : true;
    car.dir = forward ? 1 : -1;
    car.e = first;
    // car.t 恒增代表「沿行进方向的进度」：dir>0 时 t 就是边的世界参数 u，
    // dir<0 时 lanePoint 用 u=1-t，故 t=1-u。把车放到离出发地最近的路段点。
    const ax = first.a.x, az = first.a.z;
    const ex = first.b.x - ax, ez = first.b.z - az;
    const eL2 = ex * ex + ez * ez || 1;
    const u = Math.max(0.02, Math.min(0.98,
      ((from.x - ax) * ex + (from.z - az) * ez) / eL2));
    car.t = forward ? u : 1 - u;
    car.route = route.slice(1);
    car.owner = i; car.lastOwner = i;
    // 车只能开到「离门牌最近的路网节点」，剩下的路是人下车自己走完的。
    // 旧版把 car.dest 直接设成楼内门牌坐标，车沿车道永远差十几米到不了，
    // 于是 21 辆车开一整天 arrivals 恒为 0，目标全超时。
    car.dest = { x: B ? B.x : dest.x, z: B ? B.z : dest.z };
    car.finalDest = { x: dest.x, z: dest.z };
    car.travelled = 0;
    car.driver = driver || null; car.parked = false; car.arrived = false;
    car.stalled = false; car.waitingRed = false; car.waitSec = 0;
    car.wait = 0; car.blocked = 0; car.travelled = 0;
    car.yielding = false; car.yieldWhy = ''; car.pedNear = 0;
    car.distToDest = Infinity; car.yaw = undefined; car.probeT = 0;
    return idx;
  }
  function release(i) {
    const car = carOf(i);
    if (!car) return false;
    car.owner = null; car.route = null; car.dest = null; car.driver = null;
    car.parked = true; car.arrived = false; car.vLast = 0;
    car.yielding = false; car.pedNear = 0; car.waitingRed = false;
    // 交规计时必须随认领关系一起清掉，否则上一任主人等过的红灯会带到下一任。
    car.wait = 0; car.waitSec = 0; car.blocked = 0; car.stalled = false;
    return true;
  }
  function available() {
    let n = 0;
    for (const c of cars) if (c.owner === null) n++;
    return n;
  }
  function carInfo(i) {
    const car = carOf(i);
    if (!car) return null;
    net.lanePoint(car.e, Math.min(1, Math.max(0, car.t)), car.dir, LANE_OFF, P);
    return {
      carIdx: cars.indexOf(car), x: P.x, z: P.z, yaw: car.yaw,
      speed: car.parked ? 0 : (car.vLast || 0),
      depth: car.depth || 0, waitingRed: car.waitingRed, waitSec: car.waitSec,
      yielding: car.yielding, yieldWhy: car.yieldWhy, pedNear: car.pedNear,
      leadGap: car.leadGap || 0, stalled: car.stalled, arrived: car.arrived,
      distToDest: car.distToDest,
      schoolZone: !!(car.driver && car.driver.schoolZone),
      limit: car.driver ? car.driver.limit : CAR.URBAN_LIMIT,
    };
  }

  /** 路口红绿灯相位：40 s 周期，沿道路方向做「绿波」。
   *  旧版相位按 node.i*7+node.j*11 随机错开，全城干道平均 30 m 一个节点、
   *  车速 8 m/s ⇒ 每 4 s 到路口、几乎必停，用户看到的「隔一会儿停一下」
   *  就是这么来的。现在：
   *    ① 只有真路口（度数 ≥3）才设信号灯，路段中间的采样点不设灯；
   *    ② 相位随沿路坐标线性推进，偏移 = 距离 / 限速，同向连续路口依次
   *       放行（标准绿波带），车按限速行驶能一路通过。 */
  function isRed(node, roadBit) {
    if (node.signal === undefined) {
      node.signal = (adj.get(nid(node)) || []).length >= 3;
    }
    if (!node.signal) return false;
    const ns = (roadBit & 2) || (roadBit & 8);
    const along = ns ? node.z : node.x;
    const offset = along / CAR.URBAN_LIMIT;
    const phase = ((clock ? clock.minute : 52) * 60 + offset) % CAR.RED_CYCLE;
    // [0,20) 南北红、东西绿；[18,20) 全红清空；[20,40) 东西红、南北绿
    return ns ? phase < CAR.GREEN_EW : phase >= CAR.RED_NS;
  }

  function pickNext(car, node) {
    const list = adj.get(nid(node)) || [];
    if (!list.length) return null;
    // 【认领车按真实路线走】路线是出发时在 roadnet 上 BFS 出来的边序列，
    // 到路口取下一跳；不用路线时才按「优先直行、不走回头路」随机选边。
    if (car.route && car.route.length) {
      const nx = car.route[0];
      if (list.includes(nx) && edgeClear(nx)) { car.route.shift(); return nx; }
      car.route = null;      // 路线断了（施工/压楼）：立刻重算，不许变自由行
    }
    // 【认领车不许自由行】路线走完 / 断掉（施工、压楼、BFS 不通）时，
    // 每到一个路口都重新 BFS 到目的地节点；重算不出来才按常规车流走。
    if ((!car.route || !car.route.length) && car.owner !== null && car.dest) {
      const B = nearestNode(car.dest.x, car.dest.z);
      const re = planRoute(node, B);
      if (re && re.length) {
        car.route = re.slice(1);
        const nx = re[0];
        if (list.includes(nx) && edgeClear(nx)) return nx;
      }
      car.route = null;
    }
    // 不走回头路：来路方向是世界坐标，掉头边（几乎原路返回）必须排除。
    // 旧版把 back 算出来后 `void back` 丢掉，死路口 28% 概率原地 U-turn。
    const fwd = car.e.a === node ? car.e.b : car.e.a;
    const usable0 = list.filter((e) => e !== car.e
      && !e.a.underBuilding && !e.b.underBuilding);
    if (!usable0.length) return car.e;      // 死路才原地掉头，绝不驶进楼格
    // 优先选不穿过可见建筑实体的路段；若整片都被楼压住，退回原集合，
    // 免得车在路口因为「无路可走」卡死。
    const clear = usable0.filter(edgeClear);
    const usable = clear.length ? clear : usable0;
    const inX = node.x - fwd.x, inZ = node.z - fwd.z;
    const inL = Math.hypot(inX, inZ) || 1;
    const noUTurn = usable.filter((e) => {
      const other = e.a === node ? e.b : e.a;
      const ox = other.x - node.x, oz = other.z - node.z;
      const oL = Math.hypot(ox, oz) || 1;
      return (ox * inX + oz * inZ) / (oL * inL) > -0.6;
    });
    const legal = noUTurn.length ? noUTurn : usable;
    const straight = legal.filter((e) => {
      const other = e.a === node ? e.b : e.a;
      const vx = other.i - node.i, vz = other.j - node.j;
      const bx = fwd.i - node.i, bz = fwd.j - node.j;
      return vx * bx + vz * bz > 0;   // 继续背离来路
    });
    const pool = straight.length && rand() > 0.28 ? straight : legal;
    return pool[Math.floor(rand() * pool.length)];
  }

  /** 目标路段入口附近是否已有车（按里程判，8 m 内算占用）。
   *  car.t 恒增代表「沿行进方向的进度」，入口恒在 t=0，与 dir 无关。 */
  function entryBusy(edge, dir, meters) {
    const L = Math.hypot(edge.b.x - edge.a.x, edge.b.z - edge.a.z) || 1;
    for (const c of cars) {
      if (c.e !== edge || c.dir !== dir) continue;
      if (c.t * L < meters) return true;
    }
    return false;
  }

  function advance(simSec) {
    lastSimSec = simSec;
    if (simSec <= 0) return;
    // 【跟车】旧版每辆车按自己的速度往前推，同一条路上快车会直接穿进前车
    // （用户说的「车都撞在一起 / 叠着走」）。这里每帧按路段分桶，同一方向
    // 找最近的前车，按最小车距减速/停车。
    const byEdge = new Map();
    for (const car of cars) {
      let arr = byEdge.get(car.e);
      if (!arr) byEdge.set(car.e, arr = []);
      arr.push(car);
    }
    for (const car of cars) {
      // 【没人不许开】owner=null 的车一律停在车主车位上；只有真实居民坐进
      // 来（owner=居民 id）才推进。旧版 96 辆「背景车」无司机也满城绕圈，
      // 车成了装饰动画而不是代步工具。
      if (car.parked || car.owner === null || !car.crew) {
        car.vLast = 0; car.parked = true; continue;
      }
      car.waitingRed = false;
      // 到路口：判红灯，停 / 转下一条边
      // 【不硬闯】旧版用 car.wait < 3.2 兜底，而 car.wait 会被入口排队累加、
      // claim/release 又不重置，导致有的车等过 3.2 s 后**永久绕过红灯**。
      // 现在只按「这一个信号周期内已等多久」计，绿灯一到自然放行。
      if (car.t >= 1) {
        const node = car.dir > 0 ? car.e.b : car.e.a;
        if (isRed(node, car.e.bit) && car.waitSec < CAR.RED_CYCLE) {
          car.t = STOP_T + 0.13;
          car.waitingRed = true; car.waitSec += simSec;
          car.vLast = 0;
          continue;
        }
        car.waitSec = 0;
        const nx = pickNext(car, node);
        if (!nx) { car.t = 0; continue; }
        const ndir = nx.a === node ? 1 : -1;
        // 【入口排队】目标路段入口 8 m 内已经有车，就再等一帧，别一头撞上去。
        // 这里不再累加 car.wait / waitSec：排队不是等红灯，不能混进信号计时。
        if (entryBusy(nx, ndir, CAR.ENTRY_BUSY)) { car.t = 1; continue; }
        car.dir = ndir;
        car.e = nx;
        car.t = 0.02;
        continue;
      }
      // 接近路口且红灯：停在停止线前。
      // car.t 恒增代表「沿行进方向的进度」（dir<0 时 lanePoint 用 u=1-t 反向
      // 映射到世界坐标），所以 head 与停止线都与 dir 无关，旧版 head=1-t
      // 让反向车的停止线/让行/入口判定全部反过来。
      const head = car.t;
      if (head > STOP_T - 0.06) {
        const node = car.dir > 0 ? car.e.b : car.e.a;
        if (isRed(node, car.e.bit)) {
          car.t = Math.min(car.t, STOP_T);
          car.waitingRed = true; car.waitSec += simSec;
          car.vLast = 0;
          continue;
        }
      }
      const L = Math.hypot(car.e.b.x - car.e.a.x, car.e.b.z - car.e.a.z) || 1;
      // 积水里减速：和同一时刻的水深挂钩
      let v = car.speed;
      let dep = 0;
      if (o.depthAt) {
        net.lanePoint(car.e, Math.min(1, Math.max(0, car.t)), car.dir, LANE_OFF, P);
        // 【时间维】必须把「现在几点」传下去：不传的话 depthAt 只会读当前帧，
        // 而车的 update 走的是 CLOCK 的同一秒，跨帧瞬间会突然「水深归零」--
        dep = o.depthAt(P.x, P.z, clock ? clock.minute : undefined) || 0;
        if (dep > CAR.WET_DEPTH) v = Math.min(v, CAR.WET_LIMIT, v * CAR.WET_MUL);
        if (dep > CAR.STALL_DEPTH) {
          // 【别让车永远钉在水里】现实里司机会犹豫一下然后硬着头皮冲出去。
          // 犹豫 STALL_HESITATE 仿真秒后按 3 成速度爬行；只有接近 1 m
          // （车门都淹了）才是真的开不动。
          car.blocked = (car.blocked || 0) + simSec;
          if (dep > CAR.DROWN_DEPTH) v = 0;
          else v = car.blocked > CAR.STALL_HESITATE
            ? Math.max(CAR.MIN_CREEP, car.speed * CAR.CREEP_MUL) : 0;
        } else {
          car.blocked = 0;
        }
      }
      car.depth = dep;
      // ---- 双向耦合：车泡在水里也在改水流 ----
      // 慢速通过 = 像行人一样搅动（按车宽折算成几个人的等效）；
      // 彻底停住 = 熄火，压住这一格的雨水口，权重更高。
      if (fb) {
        if (v === 0 && dep > CAR.STALL_DEPTH) fb.stall(P.x, P.z, dep, simSec);
        else if (dep > 0.05) fb.wade(P.x, P.z, dep, simSec * 3);
      }
      // 跟车：同路段同方向，12 m 内开始收油，6.5 m 内停住。
      // car.t 对两个方向都恒增，前车恒为 t 更大的那一辆；旧版乘 car.dir
      // 让 dir=-1 的车把「后车」当成了前车。
      const lane = byEdge.get(car.e);
      let leadCar = null;
      if (lane && lane.length > 1) {
        for (const o2 of lane) {
          if (o2 === car || o2.dir !== car.dir) continue;
          const dt2 = o2.t - car.t;
          if (dt2 > 0 && (!leadCar || dt2 < leadCar.t - car.t)) leadCar = o2;
        }
        if (leadCar) {
          const gap = Math.abs(leadCar.t - car.t) * L;
          car.leadGap = gap;
          if (gap < CAR.FOLLOW_STOP_GAP) v = 0;
          else if (gap < CAR.FOLLOW_SLOW_GAP) {
            v = Math.min(v, Math.max(CAR.MIN_CREEP, (leadCar.vLast || 6) * 0.85));
          }
        }
      } else car.leadGap = 0;
      // ---- 外部前车（马克的车）避让 ----
      // 只认「正在行驶」的马克车：它停在楼门口时不能把整条路堵死。
      const ext = externalCar ? externalCar() : null;
      if (ext && Number.isFinite(ext.x) && Number.isFinite(ext.z)) {
        net.lanePoint(car.e, Math.min(1, Math.max(0, car.t)), car.dir, LANE_OFF, P);
        const dx = ext.x - P.x, dz = ext.z - P.z;
        const d = Math.hypot(dx, dz);
        const a = car.dir > 0 ? car.e.a : car.e.b;
        const b = car.dir > 0 ? car.e.b : car.e.a;
        const fl = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const ahead = (dx * (b.x - a.x) + dz * (b.z - a.z)) / fl;
        if (d < CAR.YIELD_DIST && ahead > -2) {
          if (d < CAR.YIELD_STOP) v = Math.min(v, CAR.MIN_CREEP);
          else v = Math.min(v, Math.max(CAR.MIN_CREEP, (d - 5.5) * 1.2));
        }
      }
      // ---- 交规硬约束：限速 / 学区 / 积水 / 行人优先 ----
      let limit = CAR.URBAN_LIMIT;
      if (car.driver) limit = Math.min(limit, car.driver.limit || CAR.URBAN_LIMIT);
      if (car.driver && car.driver.schoolZone) limit = Math.min(limit, CAR.SCHOOL_LIMIT);
      if (dep > CAR.WET_DEPTH) limit = Math.min(limit, CAR.WET_LIMIT);
      v = Math.min(v, limit);
      car.yielding = false;
      // 【所有车都让行人】旧版加了 `car.owner !== null`，于是 96 辆里只有被
      // 居民认领的少数几辆会查行人，其余背景车径直穿过斑马线上的人。
      if (pedProbe) {
        car.probeT -= simSec;
        // 【只在斑马线附近查人】让行判定要求 head > 0.62，路段中部查了也
        // 用不上；96 辆车全路段每 0.4 s 查一次全城行人网格，会把离线
        // 24h 验收拖慢一倍以上。这里按位置门控 + 降频到 0.6 s。
        if (head > 0.5) {
          if (car.probeT <= 0) {
            car.probeT = 0.6;
            net.lanePoint(car.e, Math.min(1, Math.max(0, car.t)), car.dir, LANE_OFF, P);
            car.pedNear = pedProbe(P.x, P.z, CAR.YIELD_DIST);
          }
        } else car.pedNear = 0;
        // 只在接近路口（斑马线）时让行，路段中部行人走人行道，不该互相干扰。
        if (car.pedNear > 0 && head > STOP_T - 0.24) {
          car.yielding = true;
          // 【礼让不等于急刹】旧版 pedNear>=3 直接 v=0，全城路网上路口密集，
          // 车一接近斑马线就被钉住，用户看到的「隔一会儿停一下」多半来自
          // 这里。现在一律低速通过；只有正前方极近的人由外部车避让兜底。
          v = Math.min(v, car.pedNear >= 3 ? CAR.MIN_CREEP : CAR.WET_LIMIT);
          car.yieldWhy = `斑马线 ${car.pedNear} 名行人，减速让行`;
        }
      } else car.pedNear = 0;
      car.stalled = dep > CAR.STALL_DEPTH && v === 0;
      car.travelled = (car.travelled || 0) + Math.max(0, v) * simSec;
      car.waitSec = 0;   // 只有真在等灯的子步才累加，绿灯放行后归零
      // ---- 到达：认领车抵达真实门牌附近，停住交给 goal 判完成 ----
      if (car.owner !== null && car.dest) {
        net.lanePoint(car.e, Math.min(1, Math.max(0, car.t)), car.dir, LANE_OFF, P);
        car.distToDest = Math.hypot(P.x - car.dest.x, P.z - car.dest.z);
        if (car.distToDest < CAR.ARRIVE_R && (!car.route || car.route.length === 0)
          && (car.travelled || 0) > 10) {
          car.arrived = true;
          car.parked = true;
          v = 0;
        }
      }
      car.vLast = v;
      let nt = car.t + v * simSec / L;
      // 【位置硬约束】只按速度收敛还不够：红灯前所有车都会被夹到同一条停止线，
      // t 完全重合（实测最小车距 0.39 m）。这里直接按「前车里程 - 6.5 m」夹住。
      // 前车 t 恒更大，与 dir 无关；并且 t 必须夹在 [0,1]，否则 lanePoint
      // 会把车放到边的延长线外（旧版 t>1 可存在一帧，实测 30 分钟内有 29 车次）。
      if (leadCar) {
        const limitT = leadCar.t - CAR.FOLLOW_STOP_GAP / L;
        if (nt > limitT) { nt = limitT; car.vLast = 0; }
      }
      car.t = Math.max(0, Math.min(1, nt));
    }
  }

  let lastSimSec = 0;          // advance 传进来的仿真秒，sync 做转角限速要用

  function sync() {
    const idx = {};
    for (const k of kinds) idx[k] = 0;
    for (const car of cars) {
      const e = car.e;
      // 停放的车贴路缘，不占着车道中心像违停；行驶车仍在右侧车道中心。
      const off = car.parked ? CAR.PARK_OFF : LANE_OFF;
      net.lanePoint(e, Math.min(1, Math.max(0, car.t)), car.dir, off, P);
      const b = car.dir > 0 ? e.b : e.a;
      const a = car.dir > 0 ? e.a : e.b;
      const want = Math.atan2(b.x - a.x, b.z - a.z) + (CAR_YAW[car.kind] || 0);
      // 【转角限速】换边时新边可能与旧边垂直，yaw 一步跳 90° —— 位置是连续的
      // （车道偏移已在路口 taper 到 0），但车头瞬转会让人以为「车横着滑过去」。
      // 现实里打方向有速度上限，这里按 2.6 rad/s × 仿真秒数夹住，转弯就成了
      // 一个持续几帧的过程。
      if (car.yaw === undefined) car.yaw = want;
      let d = want - car.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const maxTurn = CAR.TURN_RATE * Math.max(1e-3, Math.min(lastSimSec, 0.5));
      car.yaw += Math.max(-maxTurn, Math.min(maxTurn, d));
      Q.setFromAxisAngle(UP, car.yaw);
      P.y += 0.02;
      M.compose(P, Q, ONE);
      for (let p = 0; p < buckets[car.kind].length; p++) {
        const im = buckets[car.kind][p];
        const i = idx[car.kind];
        if (i < im.count) im.setMatrixAt(i, M);
      }
      idx[car.kind]++;
    }
    for (const k of kinds) for (const im of buckets[k]) im.instanceMatrix.needsUpdate = true;
  }

  sync();
  console.info(`[traffic] ${cars.length} 辆车 / ${net.edges.length} 条路段，随城市时钟行驶`
    + `（限速 ${kmh(CAR.URBAN_LIMIT).toFixed(0)} km/h · 右侧通行 · 红灯 ${CAR.RED_CYCLE}s 周期）`);
  return {
    group, cars,
    update(simSec) { advance(simSec); sync(); },
    advance,
    sync,
    // ---- 居民驾车接口（drive-layer 用）----
    claim, release, available, carInfo, setPedProbe,
    bindCrews, crewStats,
    /** 这个人家里有没有配到车（drive-layer 的出行方式抉择要用）。 */
    hasCrewCar: (i) => cars.some((c) => c.crew && c.crew.i === i),
    carOf: (i) => carOf(i),
    claimed: () => cars.filter((c) => c.owner !== null).length,
    speedTruth: { urban: CAR.URBAN_LIMIT, school: CAR.SCHOOL_LIMIT,
      wet: CAR.WET_LIMIT, laneOff: CAR.LANE_OFF },
    /** FLOOD 在路网之后才建，回写口只能晚绑定（早期版本在 createTraffic 里
     *  取 o.feedback，那时 FLOOD 还是 null，整条耦合静默失效）。 */
    setFeedback(f) { fb = f || null; },
    /** 晚绑定外部前车（马克的车）：仅行驶中才参与跟车，停着不堵路。 */
    setExternalCar(fn) { externalCar = fn || null; },
    /** SOLIDS 装配完成后调用：清缓存，并把已经出生在压楼路段上的车迁走。 */
    setSolids(s) {
      solids = s || null;
      clearCache.clear();
      if (!solids) return;
      const ok = net.edges.filter((e) => !e.a.underBuilding
        && !e.b.underBuilding && edgeClear(e));
      if (!ok.length) return;
      let moved = 0;
      for (const c of cars) {
        if (edgeClear(c.e)) continue;
        c.e = ok[Math.floor(rand() * ok.length)];
        c.t = rand();
        c.yaw = undefined;
        moved++;
      }
      if (moved) console.info(`[traffic] ${moved} 辆车从压楼路段迁到可行驶路段`);
      sync();
    },
    stats: { count: cars.length, edges: net.edges.length, junctions: net.junctions.length },
  };
}
