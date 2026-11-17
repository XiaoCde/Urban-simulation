/**
 * 马克在主场景里的「实时个体仿真」控制器。
 *
 * 这一段是把 _legacy/src/office-main.js 的单人 demo 迁进全城页：
 *   - 故事引擎用 web/src/mark-story.js（OfficeStory 原样搬过来，只换 import 路径）
 *   - 人物不再是 walknet 上随机走的第 0 个人，而是由 story 每一帧给出真实位置、
 *     楼层、状态、理由、决策；ped.js 里对他的常规更新被 setHeroStep 接管
 *   - 办公楼 / 家 / 停车场 / 车 / 雨伞都是同一套世界坐标，不需要任何偏移
 *
 * 时钟说明：story.tMin 是「17 点后的分钟数」，52 → 17:52，95 → 18:35。
 * 主场景的积涝时间轴是另一套基准（0~360 min 的降雨情景），不强行对齐；
 * 马克用自己的时钟按真实 dt * speed 推进，拖 HUD 滑块可 seek 到任意时刻，
 * 每次 seek 都是从 17:52 重新跑一遍 0.25 s 固定子步的确定性重放。
 */
import { dayThink, DAY_THINK_STEP } from './day-think.js';
import { ANIM } from './motion-units.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OFFICE } from './office-building.js';
import { HOME } from './home-building.js';
import { PROFILES } from './decision.js';
import {
  OfficeStory, STATE_TEXT, OFFICE_STORY_START_MIN, OFFICE_STORY_END_MIN,
} from './mark-story.js';
import { buildStreetGraph, snapPolyline, polylineLength } from './street-route.js';
import { dayClockText, toDayMin, STORY_OFFSET } from './clock.js';
import { scheduleFor, inCrisis } from './day-schedule.js';
// 【2026-11-07】24h 走位改由 day-motion 的连续轨迹求解：旧 applyDay 把人
// position.set 到一个固定锚点却播 walk，就是用户说的「原地跑呀跑」；
// 且旧版没读 inBuilding，半夜把马克摆在公寓楼外的人行道上。

const IN_CAR = ['driving', 'carblocked', 'parking'];
const LOOK_STATES = ['notice', 'window', 'observing', 'blocked', 'arrive'];
const UMBRELLA_AT = 59.8;          // packing 那一拍：回工位收电脑、取伞

