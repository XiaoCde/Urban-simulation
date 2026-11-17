import * as THREE from 'three';

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
    this.states = opts.states || {};
    this.start = opts.start.clone();
    this.startFloor = opts.floor || 1;
    this.startHeading = opts.heading ?? Math.PI;
    this.baseY = opts.baseY ?? 0;
    this.floorH = opts.floorH ?? 4;
    this.wadeLimit = opts.wadeLimit ?? 0.32;
    this.walk = opts.walk ?? 1.35;
    this.run = opts.run ?? 2.9;
    this.stair = opts.stair ?? 0.8;
    this.ride = opts.ride ?? 6.0;
    this.color = opts.color || 0x4a90c2;
    this.intro = opts.intro || '';
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
    if (opts.fromCurrent && pts.length > 1) pts.unshift({ p: this.position.clone(), kind: 'road', floor: this.floor, label: '从当前位置出发' });
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
      let speed;
      if (this.pathSpeed === 'ride') speed = this.depth > 0.12 ? this.ride * 0.5 : this.ride;
      else if (this.pathSpeed === 'run') speed = this.depth > 0.2 ? this.walk * 0.8 : this.run;
      else if (this.pathSpeed === 'stair') speed = this.stair;
      else speed = this.depth > 0.2 ? this.walk * 0.7 : this.walk;
      if (wp.kind === 'stairs') speed = this.stair;
      speed *= 0.88 + 0.12 * (this.stamina / 100);

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

  /** 前方是否已经无法通过（只有步行和骑行会检查）。 */
  checkBlocked() {
    if (!this.path.length) return false;
    if (this.pathSpeed === 'stair') return false;
    const ahead = this.path[Math.min(this.pathIndex + 1, this.path.length - 1)];
    if (!ahead) return false;
    const near = this.position.distanceTo(ahead.p);
    if (near > 26) return false;
    const deep = this.depthAt(ahead.p.x, ahead.p.z, this.tMin);
    if (deep <= this.wadeLimit) return false;
    const beat = this.activeBeat;
    if (!beat || !beat.alt) return false;
    if (this.blockedAt) return false;
    this.blockedAt = { x: ahead.p.x, z: ahead.p.z, depth: deep };
    this.path = [];
    this.pathIndex = 0;
    this.speed = 0;
    this.setState('blocked',
      `前方水深约 ${deep.toFixed(2)} m，已经过不去；只能退回去换一条路`);
    this.logEvent('observation', '遇到过不去的深水',
      `${ahead.p.x.toFixed(0)}, ${ahead.p.z.toFixed(0)} 处水深 ${deep.toFixed(2)} m；` +
      (beat.blockNote || '他停下判断，决定改道'));
    this.waitUntil = this.tMin + (beat.blockHold ?? 0.8);
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
      const ok = this.startPath(beat.alt, {
        fromCurrent: true, speed: beat.altSpeed || 'walk', tail: beat.tail, tailFloor: beat.tailFloor,
      });
      if (ok) this.logEvent('state', beat.altTitle || '改道', beat.altReason || '');
      this.blockedAt = null;
      this.activeBeat = null;
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
        if (this.depth > 0.55 && this.state !== 'wading') {
          this.setState('wading', '积水已经到膝盖以上，他走得很吃力');
        }
      }
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
    };
  }
}
