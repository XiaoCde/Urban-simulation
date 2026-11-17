import * as THREE from 'three';
import { Brain, PROFILES } from './decision.js';
import { PersonState, UMBRELLA } from './person-state.js';
import { STORY_OFFSET } from './clock.js';

/**
 * 多人物共用的个体行为引擎。
 *
 * 和马克那套的区别：这里不写死每一条故事，而是用一份「脚本表」驱动，
 * 每个角色只需要描述：
 *   - 起点、楼层、初始状态
 *   - 什么时候收到什么信息（不同职业、不同渠道、不同时间）
 *   - 因为职责/认知不同，接下来做了什么
 *   - 走哪条路线（预生成的三维折线）
 *   - 结局
 *
 * 硬约束沿用上一版：
 *   1) 只用已收到的信息和现场观察，不读全场积水图，不知道最优解；
 *   2) 移动全部走真实路径，没有瞬移；
 *   3) 和积水共用同一个仿真时钟，固定 0.25 s 子步，可复现。
 */

const SUBSTEP = 0.25;

/** 这些行为状态算「人在室内」（淋不到雨、伞要收起来）。 */
const INDOOR_STATES = new Set([
  'working', 'operating', 'class', 'continuing', 'closing', 'locking',
  'packing', 'handover', 'sheltered', 'sheltering', 'shelter', 'home',
  'elevator', 'indoor', 'power', 'texting', 'window', 'radio', 'instructing',
]);

export class PersonStory {
  constructor(opts) {
    this.id = opts.id;
    this.name = opts.name;
    this.age = opts.age;
    this.occupation = opts.occupation;
    this.tag = opts.tag || '';
    this.script = opts.script || [];
    this.routes = opts.routes || {};
    this.depthAt = opts.depthAt || (() => 0);
    this.groundAt = opts.groundAt || (() => 0);
    this.raining = opts.raining || (() => false);
    this.states = opts.states || {};
    this.start = opts.start.clone();
    this.startFloor = opts.floor || 1;
    this.startHeading = opts.heading ?? Math.PI;
    this.baseY = opts.baseY ?? 0;
    this.floorH = opts.floorH ?? 4;
    this.wadeLimit = opts.wadeLimit ?? 0.32;
    // 【速度】用户 2026-11-06：「跑步感觉特别慢」。旧值 run=2.9 m/s 其实是慢跑
    // （10.4 km/h），危机里成年人是 4.5~5 m/s。走 1.35 保持不变（对应 walk clip
    // 0.633 s/两步的步频），奔跑按档案在后面覆盖。
    this.walk = opts.walk ?? 1.35;
    this.run = opts.run ?? 4.6;
    this.stair = opts.stair ?? 0.8;
    this.ride = opts.ride ?? 6.0;
    this.color = opts.color || 0x4a90c2;
    this.intro = opts.intro || '';

    // ---- 生理状态（饥饿 / 淋湿 / 体力 / 被困时长 / 伞 / 车内）----
    // 【命名】不能叫 this.state —— 那是行为状态机（working / blocked / wading…），
    // 同名会直接把状态机覆盖成对象，所有 clip 选择都会失效。
    this.key = opts.key || opts.id || 'anon';
    this.hasUmbrella = opts.hasUmbrella ?? !!UMBRELLA[this.key];
    this.hunger0 = opts.hunger ?? 12;

    // ---- 心理档案 + 和马克同款的 Brain ----
    // 用户 2026-11-06：「剩下六个人也把他们的心理状态弄出来，改成跟马克一样的」。
    // 脚本表只描述「什么时候收到什么信息、本来打算做什么」，而「要不要改道、
    // 硬涉还是绕行、现在有多紧张」全部交给 Brain 的感知→信念→候选打分。
    this.profile = opts.profile || PROFILES.mark;
    this.brain = new Brain({
      profile: this.profile,
      depthAt: (x, z, t) => this.depthAt(x, z, t),
      seed: (opts.seed ?? 7) * 131 + 11,
    });
    this.lastPerceive = -Infinity;
    this.decisions = [];              // 近 6 条真实决策（含候选得分）
    this.pendingChoice = null;        // Brain 选出的动作，交给 updateScript 执行
    // 生理状态要在 profile 就位之后建（PersonState 会读档案算体力消耗）
    this.phys = new PersonState({
      key: this.key, profile: this.profile,
      hasUmbrella: this.hasUmbrella, hunger: this.hunger0,
    });
    this.reset();
  }

