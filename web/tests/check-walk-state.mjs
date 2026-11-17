/**
 * 阶段2B 验收：行人不再「走两步停一下」。
 * 只测纯函数 nextState（显示层微行为），不动浏览器。
 */
import { nextState, WALK_MIN_SEC, LOOK_MIN_SEC } from '../src/ped.js';

const ok = [];
const check = (name, pass, extra = '') => {
  ok.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

// ① 走满 WALK_MIN_SEC 之前，无论随机数怎么抽都保持 walk（除非被挡）
{
  let held = true;
  for (let t = 0; t < WALK_MIN_SEC; t += 0.2) {
    for (const r of [0, 0.001, 0.003, 0.5, 0.99]) {
      if (nextState('walk', { rnd: r, stateT: t, blocked: false }) !== 'walk') held = false;
    }
  }
  check(`走路至少持续 ${WALK_MIN_SEC}s 不被随机打断`, held);
}

// ② 被挡是事件，立刻 yield，不受最短时长限制
check('被挡立即转 yield（事件优先）',
  nextState('walk', { rnd: 0.9, stateT: 0.1, blocked: true }) === 'yield');

// ③ 走满之后，极小概率才转 look（0.6%/次，原版 1%/s）
{
  const after = nextState('walk', { rnd: 0.003, stateT: 5, blocked: false });
  check('走满后极低概率才张望', after === 'look', after);
  check('走满后绝大多数仍继续走',
    nextState('walk', { rnd: 0.5, stateT: 5, blocked: false }) === 'walk');
}

// ④ look 最短时长内不抖回 idle
{
  let held = true;
  for (let t = 0; t < LOOK_MIN_SEC; t += 0.1) {
    for (const r of [0, 0.2, 0.9]) {
      if (nextState('look', { rnd: r, stateT: t, blocked: false }) !== 'look') held = false;
    }
  }
  check(`张望至少持续 ${LOOK_MIN_SEC}s 不来回抖`, held);
}

// ⑤ 统计对比：模拟 100 个 think 周期，新版 walk→非walk 翻转次数低于旧版逻辑
{
  const oldNext = (st, r, blocked) => {
    if (st === 'walk') { if (blocked) return 'yield'; if (r < 0.010) return 'look'; return 'walk'; }
    if (st === 'look') { if (blocked) return 'yield'; if (r < 0.46) return 'idle'; if (r < 0.82) return 'walk'; return 'look'; }
    if (st === 'idle') { if (r < 0.34) return 'walk'; if (r < 0.58) return 'look'; return 'idle'; }
    return 'walk';
  };
  const run = (fn) => {
    let st = 'walk', stateT = 0, flips = 0;
    for (let k = 0; k < 200; k++) {
      const r = ((k * 1103515245 + 12345) % 65536) / 65536;
      const ns = fn(st, r);
      if (ns !== st) { flips++; stateT = 0; } else stateT += 0.7;
      st = ns;
    }
    return flips;
  };
  const oldFlips = run((st, r) => oldNext(st, r, false));
  const newFlips = run((st, r) => nextState(st, { rnd: r, stateT: st === 'walk' ? 99 : 0, blocked: false }));
  // 说明：这里给新版传 stateT=99 是「已达最短时长」，比真实情况（前 2.2s 锁住）
  // 对新版更不利，仍应因 0.6% 的更低概率而翻转更少或相当。
  check('新版状态翻转不高于旧版（同等随机流）', newFlips <= oldFlips,
    `旧 ${oldFlips} 次 → 新 ${newFlips} 次`);
}

const failed = ok.filter((x) => !x).length;
console.log(`\n${ok.length - failed}/${ok.length} 通过`);
process.exit(failed ? 1 : 0);
