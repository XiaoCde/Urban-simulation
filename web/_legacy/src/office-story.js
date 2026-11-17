import * as THREE from 'three';
import { Brain, PROFILES } from './decision.js';

/**
 * 马克·詹森的单人故事与行为仿真。
 *
 * 三条硬约束：
 * 1) 他只使用已收到的信息和现场观察，不读取全场积水图，也不知道“最优路线”。
 * 2) 移动全部走真实路径：办公楼楼梯、街道、公寓电梯，没有瞬移。
 * 3) 人物时间和积水时间共用一个仿真时钟，固定步长 0.25 s，可复现。
 */

const START_MIN = 52;
const END_MIN = 95;
const WADE_LIMIT = 0.32;
const RUN_SPEED = 2.9;
const WALK_SPEED = 1.35;
const STAIR_SPEED = 0.78;
const LIFT_SPEED = 2.2;
const CAR_SPEED = 13.0;  // 约 47 km/h；暴雨里已经算快，但明显快过跑步
const CAR_WADE = 0.35;   // 轿车能硬过的水深上限

/**
 * 前段是“动作时间线”，不是逐帧动画脚本：每个节拍只决定他此刻在做什么、
 * 为什么这么做、以及持续多久。没有对应动画的动作（打电话、交接、取伞）
 * 由气泡与状态栏说明，时间照常计入。
 */
const BEATS = [
  {
    at: 54.0, state: 'notice', title: '手机推送洪水预警',
    reason: '他停下手里的报告看手机，先确认是不是全市范围',
    hold: 0.55,
    info: ['手机洪水预警', '国家气象局：强降雨还将持续约两小时，低洼路段可能快速积水'],
  },
  {
    at: 55.3, state: 'window', title: '起身走到窗边看雨',
    reason: '雨比刚才更密，但楼下路面还没有明显积水',
    hold: 0.8,
    // 6F 开放办公区的世界坐标：先走到过道，再往北到窗前
    errand: [[2464.2, 346.9], [2464.2, 340.9]],
  },
  {
    at: 56.7, state: 'calling', title: '给妻子打电话',
    reason: '确认她和孩子已经到家，让她不要出门买东西',
    hold: 1.2,
    // 在窗前一边打电话一边来回踱步
    errand: [[2463.0, 341.2], [2464.6, 340.7], [2463.4, 341.4]],
    info: ['家人电话', '妻子和孩子都在家；她说小区门口路面还没积水，只是雨很大'],
  },
  {
    at: 58.3, state: 'handover', title: '把手头项目交接给同事',
    reason: '明早要交的报告还没收尾，他先把未完成部分交给还在加班的同事',
    hold: 1.0,
    errand: [[2464.2, 346.6], [2470.2, 346.6], [2470.2, 345.8]],
  },
  {
    at: 59.8, state: 'packing', title: '回工位收电脑、拿伞',
    reason: '关掉显示器，把笔记本装进背包，从抽屉里取出折叠伞',
    hold: 1.1,
    errand: [[2470.2, 346.6], [2465.6, 346.6], [2463.6, 346.0]],
  },
  {
    at: 61.2, state: 'preparing', title: '拿车钥匙，准备开车回家',
    reason: '家在一公里外，他的第一反应是去地下车库取车',
    hold: 0.45,
    errand: [[2463.2, 345.2]],
  },
  {
    at: 61.5, state: 'indoor', title: '改走楼梯下楼',
    reason: '物业在群里通知电梯停运，只能走楼梯下到一层',
    motion: 'stairs', hold: 0,
  },
];

const STATE_TEXT = {
  working: '坐在工位整理报告',
  notice: '看手机预警',
  window: '在窗边观察雨势',
  calling: '给妻子打电话',
  handover: '向同事交接工作',
  packing: '收电脑、取伞',
  preparing: '拿车钥匙',
  indoor: '走楼梯下楼',
  outdoor: '走向路边的车',
  boarding: '上车、发动',
  driving: '开车回家',
  carblocked: '前方道路被淹，停车',
  parking: '靠边停车',
  observing: '在车库口判断',
  escape: '跑步回家',
  blocked: '被深水挡住',
  detour: '绕行',
  wading: '涉水通过',
  arrive: '进入公寓',
  elevator: '乘电梯上楼',
  home: '到家',
  shelter: '退回楼内',
  sheltered: '在楼内等待',
};

