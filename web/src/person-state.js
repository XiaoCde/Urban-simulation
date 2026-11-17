/**
 * person-state.js — 一个人的「身体状态」，与心理（Brain）分开记。
 *
 * 用户 2026-11-06：「给他们加状态值，谁打伞谁没打伞，被困时间长了，还有饥饿值，
 * 车里跟车外肯定不一样」。所以这里只回答「他在生理上处于什么状况」：
 *
 *   饥饿 hunger      0..100，按上次吃饭到现在的小时数涨，吃饭清零
 *   淋湿 wetness     0..1，雨中室外才涨；有伞涨得慢，室内/车内会干
 *   体力 stamina     0..100，跑、涉水、爬楼消耗，静止恢复；饿了恢复慢
 *   被困 trappedMin  累计「动不了且脚下有水」的分钟数
 *   位置位 inVehicle / inBuilding / outdoor，三者互斥
 *   伞   umbrella    none / closed / open
 *
 * 这些值都会反过来影响行为：饿了更想回家、淋湿了体力掉得快、被困久了会慌。
 * 心理状态（stress/mood）在 person-story 里算，但会读这里的值。
 */

import { WALK } from './motion-units.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 三餐时刻（一天分钟）与进食量。错过了就一直饿着。 */
const MEALS = [
  { at: 450, amount: 62, name: '早餐' },   // 07:30
  { at: 750, amount: 78, name: '午餐' },   // 12:30
  { at: 1170, amount: 84, name: '晚餐' },  // 19:30
];

export class PersonState {
  constructor(o = {}) {
    this.key = o.key || 'anon';
    this.profile = o.profile || {};
    this.hungerBias = (o.hunger ?? 12) - 12;   // 体质差异：干体力活的更扛不住饿
    this.hunger = o.hunger ?? 12;
    this.wetness = o.wetness ?? 0;
    this.stamina = o.stamina ?? 92;
    this.trappedMin = 0;
    this.inVehicle = false;
    this.inBuilding = false;
    this.umbrella = 'none';        // none / closed / open
    this.hasUmbrella = !!o.hasUmbrella;
    this.lastMeal = null;          // 上一次吃饭的时刻（一天分钟）
    this.meals = 0;
    this.lastTick = null;
    this.walkedM = 0;
    this.drank = 0;
  }

  /** 一天分钟回绕差（处理 24h 跨零点）。 */
  static dmin(a, b) {
    let d = b - a;
    while (d > 720) d -= 1440;
    while (d < -720) d += 1440;
    return d;
  }

  /**
   * 推进状态。
   * @param {number} dm   一天分钟（绝对）
   * @param {object} env  { depth, speed, raining, inVehicle, inBuilding, moving }
   */
  tick(dm, env) {
    const prev = this.lastTick;
    this.lastTick = dm;
    // 【即时状态先更新】伞、车内/室内是「此刻的位置位」，跟时间差的累积无关；
    // 原来放在 dt 判断之后，暂停/无头浏览器节流时 dt≈0 就永远不更新，
    // 结果下雨天所有人的伞都停在 'none'。
    this.inVehicle = !!env.inVehicle;
    this.inBuilding = !!env.inBuilding;
    const outdoor = !this.inVehicle && !this.inBuilding;
    if (!this.hasUmbrella) this.umbrella = 'none';
    else if (this.inVehicle || this.inBuilding) this.umbrella = 'closed';
    else this.umbrella = env.raining ? 'open' : 'closed';

    if (prev === null) { this.checkMeals(dm, true); return this; }
    const dtMin = Math.abs(PersonState.dmin(prev, dm));
    if (dtMin < 1e-4 || dtMin > 240) {   // 拖时间轴的大跳不累积生理量
      this.checkMeals(dm, false);
      return this;
    }

    // ---- 吃 ----
    this.checkMeals(dm, false);

    // ---- 饥饿：清醒 +6.5/h，睡着 +3/h，运动加成 ----
    const asleep = !!env.asleep;
    const effort = env.speed > WALK.METABOLIC_RUN ? 1.7 : env.speed > 0.4 ? 1.25 : 1.0;
    this.hunger = clamp(this.hunger + dtMin * (asleep ? 0.05 : 0.108) * effort, 0, 100);

    // ---- 淋湿：雨强 + 伞 ----
    // 【2026-11-12】用户要求「伞不用单独建模，后台计算状态时把伞带上」。
    // 旧版只看 raining 布尔（该工况全天为 true），淋湿速率又是常数，
    // 于是清早 3 mm/h 和傍晚 28 mm/h 淋得一样快，伞只差 20%。现在按真实
    // 雨强分级，撑开的伞挡掉约 85%，没伞的人暴雨里十几分钟就湿透 ——
    // 湿透又会通过 experience.js 改变他后面的判断与步速。
    const rate = clamp((Number(env.rainMMH) || (env.raining ? 8 : 0)) / 12, 0.25, 2.4);
    const rain = !!env.raining && outdoor;
    // 撑伞的人衣服会潮，但不该「浑身滴水」；给伞一个真实的上限，
    // 否则长时间连续仿真里所有人都会饱和到 100%，伞的差异被抹平。
    const cap = (this.hasUmbrella && this.umbrella === 'open') ? 0.55 : 1;
    if (rain) {
      const shield = this.umbrella === 'open' ? 0.85 : 0;
      this.wetness = clamp(this.wetness + dtMin * 0.030 * rate * (1 - shield), 0, cap);
    } else {
      // 室内/车内/伞下都会慢慢干；有遮蔽干得快
      const dry = this.inVehicle ? 0.028 : this.inBuilding ? 0.020
        : (this.umbrella === 'open' ? 0.012 : 0.006);
      this.wetness = clamp(this.wetness - dtMin * dry, 0, cap);
    }

    // ---- 体力 ----
    const hungryPenalty = this.hunger > 70 ? 1.6 : 1.0;
    let dStam = 0;
    if (env.speed > WALK.METABOLIC_RUN) dStam -= dtMin * 1.15 * hungryPenalty;
    else if (env.speed > 0.4) dStam -= dtMin * 0.28 * hungryPenalty;
    else dStam += dtMin * (this.wetness > 0.6 ? 0.45 : 0.85);
    if (env.depth > 0.25 && env.speed > 0.05) dStam -= dtMin * 0.55;   // 涉水很费腿
    this.stamina = clamp(this.stamina + dStam, 0, 100);

    // ---- 被困：脚下有水、又走不动 ----
    const stuck = env.depth > 0.35 && (env.speed || 0) < 0.45;
    if (stuck) this.trappedMin += dtMin;
    else if (env.speed > 1.2) this.trappedMin = Math.max(0, this.trappedMin - dtMin * 0.5);

    // ---- 伞已经在函数开头按「此刻位置位」定过了，这里不再重复 ----

    this.walkedM += (env.speed || 0) * dtMin * 60;
    return this;
  }

