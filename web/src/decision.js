/**
 * 个体决策引擎（Stage A）
 *
 * 设计的硬约束：**决策函数拿不到全场水深**。
 * 它只能看见自己感知半径内的情况，并把看到的东西写进一张“信念表”；
 * 半径之外一律靠这张表和趋势推断。这样就不存在“所有人都知道最优避难点”。
 *
 * 结构：感知(perceive) → 信念(belief) → 候选行为(candidates) → 效用打分(score) → 选定(decide)
 */

/** 确定性随机：同一 seed 两次运行结果完全一致。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * 信念表：以 5 m 网格记住“我亲眼看到的水深”，带时间戳。
 * 没有观测过的格子返回 null —— 上层必须自己处理“不知道”，而不是当成 0。
 */
export class Belief {
  constructor(cell = 5, memoryMin = 8) {
    this.cell = cell;
    this.memoryMin = memoryMin;
    this.cells = new Map();
    this.samples = [];       // {t, depth} 近端观测，用来估趋势
  }

  key(x, z) {
    return `${Math.round(x / this.cell)},${Math.round(z / this.cell)}`;
  }

  observe(x, z, depth, tMin) {
    const k = this.key(x, z);
    const prev = this.cells.get(k);
    // 同一个格子取“更危险”的那次观测：人记住的是最深的一眼，而不是平均值
    if (!prev || depth > prev.depth + 0.02) {
      this.cells.set(k, { depth, t: tMin, x, z });
    } else {
      prev.t = tMin;
    }
    this.samples.push({ t: tMin, depth });
    if (this.samples.length > 400) this.samples.shift();
  }

  /** 半径 cell*1.2 内最近的一次观测；没有就返回 null。 */
  depthAt(x, z) {
    const r = Math.ceil(this.cell * 1.2);
    let best = null;
    let bestD = Infinity;
    const cx = Math.round(x / this.cell);
    const cz = Math.round(z / this.cell);
    for (let i = -1; i <= 1; i += 1) {
      for (let j = -1; j <= 1; j += 1) {
        const c = this.cells.get(`${cx + i},${cz + j}`);
        if (!c) continue;
        const d = Math.hypot(c.x - x, c.z - z);
        if (d < r && d < bestD) { bestD = d; best = c; }
      }
    }
    return best ? best.depth : null;
  }

  /** 近期见过的最深水，按分钟衰减：用来给“没看过的地方”一个先验。 */
  ambient(tMin) {
    let m = 0;
    for (const s of this.samples) {
      const age = tMin - s.t;
      if (age > this.memoryMin) continue;
      const decay = Math.max(0, 1 - age / this.memoryMin);
      m = Math.max(m, s.depth * decay);
    }
    return m;
  }

  /** 水面在涨还是在退：近 5 分钟最大深度对前 5 分钟。 */
  trend(tMin) {
    const recent = this.samples.filter((s) => s.t >= tMin - 5);
    const older = this.samples.filter((s) => s.t >= tMin - 10 && s.t < tMin - 5);
    if (!recent.length || !older.length) return 0;
    const a = Math.max(...recent.map((s) => s.depth));
    const b = Math.max(...older.map((s) => s.depth));
    return a - b;
  }
}

/**
 * 一个人物档案：决定“他会怎么权衡”。
 * 这不是行为脚本，只是权重；同一套候选行为，不同档案会选出不同结果。
 */