  reset() {
    this.tMin = this.script.length ? this.script[0].at - 0.3 : 0;
    this.state = this.script.length ? (this.script[0].state || 'idle') : 'idle';
    this.reason = this.script.length ? (this.script[0].reason || '') : '';
    this.position = this.start.clone();
    this.heading = this.startHeading;
    this.floor = this.startFloor;
    this.path = [];
    this.pathIndex = 0;
    this.pathName = null;
    this.beatIndex = 0;
    this.waitUntil = 0;
    this.depth = 0;
    this.speed = 0;
    this.travelled = 0;
    this.stamina = 100;
    this.health = 100;
    this.events = [];
    this.info = [];
    this.trace = [];
    this.lastTraceSec = -Infinity;
    this.finished = false;
    this.outcome = null;
    this.blockedAt = null;
    // 心理状态（不是标签，是按感知实时算出来的连续量）
    this.stress = 0.08;               // 紧张 0..1
    this.urgency = 0.10;              // 紧迫 0..1
    this.caution = 0.30;              // 谨慎 0..1
    this.mood = '平静';
    this.moodNote = '';
    this.decisions = [];
    this.pendingChoice = null;
    this.lastPerceive = -Infinity;
    this.effectiveWade = null;
    this.lastBlockDecideT = -Infinity;
    this.lastChoice = null;
    this.departureDecided = false;
    this.brain.decisions.length = 0;
    this.brain.belief.cells.clear();
    this.brain.belief.samples.length = 0;
    this.lastState = null;
    this.lastSpeed = 0;
    this.lastY = null;
    this.actionCue = null;            // 一次性动作提示（起停/转身/开门/跌倒）
    // 生理状态也要回到这一天的初始值，否则拖时间轴会带着上一轮的饥饿/淋湿
    if (this.phys) {
      this.phys = new PersonState({
        key: this.key, profile: this.profile,
        hasUmbrella: this.hasUmbrella, hunger: this.hunger0,
      });
    }
    this.recordTrace(true);
  }

  text(state = this.state) {
    return this.states[state] || state;
  }

  logEvent(type, title, detail = '') {
    const last = this.events[this.events.length - 1];
    if (last && last.title === title && Math.abs(last.t - this.tMin) < 0.02) return;
    this.events.push({ t: this.tMin, type, title, detail });
  }

  receive(source, content) {
    this.info.push({ t: this.tMin, source, content });
    this.logEvent('information', `收到${source}`, content);
  }

  setState(state, reason) {
    if (this.state !== state) {
      this.state = state;
      this.logEvent('state', this.text(state), reason);
    }
    this.reason = reason;
  }

  /** 把 JSON 路线变成三维路径点；可覆盖首尾，用于“从当前位置接入”。 */
  buildPath(key, opts = {}) {
    const raw = this.routes[key];
    if (!raw || !raw.length) return [];
    // 路线两种写法：[x,y,z] 数组（室外道路），或 {p:[x,y,z], kind, floor, label}（楼内）。
    const asObj = raw[0] && !Array.isArray(raw[0]);
    const pts = raw.map((row, i) => (asObj ? {
      p: new THREE.Vector3(row.p[0], row.p[1], row.p[2]),
      kind: row.kind || 'road',
      floor: row.floor ?? 1,
      label: row.label || (i === 0 ? '出发' : (i === raw.length - 1 ? '到达' : '前进')),
    } : {
      p: new THREE.Vector3(row[0], row[1], row[2]),
      kind: 'road',
      floor: 1,
      label: i === 0 ? '出发' : (i === raw.length - 1 ? '到达' : '沿街前进'),
    }));
    if (opts.fromCurrent && pts.length > 1) {
      const here = this.position;
      const head = pts[0].p;
      const gap = Math.hypot(head.x - here.x, head.z - here.z);
      if (gap > 18) {
        // 【不插当前位置】旧版无条件 unshift(this.position)，当路线的登记起点
        // 离角色几十米时（实测店员 80 m、骑手 72 m），第一段就是一条横穿
        // 咖啡馆墙体和整个街区的直线 —— 用户说的「和别的路面、房屋卡模重叠」。
        // 改成沿路线找离自己最近的点，从那里接入；同时补一小段「出门」接驳，
        // 让角色先从室内挪到门外，再沿街走，全程没有瞬移也没有穿墙长直线。
        let bi = 0, bd = Infinity;
        for (let i = 0; i < pts.length; i++) {
          const d = Math.hypot(pts[i].p.x - here.x, pts[i].p.z - here.z);
          if (d < bd) { bd = d; bi = i; }
        }
        const near = pts[bi];
        const approach = [];
        // 门口接驳：先横出楼体，再折向路线接入点（最多 3 个拐点、每段 ≤ 16 m）
        const dx = near.p.x - here.x, dz = near.p.z - here.z;
        const L = Math.hypot(dx, dz) || 1;
        const steps = Math.min(3, Math.max(1, Math.ceil(L / 16)));
        for (let k = 1; k < steps; k++) {
          const t = k / steps;
          approach.push({
            p: new THREE.Vector3(here.x + dx * t, here.y + (near.p.y - here.y) * t, here.z + dz * t),
            kind: 'walk', floor: this.floor,
            label: k === 1 ? '走出门口' : '沿街接近',
          });
        }
        approach.push({ ...near, label: '接入街道' });
        pts.splice(0, bi + 1, ...approach);
        this.logEvent('observation', '就近接入街道',
          `路线登记起点离当前 ${gap.toFixed(0)} m，改从最近的街道点（${bd.toFixed(0)} m）汇入，避免横穿建筑`);
      } else {
        pts.unshift({ p: this.position.clone(), kind: 'road', floor: this.floor, label: '从当前位置出发' });
      }
    }
    if (opts.tail) {
      for (const [x, y, z, label] of opts.tail) {
        pts.push({ p: new THREE.Vector3(x, y, z), kind: 'walk', floor: opts.tailFloor || 1, label: label || '最后一段' });
      }
    }
    return pts;
  }