export class OfficeStory {
  constructor({ office, home, routes, depthAt, groundAt, seed = 33, profile = PROFILES.mark }) {
    this.office = office;
    this.home = home;
    this.routes = routes;
    this.depthAt = depthAt;
    this.groundAt = groundAt;
    this.seed = seed;
    this.profile = profile;
    // 同一个 seed 保证同一工况下“同一个人的同一次判断”可复现
    this.brain = new Brain({ profile, depthAt, seed: seed * 17 + 5 });
    this.reset();
  }

  // ---------------------------------------------------------------- 路径准备
  /** 折线直接用会“到点瞬间拐弯”，用 Catmull-Rom 重采样成连续曲线。 */
  smoothPath(points) {
    if (points.length < 4) return points;
    const curve = new THREE.CatmullRomCurve3(points.map((p) => p.p), false, 'catmullrom', 0.4);
    const total = curve.getLength();
    const n = Math.max(points.length, Math.round(total / 2.5));
    const out = [];
    for (let i = 0; i <= n; i += 1) {
      out.push({
        p: curve.getPoint(i / n), kind: points[0].kind, floor: points[0].floor,
        label: points[0].label,
      });
    }
    return out;
  }

  /** 靠左行驶：整条车行线沿左法线偏 3.2 m，首尾各 20 个点渐入渐出。 */
  leftBias(points, offset = 2.4) {
    if (points.length < 4) return points;
    const out = [];
    for (let i = 0; i < points.length; i += 1) {
      const a = points[Math.max(0, i - 1)].p;
      const b = points[Math.min(points.length - 1, i + 1)].p;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      const nx = dz / l;
      const nz = -dx / l;
      const taper = Math.min(1, Math.min(i, points.length - 1 - i) / 20);
      const off = offset * taper;
      out.push({
        ...points[i],
        p: new THREE.Vector3(points[i].p.x + nx * off, points[i].p.y, points[i].p.z + nz * off),
      });
    }
    return out;
  }

  pathFromRoute(key, firstLabel) {
    const raw = this.routes[key] || [];
    const base = raw.map(([x, y, z], i) => ({
      p: new THREE.Vector3(x, y, z),
      kind: 'road',
      floor: 1,
      label: firstLabel && i === 0 ? firstLabel : '沿街前进',
    }));
    // 车行线：先平滑成曲线，再整体靠左偏一个车道。
    if (key === 'route_drive' || key === 'route_drive_detour') {
      return this.leftBias(this.smoothPath(base));
    }
    return base;
  }

  pathFromIndoor() {
    return this.office.indoorRoute.map((wp) => ({
      p: wp.p.clone(), kind: wp.kind, floor: wp.floor, label: wp.label,
    }));
  }

  pathFromApartment() {
    return this.home.route.map((wp) => ({
      p: wp.p.clone(), kind: wp.kind, floor: wp.floor, label: wp.label,
    }));
  }

  /** 从当前位置接入一条室外路线的最近点，避免走回头路。 */
  joinNearestPath(path) {
    let best = 0; let bestD = Infinity;
    for (let i = 0; i < path.length; i += 1) {
      const d = path[i].p.distanceToSquared(this.position);
      if (d < bestD) { bestD = d; best = i; }
    }
    // 只在确实更近时裁掉前段，防止从半路开始跳过应走的路线。
    // 只允许 6 m 内接入，原来 20 m 会让人物直接“跳”到路线中段
    return best > 0 && bestD < 36 ? path.slice(best) : path;
  }

  reset() {
    this.tMin = START_MIN;
    this.state = 'working';
    this.reason = '报告还差最后一部分；窗外雨在变大，但他还没觉得需要离开';
    this.position = this.office.start.clone();
    this.heading = Math.PI;
    this.floor = 6;
    this.path = [];
    this.pathIndex = 0;
    this.pathName = null;
    this.beatIndex = 0;
    this.waitUntil = 0;
    this.liftStarted = false;
    this.depth = 0;
    this.stamina = 100;
    this.health = 100;
    this.reroutes = 0;
    this.events = [];
    this.trace = [];
    this.info = [];
    this.lastTraceSec = -Infinity;
    this.finished = false;
    this.travelled = 0;
    this.speed = 0;
    this.decisions = [];
    this.lastChoice = null;
    this.effectiveWade = null;
    this.lastPerceiveAt = -Infinity;
    if (this.brain) { this.brain.decisions.length = 0; this.brain.belief.cells.clear(); this.brain.belief.samples.length = 0; }
    this.logEvent('story', '开始个体追踪',
      '马克·詹森，36 岁，工程咨询公司项目职员；17:52 仍在 6F 工位整理项目报告');
    this.sampleDepth();
    this.recordTrace(true);
  }

