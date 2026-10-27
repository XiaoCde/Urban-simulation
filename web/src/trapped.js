/**
 * trapped.js —— 「被彻底困住无法逃生」的人数统计。
 *
 * 【为什么需要这个】积水深度图只说明「哪里淹了」，说明不了「人还有没有出路」。
 * 真实内涝里致命的是**连通性被切断**：一片干地变成孤岛，四周全是超过涉水极限
 * 的深水，里面的人走不出去，救援也进不来。
 *
 * 【判据：什么叫「逃掉」】
 * 把水深图变成一张「可涉水图」（深度 > WADE_MAX 不可通行），做八邻域连通域。
 * 其中**面积最大的那一块**（`mainland`）就是仍然连成一片的主城干地 ——
 * 人只要站在 mainland 上，就没被洪水切断，可以自由离开。
 * 站在其它任何一块连通域上，就是被深水围住了：
 *   · 块里有避难所（高地/屋顶）→ ISLET_SAFE：能爬到高处活下来，但**出不去**
 *   · 块里没有任何避难所       → TRAPPED：活着都成问题，**彻底被困**
 *   · 人已经泡在深水里、12 m 内连干格都没有 → DROWNING：最危险
 *
 * 【为什么不按「块里有没有避难所」直接判被困】第一版就是这么写的，实测永远是
 * 0 —— 全城有 24,119 个避难所（屋顶 + 高程前 20% 的步行网点），几乎每个连通块
 * 都落着一个，于是「有避难所=能逃」这个假设把所有人都判成安全了。可是爬到楼顶
 * 并不等于能离开灾区。判据必须是「能不能走回主城」，不是「脚下有没有高地」。
 *
 * 【判据取值依据】
 *   WADE_MAX = 0.30 m   成年人涉水极限。0.3 m 静水对成人尚可行走，0.5 m 多数人
 *                       已站不稳（流速 >0.5 m/s 时 0.15 m 就危险）。模型没有流速
 *                       场，取静水偏保守的 0.30 m。
 *   NEAR_CELLS = 2      避难所「接入格」的搜索半径（2 格 × 6 m = 12 m）。屋顶避难所
 *                       本身落在楼的格子上，而楼格在水深图里可能是 1 m 深（模型让
 *                       水穿楼而过），但人走到楼的干边就能爬上去，所以用「避难所
 *                       周围 12 m 内最近的干格」当接入点。
 *
 * 【为什么按 6 m 栅格算】flood 叠层本身就是 6 m 抽稀（996×853），85 万格做一次
 * 并查集约 20~30 ms（实测 20.6~28.3 ms），切帧时算一次完全够用；1 m 是 3000 万格，
 * 浏览器里做不动，而且被困是「街区尺度」的判断，6 m 精度绰绰有余。
 */

/** 可涉水上限（米）。超过这个深度视为不可通行。 */
export const WADE_MAX = 0.30;

/** query() 的返回值 */
export const STATE = {
  SAFE: 0,       // 在 maindland 上（或与主城连通）—— 能走掉
  ISLET_SAFE: 1, // 孤岛，岛上有高地/屋顶 —— 暂时活得下来，但出不去
  TRAPPED: 2,    // 孤岛，岛上没有任何避难所 —— 彻底被困
  DROWNING: 3,   // 已泡在深水里，12 m 内无干格
};