  startPath(key, opts = {}) {
    const pts = this.buildPath(key, opts);
    if (!pts.length) return false;
    this.path = pts;
    this.pathIndex = 0;
    this.pathName = key;
    this.pathSpeed = opts.speed || 'walk';
    this.blockedAt = null;
    return true;
  }

  /** 沿当前路径推进；到达后交给 nextBeat。 */
  moveAlong(dtSec) {
    let remaining = dtSec;
    let guard = 0;
    this.speed = 0;
    while (remaining > 1e-6 && this.pathIndex < this.path.length && guard++ < 64) {
      const wp = this.path[this.pathIndex];
      const target = wp.p;
      if (!Number.isFinite(target.x) || !Number.isFinite(target.z)) {
        // 路线点坏了就跳过，别把 NaN 传染给位置（这个坑刚踩过一次）
        this.pathIndex += 1;
        continue;
      }
      const dx = target.x - this.position.x;
      const dz = target.z - this.position.z;
      const flat = Math.hypot(dx, dz);
      const dist = Math.hypot(flat, target.y - this.position.y);
      if (dist < 0.04) {
        this.position.copy(target);
        this.floor = wp.floor;
        this.pathIndex += 1;
        continue;
      }
      // 【速度分档】原来只有「水深 > 0.2 就 ×0.7」一档，40 cm 深的水里
      // 人还能按 0.94 m/s 走，比真实快一倍多。现在分三档：
      // 干地全速 / 18 cm 以上蹚水 0.62 倍 / 40 cm 以上只剩 0.42 倍。
      const dep = this.depth;
      let speed;
      if (this.pathSpeed === 'ride') speed = dep > 0.12 ? this.ride * 0.45 : this.ride;
      else if (this.pathSpeed === 'run') {
        // 涉水时跑不起来：20 cm 以上只能快走，40 cm 以上跟走路一样
        speed = dep > 0.40 ? this.walk * 0.45
          : dep > 0.20 ? this.walk * 1.05 : this.run;
      } else if (this.pathSpeed === 'stair') speed = this.stair;
      else speed = dep > 0.40 ? this.walk * 0.42
        : dep > 0.18 ? this.walk * 0.62 : this.walk;
      if (wp.kind === 'stairs') speed = this.stair;
      // 体力/淋湿/饥饿的乘子（0.72~1.0），由 PersonState 算
      speed *= this.phys ? this.phys.speedFactor() : 1;

      const dir = new THREE.Vector3(dx, 0, dz);
      if (dir.lengthSq() > 1e-8) {
        dir.normalize();
        const want = Math.atan2(dir.x, dir.z);
        let diff = want - this.heading;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.heading += diff * Math.min(1, dtSec * 8);
      }
      this.speed = speed;
      const step = Math.min(dist, speed * remaining);
      this.position.lerp(target, step / dist);
      this.travelled += step;
      remaining -= step / speed;
      if (step / dist > 0.999) {
        this.position.copy(target);
        this.floor = wp.floor;
        this.pathIndex += 1;
      }
    }
    const wp = this.path[Math.min(this.pathIndex, this.path.length - 1)];
    if (wp && wp.label) this.reason = wp.label;
    if (this.pathIndex >= this.path.length && this.path.length) {
      this.path = [];
      this.pathIndex = 0;
      this.pathName = null;
      this.speed = 0;
      // 到达后等一会儿，再进入下一条节拍
      const beat = this.script[this.beatIndex];
      this.waitUntil = this.tMin + (beat && beat.after ? beat.after : 0.2);
    }
  }