/** 17 点后的分钟数 → 17:52:00 这样的墙钟文本。 */
export function clockText(t) {
  const total = 17 * 3600 + Math.round(t * 60);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** 代码生成的雨伞：半球伞面 + 细杆，尺寸小、必可见。 */
function makeUmbrella(color, opened) {
  const g = new THREE.Group();
  const cloth = new THREE.MeshStandardMaterial({
    color, roughness: 0.82, metalness: 0, side: THREE.DoubleSide,
    emissive: new THREE.Color(color).multiplyScalar(0.22),
  });
  const metal = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.55 });
  if (opened) {
    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(0.66, 12, 5, 0, Math.PI * 2, 0, Math.PI * 0.46),
      new THREE.MeshStandardMaterial({
        color, roughness: 0.82, metalness: 0, side: THREE.DoubleSide,
        flatShading: true, emissive: new THREE.Color(color).multiplyScalar(0.22),
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

function fitCar(src, x, z, rot, groundY) {
  const obj = src.scene.clone(true);
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  obj.scale.setScalar(4.55 / Math.max(size.z, size.x));
  obj.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(obj);
  const yOffset = -b2.min.y + 0.02;
  obj.position.set(x, groundY + yOffset, z);
  obj.rotation.y = rot;
  const wheels = {};
  obj.traverse((o) => {
    const n = (o.name || '').toLowerCase();
    if (!n.includes('wheel')) return;
    const front = n.includes('front'), left = n.includes('left');
    wheels[front ? (left ? 'fl' : 'fr') : (left ? 'bl' : 'br')] = o;
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  obj.userData.wheels = wheels;
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { obj, yOffset, wheels };
}

/**
 * @param {object} o
 *   world    场景根 Group
 *   office   buildOfficeBuilding() 的返回
 *   home     buildHomeBuilding() 的返回
 *   lot      buildParkingLot() 的返回（已 add 到 world）
 *   groundAt 步行图的地面高程函数
 *   flood    FLOOD（可为 null；只为 story 提供水深感知）
 *   ped      buildPedestrians() 的返回
 *   qs       URLSearchParams
 */
export async function createMark(o) {
  const {
    world, office, home, lot, groundAt, flood, ped, qs, camera, controls, clock, roadnet,
    dayMotion = null, solids = null, collide = null,
  } = o;
  const heroPed = ped.peds[0];
  if (!heroPed || !heroPed.hero) throw new Error('第 0 个行人不是马克高模');

  const loader = new GLTFLoader();
  const [sedan, suv] = await Promise.all([
    loader.loadAsync('/assets/props/car_sedan.glb'),
    loader.loadAsync('/assets/props/car_suv.glb'),
  ]);
  const routes = await fetch('/assets/ped/home_route.json').then((r) => r.json());

  // ---------- 0) 把旧街心线重投影到当前瓦片路网 ----------
  // 【为什么必须做】home_route.json 来自 data/streets/dc_streets.json 的 OSM
  // 街心线；地上铺的却是 roadnet 的规整棋盘瓦片。两套几何相位差几米到二十米，
  // 于是马克沿着旧线走的时候会切过人行道和花坛 —— 用户 2026-11-06 看到的就是
  // 「马克横贯草地直接就走了」。人（日程）早就改成沿 roadnet 走 Dijkstra 了，
  // 只有马克这一条还是旧线，所以单点修这里就够。
  if (roadnet && roadnet.nodes) {
    try {
      const G = buildStreetGraph(roadnet);
      const surf = (x, z) => (roadnet.surfaceY ? roadnet.surfaceY(x, z) : groundAt(x, z));
      const rep = {};
      for (const k of ['route_home', 'route_detour', 'route_drive', 'route_drive_detour']) {
        const raw = routes[k];
        if (!Array.isArray(raw) || raw.length < 3) continue;
        const before = polylineLength(raw);
        // 【2026-11-07】两条 detour 用旧折线中点当 via 节点，保证绕行线和主线
        // 真的不同，而不是最短路算出来同一条。中间所有点都是路网节点，
        // 只有首尾留了「门口 → 路边」的垂直短线。
        const after = snapPolyline(raw, G, surf, {
          maxSnap: 120,
          viaFromPolyline: k.endsWith('detour'),
        });
        // 长度暴涨说明路网把这条路绕成了圈，宁可退回旧线
        if (after.length < 3 || polylineLength(after) > before * 2.2) continue;
        routes[k] = after;
        rep[k] = `${after.length} 点 / ${Math.round(polylineLength(after))} m（原 ${Math.round(before)} m）`;
      }
      console.info('[mark] 路线已重投影到瓦片路网：', JSON.stringify(rep));
    } catch (e) {
      console.warn('[mark] 路线重投影失败，保留旧街心线：', e && e.message);
    }
  }

  // ---------- 1) 停车场里的车：马克自己那辆 + 周边 + 公寓门口 ----------
  const south = (lot?.stalls || []).filter((s) => s.face > 0).sort((a, b) => b.x - a.x);
  const myStall = south[0] || { x: 2541.6, z: 385.2 };
  const parkY = lot ? lot.groundY : groundAt(myStall.x, myStall.z);
  const markCar = fitCar(sedan, myStall.x, myStall.z, Math.PI, parkY);
  world.add(markCar.obj);

  const others = (lot?.stalls || []).filter((s) => !(
    Math.abs(s.x - myStall.x) < 0.1 && Math.abs(s.z - myStall.z) < 0.1));
  const picks = [0, 3, 7, 12, 18, 23].map((i) => others[i]).filter(Boolean);
  const extras = picks.map((s, i) => fitCar(
    i % 2 ? suv : sedan, s.x, s.z, s.face > 0 ? Math.PI : 0, parkY));
  const homeZ = HOME.cz - HOME.depth / 2 - 9.0;
  extras.push(fitCar(sedan, HOME.entryX - 12, homeZ, Math.PI, groundAt(HOME.entryX - 12, homeZ)));
  extras.push(fitCar(suv, HOME.entryX + 9, homeZ, Math.PI, groundAt(HOME.entryX + 9, homeZ)));
  for (const c of extras) world.add(c.obj);

  // ---------- 2) 雨伞：撑开 / 收起（代码生成，和 6 个角色同一套做法） ----------
  // glb 版伞的几何 drawRange.count 是 null、材质带透射，实测画不出来；
  // 这里是主角，必须一眼看到，所以自己搭。
  const umOpen = makeUmbrella(0x7d9ec4, true);
  const umClosed = makeUmbrella(0x7d9ec4, false);
  for (const u of [umOpen, umClosed]) {
    u.visible = false;
    world.add(u);
  }

  // ---------- 3) 故事引擎 ----------
  const story = new OfficeStory({
    office: { ...OFFICE, ...office },
    home: { ...HOME, ...home, name: HOME.name },
    routes,
    // 主场景积涝叠层默认关闭；打开时让马克「看见脚下的水」。
    // 【时间维】story.tMin 是「17 点后的分钟数」，flood.depthAt 的第三个参数
    // 是「一天分钟」，必须 +STORY_OFFSET 换算 —— 直接把 52 当一天分钟会落到
    // 凌晨 00:52 的干燥帧上，马克会以为全场没水，一路走进深水。
    depthAt: (x, z, t) => {
      if (!flood || !flood.depthAt || (flood.group && !flood.group.visible)) return 0;
      return flood.depthAt(x, z, (t === undefined || t === null) ? undefined : toDayMin(t)) || 0;
    },
    groundAt,
    seed: 33,
    // 和旧 demo 一样可以换性格权重：?markprofile=cautious / bold
    // 不同档案在「开车还是步行」「绕行还是弃车」会做出不同选择，路线也就不同。
    profile: PROFILES[({
      mark: 'mark', cautious: 'markCautious', bold: 'markBold',
    })[qs.get('markprofile')] || 'mark'] || PROFILES.mark,
  });

  let speed = Math.max(0.25, Number(qs.get('markspeed')) || 6);
  let playing = !qs.has('markpause');
  let focus = false;
  // 全城机位的最小距离是 12 m（防止镜头钻进地形），跟拍马克时会被 OrbitControls
  // 强行推到 12 m 外 —— 在公寓大堂里就是一头撞进内墙。选中时临时放开。
  const cityMinDistance = controls ? controls.minDistance : 12;
  let lastEventN = 0;
  let carPrev = new THREE.Vector3();
  let carSpin = 0;
  let lastHeroClip = null;

  const atHome = () => {
    const p = story.position;
    return Math.abs(p.x - HOME.cx) <= HOME.width / 2 + 0.6
      && Math.abs(p.z - HOME.cz) <= HOME.depth / 2 + 0.6;
  };

  // ---------- 24 小时连续轨迹（暴雨窗口之外）----------
  // 【2026-11-07 重写】旧版 applyDay 每帧把人 position.set 到一个固定锚点，
  // 却播 walk 循环 —— 用户看到的「出去买早餐就在原地跑呀跑」。而且它无条件
  // p.obj.visible=true、把人摆在 placeSpot('home')（公寓楼**外**的人行道），
  // 于是「大半夜的马克在外面，不在家里边」。
  // 现在位置/朝向/动作/室内外全部来自 day-motion 的时刻纯函数。
  let day = null;
  let lastThinkMin = -999;      // 日常决策节流（一天分钟）
  let inDayMode = true;
  let liveBound = false;          // true 后只读全城实时行人状态，旧轨迹不再驱动
  const parkPos = { x: myStall.x, y: parkY, z: myStall.z };
  let carIsOut = false;

  /** 车落地前的统一实体约束。
   *  轨迹层已经做过避障寻路，但暴雨窗口（story 引擎接管）走的是另一套旧街心
   *  线；这里对两个来源一视同仁：只要车的中心落在可见建筑实体内，就推到楼外。
   *  用户 2026-11-08：「车会直接穿过楼……连着穿过了两个楼」。 */
  function placeCar(x, z, heading, y = null) {
    let cx = x, cz = z;
    if (solids && solids.hit(cx, cz, 1.6)) {
      const s = solids.snapOut(cx, cz, 2.4);
      if (s.clear) { cx = s.x; cz = s.z; }
    }
    const gy = Number.isFinite(y) ? y : groundAt(cx, cz);
    markCar.obj.position.set(cx, gy + markCar.yOffset, cz);
    markCar.obj.rotation.y = heading;
  }

  function applyDay(dt) {
    const q = day;
    if (!q || q.crisis) return;
    const p = heroPed;
    // 车的位置由独立的地面轨迹给出（人/车已分流）
    const car = dayMotion && dayMotion.carAt ? dayMotion.carAt(q.minute, 'mark') : null;
    // 【跟拍视点也要切到车】人在车里是隐藏的，但 focusCamera / followEye /
    // main.js 的跟拍 lerp / HUD 全都读 q.x/y/z。若继续给人路径，07:40 的
    // 相机会沿 9F→电梯井→6F 垂直飞，车却在地面街上，画面完全脱节。
    if (q.inVehicle && car) {
      q.x = car.x; q.y = car.y; q.z = car.z; q.heading = car.heading;
      q.indoor = false; q.floor = 1; q.place = 'street';
      q.placeName = '通勤路上';
    }
    // 深夜在 9F 主卧、上午在 6F 工位、12:30 真的走到咖啡馆 —— 位置是剧本给的
    p.obj.visible = !q.inVehicle;
    p.obj.position.set(q.x, q.y + p.footFix, q.z);
    p.obj.rotation.y = q.heading;
    // clip 由「这一刻有没有位移」决定；站定绝不播 walk/run
    if (q.clip !== lastHeroClip) {
      ped.playFor(p, q.clip, 0.25);
      p.mixer.update(0.3);      // 淡入走完，暂停时也不是 T-pose
      lastHeroClip = q.clip;
    }
    // dt 已经是乘过倍率的仿真秒；动画只吃这一个时间，不再二次乘 clock.speed。
    if (dt > 0) p.mixer.update(Math.min(ANIM.animDt(dt), 0.1));

    // 【人/车分流】车读上面算出的独立地面轨迹：段首停在出发楼车库口，
    // 街面那一截沿避障路网走，段尾停在目标楼车库口。绝不再把车摆到
    // 人的路线（含 9F 房间与电梯井垂直段）上。
    if (car && car.active) {
      placeCar(car.x, car.z, car.heading);
      carIsOut = true;
    } else if (carIsOut) {
      placeCar(parkPos.x, parkPos.z, Math.PI);
      carIsOut = false;
    }

    // 【日程里也要「想」】暴雨窗口之外，马克每 25 分钟也用同一套 Brain
    // 权衡一次「按计划 / 抄近道 / 先停一下」，写进 story.decisions（面板同源）。
    if (story.brain) {
      const dm = clock ? clock.minute : 0;
      // 用绝对差：拖时间轴往回拨时也必须能重新想，否则一次前进就把节流锁死
      if (Math.abs(dm - lastThinkMin) >= DAY_THINK_STEP) {
        lastThinkMin = dm;
        const rec = dayThink(story.brain, q, dm, q.activity || q.spot, 'mark');
        if (rec) {
          story.decisions.push(rec);
          if (story.decisions.length > 40) story.decisions.shift();
        }
      }
    }
    // 伞只在室外、降雨、且人在路上时撑；卧室 / 工位 / 车里都不该有伞
    const outdoors = !q.indoor && !q.inVehicle;
    const raining = !!(clock && clock.raining) || !!(flood && flood.raining);
    if (umOpen) {
      umOpen.visible = outdoors && raining && q.moving;
      if (umOpen.visible) {
        umOpen.position.set(q.x, q.y + 1.02, q.z);
        umOpen.rotation.set(0, q.heading, 0);
      }
    }
    if (umClosed) {
      umClosed.visible = outdoors && raining && !q.moving;
      if (umClosed.visible) {
        umClosed.position.set(q.x + Math.cos(q.heading) * 0.30, q.y + 0.52,
          q.z - Math.sin(q.heading) * 0.30);
        umClosed.rotation.set(0.16, q.heading, 0.22);
      }
    }
    // 剖切由 main.js 按「此刻谁在室内」统一管，这里不再每帧关掉它
  }

  /** 只在「点选了马克 + 他在楼里」时剖开楼层，否则从街上看整栋楼是完整的。 */
  function applyFocus() {
    const f = story.floor;
    const cut = focus && f > 1;
    const homeSide = atHome() || story.pathName === 'apartment';
    if (cut && homeSide) {
      home.setActiveFloor(f); home.setCutaway(true);
      office.setActiveFloor(null); office.setCutaway(false);
    } else if (cut) {
      office.setActiveFloor(f); office.setCutaway(true);
      home.setActiveFloor(null); home.setCutaway(false);
    } else {
      office.setActiveFloor(null); office.setCutaway(false);
      home.setActiveFloor(null); home.setCutaway(false);
    }
  }

  /** story 的事件流写回 p.decisions，让已有的决策面板/列表直接显示。 */
  function syncEvents() {
    const ev = story.events;
    if (ev.length < lastEventN) lastEventN = 0;      // reset 过
    for (let i = lastEventN; i < ev.length; i++) {
      const e = ev[i];
      const d = {
        i: heroPed.i, who: '马克', kind: e.type, text: e.title,
        detail: e.detail, depth: story.depth, t: Math.round(e.t * 60),
        // 浮点尾数会直接印到决策流里（实测 -338.7999999999995）
        at: [+story.position.x.toFixed(0), +story.position.z.toFixed(0)],
      };
      heroPed.decisions.push(d);
      if (heroPed.decisions.length > 8) heroPed.decisions.shift();
      heroPed.decision = d;
    }
    lastEventN = ev.length;
  }

  function apply(dt) {
    // 24h：暴雨窗口之外由日程层接管（真实位置 + 动作 + 心理），
    // 窗口内仍是 story + Brain 的实时决策，两者不互相覆盖。
    const dmNow = clock ? clock.minute : toDayMin(OFFICE_STORY_START_MIN);
    const wetHere = (flood && flood.depthAt && (!flood.group || flood.group.visible))
      ? (flood.depthAt(heroPed.obj.position.x, heroPed.obj.position.z) || 0) : 0;
    if (inCrisis(dmNow)) day = null;
    else if (dayMotion) day = dayMotion.at('mark', dmNow);
    else {
      // 没有轨迹层的降级路径：兼容旧 scheduleFor 的字段，保证页面仍能用
      const s = scheduleFor('mark', dmNow, wetHere);
      day = s ? {
        ...s, y: groundAt(s.x, s.z), heading: 0, moving: false, crisis: false,
        inVehicle: false, indoor: !!s.inBuilding, clip: s.clip || 'idle',
      } : null;
    }
    if (day) { applyDay(dt); return; }
    const s = story.state;
    const inCar = IN_CAR.includes(s);
    const p = heroPed;

    // 【避险结局不能钉死】18:10–18:35 故事 beats 已走完，7 人坐标逐帧相同、
    // clip 全是 idle（实测三帧一模一样）。与 people.js 同一口径加小幅往返：
    // 只有位移相位播 walk，停下就回待机。
    const shelterIdle = dmNow >= 1090 && dmNow <= 1115 && !inCar;
    let vx = story.position.x, vz = story.position.z, vHeading = story.heading;
    let shelterMoving = false;
    if (shelterIdle) {
      const ph = (dmNow - 1090) / 25, ang = 1.13;
      const wave = ph * Math.PI * 4 + ang;
      const osc = Math.sin(wave), v = Math.cos(wave);
      vx += Math.cos(ang) * 1.7 * osc;
      vz += Math.sin(ang) * 1.7 * osc;
      shelterMoving = Math.abs(v) > 0.42;
      if (shelterMoving) vHeading = Math.atan2(Math.cos(ang) * v, Math.sin(ang) * v);
      if (collide && collide.blockedCircle(vx, vz, 0.34,
        story.position.y + 0.1, story.position.y + 1.7,
        { ignoreTags: new Set(['building', 'tree']) })) {
        vx = story.position.x; vz = story.position.z;
        shelterMoving = false; vHeading = story.heading;
      }
    }

    // 位置：story.position 是「脚底」的世界高程；ped.js 的模板脚底有偏移，补上。
    if (s === 'boarding') {
      p.obj.position.set(markCar.obj.position.x - 1.55,
        story.position.y + p.footFix, markCar.obj.position.z + 0.15);
      p.obj.rotation.y = -Math.PI / 2;
    } else {
      p.obj.position.set(vx, story.position.y + p.footFix, vz);
      p.obj.rotation.y = vHeading;
    }
    p.obj.visible = !inCar;

    // 车：只在开车的三个状态跟着跑，其余时间停在自己车位 / 最后停下的地方
    if (inCar) {
      const moved = carPrev.distanceTo(story.position);
      if (moved > 0.001 && moved < 6) {
        carSpin += moved / 0.32;
        for (const k of ['fl', 'fr', 'bl', 'br']) {
          if (markCar.wheels[k]) markCar.wheels[k].rotateX(moved / 0.32);
        }
      }
      carPrev.copy(story.position);
      // 暴雨窗口用的是旧街心线，同样要过实体约束，不能借着「故事引擎接管」
      // 就从楼里穿过去。
      placeCar(story.position.x, story.position.z, story.heading, story.position.y);
    }

    // 动作：按真实速度选，不按状态名硬套（与 demo 的 updateAnimation 同口径）
    let clip = 'idle';
    if (inCar) clip = 'sit';
    else if (story.speed > 0.25 && story.path.length) {
      const wp = story.path[story.pathIndex];
      clip = (wp && wp.kind === 'stairs') ? 'stairs_down'
        : (story.speed > 2.2 ? 'run' : 'walk');
    } else if (s === 'working') clip = 'sit';
    else if (LOOK_STATES.includes(s)) clip = 'look';
    else if (s === 'wading' || s === 'outdoor') clip = 'walk';
    if (shelterMoving) clip = 'walk';
    // 只在动作切换时播，并立刻 update 一次让姿势落地。
    // 暂停（simSec=0）时 mixer 不再推进，不这一下马克会一直保持 T-pose。
    if (clip !== lastHeroClip) {
      ped.playFor(p, clip, 0.25);
      // ped.js 初始化时是 fadeIn(0.01).play()，而马克的常规 update 被
      // heroStep 跳过了 ——  mixer 从没推进过，权重还停在接近 0，人就是 T-pose。
      // 切动作时一次推进 0.3 s 让淡入走完、姿势落地；之后暂停也不会退回绑定姿势。
      p.mixer.update(0.3);
      lastHeroClip = clip;
    }
    // 【速度一致性】旧版这里又乘一次 min(clock.speed,2)，而 main.js 传下来的
    // dt 早已含倍率 —— 同一帧位移走一遍、动画走两遍。现在统一成同一个仿真秒。
    if (dt > 0) p.mixer.update(Math.min(ANIM.animDt(dt), 0.1));

    // 雨伞：packing 之后他有伞，室外撑开、室内收起握在手里
    const hasUm = story.tMin >= UMBRELLA_AT;
    const outdoor = story.floor <= 1 && !inCar;
    if (umOpen) {
      umOpen.visible = hasUm && outdoor && !inCar;
      umOpen.position.set(story.position.x, story.position.y + 1.02, story.position.z);
      umOpen.rotation.set(0, story.heading, 0);
    }
    if (umClosed) {
      umClosed.visible = hasUm && !outdoor;
      umClosed.position.set(story.position.x + Math.cos(story.heading) * 0.30,
        story.position.y + 0.52, story.position.z - Math.sin(story.heading) * 0.30);
      umClosed.rotation.set(0.16, story.heading, 0.22);
    }

    applyFocus();
    syncEvents();
  }

  function seekAt(tMin) {
    const t = Math.max(OFFICE_STORY_START_MIN, Math.min(OFFICE_STORY_END_MIN, tMin));
    story.reset();
    const need = Math.max(0, (t - OFFICE_STORY_START_MIN) * 60);
    // 【子步重放】一次性推进 18 分钟会跳过全部 beat 直接落到结局，
    // 用户拖时间轴就看不到「停车进楼 / 开车绕路」这些真实判断了。
    const n = Math.max(1, Math.ceil(need / 2));
    for (let k = 0; k < n; k++) story.step(need / n);
    carPrev.copy(story.position);
    lastEventN = 0;
    heroPed.decisions.length = 0;
    apply(0);
  }

  /** 由城市统一时钟调用：推进故事（本帧的仿真秒）。
   *  【不能放在 update 里】update 是 ped.js 的 heroStep 回调，一帧只该摆位一次；
   *  时间推进必须只发生一次，否则马克会比别人快一倍。 */
  function advance(simSec) {
    const dm = clock ? clock.minute : toDayMin(OFFICE_STORY_START_MIN);
    if (!inCrisis(dm)) {
      inDayMode = true;
      // 【不能只靠 ped.js 的 heroStep】暂停 / 人数裁剪 / 无头手动推帧时它可能不跑，
      // 人就会停在上一分钟。轨迹是时刻的纯函数，这里每帧求一次，任何帧都在位。
      apply(0);
      return;
    }
    if (inDayMode) { seekAt(dm - STORY_OFFSET); inDayMode = false; }
    if (simSec > 0 && !story.finished) story.step(simSec);
  }

  /** 只把故事当前状态摆到 3D 里，不推时间。 */
  function update(dt) {
    if (!liveBound) apply(dt);
  }

  /**
   * 马克只是全城第 0 个实时居民。这里只把同一位置/目标同步给旧 HUD 与相机，
   * 不写人物位置、不推进 OfficeStory，杜绝“马克一套动画、市民另一套系统”。
   */
  function syncLive() {
    if (!liveBound) return;
    const q = ped.crowdLife ? ped.crowdLife.at(0) : null;
    const L = ped.live ? ped.live.debug(0) : null;
    if (!q) return;
    const clip = heroPed.cur ? String(heroPed.cur.getClip().name) : 'idle';
    // 屋内时以社会状态里的真实房间锚点为目标；行人代理在“不可见”时可能还
    // 停在楼门口，用它当机位目标会把相机放在楼外半米，永远进不了房间。
    const inRoom = !!q.indoor && Number.isFinite(q.x) && Number.isFinite(q.y);
    day = {
      ...q, minute: clock ? clock.minute : 0,
      x: inRoom ? q.x : heroPed.obj.position.x,
      y: inRoom ? q.y : heroPed.obj.position.y - heroPed.footFix,
      z: inRoom ? q.z : heroPed.obj.position.z, heading: heroPed.obj.rotation.y,
      clip, moving: /walk|run/i.test(clip) && heroPed.obj.visible,
      floor: q.indoor ? (q.place === 'home' ? 9 : 6) : 1,
      placeName: q.place === 'home' ? '自己的住所' : (q.place === 'office' ? '工作岗位' : '城市街面'),
      activity: L && L.goal ? L.goal.label : q.activity,
      label: L && L.goal ? L.goal.label : q.activity,
      note: (L && L.lastReason) || q.activity,
      inVehicle: false,
    };
    story.position.set(day.x, day.y, day.z);
    story.heading = day.heading;
  }

  function bindLive() { liveBound = true; syncLive(); }

  function hud() {
    // 一律对外显示「一天分钟」的墙钟；故事内部相对分钟只在 seek 时用。
    const absolute = clock ? clock.minute : toDayMin(story.tMin);
    const nowText = dayClockText(clock ? clock.minute : absolute);
    const winStart = toDayMin(OFFICE_STORY_START_MIN);
    const winEnd = toDayMin(OFFICE_STORY_END_MIN);
    if (day) {
      return {
        clock: nowText, tMin: absolute,
        state: 'schedule', stateText: day.activity || day.label,
        reason: day.note || day.activity || '', floor: day.floor || 1,
        x: day.x, y: day.y, z: day.z,
        speed: clock ? clock.speed : speed,
        playing: clock ? clock.playing : playing,
        finished: false, start: winStart, end: winEnd,
        events: 0, decisions: story.decisions.length, clip: day.clip,
        inHome: day.place === 'home', focused: focus,
        mood: day.mood, stress: day.stress,
        dayLabel: day.label, placeName: day.placeName || day.spot,
        indoor: day.indoor, moving: day.moving, kind: day.kind,
        inVehicle: day.inVehicle, sceneId: day.sceneId,
      };
    }
    return {
      clock: nowText, tMin: absolute,
      state: story.state, stateText: STATE_TEXT[story.state] || story.state,
      reason: story.reason, floor: story.floor,
      x: story.position.x, y: story.position.y, z: story.position.z,
      speed: clock ? clock.speed : speed,
      playing: clock ? clock.playing : playing,
      finished: story.finished || (clock ? clock.finished : false),
      start: winStart, end: winEnd,
      events: story.events.length, decisions: story.decisions.length,
      clip: heroPed.cur ? String(heroPed.cur.getClip().name) : '—',
      inHome: atHome(), focused: focus,
      mood: null, stress: null, dayLabel: '暴雨 · 实时决策', placeName: '',
    };
  }

  /** 选中马克时的近景机位。
   *  【不能用主场景那套 6 候选遮挡检测】它只 raycast 通用纸壳子 blocks，
   *  而精细楼是独立的 group；进了公寓大堂相机会直接贴到墙上。这里按人物
   *  自身朝向摆一个短距离机位，室内外都成立。 */
  function focusCamera() {
    if (!camera || !controls) return;
    // 中距离机位：人在画面中间，但周围街区还在视野里。
    // 贴到 3~4 m 会把用户「锁」在人身上，全城和周边建筑全看不见。
    const p = day ? { x: day.x, y: day.y, z: day.z } : story.position;
    const hd = day ? day.heading : story.heading;
    const dx = Math.sin(hd), dz = Math.cos(hd);
    // 【2026-11-07 修】室内跟拍原来也是「后退 12 m、抬高 7 m」，机位直接被推到
    // 楼外/楼板上方，整栋楼挡在镜头前什么也看不见（点人名只看到一堵墙）。
    // 人在室内就改成贴身的短片机位：后退 3.4 m、抬高 1.9 m，仍在同一层。
    const indoor = !!(day && day.indoor);
    const back = indoor ? 4.6 : 12;
    const side = indoor ? 1.5 : 4;
    const up = indoor ? 2.3 : 7;
    camera.position.set(p.x - dx * back - dz * side, p.y + up,
      p.z - dz * back + dx * side);
    controls.target.set(p.x, p.y + 1.1, p.z);
    // 【BUG 修复】OrbitControls 开着阻尼（dampingFactor 0.055）时，update() 会用
    // 内部的球坐标+残余角速度重算机位，把刚 set 的位置改回去 —— 实测室内机位
    // 明明算的是后退 3.4 m，更新完却还是 11.7 m（等于没改）。切机位这一下临时
    // 关掉阻尼，让位置真正落地。
    // 同时放宽 OrbitControls 的最小距离：默认 minDistance=12，室内 3.4 m 的
    // 机位会被它顶回 12 m（等于永远站在楼外），必须一起改。
    const hadDamp = controls.enableDamping;
    controls.enableDamping = false;
    if (indoor) controls.minDistance = 1.2;
    controls.update();
    // 不还原 minDistance：交给 main.js 的 updateIndoorCutaway 每帧统一裁定
    // （室内/跟拍 = 1.2，否则 12）。在这里还原会让「下一帧 controls.update()
    // 又把相机顶回 12 m」，室内机位永远站不住。
    controls.enableDamping = hadDamp;
  }

  /** 跟拍时相机该待的位置（main.js 每帧 lerp 过去，人走远也不会出画）。 */
  function followEye(out) {
    const p = day ? { x: day.x, y: day.y, z: day.z } : story.position;
    const hd = day ? day.heading : story.heading;
    const dx = Math.sin(hd), dz = Math.cos(hd);
    const indoor = !!(day && day.indoor);
    const back = indoor ? 4.6 : 12;
    const side = indoor ? 1.5 : 4;
    const up = indoor ? 2.3 : 7;
    return out.set(p.x - dx * back - dz * side, p.y + up,
      p.z - dz * back + dx * side);
  }

  // 时钟初值由 main.js 统一设定（?markt 现在语义是「一天分钟」）。
  // 这里只按当前时刻把故事或日程摆到位，绝不再抢改时钟 —— 全城只有一个现在。
  const dm0 = clock ? clock.minute : toDayMin(OFFICE_STORY_START_MIN);
  if (inCrisis(dm0)) { seekAt(dm0 - STORY_OFFSET); inDayMode = false; }
  else { inDayMode = true; apply(0); }

  return {
    story, car: markCar.obj, umbrellas: { open: umOpen, closed: umClosed },
    update, advance, hud, snapshot: () => story.snapshot(), clockText,
    bindLive, syncLive, focusCamera, followEye,
    indoorNow: () => !!(day && day.indoor),
    /** 城市时钟的 seek hook 调这个；对外想跳时刻请用 CLOCK.seek()。 */
    seekAt,
    seek: (m) => { if (clock) clock.seek(m); else seekAt(m); },
    setFocus: (on) => {
      focus = !!on;
      if (controls) controls.minDistance = focus ? 2.2 : cityMinDistance;
      if (liveBound) syncLive(); else apply(0);
    },
    setPlaying: (on) => { if (clock) clock.setPlaying(on); else playing = !!on; },
    setSpeed: (v) => { if (clock) clock.setSpeed(v); else speed = Math.max(0.25, Number(v) || 1); },
    get speed() { return clock ? clock.speed : speed; },
    get playing() { return clock ? clock.playing : playing; },
    start: toDayMin(OFFICE_STORY_START_MIN), end: toDayMin(OFFICE_STORY_END_MIN),
  };
}
