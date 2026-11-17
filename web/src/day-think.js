/**
 * day-think.js —— 让「日程里的人」也会思考。
 *
 * 现状问题（用户问「现在所有人都有 brain 了吗」）：
 *   7 个具名角色 + 24 个随机行人**都装了** decision.js 的 Brain，但只有
 *   17:52–18:35 那 43 分钟暴雨窗口里才会真的调用 decide()；剩下 23 小时
 *   完全是「照时刻表摆位置」，脑子和没有一样。
 *
 * 这里补一层日常决策：每隔 ~25 分钟，用同一套 Brain（感知 → 信念 → 候选
 * 效用打分）在「按计划 / 抄近道 / 缓一缓」之间权衡一次，结果写进各自的
 * decisions 列表（HUD 与详情面板同一份数据）。
 *
 * 为什么不是每帧：perceive() 会按 sightM 扫一遍水深栅格（约 100 次采样），
 * 31 人 × 每帧是不可接受的；25 分钟一次既像人（不会每秒改主意），又够便宜。
 */

import { WALK } from './motion-units.js';

export const DAY_THINK_STEP = 25;      // 一天分钟


/** 根据当前处境造 3 个候选。全部走同一套效用打分，不是随机数。 */
export function makeDayCandidates(q) {
  const indoor = !!q.indoor;
  const kind = q.kind || 'wait';
  const steady = indoor ? 26 : 55;
  return [
    {
      label: indoor ? '按计划继续' : '照原路走',
      reason: indoor ? '手上的事还没做完' : '这条路熟',
      distance: steady, speed: indoor ? WALK.BASE * 0.45 : WALK.BASE, duty: 0.85,
      effortWeight: 0.2, timeWeight: 0.2,
      path: [],
    },
    {
      label: '抄近道',
      reason: '想早点到',
      distance: steady * 0.72, speed: WALK.RAIN, duty: 0.55,
      effortWeight: 0.34, timeWeight: 0.12,
      path: [],
    },
    {
      label: kind === 'meal' || kind === 'sleep' ? '再缓一会儿' : '先停一下',
      reason: '时间还宽裕',
      distance: 0, speed: 0, duty: 0.3, waitWeight: 0.7,
      path: [],
    },
  ];
}

/**
 * 跑一次日常决策。
 * @returns {object|null} Brain 的决策记录（{t, situation, chosen, reason, ...}）
 */
export function dayThink(brain, q, minute, situation, who = 'anon') {
  if (!brain || !q) return null;
  try {
    brain.perceive({ x: q.x, y: q.y || 0, z: q.z }, minute);
    const out = brain.decide({
      candidates: makeDayCandidates(q),
      from: { x: q.x, y: q.y || 0, z: q.z },
      tMin: minute,
      situation: situation || q.activity || q.spot || '接下来做什么',
    });
    const rec = (out && out.record) || null;
    // 计数器不随 story.reset() 清零，验收才能统计「一天里真的想过几次」
    if (rec && typeof window !== 'undefined') {
      window.__thinkCount = (window.__thinkCount || 0) + 1;
      const w = window.__thinkWho || (window.__thinkWho = {});
      w[who] = (w[who] || 0) + 1;
    }
    return rec;
  } catch (e) {
    // 决策失败不该影响画面，但要把原因留下来（调试/验收用）
    if (typeof window !== 'undefined') window.__lastThinkErr = String(e && (e.message || e));
    return null;
  }
}