  // ------------------------------------------------------------------ 记录
  logEvent(type, title, detail = '') {
    const last = this.events[this.events.length - 1];
    if (last && last.title === title && Math.abs(last.t - this.tMin) < 0.02) return;
    this.events.push({ t: this.tMin, type, title, detail });
  }

  receive(source, content) {
    this.info.push({ t: this.tMin, source, content });
    this.logEvent('information', `收到${source}`, content);
  }

  setState(state, reason, title = null) {
    if (this.state !== state) {
      this.state = state;
      this.logEvent('state', title || STATE_TEXT[state] || state, reason);
    }
    this.reason = reason;
  }

  // ------------------------------------------------------------------ 动作
  startMotion(name, state, reason, title) {
    if (name === 'stairs') this.path = this.joinNearestPath(this.pathFromIndoor());
    else if (name === 'apartment') this.path = this.pathFromApartment();
    else if (name === 'detour') this.path = this.joinNearestPath(this.pathFromRoute('route_detour'));
    else if (name === 'drive') this.path = this.joinNearestPath(this.pathFromRoute('route_drive'));
    else if (name === 'driveDetour') this.path = this.joinNearestPath(this.pathFromRoute('route_drive_detour'));
    else if (name === 'garage') this.path = this.joinNearestPath(this.pathFromRoute('route_park'));
    else if (name === 'walkHome') this.path = this.joinNearestPath(this.pathFromRoute('route_home'));
    else if (name === 'shelter') this.path = this.joinNearestPath(this.pathFromRoute('route_park').slice().reverse());
    else if (name === 'push') this.path = this.path.slice(this.pathIndex);
    else if (name === 'walkIn') {
      // 从车边走到公寓北门，再接入楼内路线；直接用 joinNearestPath 会跳到楼里的中点，看起来像原地转圈。
      const door = new THREE.Vector3(
        this.home.entryX, this.home.baseY, this.home.cz - this.home.depth / 2 - 1.2,
      );
      this.path = [this.position.clone(), door].map((p, i) => ({
        p, kind: 'walk', floor: 1, label: i === 0 ? '下车' : '走向公寓北门',
      })).concat(this.pathFromApartment());
    }
    else if (name === 'back') {
      // 从车库折返到办公楼门口，再接回家路线。
      const garage = this.pathFromRoute('route_garage').reverse();
      this.path = garage.concat(this.pathFromRoute('route_home'));
    } else this.path = this.joinNearestPath(this.pathFromRoute(name));
    this.pathName = name;
    this.pathIndex = 0;
    this.liftStarted = false;
    this.setState(state, reason, title);
  }

  onArrive(arrivedName = this.pathName) {
    if (arrivedName === 'walkIn') {
      this.finishAtHome();
      return;
    }
    if (arrivedName === 'walkHome') {
      // 步行到家门口，再走楼内路线上楼
      this.startMotion('walkIn', 'arrive', '走到公寓北门，进楼乘电梯', '进入公寓');
      return;
    }
    if (arrivedName === 'shelter') {
      this.finishShelter();
      return;
    }
    if (arrivedName === 'push') {
      this.startMotion('apartment', 'arrive', '已经趟过最深处，继续往公寓走', '穿过积水区');
      return;
    }
    if (arrivedName === 'errand') {
      this.waitUntil = this.tMin + (this.errandHold || 0.4);
      return;
    }
    if (arrivedName === 'stairs') {
      this.startMotion('garage', 'outdoor',
        '穿过大堂推门出去，车就停在楼前路边', '走出办公楼，走向自己的车');
    } else if (arrivedName === 'outdoor') {
      this.setState('boarding', '解锁、拉开车门坐进驾驶位，发动车子', '上车');
      this.waitUntil = this.tMin + 0.4;
    } else if (arrivedName === 'drive' || arrivedName === 'driveDetour') {
      this.setState('parking', '在公寓楼北侧靠边停车、熄火', '到达公寓楼下');
      this.waitUntil = this.tMin + 0.35;
    } else if (arrivedName === 'garage') {
      // 走到自己车边：上车、发动，然后才进入 driving。
      this.setState('boarding', '解锁、拉开车门坐进驾驶位，发动车子', '上车');
      this.waitUntil = this.tMin + 0.4;
    } else if (arrivedName === 'back') {
      this.startMotion('detour', 'detour',
        '沿北侧高一点的街道绕行，避开刚才那片深水', '改道绕行');
    } else if (arrivedName === 'detour') {
      this.startMotion('apartment', 'arrive',
        '绕过深水后回到 6th St，公寓就在前面', '抵达公寓楼下');
    } else if (arrivedName === 'apartment') {
      this.finishAtHome();
    }
  }

