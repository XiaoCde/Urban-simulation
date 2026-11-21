/**
 * check-reception-channel.mjs — 门 1「接收」渠道重分配自检（2026-11-21 新增）
 *
 * 验的是：默认中性、保均值、方向对、可关回。
 * 注意这里验的不是"某职业接收率是多少"——那个数不存在，验不了。
 */
import { WARNING_STAGES, warningStageOf } from '../src/kernel/warning.js';
import {
  RECEPTION, DUTY_POPULATION_SHARE, receiveShareFor,
  setDutyMissionRatio, setReceptionChannel,
} from '../src/kernel/reception-channel.js';

let pass = 0;
let total = 0;
function ok(name, cond, detail = '') {
  total += 1;
  if (cond) { pass += 1; console.log(`PASS  ${name}${detail ? ` (${detail})` : ''}`); }
  else console.log(`FAIL  ${name}${detail ? ` (${detail})` : ''}`);
}

const N = 20000;
function tally(ratio) {
  setDutyMissionRatio(ratio);
  const c = { never: 0, aware: 0, instruction: 0, timely: 0, dutyNever: 0, dutyN: 0 };
  for (let i = 1; i <= N; i++) {
    const isDuty = (i % 11) < 1;             // 约 9.1%，贴 ACS 的 8.9%
    const st = warningStageOf(i, isDuty);
    c[st] += 1;
    if (isDuty) { c.dutyN += 1; if (st === 'never') c.dutyNever += 1; }
  }
  return c;
}

// ---- 默认中性：必须逐位等于 Silva 的三个实测比例
const b = tally(1);
const received = (b.aware + b.instruction + b.timely) / N;
ok('默认 ratio=1：总体收到率回到 Silva 的 57%',
  Math.abs(received - WARNING_STAGES.warnedAny) < 0.01, `${received.toFixed(3)}`);
ok('默认 ratio=1：来得及（timely）比例回到 13.8%',
  Math.abs(b.timely / N - WARNING_STAGES.beforeArrival) < 0.008, `${(b.timely / N).toFixed(3)}`);
const baseDutyNever = b.dutyNever / b.dutyN;
ok('默认 ratio=1：值守人群与全人群同分布',
  Math.abs(baseDutyNever - (b.never / N)) < 0.03,
  `值守 ${baseDutyNever.toFixed(3)} vs 全人群 ${(b.never / N).toFixed(3)}`);

// ---- 保均值：ratio=2 时总量不变，只在人群内换位
const b2 = tally(2);
const received2 = (b2.aware + b2.instruction + b2.timely) / N;
ok('ratio=2：总体收到率仍然 = 57%（保均值重分配）',
  Math.abs(received2 - WARNING_STAGES.warnedAny) < 0.012, `${received2.toFixed(3)}`);
ok('ratio=2：值守人群更少「从未收到」',
  b2.dutyNever / b2.dutyN < baseDutyNever - 0.10,
  `${(b2.dutyNever / b2.dutyN).toFixed(3)} vs 基准 ${baseDutyNever.toFixed(3)}`);

// ---- 保均值的算术（纯函数，无抽样噪声）
const pDuty = receiveShareFor(true, 0.57);
const pOther = receiveShareFor(false, 0.57);
ok('receiveShareFor 保均值：加权后恰好 0.57',
  Math.abs(DUTY_POPULATION_SHARE * pDuty + (1 - DUTY_POPULATION_SHARE) * pOther - 0.57) < 1e-9,
  `duty ${pDuty.toFixed(3)} / other ${pOther.toFixed(3)}`);

// ---- 可关回
setReceptionChannel(false);
const off = tally(2);
setReceptionChannel(true);
const receivedOff = (off.aware + off.instruction + off.timely) / N;
ok('关闭后 ratio 不再起作用（总体仍 57%、值守同分布）',
  Math.abs(receivedOff - WARNING_STAGES.warnedAny) < 0.01 &&
  Math.abs(off.dutyNever / off.dutyN - baseDutyNever) < 0.03);

// ---- 元数据与敏感性区间
ok('敏感性区间是 0.5/1/2 三档', Array.isArray(RECEPTION.ratioRange) && RECEPTION.ratioRange.length === 3);
setDutyMissionRatio(1);
ok('复位到中性后 receiveShareFor 精确等于 base',
  receiveShareFor(true, 0.57) === 0.57 && receiveShareFor(false, 0.57) === 0.57);

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