export const PROFILES = {
  mark: {
    key: 'mark',
    dutyWeight: 1.0,        // 回家见到家人的意愿
    riskAversion: 0.75,     // 对“没看过的地方”的惩罚
    wadeLimit: 0.30,        // 步行愿意涉水深度
    carWade: 0.35,          // 开车愿意涉水深度
    sightM: 42,             // 地面视线
    driveSightM: 70,        // 车上前方可视距离
    patience: 0.5,          // 等待/犹豫倾向
    noise: 0.04,            // 决策噪声（同一个人也不总是同一个选择）
  },
  markCautious: {
    key: 'markCautious',
    dutyWeight: 0.85,
    riskAversion: 1.15,
    wadeLimit: 0.18,
    carWade: 0.22,
    sightM: 38,
    driveSightM: 62,
    patience: 0.85,
    noise: 0.03,
  },
  markBold: {
    key: 'markBold',
    dutyWeight: 1.15,
    riskAversion: 0.45,
    wadeLimit: 0.45,
    carWade: 0.55,
    sightM: 46,
    driveSightM: 80,
    patience: 0.2,
    noise: 0.08,
  },

  // ---- 6 个具名角色的心理档案（2026-11-06）----
  // 用户：「剩下六个人也把他们的心理状态弄出来，改成跟马克一样的」。
  // 不是给他们各写一套行为脚本，而是给同一套 Brain 不同的权重：
  // 同样的水、同样的候选动作，六个人会做出六种选择、经历六种情绪。
  boss: {
    key: 'boss', label: '罗伯特·惠特克', role: '公司合伙人',
    dutyWeight: 1.25,      // 职责最重：等团队走完才肯走
    riskAversion: 0.62, wadeLimit: 0.34, carWade: 0.38,
    sightM: 34, driveSightM: 60, patience: 0.78, noise: 0.035,
    trait: '责任感压过风险感，越乱越要收尾',
  },
  doctor: {
    key: 'doctor', label: '大卫·帕特尔', role: '外科医生',
    dutyWeight: 1.40,      // 手术中的病人 > 自己的安危
    riskAversion: 0.50, wadeLimit: 0.40, carWade: 0.42,
    sightM: 30, driveSightM: 55, patience: 0.92, noise: 0.02,
    trait: '专业惯性极强，不到必要不改变计划',
  },
  worker: {
    key: 'worker', label: '路易斯·拉米雷斯', role: '钢筋工',
    dutyWeight: 0.70, riskAversion: 0.88, wadeLimit: 0.42, carWade: 0.45,
    sightM: 44, driveSightM: 66, patience: 0.35, noise: 0.07,
    trait: '熟悉工地水情，胆子大但撤离果断',
  },
  woman: {
    key: 'woman', label: '艾米·陈', role: '咖啡馆店员',
    dutyWeight: 0.85, riskAversion: 1.05, wadeLimit: 0.24, carWade: 0.28,
    sightM: 46, driveSightM: 62, patience: 0.55, noise: 0.05,
    trait: '最早收到消息，谨慎、认路、不冒险',
  },
  rider: {
    key: 'rider', label: '泰瑞尔·杰克逊', role: '外卖骑手',
    dutyWeight: 1.15,      // 这一单必须送到
    riskAversion: 0.38, wadeLimit: 0.46, carWade: 0.50,
    sightM: 40, driveSightM: 78, patience: 0.22, noise: 0.09,
    trait: '几乎没有预警，靠现场观察，敢冲也敢弃车',
  },
  girl: {
    key: 'girl', label: '索菲亚·马丁内斯', role: '小学三年级',
    dutyWeight: 0.55, riskAversion: 1.20, wadeLimit: 0.14, carWade: 0.18,
    sightM: 24, driveSightM: 30, patience: 0.60, noise: 0.03,
    trait: '跟着队伍走，视线短、最容易被深水吓住',
  },
};

export class Brain {
  constructor({ profile = PROFILES.mark, depthAt, seed = 33 } = {}) {
    this.profile = profile;
    this.depthAt = depthAt;
    this.rand = mulberry32(seed);
    this.belief = new Belief();
    this.lastPerceive = -Infinity;
    this.decisions = [];
    this.notes = [];
  }

  /**
   * 感知：只在半径内采样，写进信念表。
   * 这不是“上帝视角”——半径外一个点都不读。
   */
  perceive(pos, tMin, radiusM = null) {
    const r = radiusM ?? this.profile.sightM;
    const step = 6;
    let seen = 0;
    let deepest = 0;
    for (let dx = -r; dx <= r; dx += step) {
      for (let dz = -r; dz <= r; dz += step) {
        if (Math.hypot(dx, dz) > r) continue;
        const x = pos.x + dx;
        const z = pos.z + dz;
        const d = this.depthAt(x, z, tMin);
        seen += 1;
        if (d > deepest) deepest = d;
        this.belief.observe(x, z, d, tMin);
      }
    }
    this.lastPerceive = tMin;
    return { seen, deepest };
  }