  finishAtHome() {
    if (this.finished) return;
    this.finished = true;
    this.floor = this.home.homeFloor || 9;
    this.setState('home',
      `乘电梯到 ${this.floor}F，用钥匙开门进屋；妻子和孩子都在家`,
      '到家');
    this.logEvent('outcome', '安全到家',
      `17:${String(Math.floor(this.tMin)).padStart(2, '0')} 抵达 ${this.home.name} 家中；全程未使用全场最优避难路线`);
  }

  /** 6F 楼板高度：所有“楼里走动”都踩在同一层楼板上。 */
  floorY() {
    return this.office.baseY + 5 * this.office.floorH;
  }

  /** 把一串 [x,z] 变成当前楼层的行走路径，起步点就是他现在站的地方。 */
  errandPath(list) {
    const y = this.floorY();
    const pts = [this.position.clone()];
    for (const [x, z] of list) pts.push(new THREE.Vector3(x, y, z));
    return pts.map((p, i) => ({
      p, kind: 'walk', floor: 6,
      label: i === 0 ? '走向目的地' : (i === pts.length - 1 ? '到达' : '在办公区里走动'),
    }));
  }

  /** 前段节拍：按仿真时间推进，动作持续时间计入总时长。 */
  updateBeats() {
    const beat = BEATS[this.beatIndex];
    if (!beat) return;
    if (this.tMin < beat.at) return;
    if (this.pathName === 'errand' && this.path.length) return;
    if (this.state !== 'working' && this.tMin < this.waitUntil) return;
    this.beatIndex += 1;
    if (beat.info) this.receive(beat.info[0], beat.info[1]);
    if (beat.errand) {
      this.path = this.errandPath(beat.errand);
      this.pathName = 'errand';
      this.pathIndex = 0;
      this.errandHold = beat.hold || 0.4;
      this.setState(beat.state, beat.reason, beat.title);
      return;
    }
    if (beat.motion) {
      this.startMotion(beat.motion, beat.state, beat.reason, beat.title);
      return;
    }
    this.setState(beat.state, beat.reason, beat.title);
    this.waitUntil = this.tMin + beat.hold;
  }

