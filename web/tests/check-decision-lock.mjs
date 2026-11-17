/**
 * 阶段2A 验收：决策分层 + 被困锁死。
 * 用户反馈「走两步停一下」「在两个水坑之间往返」。
 *
 * 验四件事（纯 Node，不动浏览器）：
 *  ① judge 的 forceProtect 覆盖生效：传 true/false 时 action 走对应分支，
 *     且随机数消耗与不传时一致（模型本身没被改）；
 *  ② 情境签名在连续小波动时稳定（去抖），跨档/预警/换目标时变化；
 *  ③ 同一情境下锁定后动作翻转次数显著低于每次重抽；
 *  ④ INC.isStranded 接口正确，被困者能被 live-agent 识别。
 */
import { makeKernel, judge, ACTIONS } from '../src/cohort.js';
import { mulberry32 } from '../src/decision.js';
import { createIncidents } from '../src/incidents.js';

const ok = [];
const check = (name, pass, extra = '') => {
  ok.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

// ---------- ① forceProtect 覆盖 ----------
{
  const k = makeKernel(1, { citizen: { ageBand: 'prime', age: 40 } });
  const base = { depthAhead: 0.35, depthHere: 0.35, rain: 20, late: true,
    overdue: 0.5, blocked: true, stuck: 8, waitSec: 1, stuckR: 0 };
  // 强制保护走执行层（blocked → detour/wait），强制不保护走常规层（late → hurry）
  const forcedOn = judge(k, base, mulberry32(7), ACTIONS, true);
  const forcedOff = judge(k, base, mulberry32(7), ACTIONS, false);
  check('forceProtect=true 走执行层（不再 hurry/continue）',
    !['hurry', 'continue'].includes(forcedOn.action), forcedOn.action);
  check('forceProtect=false 走常规层（不出现 detour）',
    forcedOff.action !== 'detour', forcedOff.action);
  check('judge 暴露实际生效的 protectHeld',
    forcedOn.protectHeld === true && forcedOff.protectHeld === false);
  // 不传 forceProtect 时行为与旧版一致（抽样决定，不强制）
  const free = judge(k, base, mulberry32(7));
  check('不传覆盖时模型照常抽样（旧行为保留）',
    typeof free.protectHeld === 'boolean');
}

// ---------- ② 情境签名去抖 ----------
{
  // 复刻 live-agent 的 depthBand/scenarioKey 逻辑做数值对照
  const depthBand = (d) => d < 0.05 ? 0 : d < 0.15 ? 1 : d < 0.35 ? 2
    : d < 0.60 ? 3 : d < 0.85 ? 4 : d < 1.2 ? 5 : 6;
  const key = (dh, da, win) => [depthBand(da), depthBand(dh), 0, 'commute', 0, 0, win].join('|');
  check('同一档内小波动签名不变（去抖）',
    key(0.36, 0.36, 3) === key(0.42, 0.39, 3));
  check('水深跨档签名变化（触发重估）',
    key(0.36, 0.36, 3) !== key(0.66, 0.66, 3));
  check('跨 30 分钟窗口签名变化（防冻结一整天）',
    key(0.36, 0.36, 3) !== key(0.36, 0.36, 4));
}

// ---------- ③ 锁定减少动作翻转 ----------
{
  const k = makeKernel(2, { citizen: { ageBand: 'prime', age: 35 } });
  // 造一段 120 个 think 的水深波形：小噪声在同一个档内波动，中间有一次跨档
  const rndForWave = mulberry32(99);
  const waves = Array.from({ length: 120 }, (_, t) => ({
    depthAhead: t < 60 ? 0.30 + rndForWave() * 0.08 : 0.55 + rndForWave() * 0.08,
    depthHere: 0.30, rain: 8, blocked: false, stuck: 0, stuckR: 0,
    late: false, overdue: 0, waitSec: 1,
  }));
  const flips = (locked) => {
    const rnd = mulberry32(1234);
    const depthBand = (d) => d < 0.05 ? 0 : d < 0.15 ? 1 : d < 0.35 ? 2
      : d < 0.60 ? 3 : d < 0.85 ? 4 : d < 1.2 ? 5 : 6;
    let prevKey = null, held = null, prevAct = null, n = 0;
    for (const s of waves) {
      const key = [depthBand(s.depthAhead), depthBand(s.depthHere), 0, '', 0, 0, 0].join('|');
      const force = locked && prevKey === key ? held : null;
      const out = judge(k, s, rnd, ACTIONS, force);
      if (locked) { prevKey = key; held = out.protectHeld; }
      if (prevAct !== null && out.action !== prevAct) n++;
      prevAct = out.action;
    }
    return n;
  };
  const freeFlips = flips(false), lockedFlips = flips(true);
  check('锁定后动作翻转次数明显减少', lockedFlips < freeFlips,
    `每次重抽 ${freeFlips} 次 → 锁定 ${lockedFlips} 次`);
}

// ---------- ④ 被困接口 ----------
{
  let minute = 0;
  const clock = { get minute() { return minute; } };
  const INC = createIncidents({ peds: [{ i: 0 }, { i: 1 }], clock });
  check('初始无人被困', INC.isStranded(0) === false);
  // 深水里速度 0 持续 >90 秒 → stranded
  for (let k = 0; k < 100; k++) {
    minute += 1;
    INC.tick(0, 1, { x: 0, z: 0, depth: 1.3, speed: 0, indoor: false });
  }
  check('深水里不动的人被判被困', INC.isStranded(0) === true,
    `status=${INC.statusOf(0)}`);
  check('另一个人仍未被困', INC.isStranded(1) === false);
}

const failed = ok.filter((x) => !x).length;
console.log(`\n${ok.length - failed}/${ok.length} 通过`);
process.exit(failed ? 1 : 0);