  // ---------------------------------------------------------------- 心理 / 决策
  /** 只感知视线半径内的水，不读全场（和马克同一条硬约束）。 */
  perceiveNow() {
    if (this.tMin - this.lastPerceive < 0.045) return;   // 约 2.7 秒仿真一次
    this.lastPerceive = this.tMin;
    if (this.floor > 1) return;                          // 楼上的人看不见街面水深
    const r = this.pathSpeed === 'ride' ? this.profile.driveSightM : this.profile.sightM;
    this.brain.perceive(this.position, this.tMin, r);
  }

  /** 沿候选路线往前看一段，把看到的水写进信念表。 */
  sensePath(path, meters) {
    if (!path || !path.length) return;
    let prev = this.position, d = 0;
    for (const wp of path) {
      const p = wp.p;
      if (!p) continue;
      const seg = Math.hypot(p.x - prev.x, p.z - prev.z);
      if (d + seg > meters) break;
      d += seg; prev = p;
      this.brain.belief.observe(p.x, p.z, this.depthAt(p.x, p.z, this.tMin), this.tMin);
    }
  }

  pathLength(path) {
    if (!path || path.length < 2) return 0;
    let d = 0;
    for (let i = 1; i < path.length; i++) {
      d += Math.hypot(path[i].p.x - path[i - 1].p.x, path[i].p.z - path[i - 1].p.z);
    }
    return d;
  }

  /**
   * 收到预警 / 准备出发时的决策：继续手头的事、先停下来看一眼、还是按原计划走。
   * 候选效用由本人档案算（医生 dutyWeight 高 → 更可能继续手术；
   * 骑手 riskAversion 低 → 更可能照常冲出去）。这一步让 6 个人在没遇到
   * 深水时也都有真实决策和情绪变化，而不是只有脚本。
   */
  decideAtDeparture(beat) {
    const p = this.profile;
    const candidates = [
      {
        action: 'stay', label: '先做完手上的事', kind: 'wait',
        path: [], distance: 0, speed: 0.01,
        wadeLimit: p.wadeLimit, lookAhead: p.sightM,
        // 【不要再乘 p.dutyWeight】Brain.scoreCandidates 里已经有
        // `duty * p.dutyWeight`，这里再乘一次就变成平方，导致高职责档案
        // 一律压倒性选 stay（实测 6 人里 5 个选同一项，看不出性格差异）。
        duty: 0.62, survivalWeight: 0.80, waitWeight: 0.95,
        reason: '事情做到一半，不能说停就停',
      },
      {
        action: 'confirm', label: '先停下来看一眼', kind: 'wait',
        path: [], distance: 0, speed: 0.01,
        wadeLimit: p.wadeLimit, lookAhead: p.sightM,
        duty: 0.48, survivalWeight: 1.12, waitWeight: 0.35,
        reason: '消息不一定准，先看看窗外和街上的反应',
      },
      {
        action: 'go', label: '按眼前的路走', kind: 'walk',
        path: beat.path ? this.buildPath(beat.path, { fromCurrent: true }) : [],
        distance: 160, speed: this.walk,
        wadeLimit: p.wadeLimit, lookAhead: p.sightM,
        duty: 0.92, survivalWeight: 1.0, effortWeight: 0.18, timeWeight: 0.12,
        reason: '早点动身，别等水涨上来',
      },
    ];
    this.perceiveNow();
    for (const c of candidates) this.sensePath(c.path, c.lookAhead || p.sightM);
    const { chosen, scored } = this.brain.decide({
      situation: beat.info ? `刚收到「${beat.info[0]}」的消息` : '准备动身，判断要不要按原计划走',
      tMin: this.tMin, from: this.position, candidates,
    });
    this.decisions = this.brain.decisions.slice(-6);
    const table = scored.map((x) => `${x.label} ${x.utility.toFixed(2)}`).join('；');
    this.logEvent('decision', `判断：${chosen ? chosen.label : '—'}`,
      `${chosen ? chosen.reason : ''}。候选得分：${table}`);
    if (chosen && chosen.action === 'confirm') {
      // 谨慎的人原地多观察一会儿，紧张度也跟着上来
      this.waitUntil = Math.max(this.waitUntil, this.tMin + 0.35);
      this.stress = Math.min(1, this.stress + 0.12);
    }
    return chosen;
  }

