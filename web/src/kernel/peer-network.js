/**
 * peer-network.js — 参照群体（社会网络）生成器：Kleinberg 小世界 + 三类接触
 *
 * 为什么要有这个文件
 * ------------------
 * 2026-11-21 之前，参照群体是 `crowd-life.js` 里一段**自己定**的规则：
 * 「同户 + 住址 120 m 内最多 3 个邻居（优先不同楼）」。它能修掉一个真失真——
 * 独居者（ACS 户规模=1，DC 占三成）此前没有任何同伴，`peersStay=0` 被 Borowski
 * 的问卷口径读成「同伴全走光了」，凭空多出一股撤离压力——但代价是「住得近」
 * 被当成了「认识」，而且这个 120 m / 3 人没有任何文献可引。
 *
 * 现在换成**发表过的生成方法**，好回答「这个网络哪来的」：
 *
 *  1. 结构：Kleinberg 小世界（short-range radius d_sr + 每节点 q 条幂律长程边
 *     ∝ d^-r, r=2），这是 Kuhlman et al. 2020 (AAMAS 19, pp.654–662) §2.2 +
 *     Table 1 的合成人口网络做法；他们自己也把 d_sr 与 q 各扫一遍报稳健性
 *     （§4.2, Fig.4）——所以「扫参数」不是我们发明的，是照他们的做法做。
 *  2. 备选结构：Newman (2003b) 配置模型 + 多社区边混合矩阵，即 Hasan & Ukkusuri
 *     2011 (TR-C 19:1219–1234) §4 Stage I 的生成方式。本文件按 Kleinberg 实现
 *     （空间上可解释，且不需要边混合矩阵这种我们估不出来的量）。
 *  3. 三类接触：家庭（ACS 户结构，同户互为同伴）／工作（同办公楼的同事，来自
 *     SOC→场所映射与 FDW 分配）／邻里（d_sr 内的住户，优先不同楼）。
 *     **学校这一类没接**——合成人口里没有学校实体，硬造一个会变成新的自设。
 *  4. 规模上限 5：Borowski 2023 第四轮问卷 QA9 的自我中心网络「至多 5 人」。
 *     这是问卷设计上限，不是我们挑的数。
 *
 * 名额怎么分（5 个上限怎么花）：家庭边先占（ACS 户规模 1–5），剩下的名额按
 * 「同事 1 / 长程 1 / 邻里补满」分配。**这一步是自设的预算分配**，文献只给了
 * 上限 5 人，没给三类接触各几条——所以它写在 selfSet.budget 里，并用
 * shortRangeQuota/workQuota 两个参数暴露出来供扫。
 */

/** 运行时参数（可被 ?peer= / ?peerR= / ?peerQ= / SIM_PEER* 覆盖） */
export const PEER_NETWORK = {
  mode: 'synthetic',      // 'synthetic' | 'neighbour' | 'household'
  shortRangeM: 120,       // d_sr：邻里半径（自设，Kuhlman 扫 40/70/100 m，我们街区尺度取 120）
  longRangeQ: 1,          // q：每人长程边数（自设，Kuhlman 扫 0–32）
  longRangePower: 2,      // Kleinberg r=2：长程边概率 ∝ d^-r
  maxPeers: 5,            // Borowski 2023 QA9：自我中心网络至多 5 人（实测设计上限）
  extraTies: 3,           // 非家庭同伴目标数（自设：同户之外再给 3 条接触）
  workQuota: 1,           // 其中同事最多 1 条
  neighbourK: 3,          // 旧规则 'neighbour' 模式的邻居数，仅用于对照
};

const MODES = new Set(['synthetic', 'neighbour', 'household']);

export function setPeerMode(mode) {
  const m = String(mode || '').toLowerCase();
  if (!MODES.has(m)) return false;
  PEER_NETWORK.mode = m;
  return true;
}

export function setPeerParams({ shortRangeM, longRangeQ, maxPeers, neighbourK, extraTies, workQuota } = {}) {
  const setNum = (v, lo, hi, key) => {
    const x = Number(v);
    if (!Number.isFinite(x) || x < lo || x > hi) return false;
    PEER_NETWORK[key] = x;
    return true;
  };
  const out = [];
  if (shortRangeM !== undefined) out.push(setNum(shortRangeM, 10, 2000, 'shortRangeM'));
  if (longRangeQ !== undefined) out.push(setNum(longRangeQ, 0, 8, 'longRangeQ'));
  if (maxPeers !== undefined) out.push(setNum(maxPeers, 1, 12, 'maxPeers'));
  if (neighbourK !== undefined) out.push(setNum(neighbourK, 1, 12, 'neighbourK'));
  if (extraTies !== undefined) out.push(setNum(extraTies, 0, 8, 'extraTies'));
  if (workQuota !== undefined) out.push(setNum(workQuota, 0, 8, 'workQuota'));
  return out.every(Boolean);
}

