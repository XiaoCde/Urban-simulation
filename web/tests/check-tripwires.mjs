/**
 * check-tripwires.mjs — 纯 Node，验四条绊线（A5）的判据本身，不跑真仿真。
 *
 * 一条绊线的价值在于「它会在该响的时候响、不该响的时候不响」，所以测试要同时覆盖
 * 正例和反例：真断流要报、正常心跳不报；真超时（p24 那种 420 s 只跑 320 分）要报、
 * 正常快跑不报；v4 那种死 97 对基线 21 要报、正常范围不报；NaN 要被点名、
 * JSON.stringify(NaN)→null 的「尸体」也要被识别成缺失而不是「跑完了」。
 *
 * 用法：cd web && node tests/check-tripwires.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  WATCH, createWatchdog, parseProgress, etaOf, etaVerdict, rainFamily, familyRefSec,
  scanNaN, sanityOf, tripwireSummary,
  familyInversions,
} from '../sim/tripwires.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? `  ← ${detail}` : ''}`); }
};

// ---------------------------------------------------------------- 绊线2 进度解析
const REAL_LINE = '[sim] 43% · 620.5 分 · 判断 12000 条 · 本批 61.2s · 540s';
{
  const p = parseProgress(REAL_LINE);
  ok(p && p.pct === 43 && p.minute === 620.5 && p.wallSec === 540, '进度行解析：分钟与累计墙钟（不拿「本批 61.2s」当累计）',
    JSON.stringify(p));
  ok(parseProgress('') === null && parseProgress('noise') === null, '没有进度行 → null（不编）');
  const multi = REAL_LINE + '\n' + '[sim] 60% · 900 分 · 判断 2 条 · 本批 30.0s · 800s';
  ok(parseProgress(multi).minute === 900, '多行时取最后一条进度');
}

// ---------------------------------------------------------------- 绊线2 ETA 外推
{
  const e = etaOf({ minute: 620.5, wallSec: 540, minutesTotal: 1440 });
  ok(Math.abs(e.rate - +(620.5 / 540).toFixed(4)) < 1e-9, '速率 = 仿真分钟 / 墙钟秒（保留 4 位）', String(e.rate));
  ok(e.remainingSec === Math.round((1440 - 620.5) / (620.5 / 540)), '剩余时间按同一速率外推',
    `${e.remainingSec} vs ${Math.round((1440 - 620.5) / (620.5 / 540))}`);
  ok(e.done === false, '未跑完时 done=false');
  ok(etaOf({ minute: 0, wallSec: 0, minutesTotal: 1440 }).remainingSec === null,
    '还没有进度时给 null，不编 0');

  // p24 的现场：1440 分跑了 420s 才到 320 分 → 外推总时长 ~1890s，
  // 而同批正常工况 420s 能跑完。这里验证「超 slack 就报」。
  const slow = etaOf({ minute: 320, wallSec: 420, minutesTotal: 1440 });
  ok(slow.etaWallSec > 1440, 'p24 式慢速外推出明显超过正常的总墙钟', String(slow.etaWallSec));
  ok(etaVerdict({ wallSec: 1500, expectedWallSec: slow.etaWallSec }).over === false,
    '在预期范围内不报（本来就算出慢，跑到位不算偏离）');
  ok(etaVerdict({ wallSec: 600, expectedWallSec: 420 }).over === true,
    '实际 600s / 预期 420s = 1.43× → 超 1.35 报警');
  ok(etaVerdict({ wallSec: 500, expectedWallSec: 420 }).over === false, '1.19× 不报');
  ok(etaVerdict({ wallSec: 0, expectedWallSec: 0 }).ratio === null, '缺数据时不报（不假警报）');
}

// ---------------------------------------------------------------- 绊线1 断流
{
  // 假时钟 + 假文件系统：完全确定，不用真等 8 分钟。
  let t = 1000;
  let size = 100;
  const silent = [];
  const wd = createWatchdog({
    probe: () => ({ size, mtimeMs: size }),
    now: () => t,
    silentMs: WATCH.stallMin * 60000,
    onSilent: (e) => silent.push(e),
  });
  wd.tick();                                    // 建立基线
  t += 60000; size = 200; wd.tick();             // 1 分钟后仍在长 → 有心跳
  ok(silent.length === 0, '正常心跳不报警');
  ok(wd.state.beats === 1, '心跳计数', String(wd.state.beats));

  // 断流：连续 9 分钟没变
  for (let i = 0; i < 10; i++) { t += 60000; wd.tick(); }
  ok(silent.length === 1, '连续 9 分钟无增长 → 报警一次（不刷屏）', String(silent.length));
  ok(silent[0].silentSec >= WATCH.stallMin * 60, '报警里带静默秒数', JSON.stringify(silent[0]));

  // 继续断流不重复报
  t += 60000; wd.tick();
  ok(silent.length === 1, '同一段断流只报一次');

  // 恢复心跳 → 再断 → 重新报
  size = 300; t += 60000; wd.tick();
  ok(wd.stalled === false, '恢复心跳后解除断流状态');
  for (let i = 0; i < 10; i++) { t += 60000; wd.tick(); }
  ok(silent.length === 2, '恢复后再次断流重新报警', String(silent.length));

  // probe 抛错（文件被删）不炸
  const wd2 = createWatchdog({ probe: () => { throw new Error('gone'); }, now: () => t, onSilent: () => {} });
  wd2.tick();
  ok(true, 'probe 异常不抛（跑批不能因为看门狗自己挂掉而停）');
  wd.stop();
}

// ---------------------------------------------------------------- 绊线4 NaN
{
  const hits = scanNaN({ a: 1, b: NaN, c: { d: Infinity }, e: [1, -Infinity, 3] });
  ok(hits.length === 3, 'NaN / Infinity / -Infinity 都被点名', String(hits.length));
  ok(hits.some((h) => h.path === '$.b'), '给出字段路径（$.b）', JSON.stringify(hits.map((h) => h.path)));
  ok(hits.some((h) => h.path === '$.c.d') && hits.some((h) => h.path === '$.e[1]'), '嵌套对象与数组里的也能定位');
  ok(scanNaN({ a: 1, b: 'x', c: null }).length === 0, '干净对象零误报');
  const big = Array.from({ length: 500 }, () => NaN);
  ok(scanNaN({ big }).length === 40, '命中数有上限（不炸内存）');
}

// ---------------------------------------------------------------- 绊线3 合理性
{
  const good = { dead: 21, deathsByCause: { a: 13, b: 8 }, maxDepthCm: 62 };
  const s1 = sanityOf(good, { people: 1000, baselineDead: 21 });
  ok(s1.ok === true, '正常汇总无告警', JSON.stringify(s1.issues));

  ok(sanityOf(null).ok === false, '没有结果文件 → 不通过');
  ok(sanityOf({ error: 'parse: x' }).issues.some((t) => t.includes('解析失败')), '解析失败被点名');

  const noDead = sanityOf({ maxDepthCm: 10 }, { people: 1000 });
  ok(noDead.ok === false && noDead.issues.includes('死亡数缺失'),
    '死亡数缺失（JSON.stringify(NaN) 的尸体）→ 报警，不当成 0');

  ok(sanityOf({ dead: NaN }).issues.some((t) => t.includes('不是有限数字')), 'dead 是 NaN → 点名');

  const tooMany = sanityOf({ dead: 1200 }, { people: 1000 });
  ok(tooMany.ok === false && tooMany.issues.some((t) => t.includes('超过总人数')), '死亡数超过人数 → 报警');

  const mism = sanityOf({ dead: 21, deathsByCause: { a: 13, b: 5 } });
  ok(mism.ok === false && mism.issues.some((t) => t.includes('两套口径没对齐')),
    '死因分解求和 ≠ 死亡数 → 报警');

  // v4 现场：死 97，基线 21
  const v4 = sanityOf({ dead: 97 }, { people: 1000, baselineDead: 21 });
  ok(v4.ok === false && v4.issues.some((t) => t.includes('4.6 倍')),
    'v4（死 97 / 基线 21）被拦下', JSON.stringify(v4.issues));
  const low = sanityOf({ dead: 2 }, { people: 1000, baselineDead: 21 });
  ok(low.ok === false && low.issues.some((t) => t.includes('只有基线')),
    '死亡数掉到基线的零头也报警（漏接不是「更安全」）');
  ok(sanityOf({ dead: 97 }, { people: 1000, baselineDead: null }).ok === true,
    '没有基线时只做绝对检查，不编一个基线');
}

// ---------------------------------------------------------------- 汇总
{
  const t1 = tripwireSummary({});
  ok(t1.ok === true, '四类都干净 → ok');
  const t2 = tripwireSummary({ stalled: true, eta: { over: true, ratio: 1.6 }, nan: [{ path: '$.a' }],
    sanity: sanityOf({ dead: 1200 }, { people: 1000 }) });
  ok(t2.ok === false && t2.bad.length === 4, '有告警 → 不 ok（断流/ETA/NaN/合理性各一条）', JSON.stringify(t2.bad));
  ok(t2.bad.some((b) => b.includes('断流')) && t2.bad.some((b) => b.includes('ETA')) && t2.bad.some((b) => b.includes('NaN')),
    '汇总里四类来源都保留');
}

// ------------------------------------------------- 绊线2 的参照：同族中位数
{
  ok(rainFamily('u_p8_s0') === 'uniform' && rainFamily('u_p32_s0') === 'uniform',
    '全天雨 8/16/24/32 归「全天」族');
  ok(rainFamily('u_p20_s0') === 'evening' && rainFamily('u_p120_s0') === 'evening',
    '傍晚暴雨 20/40/80/120 归「傍晚」族');
  ok(rainFamily('乱写') === 'evening' && rainFamily(null) === 'evening',
    '认不出的工况名不冒充全天族（宁可不比）');

  // 结果项的真实字段名是 case（sim-sweep 第 213 行 results.push({case,…})），不是 c —— 这里用真名。
  const done = (caseName, sec, extra = {}) => ({ case: caseName, sec, trip: { stalled: false }, sum: { dead: 1 }, ...extra });
  ok(familyRefSec('u_p24_s0', []) === 0, '没有已完成工况 → 参照 0（调用方据此不报警）');
  ok(familyRefSec('u_p24_s0', [done('u_p8_s0', 100), done('u_p16_s0', 300)]) === 300,
    '同族两个已完成 → 取上中位数（宁可晚报警，不误报）');
  ok(familyRefSec('u_p24_s0', [done('u_p8_s0', 60), done('u_p24_s0', 100), done('u_p32_s0', 140)]) === 100,
    '三个取中间那个');
  ok(familyRefSec('u_p24_s0', [done('u_p120_s0', 900)]) === 0,
    '只有傍晚族的工况 → 全天族拿不到参照（跨族不做参照）');
  ok(familyRefSec('u_p24_s0', [done('u_p8_s0', 100, { trip: { stalled: true } })]) === 0,
    '断流的工况不进参照（它没有跑完，时间不代表成本）');
  ok(familyRefSec('u_p24_s0', [done('u_p8_s0', 100, { sum: { error: 'parse: boom' } })]) === 0,
    '解析失败的工况不进参照');
  ok(familyRefSec('u_p24_s0', [done('u_p8_s0', 100), done('u_p16_s0', 200)], { upperHalf: true }) === 200,
    'upperHalf 取上四分位（留作宽松口径）');

  // 「早期线性外推」必须已经不在跑批里 —— 它是 u_p120_s0 误报 1.57× 的根因。
  const sweepTxt = readFileSync(join(ROOT, 'web', 'sim', 'sim-sweep.mjs'), 'utf8');
  ok(!/expectedWallSec = e\.etaWallSec/.test(sweepTxt), '跑批不再用「首次外推」当基准');
  ok(/familyRefSec\(c, results\)/.test(sweepTxt), '跑批的基准来自同族已完成工况');
  ok(/etaRefMissing/.test(sweepTxt) && /同族参照/.test(sweepTxt), '无参照时不报警，有参照时文案说清来源');
  ok(/仅参考，不作告警/.test(sweepTxt), '无参照时的预计时间明确标「仅参考」');
  // 进度行可能只打两行（120 人 60 分工况实测只有 66.7% 那一行），所以收尾必须再复核一次。
  ok(/整场超时/.test(sweepTxt) && /cp\.on\('close'/.test(sweepTxt),
    '收尾时用最终墙钟对比同族参照（进度行跑到一半的工况也不会漏）');
  ok(/sec > expectedWallSec \* WATCH\.etaSlack/.test(sweepTxt), '收尾复核用同一个 slack 阈值');
}

// ---------------------------------------------------------------- 接线
{
  const sweep = readFileSync(join(ROOT, 'web', 'sim', 'sim-sweep.mjs'), 'utf8');
  ok(/from '\.\/tripwires\.mjs'/.test(sweep), 'sim-sweep 引了 tripwires');
  ok(/createWatchdog/.test(sweep), '跑批里起了断流看门狗');
  ok(/parseProgress|etaOf/.test(sweep), '跑批里算 ETA');
  ok(/scanNaN|sanityOf/.test(sweep), '跑批里查 NaN 与合理性');
  ok(/killedByWatchdog/.test(sweep) && /被看门狗终止/.test(sweep),
    '被看门狗终止的工况单独标注、不当成「跑完了」');
  ok(/familyInversions/.test(sweep), '跑批用同族雨强逆转判据，不用跨雨强中位数');
  ok(!/baselineDead > 0 \?/.test(sweep) && /不再用于判据/.test(sweep),
    '跨雨强中位数基线已移除（它会把小雨工况全部误报）');
  ok(/死亡数不做跨雨强比较/.test(sweep), '控制台明说死亡数不做跨雨强比较');
}

// ---------------------------------------------------------------- 雨强逆转判据（2026-11-22 改法）
{
  // 真实的使用场景：8 工况跑批（2026-11-22 凌晨实测），同族内死亡随雨强上升，
  // 唯一的 16→24 是 30→29（差 1 人）——不该报。
  const real = [
    ['u_p8_s0', 'uniform', 8, 3], ['u_p16_s0', 'uniform', 16, 30],
    ['u_p24_s0', 'uniform', 24, 29], ['u_p32_s0', 'uniform', 32, 42],
    ['u_p20_s0', 'evening', 20, 0], ['u_p40_s0', 'evening', 40, 2],
    ['u_p80_s0', 'evening', 80, 9], ['u_p120_s0', 'evening', 120, 26],
  ].map(([cs, family, intensity, dead]) => ({ case: cs, family, intensity, dead }));
  ok(familyInversions(real).length === 0, '真实 8 工况结果不报逆转（30→29 的 1 人之差不该算异常）');

  // 跨族不能比：全天 8 mm/h 死 3、傍晚 20 mm/h 死 0，两族强度不同、时长短不同。
  ok(familyInversions([
    { case: 'u_p8_s0', family: 'uniform', intensity: 8, dead: 3 },
    { case: 'u_p20_s0', family: 'evening', intensity: 20, dead: 0 },
  ]).length === 0, '跨族不当比较（小雨族 vs 暴雨族互不参照）');

  // 真逆转：同族里 40 mm/h 死 6，80 mm/h 只死 2。
  const inv = familyInversions([
    { case: 'u_p40_s0', family: 'evening', intensity: 40, dead: 6 },
    { case: 'u_p80_s0', family: 'evening', intensity: 80, dead: 2 },
  ]);
  ok(inv.length === 1 && inv[0].from === 'u_p40_s0' && inv[0].to === 'u_p80_s0',
    '同族内雨强升高、死亡掉一半以上要报');
  ok(/不到/.test(inv[0].note) && /mm\/h/.test(inv[0].note), '提示里写清两边雨强与死亡数');

  // 低基数不比：0/1/2 人的抖动不是结构性逆转。
  ok(familyInversions([
    { case: 'u_p20_s0', family: 'evening', intensity: 20, dead: 0 },
    { case: 'u_p40_s0', family: 'evening', intensity: 40, dead: 0 },
    { case: 'u_p80_s0', family: 'evening', intensity: 80, dead: 1 },
  ]).length === 0, '低基数档（<minDead）不参与比较，避免拿 0 比 0');
  ok(familyInversions([
    { case: 'u_p80_s0', family: 'evening', intensity: 80, dead: 6 },
    { case: 'u_p120_s0', family: 'evening', intensity: 120, dead: 2 },
  ], { minDead: 10 }).length === 0, 'minDead 可调（阈值放宽后同一组不报）');
  ok(familyInversions([]).length === 0 && familyInversions(null).length === 0, '空输入不炸');
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);