  /**
   * 受阻时的真实决策：构造 4 个候选（硬涉 / 绕行 / 等待 / 退回），
   * 由 Brain 按本人档案的效用函数打分，而不是一条固定阈值 alt。
   * 不同 profile 在同一处水深会选出不同动作，这就是「心理状态」。
   */
  decideAtBlock(deep, altKey) {
    const p = this.profile;
    const here = this.path.slice(this.pathIndex);
    const alt = altKey ? this.buildPath(altKey, { fromCurrent: true }) : [];
    const dis = this.pathLength(here) || 40;
    const candidates = [
      {
        action: 'push', label: '硬着头皮涉过去', kind: 'push',
        path: here, distance: dis, speed: this.walk * 0.65,
        wadeLimit: p.wadeLimit + 0.26, lookAhead: p.sightM,
        duty: 0.85, survivalWeight: 0.72, effortWeight: 0.16, timeWeight: 0.20,
        reason: `${deep.toFixed(2)} m 已经过膝，但不想放弃原本的事`,
      },
      alt.length ? {
        action: 'detour', label: '绕一条远路', kind: 'walk',
        path: alt, distance: this.pathLength(alt), speed: this.walk,
        wadeLimit: p.wadeLimit, lookAhead: p.sightM * 1.2,
        duty: 0.55, survivalWeight: 1.25, effortWeight: 0.42, timeWeight: 0.46,
        reason: '宁可多走，也不趟没看见底的水',
      } : null,
      {
        action: 'wait', label: '原地等水退', kind: 'wait',
        path: [], distance: 0, speed: 0.01,
        wadeLimit: p.wadeLimit, lookAhead: p.sightM,
        duty: 0.20, survivalWeight: 1.15, waitWeight: 1.25, timeWeight: 0.30,
        reason: '不确定前面多深，先停一下看看',
      },
      {
        action: 'shelter', label: '退回高处避险', kind: 'shelter',
        path: [], distance: 30, speed: this.walk,
        wadeLimit: p.wadeLimit, lookAhead: p.sightM,
        duty: 0.10, survivalWeight: 1.45, effortWeight: 0.30,
        reason: '不赌了，先保命',
      },
    ].filter(Boolean);

    this.perceiveNow();
    for (const c of candidates) this.sensePath(c.path, c.lookAhead || p.sightM);
    const { chosen, scored } = this.brain.decide({
      situation: `前方水深 ${deep.toFixed(2)} m，超过自己能涉的 ${p.wadeLimit.toFixed(2)} m`,
      tMin: this.tMin, from: this.position, candidates,
    });
    // 同一动作刚失败过就别再选它，避免在原地反复打转
    const prev = this.lastChoice;
    let final = chosen;
    if (prev && chosen && chosen.action === prev.action
      && this.tMin - prev.t < 3 && scored.length > 1) final = scored[1];
    this.lastChoice = final ? { action: final.action, t: this.tMin } : prev;

    this.decisions = this.brain.decisions.slice(-6);
    this.pendingChoice = final || null;
    const table = scored.map((x) => `${x.label} ${x.utility.toFixed(2)}`).join('；');
    this.logEvent('decision', `判断：${final ? final.label : '—'}`,
      `水深 ${deep.toFixed(2)} m。${final ? final.reason : ''}。候选得分：${table}`);
    return final;
  }

  /** 心理状态：紧张 / 紧迫 / 谨慎都从「亲眼看见的水」和刚才的判断推导。 */
  // ---------------------------------------------------------------- 生理状态
  /** 每 0.25 s 子步推进一次生理状态（饥饿/淋湿/体力/被困/伞/车内）。 */
  updatePhys(dtSec) {
    if (!this.phys) return;
    const inBuilding = this.floor > 1 || INDOOR_STATES.has(this.state);
    const inVehicle = this.state === 'driving' || this.state === 'carblocked';
    this.phys.inVehicle = inVehicle;
    this.phys.inBuilding = inBuilding;
    this.phys.tick(STORY_OFFSET + this.tMin, {
      depth: this.depth,
      speed: this.speed,
      raining: this.rainingNow(),
      inVehicle, inBuilding,
      asleep: this.state === 'sleeping',
    });
    // 旧字段还要给 updateMood 用，保持同步
    this.stamina = this.phys.stamina;
  }

