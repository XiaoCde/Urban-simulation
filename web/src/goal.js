/**
 * goal.js — 一天的目标节点（慢层）。
 *
 * 【2026-11-11 用户要求】「人一般每天其实是干一些事，是有一些相应的节点的，
 *  比如说上班或回家或者说吃饭之类的，就是这些节点，我们把它设置为一个一个的
 *  目标。人就是在实现这个目标中做了一些决策，决策也包括有放弃」。
 *
 * 【2026-11-15 已换掉自设模板】旧版这里手写 4 套固定时间表
 * （上班族 9 节点 / 学生 9 节点 / 退休 8 节点 / 夜班 6 节点），
 * 几点起床、几点吃饭、几点下班全是项目自己定的分钟数，同一类人一模一样。
 * 现在节点由 kernel/day-baseline.js 按 FHWA 2022 NHTS 加权交叉表生成：
 * 出行目的 × 户内有无未成年 × 年龄段 × 出发时段，每人按自己的真实身份抽。
 *
 * 这个文件只保留状态机：节点只给时间窗和真实门牌，完成 / 放弃 / 超时
 * 一律由人在真实路网上的过程决定 —— 走到门牌才算完成，不是提前写好的结果。
 */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * 一天的骨架节点。具体门牌从 crowd-life 的 at(i, minute) 取，保证是真实地点。
 * destKey 明确指定这件事去哪里（自己家 / 岗位 / 餐馆 / 街口），模板可以换
 * 名字而不会把「放学回家」又导航回办公室。
 *
 * 【2026-11-12 精细正确】不同人群一天干的事本来就不同：学龄前儿童和退休
 * 老人不该「出门上班」，学生 16:00 放学，夜班保安白天在家、夜里在岗。
 * 时间表仍然只给时间窗与门牌，走到没走到、放不放弃全靠连续仿真决定。
 */
import { buildDayNodes, TIME_SLOTS } from './kernel/day-baseline.js';
import { samplePerson } from './kernel/population.js';
import { mulberry32 } from './decision.js';

/**
 * 不再有固定模板，也不再有「按身份挑模板」这回事。
 * 节点由真实调查分布生成，字段结构与旧版一致，状态机与 live-agent 不用改。
 */
export { TIME_SLOTS as GOAL_SLOTS };

/** 到门牌多近算「到了」——用户明确说不用做精细进门动画，给阈值直接进。 */
export const ARRIVE_R = 9;

/**
 * 给第 i 个人造一天的目标表。
 * @param {number} i 行人序号
 * @param {(i:number,m:number)=>object} atFn crowd-life.at
 * @param {number} jitter 个人错峰（分钟，正负）
 */