  // ------------------------------------------------------------------ 移动
  moveAlong(dtSec) {
    let remaining = dtSec;
    let guard = 0;
    this.speed = 0;
    while (remaining > 1e-6 && this.pathIndex < this.path.length && guard++ < 64) {
      const wp = this.path[this.pathIndex];
      const target = wp.p;
      const dx = target.x - this.position.x;
      const dz = target.z - this.position.z;
      const flat = Math.hypot(dx, dz);

      if (wp.kind === 'lift' && flat < 0.35) {
        // 电梯内：水平不动，只做竖直运动。
        const dy = target.y - this.position.y;
        if (Math.abs(dy) < 0.05) {
          this.position.y = target.y;
          this.pathIndex += 1;
          this.liftStarted = false;
          continue;
        }
        if (!this.liftStarted) {
          this.liftStarted = true;
          this.setState('elevator', `电梯上行，从 ${this.floor}F 前往 ${wp.floor}F`, '乘电梯上楼');
        }
        const step = Math.min(Math.abs(dy), LIFT_SPEED * remaining);
        this.position.y += Math.sign(dy) * step;
        remaining -= step / LIFT_SPEED;
        this.floor = Math.min(wp.floor, Math.max(1, Math.round(
          (this.position.y - this.home.baseY) / this.home.floorH) + 1));
        continue;
      }

      const dist = Math.hypot(flat, target.y - this.position.y);
      if (dist < 0.03) {
        this.position.copy(target);
        this.floor = wp.floor;
        this.pathIndex += 1;
        continue;
      }

      let speed;
      if (wp.kind === 'stairs') speed = STAIR_SPEED;
      else if (this.pathName === 'drive' || this.pathName === 'driveDetour') speed = this.depth > 0.10 ? CAR_SPEED * 0.55 : CAR_SPEED;
      else if (this.pathName === 'errand') speed = WALK_SPEED * 0.95;
      else if (this.pathName === 'garage') speed = WALK_SPEED * 1.35;
      else if (this.pathName === 'walkIn') speed = WALK_SPEED * 1.1;
      else if (this.pathName === 'apartment' || this.pathName === 'stairs') speed = WALK_SPEED;
      else speed = this.depth > 0.22 ? WALK_SPEED * 0.75 : RUN_SPEED;
      speed *= 0.86 + 0.14 * (this.stamina / 100);

      const dir = new THREE.Vector3(target.x - this.position.x, 0, target.z - this.position.z);
      if (dir.lengthSq() > 1e-8) {
        dir.normalize();
        const want = Math.atan2(dir.x, dir.z);
        let diff = want - this.heading;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        // 航向按时间常数逼近，转弯不会瞬间甩头；转角越大越减速。
        const k = Math.min(1, dtSec * (this.pathName && this.pathName.startsWith('drive') ? 2.6 : 9));
        this.heading += diff * k;
        if (this.pathName && this.pathName.startsWith('drive')) {
          speed *= 1 - Math.min(0.6, Math.abs(diff) * 0.75);
        }
      }
      this.speed = speed;
      const step = Math.min(dist, speed * remaining);
      const ratio = step / dist;
      this.position.lerp(target, ratio);
      this.travelled += step;
      remaining -= step / speed;
      if (ratio > 0.999) {
        this.position.copy(target);
        this.floor = wp.floor;
        this.pathIndex += 1;
      }
    }
    const wp = this.path[Math.min(this.pathIndex, this.path.length - 1)];
    if (wp && wp.label) this.reason = wp.label;
    if (this.pathIndex >= this.path.length && this.path.length) {
      const arrived = this.pathName;
      this.path = [];
      this.pathIndex = 0;
      this.onArrive(arrived);
    }
  }

  // ------------------------------------------------------------- 积水与身体
  sampleDepth() {
    this.depth = this.floor === 1 ? this.depthAt(this.position.x, this.position.z, this.tMin) : 0;
  }

  // ---------------------------------------------------------------- 决策
  pathLength(path) {
    let d = 0;
    let prev = this.position;
    for (const wp of path) { d += Math.hypot(wp.p.x - prev.x, wp.p.z - prev.z); prev = wp.p; }
    return d;
  }

  /** 只在街面上感知；在楼里看不到街面积水。 */
  perceiveNow() {
    if (this.floor > 1) return;
    if (this.tMin - this.lastPerceiveAt < 1.2) return;
    this.lastPerceiveAt = this.tMin;
    const radius = this.state === 'driving' ? this.profile.driveSightM : this.profile.sightM;
    this.brain.perceive(this.position, this.tMin, radius);
  }

  /** 候选：上车前——开车 / 步行 / 退回楼里。 */
  candidatesBeforeBoarding() {
    const drive = this.joinNearestPath(this.pathFromRoute('route_drive'));
    const walk = this.joinNearestPath(this.pathFromRoute('route_home'));
    const shelter = this.joinNearestPath(this.pathFromRoute('route_park').slice().reverse());
    return [
      {
        action: 'drive', label: '开车回家', kind: 'drive',
        reason: '雨还在下但路面没到大水，车里比外面安全',
        path: drive, speed: 13, distance: this.pathLength(drive),
        wadeLimit: this.profile.carWade, lookAhead: this.profile.driveSightM,
        duty: 1.0,
      },
      {
        action: 'walkHome', label: '直接步行回家', kind: 'walk',
        reason: '与其在车库排队，不如趁水不深走回去',
        path: walk, speed: 2.9, distance: this.pathLength(walk),
        wadeLimit: this.profile.wadeLimit, lookAhead: this.profile.sightM,
        duty: 1.0, effortWeight: 0.5, timeWeight: 0.5,
      },
      {
        action: 'shelter', label: '退回办公楼等待', kind: 'shelter',
        reason: '外面情况不明，先回坚固建筑里等水退',
        path: shelter, speed: 1.4, distance: this.pathLength(shelter),
        wadeLimit: this.profile.wadeLimit, lookAhead: this.profile.sightM,
        duty: 0.25, waitWeight: 0.4,
      },
    ];
  }