  /**
   * 跳到某个时刻：把饥饿一次性算到这一刻（三餐之间的累积）。
   * 拖时间轴时不能只靠逐帧累积 —— 那会永远停在上一次的数值。
   */
  seekTo(dm) {
    this.lastTick = dm;
    let h = 9;
    let last = 0;
    for (const m of MEALS) {
      if (dm < m.at) break;
      h += ((m.at - last) / 60) * 6.5;
      // 餐点过了就是吃过了（哪怕已经过去几小时），之后的饿由累积继续算
      h = Math.max(0, h - m.amount);
      this.ateAt = m.name;
      last = m.at;
    }
    h += ((dm - last) / 60) * 6.5;
    this.hunger = clamp(h + this.hungerBias * 0.35, 0, 100);
    // 淋湿/体力也按「此刻在不在雨里」给个合理初值
    this.wetness = this.umbrella === 'open' ? 0.18 : (this.inBuilding ? 0 : this.wetness);
    return this;
  }

  /** 三餐：到点且还没吃过就吃（每次只触发一次）。 */
  checkMeals(dm, quiet) {
    for (const m of MEALS) {
      if (dm < m.at) continue;
      const key = m.at;
      if (this._ate && this._ate[key]) continue;
      this._ate = this._ate || {};
      this._ate[key] = true;
      // 只有「人还清醒、且这一顿离现在不超过 3 小时」才真的吃上
      if (dm - m.at <= 180) {
        this.hunger = clamp(this.hunger - m.amount, 0, 100);
        this.meals += 1;
        this.lastMeal = { at: key, name: m.name };
        if (!quiet) this.ateAt = m.name;
      }
    }
    // 跨天清零，第二天还能再吃
    if (dm < 60 && this._ate) this._ate = {};
  }

  /** 体力对速度的乘子：0.72（虚脱）~1.0。 */
  speedFactor() {
    const stam = 0.72 + 0.28 * (this.stamina / 100);
    const wet = this.wetness > 0.55 ? 0.92 : 1.0;
    const hungry = this.hunger > 82 ? 0.88 : 1.0;
    return stam * wet * hungry;
  }

  /** 给 HUD / 决策用的中文短语。 */
  labels() {
    const hunger = this.hunger < 25 ? '不饿' : this.hunger < 50 ? '有点饿'
      : this.hunger < 75 ? '很饿' : '饿得发慌';
    const wet = this.wetness < 0.15 ? '干爽' : this.wetness < 0.45 ? '有点湿'
      : this.wetness < 0.75 ? '湿透' : '浑身滴水';
    const where = this.inVehicle ? '车内' : this.inBuilding ? '室内' : '室外';
    const um = this.umbrella === 'open' ? '撑伞'
      : this.umbrella === 'closed' ? '伞收着' : '没伞';
    const trapped = this.trappedMin < 1 ? '' : `被困 ${Math.round(this.trappedMin)} 分钟`;
    return { hunger, wet, where, um, trapped };
  }

  snapshot() {
    const l = this.labels();
    return {
      hunger: Math.round(this.hunger), wetness: Math.round(this.wetness * 100),
      stamina: Math.round(this.stamina), trappedMin: Math.round(this.trappedMin),
      inVehicle: this.inVehicle, inBuilding: this.inBuilding,
      umbrella: this.umbrella, hasUmbrella: this.hasUmbrella,
      hungerText: l.hunger, wetText: l.wet, whereText: l.where, umText: l.um,
      trappedText: l.trapped, meals: this.meals,
      ateAt: this.ateAt || null,
    };
  }
}

/** 谁备着伞、谁没有 —— 用户明确要「谁打伞谁没打伞」要有区别。 */
export const UMBRELLA = {
  mark: true,
  boss: true,
  doctor: true,
  woman: true,
  girl: true,
  worker: false,      // 工地有雨衣，嫌麻烦不带伞
  rider: false,       // 骑手有雨披，撑伞没法骑车
};