export function createPlan(i, atFn, jitter = 0, person = null, circle = null) {
  // 【2026-11-15】按真实 ACS 身份 + NHTS 加权交叉表排一天。
  // 同 seed 可复现；不传 person 时自己抽一条真实记录，绝不退回固定模板。
  const real = (person && person.real) || samplePerson(i, 20261115);
  const rnd = mulberry32(20261115 + i * 104729);
  const extras = (circle && Array.isArray(circle.pickups)) ? circle.pickups : [];
  const nodes = buildDayNodes(real, rnd, extras);
  const list = nodes.map((n) => {
    // 深夜休息从 0 点就已经是“当前状态”，不能被个人 ±20 分钟错峰推迟到
    // 0:20 还没有任何目标（实测一半人在 0 点成了无目标的街上游民）。
    const s = n.start === 0 ? 0 : clamp(n.start + jitter, 0, 1438);
    const due = clamp(n.due + jitter, s + 15, 1440);
    let dest = null;
    try {
      const q = atFn(i, s + 1);
      // 目的地必须按「这件事本身」取，不能按这一刻作息表碰巧写了什么取。
      // 旧版 goHome 在 17:10 读到“上班”，结果下班回家又导航回办公室；
      // lunch 在 11:55 也读到“上班”，午饭目标同样是办公室。
      const D = q && q.doors;
      // destKey 由节点自己声明，不再靠 id 猜 —— 「放学回家」不会又走回办公室。
      const d = (D && D[n.destKey || 'street']) || (D && D.street);
      const fallback = q && q.dest;
      const src = (d && Number.isFinite(d.x)) ? d : fallback;
      if (src && Number.isFinite(src.x)) dest = { id: src.id, x: src.x, z: src.z };
    } catch (e) { /* 社会层还没装配好时目标仍可生成，稍后补 */ }
    return {
      id: n.id, label: n.label, type: n.type, destKey: n.destKey,
      startMin: s, dueMin: due, dest, arrivedAt: null,
      // travel 不预写：目标激活那一刻由「当前水深 / 距离 / 雨 / 车池」现算
      // 步行还是开车（见 social-circles.chooseTravel / drive-layer.request）。
      travel: null, travelReason: '',
      priority: n.type === 'commute' ? 1 : n.type === 'pickup' ? 1.05
        : n.type === 'work' ? 0.9 : 0.6,
      state: 'pending', reason: '', startedAt: null, finishedAt: null,
    };
  });
  // 节点在数组里本来按时间排，抖动后仍保持（jitter 是同一个值）
  let idx = -1;

  const api = {
    list,
    get idx() { return idx; },
    active() { return idx >= 0 ? list[idx] : null; },
    counts() {
      const c = { pending: 0, active: 0, done: 0, abandoned: 0, timeout: 0 };
      for (const g of list) c[g.state] = (c[g.state] || 0) + 1;
      return c;
    },
    /**
     * 按「仿真时刻 + 人的真实位置」推进目标状态。
     * @returns {Array<{type:string,goal:object,reason:string}>} 本步发生的事件
     */
    step(minute, pos) {
      const ev = [];
      const g = idx >= 0 ? list[idx] : null;
      if (g && g.state === 'active') {
        const d = g.dest ? Math.hypot(pos.x - g.dest.x, pos.z - g.dest.z) : Infinity;
        const settled = g.type === 'home' || g.type === 'work';
        if (d <= ARRIVE_R) {
          if (settled) {
            // 到家/到岗不是立刻把目标删掉，而是在这里持续生活到本节点结束。
            // 旧版 00:00 一到家门口就完成“在家休息”，随后作息表又把人放街上。
            if (g.arrivedAt === null) g.arrivedAt = minute;
          } else {
            g.state = 'done'; g.reason = `走到 ${g.dest ? g.dest.id : '门口'}`;
            g.finishedAt = minute;
            ev.push({ type: 'done', goal: g, reason: g.reason });
            idx = -1;
          }
        }
        if (idx >= 0 && minute > g.dueMin) {
          const arrived = settled && (g.arrivedAt !== null || d <= ARRIVE_R);
          g.state = arrived ? 'done' : 'timeout';
          g.reason = arrived
            ? (g.type === 'home' ? '这段时间在家休息过了' : '这个工作时段结束了')
            : `过了 ${Math.round(g.dueMin / 60)} 点还没到`;
          g.finishedAt = minute;
          ev.push({ type: g.state, goal: g, reason: g.reason });
          idx = -1;
        }
      }
      // 到点激活：只挑「时间已到、还没办」的第一个；同一时刻只激活一个
      if (idx < 0) {
        for (let k = 0; k < list.length; k++) {
          const q = list[k];
          if (q.state !== 'pending') continue;
          if (minute < q.startMin) break;      // 后面的更晚，不用看了
          // 【过期节点不许被“补激活”】旧版留了 45 分钟宽限，17:10 的下班
          // 回家到了 21:40 仍会被拉起来补跑，结果把人放在半路的办事项门口。
          // 时间窗过了就是错过了，直接跳过，继续找此刻真正该办的节点。
          if (minute > q.dueMin + 20) {
            const resting = q.type === 'home' || q.type === 'sleep';
            q.state = resting ? 'done' : 'timeout';
            q.reason = resting ? '这段时间在家' : '这个时间窗已经过了';
            ev.push({ type: q.state, goal: q, reason: q.reason });
            continue;
          }
          // 【节点交界空窗】拖时间轴 / 快照落在两个节点之间时，旧版把刚过
          // 截止的节点一律判超时，于是全城人变成「街上无目标站着」。
          // 截止后 20 分钟内仍算此刻该办的事，给他 15 分钟补做（迟到）。
          // 超过 20 分钟（例如 21:40 才想起 17:10 的下班）仍然是错过。
          if (minute > q.dueMin) {
            q.dueMin = Math.min(1440, minute + 15);
            if (q.type === 'home' || q.type === 'work') q.arrivedAt = -1;
          }
          q.state = 'active'; q.startedAt = minute;
          idx = k;
          ev.push({ type: 'activate', goal: q, reason: `到点了，${q.label}` });
          break;
        }
      }
      return ev;
    },
    /** 放弃当前目标（真实行为：掉头 / 改去别处），并留下原因。 */
    abandon(reason) {
      const g = api.active();
      if (!g) return null;
      g.state = 'abandoned'; g.reason = reason || '走不下去了';
      g.finishedAt = g.finishedAt || null;
      idx = -1;
      return g;
    },
    /** 下一个还没办、且时间最接近的目标（用于放弃后立刻改道）。 */
    nextPending(minute) {
      let best = null;
      for (const q of list) {
        if (q.state !== 'pending') continue;
        if (!best || Math.abs(q.startMin - minute) < Math.abs(best.startMin - minute)) best = q;
      }
      return best;
    },
    /** 强制把某个目标设为当前（放弃后改道用）。已完成/放弃/超时的不许复活。 */
    forceActivate(goal, minute) {
      const k = list.indexOf(goal);
      if (k < 0 || !goal) return null;
      if (goal.state !== 'pending' && goal.state !== 'active') return null;
      goal.state = 'active'; goal.startedAt = minute;
      idx = k;
      return goal;
    },
  };
  return api;
}
