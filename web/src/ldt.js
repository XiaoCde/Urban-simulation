/**
 * 最晚出发时刻（LDT, Latest Departure Time）图层 —— 回答「人一直在动」这件事。
 *
 * 原来 `trapped.js` 判定的是**静止快照**：此刻你脚下这格通不通。隐含假设人站着不动。
 * 真实疏散是人一直在走，能不能活取决于两件事谁先到：
 *     「水什么时候淹掉你这条路」   vs   「你走到干地要多久」
 * 把第一件事算成 tau（每格第一次不可通行的时刻），
 * 把两件事合起来算成 LDT（从这格出发、最晚什么时候走还能到高处）。
 * 于是每个人的剩余逃生时间就是一次查表：
 *
 *     margin(x, z, t) = LDT(x, z) - t
 *
 *   margin > 0  还来得及，富余这么多分钟（会随播放的 t 慢慢变小 → 像人在跑）
 *   margin <= 0 这条路已经来不及了：现在出发也到不了，会困死在原地
 *
 * 数据由 `tools/ped/export_ldt.py` 生成，两种文件：
 *   <case>.json  meta（栅格几何、阈值、统计）
 *   <case>.u16   uint16 分钟，行主序，编码见下
 *
 * 编码（必须和导出脚本一致）：
 *     0     没有步行网覆盖（没人会站这儿，查表返回 null）
 *     65534 开局（t=0）就已经泡在深水里，不能当出生点，也没有余量
 *     65535 整个情景都不会淹（无截止时刻）
 *     其它  最晚出发时刻（分钟）
 */

export const LDT_NEVER = 65535;
export const LDT_WET0 = 65534;

/** 无界余量：整个情景都不会淹，可以理解成「什么时候走都行」 */
const INF_MARGIN = 1e6;
/** 开局就在水里的那些人：给一个明确的「已经来不及」而不是假装有富余 */
const DEAD_MARGIN = -1e6;

/**
 * 载入 LDT 图层。
 * @param {string} caseName  网页工况名（和 #flCase 的 value 同名，如 `p25_s4`）
 * @param {string} base      资源前缀，默认 `/assets/ldt/`
 */
export async function loadLdt(caseName, base = '/assets/ldt/') {
  if (!caseName) throw new Error('loadLdt: 没给工况名');
  const jr = await fetch(base + caseName + '.json');
  if (!jr.ok) throw new Error(`LDT 清单 ${caseName}.json HTTP ${jr.status}`);
  const meta = await jr.json();
  const br = await fetch(base + caseName + '.u16');
  if (!br.ok) throw new Error(`LDT 数据 ${caseName}.u16 HTTP ${br.status}`);
  const data = new Uint16Array(await br.arrayBuffer());

  const cols = meta.cols | 0, rows = meta.rows | 0;
  const step = +meta.step_m, x0 = +meta.x0, z0 = +meta.z0;
  if (data.length !== cols * rows) {
    throw new Error(`LDT 尺寸不符：${data.length} != ${cols * rows}`);
  }

  // 与 trapped.js:200 完全同源的坐标变换（plan 坐标 → 栅格行列）
  const cellOf = (x, z) => {
    const c = Math.floor((x - x0) / step);
    const r = Math.floor((z - z0) / step);
    if (c < 0 || c >= cols || r < 0 || r >= rows) return -1;
    return r * cols + c;
  };

  return {
    meta, cols, rows, step, x0, z0, data,
    caseName,

    /** 这一格的原始编码（诊断用） */
    codeAt(x, z) {
      const i = cellOf(x, z);
      return i < 0 ? 0 : data[i];
    },

    /**
     * 剩余逃生余量（分钟）。
     * @returns {number|null} null = 这格没有 LDT（不在步行网上）
     */
    marginAt(x, z, nowMin) {
      const i = cellOf(x, z);
      if (i < 0) return null;
      const v = data[i];
      if (v === 0) return null;
      if (v === LDT_WET0) return DEAD_MARGIN;
      if (v === LDT_NEVER) return INF_MARGIN;
      return v - (nowMin || 0);
    },

    /** 能不能拿这一格当出生点（开局就淹的格不行，否则人站在 4 m 水里）。
     *  没覆盖（0）是允许的：步行网边缘难以插值时不该因此封掉整条街。 */
    spawnOk(x, z) {
      const i = cellOf(x, z);
      if (i < 0) return false;
      return data[i] !== LDT_WET0;
    },

    /** 给 HUD 用的一句话摘要 */
    summary() {
      const m = this.meta || {};
      return {
        nodes: m.nodes, destNodes: m.dest_nodes, floodedNodes: m.flooded_nodes,
        wetAtT0: m.wet_at_t0_nodes, reachable: m.reachable_nodes,
        unreachable: m.unreachable_nodes, medianLdt: m.ldt_median_min,
        run: m.run, wadeMax: m.wade_max_m, speed: m.walk_speed_mps,
      };
    },
  };
}