/**
 * check-time-layer.mjs — 纯 Node，验证 §5 时间层三钟（发布 / 收到 / 动身）。
 *
 * 目的：这套改动打开后会改全部工况的数字，所以先把内核数学钉死，
 *      别等到八工况跑完才发现分布写错。
 *
 * 检查：
 *   1 publishMinOf：脉冲族（雨 1020 分）→ 990 分；全天族（雨 0 分）→ 0 分
 *   2 receiveAtOf：收不到的比例 ≈ 43%（Silva 2025：收到任何预警 57%），且落在发布的延迟窗口里
 *   3 prepMinOf：截断在 0–45 分钟，中位数接近 8
 *   4 departAtOf：= min(收到, 见水) + 准备时间，且不早于「知道」那一刻
 *   5 开关默认关闭，且关掉时 warnAtOf() 仍然工作（旧路径没被改坏）
 *
 * 用法：node tests/check-time-layer.mjs
 */
import {
  TIMELAYER, TIMELAYER_META, publishMinOf, receiveAtOf, prepMinOf, departAtOf,
  timeLayerOn, setTimeLayer, receivesWarning, warnAtOf, warningLeadMin,
} from '../src/kernel/warning.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? ' → ' + extra : '')); }
};
const N = 5000;

console.log('[1] 发布时刻');
ok(publishMinOf(1020) === 990, '脉冲族：雨 1020 分 → 发布 990 分', publishMinOf(1020));
ok(publishMinOf(0) === 0, '全天族：雨 0 分 → 发布 0 分', publishMinOf(0));
ok(publishMinOf(undefined) === 0, '缺 manifest 时退回 0', publishMinOf(undefined));

console.log('[2] 收到时刻');
let never = 0;
const recvAt990 = [];
for (let i = 0; i < N; i++) {
  const t = receiveAtOf(990, i);
  if (!Number.isFinite(t)) never++; else recvAt990.push(t);
}
const neverShare = never / N;
ok(Math.abs(neverShare - 0.43) < 0.02,
  `收不到比例 ${(neverShare * 100).toFixed(1)}% ≈ 43%（Silva 2025 Ahr：57% 收到任何预警）`, neverShare);
const lo = TIMELAYER.receiveClipMin[0], hi = TIMELAYER.receiveClipMin[1];
ok(recvAt990.every((t) => t >= 990 - 1e-9 && t <= 1440 + 1e-9),
  '收到时刻落在 [发布, 当天结束] 里（延迟改由 Eq.(S1) 扩散曲线给，不再有 [5,600] 截断）');
recvAt990.sort((a, b) => a - b);
const recvMedianOffset = recvAt990[Math.floor(recvAt990.length / 2)] - 990;
// 曲线锚定论文 Table S2 的累计点（8h 74.3%、24h 90.0%、72h 95.0%），
// 0→8h 段按 log1p 插值，中位自然落在 60 分上下，不再有"中位 60 分"这个自设目标。
ok(recvMedianOffset > 50 && recvMedianOffset < 80,
  `收到延迟中位数 ${recvMedianOffset.toFixed(0)} 分（Table S2 A1.2 锚点插值）`, recvMedianOffset);
ok(never === N - recvAt990.length, '收得到的都算出了有限时刻');

console.log('[3] 准备时间');
const preps = [];
for (let i = 0; i < N; i++) preps.push(prepMinOf(i));
ok(preps.every((p) => p >= TIMELAYER.prepClipMin[0] && p <= TIMELAYER.prepClipMin[1]),
  '准备时间截断在 0–45 分');
const ps = preps.slice().sort((a, b) => a - b);
const prepMedian = ps[Math.floor(ps.length / 2)];
ok(prepMedian > 5 && prepMedian < 12, `准备时间中位数 ${prepMedian.toFixed(1)} 分 ≈ 8`, prepMedian);

console.log('[4] 动身时刻');
ok(departAtOf(Infinity, Infinity, 3) === Infinity, '既没收到又没见水 → 永不动身');
const d1 = departAtOf(1000, 1100, 7);
ok(d1 >= 1000 && d1 <= 1045, '收到早于见水 → 动身 = 收到 + 准备', d1);
const d2 = departAtOf(1400, 1200, 7);
ok(d2 >= 1200 && d2 <= 1245, '见水早于收到 → 动身 = 见水 + 准备', d2);
ok(departAtOf(600, Infinity, 11) >= 600, '只有广播的人从广播起算');
let mono = true;
for (let i = 0; i < N; i++) {
  const a = departAtOf(receiveAtOf(990, i), 1300, i);
  const b = departAtOf(receiveAtOf(960, i), 1300, i);
  if (!(b <= a + 1e-9)) mono = false;
}
ok(mono, '发布提前 30 分钟 → 动身中位单调前移（不会出现「越早预警越晚动」）');

console.log('[5] 开关与旧路径');
ok(timeLayerOn() === false, '默认关闭（不打开时行为与 v2 一致）');
setTimeLayer(true);
ok(timeLayerOn() === true, 'setTimeLayer(true) 生效');
setTimeLayer(false);
const legacy = warnAtOf(1200, 5);
ok(Number.isFinite(legacy) || !receivesWarning(5),
  '关掉时旧 warnAtOf() 仍然工作（收不到的人本来就该是 Infinity）', legacy);
let fi = -1;
for (let i = 0; i < 1000 && fi < 0; i++) if (receivesWarning(i)) fi = i;
ok(fi >= 0 && Number.isFinite(warnAtOf(1200, fi)) && warnAtOf(1200, fi) < 1200,
  `收到预警的人（i=${fi}）仍有有限的旧时刻`, warnAtOf(1200, fi));
ok(Number.isFinite(warningLeadMin(5)) && receivesWarning(5) === Number.isFinite(warnAtOf(500, 5)),
  '旧路径收不到的人仍是 Infinity');
ok(TIMELAYER_META.selfSet.length >= 3, '自设项都在元数据里标出来了');

console.log(`\n结果 ${pass} 通过 · ${fail} 失败`);
process.exit(fail ? 1 : 0);