  rainingNow() {
    try {
      return !!(this.raining && this.raining());
    } catch (e) { return false; }
  }

  updateMood() {
    const b = this.brain.belief;
    const ambient = b.ambient(this.tMin);
    const trend = b.trend(this.tMin);
    const seen = Math.max(this.depth, ambient);
    const p = this.profile;
    const ph = this.phys;
    // 水越深、涨得越快、信息越杂、越刚做过艰难决定 → 越紧张
    // 另外：被困越久、淋得越湿、越饿，情绪基线越高（身体状态进情绪）
    const target = Math.min(1,
      0.06 + seen / Math.max(0.15, p.wadeLimit) * 0.34
      + Math.max(0, trend) * 1.1
      + Math.min(0.20, this.info.length * 0.045)
      + (this.blockedAt ? 0.20 : 0)
      + (this.state === 'wading' || this.state === 'blocked' ? 0.16 : 0)
      + (1 - this.stamina / 100) * 0.10
      + Math.min(0.22, (ph ? ph.trappedMin : 0) / 45 * 0.22)
      + (ph ? ph.wetness * 0.09 : 0)
      + (ph && ph.hunger > 70 ? 0.06 : 0));
    // 紧张上来快、退下去慢（人不会一秒钟就 calm）
    this.stress += (target - this.stress) * (target > this.stress ? 0.22 : 0.045);
    this.urgency = Math.min(1, 0.10 + (this.path.length ? 0.32 : 0)
      + (this.decisions.length ? 0.18 : 0) + this.stress * 0.35);
    this.caution = Math.min(1, 0.20 + p.riskAversion * 0.32 + seen * 0.6);

    let mood;
    if (this.finished) {
      mood = this.stress > 0.7 ? '惊魂未定'
        : (this.outcome === 'safe' || this.outcome === 'sheltered') ? '松了口气' : '疲惫';
    }
    else if (this.stress > 0.78) mood = '恐慌';
    else if (this.stress > 0.56) mood = '焦虑';
    else if (this.stress > 0.34) mood = '紧张';
    else if (this.urgency > 0.55) mood = '急切';
    else if (this.state === 'working' || this.state === 'operating' || this.state === 'class') mood = '专注';
    else mood = '平静';
    this.mood = mood;
    const last = this.decisions[this.decisions.length - 1];
    const base = last
      ? `${last.situation} → ${last.chosen}`
      : (this.info.length ? `已收到 ${this.info.length} 条消息` : p.trait || '');
    // 身体状态也露在摘要里：撑伞 / 湿透 / 很饿 / 被困 N 分钟
    const tags = [];
    if (ph) {
      const l = ph.labels();
      if (ph.umbrella === 'open') tags.push('撑伞');
      else if (ph.hasUmbrella && ph.wetness > 0.35) tags.push('伞收着');
      if (ph.wetness > 0.55) tags.push(l.wet);
      if (ph.hunger > 58) tags.push(l.hunger);
      if (ph.trappedMin >= 3) tags.push(l.trapped);
      if (ph.inVehicle) tags.push('在车里');
    }
    this.moodNote = base + (tags.length ? ' · ' + tags.join(' · ') : '');
  }