  /** 候选：开车遇到淹水——绕行 / 弃车步行 / 退回楼里。 */
  candidatesAtCarBlock() {
    const detour = this.joinNearestPath(this.pathFromRoute('route_drive_detour'));
    const walk = this.joinNearestPath(this.pathFromRoute('route_home'));
    const shelter = this.joinNearestPath(this.pathFromRoute('route_park').slice().reverse());
    return [
      {
        action: 'driveDetour', label: '掉头绕行', kind: 'drive',
        reason: '掉头走 6th St，绕开这段淹水路面',
        path: detour, speed: 11, distance: this.pathLength(detour),
        wadeLimit: this.profile.carWade, lookAhead: this.profile.driveSightM,
        duty: 1.0,
      },
      {
        action: 'walkHome', label: '弃车步行', kind: 'walk',
        reason: '车已经过不去了，剩下的路用脚走',
        path: walk, speed: 2.9, distance: this.pathLength(walk),
        wadeLimit: this.profile.wadeLimit, lookAhead: this.profile.sightM,
        duty: 1.0, effortWeight: 0.55, timeWeight: 0.55,
      },
      {
        action: 'shelter', label: '弃车退回办公楼', kind: 'shelter',
        reason: '水涨得太快，先退回楼里，不值得冒险',
        path: shelter, speed: 1.4, distance: this.pathLength(shelter),
        wadeLimit: this.profile.wadeLimit, lookAhead: this.profile.sightM,
        duty: 0.2, waitWeight: 0.45,
      },
    ];
  }

  /** 候选：步行遇到深水——绕行 / 硬涉 / 退回楼里。 */
  candidatesAtFootBlock() {
    const detour = this.joinNearestPath(this.pathFromRoute('route_detour'));
    const shelter = this.joinNearestPath(this.pathFromRoute('route_park').slice().reverse());
    const rest = this.path.slice(this.pathIndex);
    return [
      {
        action: 'detour', label: '退回路口绕行', kind: 'walk',
        reason: '退回上一个路口，从北侧高一点的路绕过去',
        path: detour, speed: 2.4, distance: this.pathLength(detour),
        wadeLimit: this.profile.wadeLimit, lookAhead: this.profile.sightM,
        duty: 1.0, effortWeight: 0.4,
      },
      {
        action: 'push', label: '硬着头皮涉水', kind: 'wade',
        reason: '家就在前面，他觉得这段水还能过去',
        path: rest, speed: 1.2, distance: this.pathLength(rest),
        wadeLimit: Math.max(0.55, this.profile.wadeLimit + 0.25), lookAhead: 18,
        duty: 1.15, timeWeight: 0.2, effortWeight: 0.2,
      },
      {
        action: 'shelter', label: '退回办公楼', kind: 'shelter',
        reason: '水已经超过能走的深度，退回楼里等救援',
        path: shelter, speed: 1.4, distance: this.pathLength(shelter),
        wadeLimit: this.profile.wadeLimit, lookAhead: this.profile.sightM,
        duty: 0.2, waitWeight: 0.45,
      },
    ];
  }

  /** 沿路线看前方 meters 米：只看视线内，看到什么就记什么。 */
  senseRoute(path, meters) {
    if (!path || !path.length) return;
    let d = 0;
    let prev = this.position;
    for (const wp of path) {
      const seg = Math.hypot(wp.p.x - prev.x, wp.p.z - prev.z);
      if (d + seg > meters) break;
      d += seg;
      prev = wp.p;
      const dep = this.depthAt(wp.p.x, wp.p.z, this.tMin);
      this.brain.belief.observe(wp.p.x, wp.p.z, dep, this.tMin);
    }
  }