export function createTrappedIndex(refuges) {
  let cols = 0, rows = 0, step = 6, x0 = 0, z0 = 0;
  let scale = 2;

  // 每个避难所的栅格坐标（算一次就够，refuges 不会变）
  let refugeCells = null;       // Int32Array，格索引；-1 表示在域外

  let parent = null;            // Int32Array 并查集
  let compId = null;            // Int32Array，每格的最终连通域 id
  let root2id = null;           // Int32Array，临时映射（复用，避免每帧 new 3.4 MB）
  let compHasRefuge = null;     // Uint8Array，该连通域是否有避难所接入格
  let compCells = null;         // Int32Array，该连通域的干格数
  let mainland = -1;            // 最大连通域 id（主城干地）
  let ready = false;
  let lastKey = '';
  let lastStats = { trapped: 0, stranded: 0, drowning: 0, reachable: 0,
                    comps: 0, islets: 0, passCells: 0, mainlandCells: 0, mainlandPct: 0 };

  function setGeom(g) {
    cols = g.cols; rows = g.rows; step = g.step_m;
    x0 = g.x0; z0 = g.z0; scale = g.scale || 2;
    const n = cols * rows;
    // 避难所 → 格索引（只在几何确定后算一次）
    refugeCells = new Int32Array(refuges.length);
    for (let i = 0; i < refuges.length; i++) {
      const R = refuges[i];
      const c = Math.floor((R.x - x0) / step), r = Math.floor((R.z - z0) / step);
      refugeCells[i] = (c < 0 || c >= cols || r < 0 || r >= rows) ? -1 : r * cols + c;
    }
    parent = new Int32Array(n);
    compId = new Int32Array(n);
    root2id = new Int32Array(n);
    ready = false;
    lastKey = '';
  }

  function find(a) {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    // 路径压缩（一阶，够用）
    while (parent[a] !== r) { const nx = parent[a]; parent[a] = r; a = nx; }
    return r;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  }

  /** 在 (r,c) 周围 rad 半径内找最近的**可通行**格，返回其连通域 id；找不到返回 -1。 */
  function nearestPassComp(r, c, rad) {
    for (let d = 0; d <= rad; d++) {
      for (let dr = -d; dr <= d; dr++) {
        for (let dc = -d; dc <= d; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== d) continue;
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
          const j = rr * cols + cc;
          if (compId[j] >= 0) return compId[j];
        }
      }
    }
    return -1;
  }

  /**
   * 重算可涉水连通域。
   * @param {object} grid flood.depthGrid：{data(u8), cols, rows, step, x0, z0, scale}
   * @param {string} key  帧标识（工况|帧号），相同则跳过
   */
  function update(grid, key) {
    if (!grid || !grid.data) { ready = false; return lastStats; }
    if (grid.cols !== cols || grid.cols === 0) setGeom({
      cols: grid.cols, rows: grid.rows, step_m: grid.step,
      x0: grid.x0, z0: grid.z0, scale: grid.scale,
    });
    if (key && key === lastKey && ready) return lastStats;
    lastKey = key || '';

    const n = cols * rows;
    const data = grid.data;
    const dmax = grid.scale || scale;
    const thr = Math.round(WADE_MAX / dmax * 255);   // u8 阈值

    // ---- 1) 并查集：八邻域连通（水不会只从四个方向绕） ----
    for (let i = 0; i < n; i++) parent[i] = i;
    let passCells = 0;
    // 【坑】不能拿 parent[j] 判断邻居通不通 —— 向右/向下的邻居在扫描到它之前
    // parent[j] 还是初始化值 j（>=0），会被误判成「可通行」，结果深水带切不断
    // 连通域、全城算成一块、被困人数永远是 0。必须直接查水深 data[j]。
    for (let r = 0; r < rows; r++) {
      const base = r * cols;
      for (let c = 0; c < cols; c++) {
        const i = base + c;
        if (data[i] > thr) { parent[i] = -1; continue; }   // 深水：不可通行
        passCells++;
        if (c + 1 < cols && data[i + 1] <= thr) union(i, i + 1);
        if (r + 1 < rows) {
          const j = i + cols;
          if (data[j] <= thr) union(i, j);
          if (c + 1 < cols && data[j + 1] <= thr) union(i, j + 1);
          if (c > 0 && data[j - 1] <= thr) union(i, j - 1);
        }
      }
    }

    // ---- 2) 压实 id + 统计每块大小 ----
    // root2id 复用，避免每帧分配 3.4 MB
    root2id.fill(-1);
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (parent[i] < 0) { compId[i] = -1; continue; }
      const rt = find(i);
      let id = root2id[rt];
      if (id < 0) { id = k++; root2id[rt] = id; }
      compId[i] = id;
    }
    compCells = new Int32Array(k);
    for (let i = 0; i < n; i++) if (compId[i] >= 0) compCells[compId[i]]++;

    // ---- 3) 每块有没有避难所 ----
    compHasRefuge = new Uint8Array(k);
    for (let i = 0; i < refugeCells.length; i++) {
      const ci = refugeCells[i];
      if (ci < 0) continue;
      const id = nearestPassComp(Math.floor(ci / cols), ci % cols, 2);
      if (id >= 0) compHasRefuge[id] = 1;
    }

    // ---- 4) 主城 = 干格最多的那块 ----
    mainland = -1;
    let best = 0;
    for (let id = 0; id < k; id++) if (compCells[id] > best) { best = compCells[id]; mainland = id; }

    let islets = 0;
    for (let id = 0; id < k; id++) if (id !== mainland && compCells[id] >= 4) islets++;
    // 只统计 ≥4 格（144 m²）的孤岛：1~3 格的「孤岛」是栅格噪声，上面不会有真人

    lastStats = {
      trapped: 0, stranded: 0, drowning: 0, reachable: 0,
      comps: k, islets, passCells,
      mainlandCells: best,
      mainlandPct: passCells ? best / passCells : 0,
    };
    ready = true;
    return lastStats;
  }

  /**
   * 查询一个位置的人是否被困。
   * @returns {0|1|2|3} 见 STATE
   */
  function query(x, z) {
    if (!ready) return STATE.SAFE;
    const c = Math.floor((x - x0) / step), r = Math.floor((z - z0) / step);
    if (c < 0 || c >= cols || r < 0 || r >= rows) return STATE.SAFE;
    let id = compId[r * cols + c];
    if (id < 0) {
      // 人已经在深水里：找附近有没有能站的格
      id = nearestPassComp(r, c, 2);
      if (id < 0) return STATE.DROWNING;
    }
    if (id === mainland) return STATE.SAFE;
    // 孤岛：靠小水洼算不算孤岛，看它有没有 4 格以上；太小的当噪声，按安全处理
    if (compCells[id] < 4) return STATE.SAFE;
    return compHasRefuge[id] ? STATE.ISLET_SAFE : STATE.TRAPPED;
  }

  return {
    setGeom, update, query,
    get ready() { return ready; },
    get stats() { return lastStats; },
    /** 主城的连通域 id（调试用） */
    get mainlandId() { return mainland; },
  };
}