  /** 阻水检测：交给 Brain 决定，不再写死「深于 wadeLimit 就走 alt」。 */
  checkBlocked() {
    if (!this.path.length) return false;
    if (this.pathSpeed === 'stair') return false;
    if (this.blockedAt) return false;
    // 刚做过判断就别每个 0.25 s 子步都重打一次分；选了硬涉的人在这段时间
    // 内就按自己的 effectiveWade 继续走，不会原地反复犹豫。
    if (this.tMin - (this.lastBlockDecideT ?? -Infinity) < 1.2) return false;
    const ahead = this.path[Math.min(this.pathIndex + 1, this.path.length - 1)];
    if (!ahead) return false;
    const near = this.position.distanceTo(ahead.p);
    if (near > 26) return false;
    // 前方一小段里最深的水（自己的视线范围内，不是全场）
    let deep = this.depthAt(ahead.p.x, ahead.p.z, this.tMin);
    for (let k = 1; k <= 3 && this.pathIndex + k < this.path.length; k++) {
      const q = this.path[this.pathIndex + k].p;
      if (Math.hypot(q.x - this.position.x, q.z - this.position.z) > this.profile.sightM) break;
      deep = Math.max(deep, this.depthAt(q.x, q.z, this.tMin));
    }
    const limit = this.effectiveWade || this.profile.wadeLimit;
    if (deep <= limit) return false;
    this.lastBlockDecideT = this.tMin;
    const beat = this.activeBeat;
    const altKey = beat && beat.alt;
    const choice = this.decideAtBlock(deep, altKey);
    if (choice && choice.action === 'push') {
      // 选了硬涉：抬高本段可涉深度，继续沿原路走（动作会切成涉水步态）
      this.effectiveWade = choice.wadeLimit || this.profile.wadeLimit + 0.26;
      this.setState('wading', choice.reason);
      this.logEvent('observation', '决定涉水通过', `水深 ${deep.toFixed(2)} m，超过 ${this.profile.wadeLimit.toFixed(2)} m 仍选择继续`);
      return false;
    }
    if (choice && choice.action === 'wait') {
      // 选了等：停在原地一小会儿，之后重新感知再判断
      this.setState('observing', choice.reason);
      this.waitUntil = this.tMin + 0.7;
      this.blockedAt = null;
      return false;
    }
    this.blockedAt = { x: ahead.p.x, z: ahead.p.z, depth: deep };
    this.path = [];
    this.pathIndex = 0;
    this.speed = 0;
    this.setState('blocked', choice ? choice.reason
      : `前方水深约 ${deep.toFixed(2)} m，已经过不去；只能退回去换一条路`);
    this.logEvent('observation', '遇到过不去的深水',
      `${ahead.p.x.toFixed(0)}, ${ahead.p.z.toFixed(0)} 处水深 ${deep.toFixed(2)} m；`
      + (beat && beat.blockNote ? beat.blockNote : '他停下判断，决定改道'));
    this.waitUntil = this.tMin + (beat && beat.blockHold ? beat.blockHold : 0.8);
    return true;
  }

  /** 按时间推进脚本。 */
  updateScript() {
    const beat = this.script[this.beatIndex];
    if (!beat) return;
    if (this.tMin < beat.at) return;
    // 还在路上 / 还在等，就先不推进
    if (this.path.length) return;
    if (this.tMin < this.waitUntil) return;

    this.beatIndex += 1;
    // 【收到信息时先做一次判断】不是「脚本说走就走」：同一个人面对同一条
    // 预警，按自己的档案权衡「继续手头的事 / 马上走 / 先确认再走」。
    // 这一步让 6 个人在没遇到深水时也都有真实的决策记录和情绪变化。
    if (beat.info || (beat.path && !this.departureDecided)) {
      this.departureDecided = true;
      this.decideAtDeparture(beat);
    }
    if (beat.info) this.receive(beat.info[0], beat.info[1]);
    if (beat.state) this.setState(beat.state, beat.reason || '');
    if (beat.reason) this.reason = beat.reason;
    if (beat.event) this.logEvent(beat.event[0], beat.event[1], beat.event[2] || '');

    // 先处理“这一拍要走一条路”，再处理“被水挡住后改走另一条”。
    // 顺序反了的话，带 alt 的出行节拍会被当成备选节拍直接跳过，人物原地不动就跳到结局。
    if (beat.path) {
      this.activeBeat = beat;
      this.startPath(beat.path, {
        fromCurrent: true, speed: beat.speed || 'walk', tail: beat.tail, tailFloor: beat.tailFloor,
      });
      return;
    }

    if (beat.alt) {
      if (!this.blockedAt) {
        // 没被挡住：这一拍直接跳过（或收尾）
        if (beat.finish) this.finish(beat.outcome || 'sheltered', beat.summary || '');
        return;
      }
      // 【决策真的改变行为】Brain 选了「退回避险」就不走绕行路线，原地收尾；
      // 选了「绕行」才走 alt。旧版不管选什么都不加区分，只会有脚本一条路。
      const choice = this.pendingChoice;
      if (choice && choice.action === 'shelter') {
        this.blockedAt = null;
        this.activeBeat = null;
        this.pendingChoice = null;
        this.finish('sheltered', choice.reason || '不再冒险，退回高处等雨停');
        return;
      }
      const ok = this.startPath(beat.alt, {
        fromCurrent: true, speed: beat.altSpeed || 'walk', tail: beat.tail, tailFloor: beat.tailFloor,
      });
      if (ok) this.logEvent('state', beat.altTitle || (choice ? choice.label : '改道'),
        choice ? choice.reason : (beat.altReason || ''));
      this.blockedAt = null;
      this.activeBeat = null;
      this.pendingChoice = null;
      return;
    }

    if (beat.finish) {
      this.finish(beat.outcome || 'sheltered', beat.summary || '');
      return;
    }

    this.waitUntil = this.tMin + (beat.hold ?? 0.6);
  }

