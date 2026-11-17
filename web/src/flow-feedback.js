/**
 * flow-feedback.js —— 人车 → 水 的回写场（双向耦合的另一半）
 *
 * 【为什么需要这个文件】
 * 内涝水深是 tools/flood/shallow2d.py 离线算好的一串帧，浏览器只负责播。
 * 于是耦合天生是单向的：水影响人车（减速、被困、改道），人车却改不动水。
 * 这个模块就是那条反方向的线：行人和车辆把自己「踩过水 / 泡在水里 / 熄火堵路」
 * 的事实写进一个和积水同格的场，积涝层再把场读回去，改变自己吐出来的水深。
 *
 * 三条物理通道（都只加在本格上，不重新求解 SWE）：
 *
 *   ① 涉水拖曳 → 退水延滞
 *      行人/车辆在水里搅动，局部阻力变大、泥沙再悬浮让糙率上升，这一格的
 *      退水变慢。实现上不是改方程，而是「时间重参数化」：该格读帧的时刻往
 *      回拨 delay 分钟（退水段往回拨 = 水更深、退得更晚；涨水段往回拨 =
 *      水来得更晚）。因为只是换读哪一刻，水量不被凭空创造。
 *
 *   ② 排水体积 → 局部壅高
 *      人和车泡在水里，把水挤开。V_submerged / 格面积 就是这一格水位的
 *      直接抬升量（8 m 格 = 64 m²，一个人约 1 mm，一辆泡到 0.4 m 的车约
 *      2 cm）。人以 40 s 的时间常数淡出，代表尾流重新铺平。
 *
 *   ③ 熄火停车 → 压住雨水口
 *      车在深水里停住不走，基本等于把这一格的雨水篦子盖上了。按「等效
 *      6 个人持续涉水」计入 ① 的负载，而不是另开一条通道。
 *
 * 【为什么量级这么小】这是刻意的。真实世界里一个人站在 64 m² 的水面上，
 * 水位变化是毫米级；把它调成「肉眼可见」就是假。想让效果看得见，得靠
 * 「人多」而不是「一个人很猛」：u = 等效人流密度（人/m²），只有密集人群
 * （>0.35 人/m²）才把延滞推到十几分钟。默认 24 个行人的场景里这个场几乎
 * 是空的 —— 这是对的，?ped=3000 才会看到它真的动起来。?fb=G 只用来做敏感性
 * 试验，默认 G=1，不要拿它当「效果开关」。
 *
 * 【口径】一切长度单位是米，时间单位是秒（内部）/ 分钟（对外 delay）。
 */

/** 人流记忆时间常数：一个人走过之后，这一格「记得」多久（秒）。 */
const TAU_LOAD = 900;
/** 排水体积淡出时间常数（秒）：尾流重新铺平。 */
const TAU_DISP = 40;
/** 单格最大退水延滞（分钟）。取 20 min = 一帧间隔，再大就会跨过两帧、插值失真。 */
const DELAY_MAX = 20;
/** 半饱和密度：u = U_REF 时延滞取到 DELAY_MAX 的一半（人/m²）。 */
const U_REF = 0.35;
/** 一辆熄火的车折算成几个「持续涉水的人」。 */
const STALL_EQ = 6;
/** 人体泡在水里的排水体积（m³，成年人泡到膝盖约 0.055）。 */
const V_PERSON = 0.055;
/** 轿车泡到 0.4 m 时的排水体积（m³，量级估算）。 */
const V_CAR = 1.2;

const EPS_LOAD = 1e-3;      // 人·秒
const EPS_DISP = 1e-3;      // m
const EPS_DELAY = 0.02;     // min