  /** 决策并写日志：候选、得分、选择、理由全部留痕。 */
  choose(situation, candidates) {
    this.perceiveNow();
    for (const c of candidates) this.senseRoute(c.path, c.lookAhead || this.profile.sightM);
    const { chosen, scored } = this.brain.decide({
      situation, tMin: this.tMin, from: this.position, candidates,
    });
    // 刚因为受阻换过动作，又立刻换回同一个，说明在原地打转：强制换第二优
    let finalChoice = chosen;
    const prev = this.lastChoice;
    if (prev && chosen && chosen.action === prev.action
        && this.tMin - prev.t < 4 && scored.length > 1) {
      finalChoice = scored[1];
      this.logEvent('decision', '放弃重复同一个选择',
        `${prev.action} 刚刚才失败过，改试「${finalChoice.label}」`);
    }
    this.lastChoice = finalChoice ? { action: finalChoice.action, t: this.tMin } : prev;
    this.decisions = this.brain.decisions.slice(-6);
    if (!finalChoice) return null;
    const table = scored.map((x) => `${x.label} ${x.utility.toFixed(2)}`).join('；');
    this.logEvent('decision', `判断：${finalChoice.label}`,
      `${situation}。${finalChoice.detail}。候选得分：${table}`);
    return finalChoice;
  }

  applyChoice(c) {
    if (!c) return;
    // 只有主动选择“硬涉”时才临时放宽，走别的路线立刻恢复本人的涉水上限
    this.effectiveWade = c.action === 'push'
      ? (c.wadeLimit || this.profile.wadeLimit + 0.25)
      : null;
    if (c.action === 'drive') this.startMotion('drive', 'driving', c.reason, '开车回家');
    else if (c.action === 'driveDetour') this.startMotion('driveDetour', 'driving', c.reason, '掉头绕行');
    else if (c.action === 'walkHome') this.startMotion('walkHome', 'escape', c.reason, '步行回家');
    else if (c.action === 'detour') this.startMotion('detour', 'detour', c.reason, '改道绕行');
    else if (c.action === 'push') this.startMotion('push', 'escape', c.reason, '硬涉深水');
    else if (c.action === 'shelter') this.startMotion('shelter', 'shelter', c.reason, '退回办公楼');
  }

  finishShelter() {
    if (this.finished) return;
    this.finished = true;
    this.setState('sheltered', '退回一层大堂，等水退或等救援；不再尝试穿越深水', '在楼内等待');
    this.logEvent('outcome', '退回楼内等待', '他判断继续前进风险过高，选择留在坚固建筑内');
  }

  checkBlocked() {
    const driving = this.state === 'driving';
    // wading 也必须继续判断：否则一旦开始涉水，就算水涨到胸口也不会停
    if (!driving && this.state !== 'escape' && this.state !== 'wading') return;
    if (!this.path.length) return;
    const ahead = this.path[this.pathIndex];
    if (!ahead) return;
    const near = this.position.distanceTo(ahead.p);
    const deep = this.depthAt(ahead.p.x, ahead.p.z, this.tMin);
    const limit = driving ? this.profile.carWade : (this.effectiveWade ?? this.profile.wadeLimit);
    const gap = driving ? 30 : 22;
    if (near > gap || deep <= limit) return;
    this.reroutes += 1;
    // 亲眼看到的水，写进信念表：下一次判断就不会再把这条路当干的
    for (let ox = -6; ox <= 6; ox += 3) {
      for (let oz = -6; oz <= 6; oz += 3) {
        const d2 = this.depthAt(ahead.p.x + ox, ahead.p.z + oz, this.tMin);
        this.brain.belief.observe(ahead.p.x + ox, ahead.p.z + oz, d2, this.tMin);
      }
    }
    if (driving) {
      this.setState('carblocked',
        `前方路面水深约 ${deep.toFixed(2)} m，轿车过不去；只能掉头绕路`,
        '前方道路被淹');
      this.logEvent('observation', '开车遇到淹水路段',
        `${ahead.p.x.toFixed(0)}, ${ahead.p.z.toFixed(0)} 处水深 ${deep.toFixed(2)} m；他停车、掉头，改走 6th St`);
    } else {
      this.setState('blocked',
        `前方水深约 ${deep.toFixed(2)} m，超过他愿意涉水的 30 cm；硬闯风险太大`,
        '被深水挡住');
    }
    if (!driving) {
      this.logEvent('observation', '遇到无法通过的深水',
        `${ahead.p.x.toFixed(0)}, ${ahead.p.z.toFixed(0)} 处水深 ${deep.toFixed(2)} m；他停下观察，改走北侧绕行线`);
    }
    this.waitUntil = this.tMin + 1.1;
  }