  /**
   * 估计一条路线的风险。
   * 只沿路径往前看 lookAhead 米；更远的地方用“附近见过的最深水 × 衰减”当先验。
   */
  estimateRoute(path, from, tMin, lookAhead) {
    if (!path || path.length < 2) {
      return { maxDepth: 0, wetRatio: 0, unknownRatio: 1, known: 0 };
    }
    const ambient = this.belief.ambient(tMin) * 0.55;
    let travelled = 0;
    let maxDepth = 0;
    let wet = 0;
    let unknown = 0;
    let known = 0;
    let prev = from;
    for (const wp of path) {
      const seg = Math.hypot(wp.p.x - prev.x, wp.p.z - prev.z);
      if (travelled + seg > lookAhead) break;
      travelled += seg;
      prev = wp.p;
      const d = this.belief.depthAt(wp.p.x, wp.p.z);
      if (d === null) {
        unknown += 1;
        maxDepth = Math.max(maxDepth, ambient);
      } else {
        known += 1;
        maxDepth = Math.max(maxDepth, d);
        if (d > 0.08) wet += 1;
      }
    }
    const n = Math.max(1, known + unknown);
    return {
      maxDepth,
      wetRatio: wet / n,
      unknownRatio: unknown / n,
      known,
      scanned: `${Math.round(travelled)} m`,
    };
  }

  /**
   * 候选行为打分。
   * 每个候选由调用方给出“做什么、代价多大、离职责多近”，这里只算效用。
   */
  scoreCandidates(candidates, ctx) {
    const p = this.profile;
    const scored = [];
    for (const c of candidates) {
      const est = this.estimateRoute(c.path, ctx.from, ctx.tMin, c.lookAhead ?? p.sightM);
      const limit = c.wadeLimit ?? p.wadeLimit;
      // 超过承受深度的部分，风险直接拉满
      const over = limit > 0 ? est.maxDepth / limit : 0;
      const risk = clamp(over, 0, 1.6);
      const survival = clamp(1 - risk * 0.92, 0, 1);

      const minutes = (c.distance || 0) / Math.max(0.5, c.speed || 1.3) / 60;
      const timeCost = clamp(minutes / 18, 0, 1);
      const effort = clamp((c.distance || 0) / 2200, 0, 1);
      const uncertainty = est.unknownRatio * (c.kind === 'wait' ? 0 : 1);

      const utility = (c.survivalWeight ?? 1.15) * survival
        + (c.duty ?? 0) * p.dutyWeight
        - (c.effortWeight ?? 0.30) * effort
        - (c.timeWeight ?? 0.34) * timeCost
        - p.riskAversion * 0.42 * uncertainty
        - (c.waitWeight ?? 0) * (1 - p.patience)
        + (this.rand() - 0.5) * 2 * p.noise;

      scored.push({
        ...c, est, risk, survival, utility,
        detail: `感知最深 ${est.maxDepth.toFixed(2)} m / 未知 ${(est.unknownRatio * 100).toFixed(0)}% / 约 ${minutes.toFixed(0)} min`,
      });
    }
    scored.sort((a, b) => b.utility - a.utility);
    return scored;
  }

  /**
   * 决策入口。返回 { chosen, scored }，并把这次权衡记进 decisions，供日志/界面展示。
   */
  decide(ctx) {
    const scored = this.scoreCandidates(ctx.candidates, ctx);
    const chosen = scored[0];
    const record = {
      t: ctx.tMin,
      situation: ctx.situation,
      chosen: chosen ? chosen.label : '—',
      reason: chosen ? chosen.reason : '',
      options: scored.map((s) => ({
        label: s.label, utility: +s.utility.toFixed(3),
        survival: +s.survival.toFixed(2), detail: s.detail,
      })),
    };
    this.decisions.push(record);
    if (this.decisions.length > 40) this.decisions.shift();
    this.notes.push(`[${ctx.tMin.toFixed(1)}] ${ctx.situation} → ${record.chosen}`);
    return { chosen, scored, record };
  }
}