export function createFlowFeedback({ gain = 1 } = {}) {
  let cols = 0, rows = 0, step = 8, x0 = 0, z0 = 0, area = 64, n = 0;
  let load = null, occ = null, disp = null, delay = null, mark = null;
  let list = [];
  let ready = false;
  let waders = 0, stalled = 0, wadersFrame = 0, stalledFrame = 0;
  let G = Number(gain) > 0 ? Number(gain) : 1;
  const _s = { delay: 0, disp: 0, load: 0 };

  const cellIdx = (x, z) => {
    if (!ready) return -1;
    const c = Math.floor((x - x0) / step);
    const r = Math.floor((z - z0) / step);
    if (c < 0 || c >= cols || r < 0 || r >= rows) return -1;
    return r * cols + c;
  };

  /** 绑定积水栅格。换工况时格距/原点可能不同，尺寸变了就整场重建。 */
  function attach(g) {
    if (!g) return;
    const nc = g.cols | 0, nr = g.rows | 0;
    const nn = nc * nr;
    if (nn <= 0) return;
    step = Number(g.step_m) || step;
    x0 = Number(g.x0) || 0;
    z0 = Number(g.z0) || 0;
    area = step * step;
    if (nn === n && nc === cols && nr === rows) return;   // 同一套栅格，场留着
    cols = nc; rows = nr; n = nn;
    load = new Float32Array(n);
    occ = new Float32Array(n);
    disp = new Float32Array(n);
    delay = new Float32Array(n);
    mark = new Uint8Array(n);
    list = [];
    ready = true;
  }

  function touch(i) {
    if (!mark[i]) { mark[i] = 1; list.push(i); }
  }

  /**
   * 一个人在水里走了一步。
   * @param {number} x world x
   * @param {number} z world z
   * @param {number} depth 脚下水深（米）——只有真的在水里才算
   * @param {number} dtSec 这一步走了多少仿真秒
   */
  function wade(x, z, depth, dtSec) {
    if (!ready || !(dtSec > 0) || !(depth > 0.02)) return;
    const i = cellIdx(x, z);
    if (i < 0) return;
    load[i] += dtSec;                                   // 1 人·秒
    occ[i] += V_PERSON * Math.min(1, depth / 0.85);     // 泡得越深排水越多
    touch(i);
    waders++;
  }

  /**
   * 一辆车泡在深水里停住了（过不去 / 熄火）。
   * 它压住这一格的雨水口，同时把水挤开。
   */
  function stall(x, z, depth, dtSec) {
    if (!ready || !(dtSec > 0) || !(depth > 0.2)) return;
    const i = cellIdx(x, z);
    if (i < 0) return;
    load[i] += dtSec * STALL_EQ;
    occ[i] += V_CAR * Math.min(1, depth / 0.6);
    touch(i);
    stalled++;
  }

  /**
   * 每帧推一步：负载衰减、位移平滑、延滞重算、清理死格。
   * 【必须在所有 wade/stall 之后调用】，occ 在这一步被消费掉。
   */
  function advance(dtSec) {
    if (!ready) return;
    wadersFrame = waders; waders = 0;
    stalledFrame = stalled; stalled = 0;
    if (!(dtSec > 0) || !list.length) return;
    const kl = Math.exp(-dtSec / TAU_LOAD);
    const kd = Math.exp(-dtSec / TAU_DISP);
    let w = 0;
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      load[i] *= kl;
      // 目标壅高 = 本格被占掉的体积 / 格面积
      const target = occ[i] / area;
      disp[i] = target + (disp[i] - target) * kd;
      occ[i] = 0;
      // 等效人流密度：指数衰减的稳态值 = 速率 × TAU，再除掉面积
      const u = (load[i] / (area * TAU_LOAD)) * G;
      delay[i] = DELAY_MAX * u / (u + U_REF);
      if (load[i] < EPS_LOAD && disp[i] < EPS_DISP && delay[i] < EPS_DELAY) {
        load[i] = 0; disp[i] = 0; delay[i] = 0; mark[i] = 0;   // 归还，下一帧不再遍历
      } else {
        list[w++] = i;
      }
    }
    list.length = w;
  }

  /** 查一格的回写量（给 flood.depthAt 用）。不在格里返回 0。 */
  function sample(x, z, out) {
    out = out || _s;
    const i = ready ? cellIdx(x, z) : -1;
    if (i < 0) { out.delay = 0; out.disp = 0; out.load = 0; return out; }
    out.delay = delay[i];
    out.disp = disp[i];
    out.load = load[i];
    return out;
  }

  /** 遍历所有「还没凉」的格（给积涝层重画纹理用，O(活跃格)）。 */
  function forEachActive(fn) {
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      fn(i, delay[i], disp[i]);
    }
  }

  /** 拖时间轴 / 换工况：整个场归零。留着会拿「未来」的扰动去污染「过去」的水。 */
  function reset() {
    if (!ready) return;
    list.length = 0;
    if (mark) mark.fill(0);
    if (load) { load.fill(0); occ.fill(0); disp.fill(0); delay.fill(0); }
    waders = 0; stalled = 0; wadersFrame = 0; stalledFrame = 0;
  }

  function stats() {
    let maxDelay = 0, maxDisp = 0, sumLoad = 0;
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      if (delay[i] > maxDelay) maxDelay = delay[i];
      if (disp[i] > maxDisp) maxDisp = disp[i];
      sumLoad += load[i];
    }
    return {
      cells: list.length, maxDelay, maxDisp,
      waders: wadersFrame, stalled: stalledFrame,
      load: sumLoad, gain: G,
    };
  }

  return {
    attach, wade, stall, step: advance, sample, forEachActive, reset, stats, cellIdx,
    get ready() { return ready; },
    get grid() { return ready ? { cols, rows, step_m: step, x0, z0, area } : null; },
    get gain() { return G; },
    set gain(v) { G = Number(v) > 0 ? Number(v) : 1; },
  };
}