  finish(outcome, summary) {
    if (this.finished) return;
    this.finished = true;
    this.path = [];
    this.speed = 0;
    this.outcome = outcome;
    this.setState(outcome, summary);
    this.logEvent('outcome', this.text(outcome), summary);
  }

  sampleDepth() {
    this.depth = this.floor === 1 ? this.depthAt(this.position.x, this.position.z, this.tMin) : 0;
  }

  recordTrace(force = false) {
    const sec = this.tMin * 60;
    if (!force && sec - this.lastTraceSec < 0.249) return;
    this.lastTraceSec = sec;
    this.trace.push({
      t: this.tMin, x: this.position.x, y: this.position.y, z: this.position.z,
      state: this.state, floor: this.floor, depth: this.depth,
    });
  }

  step(dtSec) {
    if (dtSec <= 0) return;
    let left = dtSec;
    while (left > 1e-8) {
      const dt = Math.min(SUBSTEP, left);
      left -= dt;
      this.tMin += dt / 60;
      if (!this.finished) {
        this.updateScript();
        if (this.path.length) {
          this.moveAlong(dt);
          this.checkBlocked();
        }
        this.sampleDepth();
        this.perceiveNow();
        this.updatePhys(dt);
        this.updateMood();
        if (!this.finished && this.depth > 0.55
          && this.state !== 'wading' && this.state !== 'blocked') {
          this.setState('wading', '积水已经到膝盖以上，他走得很吃力');
        }
      }
      // 动作线索：让渲染层知道「起步 / 停步 / 转身 / 上楼 / 下楼 / 开门」，
      // 不同情境播不同 clip，而不是一路 walk 平移动画。
      // 【上下楼用 y 变化判定】floor 字段在室内路线里只是标注，实测从 6F
      // 走楼梯下去的人被判成 stairs_up；真实高度差不会撒谎。
      const st = this.state, sp = this.speed, yy = this.position.y;
      const dy = yy - (this.lastY ?? yy);
      let cue = null;
      if (dy < -0.22) cue = 'stairs_down';
      else if (dy > 0.22) cue = 'stairs_up';
      else if (this.lastSpeed < 0.25 && sp >= 0.25) cue = 'start';
      // 【原来是反的】写成 `sp > 2.2 ? 'stop' : 'run_stop'`，但停下来的那一刻
      // sp 已经是 0，永远走 run_stop，'stop' 一次都不会播。要按**上一刻**的速度判。
      else if (this.lastSpeed >= 0.25 && sp < 0.25) {
        cue = this.lastSpeed > 2.2 ? 'run_stop' : 'stop';
      }
      else if (this.lastState !== st && (st === 'blocked' || st === 'observing')) cue = 'stop';
      else if (this.lastState !== st && (st === 'locking' || st === 'boarding')) cue = 'door';
      this.actionCue = cue;
      this.lastState = st; this.lastSpeed = sp; this.lastY = yy;
      this.recordTrace();
    }
  }

  snapshot() {
    return {
      id: this.id, name: this.name, age: this.age, occupation: this.occupation,
      tag: this.tag, intro: this.intro,
      tMin: this.tMin, state: this.state, stateText: this.text(),
      reason: this.reason, floor: this.floor,
      position: [this.position.x, this.position.y, this.position.z],
      depth: this.depth, speed: this.speed, travelled: this.travelled,
      info: this.info, events: this.events, traceLength: this.trace.length,
      finished: this.finished, outcome: this.outcome, pathName: this.pathName,
      profile: this.profile.key, mood: this.mood, moodNote: this.moodNote,
      stress: this.stress, urgency: this.urgency, caution: this.caution,
      decisions: this.decisions, actionCue: this.actionCue,
      phys: this.phys ? this.phys.snapshot() : null,
    };
  }
}