  updateBody(dtSec) {
    if (this.finished) return;
    if (this.state === 'escape' || this.state === 'detour' || this.state === 'wading') {
      const cost = (this.depth > 0.12 ? 0.34 : 0.10) * dtSec;
      this.stamina = Math.max(8, this.stamina - cost);
      if (this.depth > 0.05 && this.state !== 'wading' && this.state !== 'driving') {
        this.setState('wading', '路面积水没过鞋面，他放慢脚步趟过去', '涉水通过');
      } else if (this.depth <= 0.05 && this.state === 'wading') {
        this.setState('escape', '水面变浅，重新跑起来', '继续跑步回家');
      }
    } else if (this.state === 'blocked' || this.state === 'observing') {
      this.stamina = Math.max(5, this.stamina - 0.06 * dtSec);
    } else if (this.stamina < 100) {
      this.stamina = Math.min(100, this.stamina + 0.35 * dtSec);
    }
    if (this.depth > 0.9) {
      this.health = Math.max(0, this.health - (this.depth - 0.9) * 4 * dtSec);
    }
  }

  recordTrace(force = false) {
    const sec = this.tMin * 60;
    if (!force && sec - this.lastTraceSec < 0.249) return;
    this.lastTraceSec = sec;
    this.trace.push({
      t: this.tMin, x: this.position.x, y: this.position.y, z: this.position.z,
      heading: this.heading, state: this.state, reason: this.reason, floor: this.floor,
      depth: this.depth, stamina: this.stamina, health: this.health,
      infoCount: this.info.length, travelled: this.travelled,
    });
  }

  // ------------------------------------------------------------------ 主循环
  step(dtSec) {
    if (this.finished || dtSec <= 0) return;
    let left = dtSec;
    while (left > 1e-8) {
      const dt = Math.min(0.25, left);
      left -= dt;
      this.tMin += dt / 60;

      this.updateBeats();

      if (this.state === 'boarding' && this.tMin >= this.waitUntil) {
        // 上车前：开车 / 步行 / 回楼，由本人档案与当下感知决定
        this.applyChoice(this.choose('准备回家：开车还是步行', this.candidatesBeforeBoarding()));
      } else if (this.state === 'parking' && this.tMin >= this.waitUntil) {
        this.startMotion('walkIn', 'arrive',
          '车停在楼下，背上包走到公寓北门', '下车进楼');
      } else if (this.state === 'carblocked' && this.tMin >= this.waitUntil) {
        this.applyChoice(this.choose('前方道路被淹：绕行、弃车还是退回', this.candidatesAtCarBlock()));
      } else if (this.state === 'carblocked' || this.state === 'observing') {
        // 停车/停步判断期间不能继续沿原路线前进。
        if (this.state === 'observing' && this.tMin >= this.waitUntil && !this.path.length) {
          this.startMotion('back', 'escape',
            '把车留在车库，背上包沿 6th St 往北跑；家在一公里外', '决定步行回家');
        }
      } else if (this.state === 'blocked') {
        // 站在水边判断：绕行 / 硬涉 / 退回楼里
        if (this.tMin >= this.waitUntil) {
          this.applyChoice(this.choose('步行遇到深水：绕行、硬涉还是退回', this.candidatesAtFootBlock()));
        }
      } else if (this.path.length) {
        this.moveAlong(dt);
      }

      this.sampleDepth();
      this.perceiveNow();
      this.checkBlocked();
      this.updateBody(dt);
      this.recordTrace();

      if (this.tMin >= END_MIN && !this.finished) {
        this.finished = true;
        this.logEvent('outcome', '场景结束', '到达本次演示的时间边界');
      }
    }
  }

  snapshot() {
    return {
      id: 'MARK-JENSEN-001', name: '马克·詹森', age: 36,
      occupation: '工程咨询公司项目职员', tMin: this.tMin, state: this.state,
      stateText: STATE_TEXT[this.state] || this.state,
      reason: this.reason, floor: this.floor, position: this.position,
      depth: this.depth, health: this.health, stamina: this.stamina,
      info: this.info, events: this.events, trace: this.trace,
      reroutes: this.reroutes, finished: this.finished,
      travelled: this.travelled, pathName: this.pathName,
      pathProgress: this.path.length ? this.pathIndex / this.path.length : 0,
      remaining: this.path.slice(this.pathIndex).map((w) => [w.p.x, w.p.y, w.p.z]),
      decisions: this.decisions,
      profile: this.profile ? this.profile.key : 'mark',
    };
  }
}

export { STATE_TEXT };
export const OFFICE_STORY_START_MIN = START_MIN;
export const OFFICE_STORY_END_MIN = END_MIN;