/** 确定性伪随机（同一 seed 同一张图；不用 Math.random，否则跑批不可复现） */
export function mulberry32(seed) {
  let a = (Number(seed) >>> 0) || 0x9e3779b9;
  return function rnd() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * buildPeerNetwork — 生成每人的参照群体
 *
 * 生成顺序：家庭 → 同事 → 长程 → 邻里（邻里最后，用剩下的名额补满）。
 * 顺序本身是设计选择：稀有边（同事/长程）先占位，否则永远被密集的邻里边挤掉
 * ——第一版就是先补邻里，结果 `workEdges=0`、`longRangeEdges=0`，两个机制
 * 「看着接了、实际从不发生」。
 *
 * @param {Array<{i:number, homeDoor?:{x:number,z:number}, homeBuilding?:string,
 *                workBuilding?:string, household?:number[]}>} persons
 * @returns {{peers:number[][], stats:object}}
 */
export function buildPeerNetwork(persons, opts = {}) {
  const mode = MODES.has(opts.mode) ? opts.mode : PEER_NETWORK.mode;
  const shortRangeM = Number.isFinite(opts.shortRangeM) ? opts.shortRangeM : PEER_NETWORK.shortRangeM;
  const longRangeQ = Number.isFinite(opts.longRangeQ) ? opts.longRangeQ : PEER_NETWORK.longRangeQ;
  const longRangePower = Number.isFinite(opts.longRangePower) ? opts.longRangePower : PEER_NETWORK.longRangePower;
  const maxPeers = Number.isFinite(opts.maxPeers) ? opts.maxPeers : PEER_NETWORK.maxPeers;
  const extraTies = Number.isFinite(opts.extraTies) ? opts.extraTies : PEER_NETWORK.extraTies;
  const workQuota = Number.isFinite(opts.workQuota) ? opts.workQuota : PEER_NETWORK.workQuota;
  const neighbourK = Number.isFinite(opts.neighbourK) ? opts.neighbourK : PEER_NETWORK.neighbourK;
  const seed = Number.isFinite(opts.seed) ? opts.seed : 20261122;

  const n = persons.length;
  const sets = Array.from({ length: n }, () => new Set());
  const stats = {
    mode, shortRangeM, longRangeQ, longRangePower, maxPeers, extraTies, workQuota, seed,
    householdEdges: 0, shortRangeEdges: 0, workEdges: 0, longRangeEdges: 0,
  };
  // 每人目标度数（先算，空输入也要能安全返回）
  const targets = new Array(n);
  for (let i = 0; i < n; i++) {
    const hh = Array.isArray(persons[i].household) ? persons[i].household.length : 0;
    targets[i] = Math.max(0, Math.min(maxPeers, hh + (mode === 'neighbour' ? neighbourK : extraTies)));
  }
  if (n === 0) return finish(sets, stats, targets);

  // 目标度数在函数入口已算好（见上）。约束口诀：**双端都受目标约束**——只约束主动方会让
  // 「别人加我」把我撑过目标；第一版就是这样，实测人均 4.98（几乎人人 5 个）。

  const add = (a, b) => {
    if (a === b || a < 0 || b < 0 || a >= n || b >= n) return false;
    if (sets[a].size >= targets[a] || sets[b].size >= targets[b]) return false;
    if (sets[a].has(b)) return false;
    sets[a].add(b); sets[b].add(a);
    return true;
  };

  // ---- 1) 家庭边：同户成员互为同伴（ACS 户结构，真实数据集）
  let hhPairs = 0;
  for (let i = 0; i < n; i++) {
    const hh = Array.isArray(persons[i].household) ? persons[i].household : [];
    for (const j of hh) {
      if (j === i || j < 0 || j >= n) continue;
      if (sets[i].has(j)) continue;
      sets[i].add(j); sets[j].add(i); hhPairs++;   // 家庭边不受目标限制（户规模来自 ACS）
    }
  }
  // 家庭边用 sets[i].has(j) 去重，每个无向对只记一次（不再除以 2——那是上一版双向各记一次的遗留，
  // 结果 stats 报 313、实测 625，测试当场打红）
  stats.householdEdges = hhPairs;

  if (mode === 'household') return finish(sets, stats, targets);

  // 坐标与网格（邻里边与长程边的距离都要用）
  const pos = persons.map((p) => {
    const hd = p.homeDoor;
    return hd && Number.isFinite(hd.x) && Number.isFinite(hd.z) ? { x: hd.x, z: hd.z } : null;
  });

  // ---- 2) 工作边：同一栋办公楼的同事（来自 SOC→场所映射与办公楼分配，非随机）
  //  实现方式是**两两配对**（楼内确定性洗牌后相邻两人成对），而不是「每人各挑一个」：
  //  后者在无向图里会让每个人既挑人又被挑，实得约 2 条同事边，把 5 人名额吃光。
  if (mode === 'synthetic' && workQuota > 0) {
    const byWork = new Map();
    for (let i = 0; i < n; i++) {
      const wb = persons[i].workBuilding;
      if (!wb) continue;
      if (!byWork.has(wb)) byWork.set(wb, []);
      byWork.get(wb).push(i);
    }
    const rndW = mulberry32(seed ^ 0x5f3759df);
    const workDone = new Uint8Array(n);
    for (const [, raw] of [...byWork.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
      if (raw.length < 2) continue;
      const list = raw.slice();
      for (let m = list.length - 1; m > 0; m--) {          // 确定性洗牌
        const t = Math.floor(rndW() * (m + 1));
        const tmp = list[m]; list[m] = list[t]; list[t] = tmp;
      }
      for (let m = 0; m + 1 < list.length; m += 2) {
        const a = list[m], b = list[m + 1];
        if (workDone[a] || workDone[b]) continue;
        if (sets[a].size >= targets[a] || sets[b].size >= targets[b]) continue;
        if (add(a, b)) { stats.workEdges++; workDone[a] = 1; workDone[b] = 1; }
      }
    }
  }

  // ---- 3) 长程边：Kleinberg 幂律（接受概率 (d_sr/d)^r），每人约 1 条
  //  同样两两成对（`longDone` 标记两端），否则每人各挑一条会让长程度数翻倍。
  if (mode === 'synthetic' && longRangeQ > 0) {
    const rnd = mulberry32(seed);
    const longDone = new Uint8Array(n);
    for (let q = 0; q < longRangeQ; q++) {
      for (let i = 0; i < n; i++) {
        if (longDone[i] || sets[i].size >= targets[i]) continue;
        let target = -1;
        for (let t = 0; t < 64; t++) {
          const j = Math.floor(rnd() * n);
          if (j === i || longDone[j]) continue;
          if (sets[i].has(j) || sets[j].size >= targets[j] || sets[i].size >= targets[i]) continue;
          if (!pos[i] || !pos[j]) { target = j; break; }
          const d = Math.hypot(pos[j].x - pos[i].x, pos[j].z - pos[i].z);
          const pAcc = Math.min(1, (shortRangeM / Math.max(d, 1)) ** longRangePower);
          if (rnd() < pAcc) { target = j; break; }
        }
        if (target >= 0 && add(i, target)) {
          stats.longRangeEdges++; longDone[i] = 1; longDone[target] = 1;
        }
      }
    }
  }

  // ---- 4) 邻里短程边：用剩下的名额，从 d_sr 内的住户里补满，优先不同楼
  if (mode === 'neighbour' || extraTies > 0) {
    const CELL = Math.max(20, shortRangeM / 2);
    const grid = new Map();
    for (let i = 0; i < n; i++) {
      if (!pos[i]) continue;
      const k = `${Math.floor(pos[i].x / CELL)},${Math.floor(pos[i].z / CELL)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
    const span = Math.ceil(shortRangeM / CELL) + 1;
    for (let i = 0; i < n; i++) {
      if (!pos[i] || sets[i].size >= targets[i]) continue;
      const limit = targets[i];
      const cx = Math.floor(pos[i].x / CELL), cz = Math.floor(pos[i].z / CELL);
      const cand = [];
      for (let dx = -span; dx <= span; dx++) {
        for (let dz = -span; dz <= span; dz++) {
          const arr = grid.get(`${cx + dx},${cz + dz}`);
          if (!arr) continue;
          for (const j of arr) {
            if (j === i || sets[i].has(j)) continue;
            const d = Math.hypot(pos[j].x - pos[i].x, pos[j].z - pos[i].z);
            if (d > shortRangeM) continue;
            const sameBuilding = persons[j].homeBuilding && persons[j].homeBuilding === persons[i].homeBuilding ? 1 : 0;
            cand.push([sameBuilding, d, j]);
          }
        }
      }
      if (!cand.length) continue;
      cand.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      for (let m = 0; m < cand.length && sets[i].size < limit; m++) {
        if (add(i, cand[m][2])) stats.shortRangeEdges++;
      }
    }
  }

  return finish(sets, stats, targets);
}

function finish(sets, stats, targets = []) {
  const peers = sets.map((s) => [...s].sort((a, b) => a - b));
  let degSum = 0, isolated = 0;
  const hist = {};
  for (const p of peers) {
    degSum += p.length;
    if (p.length === 0) isolated++;
    hist[p.length] = (hist[p.length] || 0) + 1;
  }
  stats.degreeSum = degSum;
  stats.isolated = isolated;
  stats.meanDegree = peers.length ? +(degSum / peers.length).toFixed(3) : 0;
  stats.isolateShare = peers.length ? +(isolated / peers.length).toFixed(4) : 0;
  stats.degreeHist = hist;
  stats.targetMean = sets.length ? +(targets.reduce((a, b) => a + b, 0) / sets.length).toFixed(3) : 0;
  stats.edges = Math.round(degSum / 2);
  return { peers, stats };
}

export const PEER_NETWORK_META = Object.freeze({
  version: '2026-11-22',
  replaced: 'crowd-life.js 旧规则「同户 + 120 m 内最多 3 个邻居（优先不同楼）」——没有文献可引',
  structure: 'Kleinberg 小世界：短程半径 d_sr + 每节点 q 条幂律长程边（∝ d^-2）；名额上限 5 人',
  tieOrder: '家庭 → 同事 → 长程 → 邻里（邻里最后补满）',
  alternatives: ['Newman (2003b) 配置模型 + 多社区边混合矩阵（Hasan & Ukkusuri 2011, TR-C 19:1219–1234, §4 Stage I）'],
  ties: {
    household: 'ACS 户结构（data/real/acs_dc.json 的户规模/关系码派生），真实数据集',
    work: '同一栋办公楼的同事；办公楼来自 SOC→场所映射与 FDW 分配，非随机',
    neighbour: 'd_sr 内的住户，优先不同楼（同楼常处在同一片积水里）',
    school: '未接：合成人口里没有学校实体，硬造会引入新的自设',
  },
  sources: {
    kleinbergSmallWorld: 'Kuhlman C.J. et al. 2020, AAMAS 19, pp.654–662, §2.2 + Table 1（d_sr 0.04/0.07/0.10 km、q 0/2/4/8/16/32）；同文 §4.2 Fig.4 对 d_sr 与 q 各扫一遍报稳健性',
    configurationModel: 'Newman M.E.J. 2003, SIAM Review 45(2):167–256；Hasan & Ukkusuri 2011, TR-C 19:1219–1234 §4 Stage I（该文明确没有任何真实网络标定，只引机制）',
    maxPeers: 'Borowski 2023 第四轮问卷 QA9：自我中心网络由姓名生成题引出、**至多 5 人**——每人上限 5 是问卷设计上限',
    household: 'ACS PUMS 微样本（户规模、与户主关系码）',
  },
  selfSet: {
    budget: '目标度数 = 同户成员数 + 3 条非家庭接触（同事最多 1、长程 1、其余邻里，封顶 5）；「额外 3 条」是自设，扫 extraTies=1/3/5',
    shortRangeM: '120 m —— Kuhlman 扫 40/70/100 m，我们街区尺度更大；敏感性扫 60/120/240 m',
    longRangeQ: '1 条/人 —— Kuhlman 扫 0–32，我们要保留 5 人小规模；敏感性扫 0/1/2',
    longRangePower: '2 —— Kleinberg 可导航性最优指数，属方法常数而非拟合值',
  },
  limits: [
    '不是社会网络调查：结构由发表方法生成，某条边是否存在仍是假设',
    '学校这一类接触没接（合成人口无学校实体）',
    '工作边只覆盖「有办公楼坐标」的人；户外/流动职业没有工作边',
    '长程边不区分「远亲/同乡/线上联系人」，只是幂律距离衰减的占位机制',
    '邻里边仍是「住得近」的代理，不是「认识」的证据',
  ],
});