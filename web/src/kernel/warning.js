import { receiveShareFor } from './reception-channel.js';
import { hash01 } from './draw.js';

/**
 * 预警接收（内核判定，纯函数，不碰 window / document / three）
 *
 * 【为什么要有这个模块】2026-11-17 之前，运行时把「收到官方预警」写成
 * 「降雨开始之后」——而这批工况的降雨从 0 点起，等于午夜一到全城每个人都
 * 收到了预警，然后一路累积到傍晚十九个小时。认知层的官方预警项（系数
 * +0.571）与时间层的实测动员曲线（Silva 2025）都建立在这个值上，于是
 * 全城被按「最知情」在算，保护行动系统性偏高。
 *
 * 【依据】Thieken 等 2022（NHESS 22:165–185）表 4、表 5，2016 年德国
 * 地表水内涝子样本 n = 448（表 5 的预警来源 n = 448，预警前置时间 n = 141）：
 *   · 完全没收到任何预警、事前也不知道的比例：35.5%
 *   · 预警前置时间：均值 2.5 小时、中位数 1 小时
 *   · 察觉方式里最多的是「自己看到水位」（47.3%），其次才是官方天气预警
 *     （13.6%）与邻里告知（7.6%）
 *
 * 第三条决定了这个模块的形状：内涝里面大多数人不是被广播叫醒的，是看见
 * 水才知道。所以这里把「收到预警的时刻」挂在他**本地水深第一次超过 3 cm**
 * 的前面若干分钟，而不是挂在一个统一的城市时刻上。这是近似，写在下面。
 *
 * 【这是近似，不是实测】前置时间的分布形式（对数正态）是我们选的，
 * 只为同时对上「中位数 1 小时」和「均值 2.5 小时」两个数；论文只给这两个
 * 统计量，没印分布。谁也没测过「某人比他脚下见水早多少分钟收到短信」。
 */

/** 文献里的实测值（Thieken 2022 表 4）。 */
export const WARNING_MEASURED = Object.freeze({
  // 【2026-11-21 统一口径】不再用 Thieken 2022 的 35.5%，改用 Silva 2025 Ahr 重建的
  // 「收到任何预警 57%」→ 收不到 43%。理由：三段比例 0.57/0.175/0.138 是同一事件、
  // 同一样本里量出来的，混用另一篇的 35.5% 会让 0.175 失去分母。
  // Thieken 的 35.5% 保留作敏感性口径（neverWarnedShareAlt），不做默认。
  neverWarnedShare: 0.43,
  neverWarnedShareAlt: 0.355,
  leadMedianMin: 60,         // 前置时间中位数（分钟）
  leadMeanMin: 150,          // 前置时间均值（分钟）
  awareByOwnObservation: 0.473,  // 靠自己看到水察觉
});

/**
 * 【目前自己定的】分布形式与截断。论文只给中位数、均值两个统计量。
 */
export const WARNING_SELF_SET = Object.freeze({
  /** 前置时间按对数正态：由中位数 60、均值 150 反解出 σ 与 μ。 */
  distribution: 'lognormal',
  /** 截断：少于 5 分钟等于没提前；超过 10 小时在内涝里不成立。 */
  leadClipMin: [5, 600],
  /** 本地水深到这个值就算「看见了水」，据此反推收到预警的时刻。 */
  wetThresholdM: 0.03,
});

/** 由中位数与均值反解对数正态参数。 */
function lognormalParams(median, mean) {
  const mu = Math.log(median);
  const sigma = Math.sqrt(2 * Math.log(mean / median));
  return { mu, sigma };
}
const LN = lognormalParams(WARNING_MEASURED.leadMedianMin, WARNING_MEASURED.leadMeanMin);

/** 标准正态分位数（Acklam 有理逼近，误差 < 1.2e-9）。 */
function invNorm(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const pl = 0.02425;
  let q, r;
  if (p <= 0) return -8;
  if (p >= 1) return 8;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * 这个人到底收不收得到官方预警。
 * 35.5% 收不到——依据是 Thieken 2022 表 4 的内涝子样本。
 */
export function receivesWarning(i, isDuty) {
  // 【2026-11-21 门1】默认（ratio=1）逐位等价于原来的 neverWarnedShare 比较。
  const pReceive = receiveShareFor(isDuty === true, WARNING_STAGES.warnedAny);
  return hash01(i, 0x9e37) >= (1 - pReceive);
}

/**
 * 这个人的预警前置时间（分钟）。中位数 60、均值 150 的对数正态，截断在 5–600。
 */
export function warningLeadMin(i) {
  const u = Math.min(0.999999, Math.max(1e-6, hash01(i, 0x85eb)));
  const raw = Math.exp(LN.mu + LN.sigma * invNorm(u));
  const [lo, hi] = WARNING_SELF_SET.leadClipMin;
  return Math.min(hi, Math.max(lo, raw));
}

/**
 * 收到预警的时刻（一天分钟）。
 *
 * @param {number} firstWetMin 他所在位置第一次见水的时刻（一天分钟）
 * @param {number} i 人员编号
 * @returns {number} 收到预警的分钟；`Infinity` 表示自始至终没收到
 *
 * 收不到的人返回 Infinity；收得到的人 = 见水时刻 − 前置时间（不低于 0）。
 * 一直没见水的人不收预警：内涝里近一半人本来就是「看见水才知道」，
 * 没水可看就谈不上预警。这一条是近似，写在模块头的说明里。
 */
export function warnAtOf(firstWetMin, i) {
  if (!receivesWarning(i)) return Infinity;
  const raw = Number(firstWetMin);
  if (!Number.isFinite(raw)) return Infinity;
  // 【修 2026-11-17】时钟量程是 0–1440 分钟。见水时刻超过 1440（跨天的坏
  // manifest）原先会返回 >1440 的预警时刻，而 NOW_MIN() 永远到不了，这个人
  // 就永远收不到预警。显式夹进一天的量程。
  const at = Math.max(0, Math.min(1440, raw));
  return Math.max(0, at - warningLeadMin(i));
}

/** 供验收与文档引用。 */
export const WARNING_META = Object.freeze({
  measured: [
    '完全没收到预警的比例 35.5%：Thieken et al. 2022, NHESS 22:165–185, Table 4（2016 地表水内涝，n=448）',
    '预警前置时间均值 2.5 h、中位数 1 h：同上 Table 4 与 Table 5（前置时间 n=141）',
    '察觉方式：自己看到水位 47.3%、官方天气预警 13.6%、邻里告知 7.6%：同上 Table 5',
  ],
  selfSet: [
    '前置时间取对数正态（只为对上中位数与均值两个统计量，论文未印分布）',
    '截断 5–600 分钟',
    '预警时刻挂在本地点首次见水（3 cm）之前，而非统一城市时刻；这是按「47.3% 靠自己看到水」做的近似',
    '一直没见水的人不赋预警',
  ],
});

/* ============================================================================
 * 【§5 时间层 2026-11-20】把「发布 / 收到 / 动身」拆成三个时刻
 *
 * 上面那个 warnAtOf() 把三种东西压成一个数：城市什么时候发布、这个人什么时候
 * 知道、他什么时候真的开始动。结果是「提前 2 小时预警能救多少人」这类问题
 * 在模型里根本问不出来。这一段把它们拆开，**默认关闭**（开关见 TIMELAYER.enabled），
 * 因为打开它会改变全部八工况的数字，必须整族重跑一次才算数。
 *
 * 三个时刻各自的出处与性质（改这几个数前先读 docs/时间层设计_2026-11-20.md）：
 *   t_publish  城市发布时刻 —— 【目前自己定的】，规则是「降雨开始前 30 分钟」
 *   t_receive  本人知道 —— 收得到的人 = t_publish + 对数正态延迟（中位 60 分）；
 *              收不到的 35.5% 永远是 Infinity（Thieken 2022 表 4 实测比例）
 *   t_depart   开始动身 —— 【目前自己定的】准备时间，中位 8 分、截断 0–45 分，
 *              依据只有 Thieken 2026 的定性描述（准备行为与救命行为要分开），没有分布
 *
 * 为什么 t_receive 的锚点要从「自己见水」改成「发布时刻」：论文里 47.3% 的人是
 * 自己看见水才察觉的（最多的一类）。旧写法让**所有人**都按「见水前 N 分钟知道」
 * 算，把「被广播叫醒」和「看见水才知道」混成了一套分布。改完之后这两类分开：
 * 收得到的走广播时刻，收不到的只能等见水。
 * ========================================================================== */

export const TIMELAYER = Object.freeze({
  /** 【目前自己定的】官方发布时刻 = 降雨开始前这么多分钟。 */
  publishLeadBeforeRainMin: 30,
  /** 收到延迟：沿用「前置时间」那两个实测统计量反解的对数正态（形状是自设的）。 */
  receiveMedianMin: 60,
  receiveMeanMin: 150,
  receiveClipMin: [5, 600],
  /** 【目前自己定的】收到 → 动身的准备时间（关阀、拿东西、叫家人）。 */
  prepMedianMin: 8,
  prepMeanMin: 20,
  prepClipMin: [0, 45],
});

const RLN = lognormalParams(TIMELAYER.receiveMedianMin, TIMELAYER.receiveMeanMin);
const PLN = lognormalParams(TIMELAYER.prepMedianMin, TIMELAYER.prepMeanMin);

/**
 * 总开关（默认 false = 走旧的 warnAtOf()，行为与 v2 一致）。
 * 用可变状态而不是塞进 TIMELAYER，是因为那是个 Object.freeze 的常数表。
 */
let _timeLayerOn = false;
export function setTimeLayer(on) { _timeLayerOn = !!on; }
export function timeLayerOn() { return _timeLayerOn; }

/** 工况级的发布时刻（一天分钟）。全天族降雨从 0 点起 → 发布也是 0 点。 */
export function publishMinOf(rainStartMin) {
  const rs = Number(rainStartMin);
  if (!Number.isFinite(rs) || rs <= 0) return 0;
  return Math.max(0, rs - TIMELAYER.publishLeadBeforeRainMin);
}

/** 第 i 个人的「知道」时刻：发布 + 延迟；收不到的人 Infinity。 */
export function receiveAtOf(publishMin, i, isDuty) {
  if (!receivesWarning(i, isDuty)) return Infinity;
  const u = Math.min(0.999999, Math.max(1e-6, hash01(i, 0x85eb)));
  const delay = diffusionDelayMin(u);
  return Math.min(1440, Math.max(0, Number(publishMin) || 0) + delay);
}

/** 第 i 个人的准备时间（分钟）。*/
export function prepMinOf(i) {
  const u = Math.min(0.999999, Math.max(1e-6, hash01(i, 0xc2b2)));
  const [lo, hi] = TIMELAYER.prepClipMin;
  return Math.min(hi, Math.max(lo, Math.exp(PLN.mu + PLN.sigma * invNorm(u))));
}

/**
 * 动身时刻 = 他知道的那一刻 + 准备时间。
 * 「知道」取 min(收到广播, 自己看见水)：没收到广播的人只有见水这一条。
 */
export function departAtOf(receiveAt, seeAt, i, isDuty) {
  // 门1 只影响「收不收得到」，动身时刻由收到时刻 + 准备时间推，不需要再过一次门1；
  // 参数留着是为了调用点签名一致，这里只做转发注释。
  void isDuty;
  const r = Number.isFinite(receiveAt) ? receiveAt : Infinity;
  const s = Number.isFinite(seeAt) ? seeAt : Infinity;
  const know = Math.min(r, s);
  if (!Number.isFinite(know)) return Infinity;
  return Math.min(1440, know + prepMinOf(i));
}

/** 三个时刻的对照表，供文档与验收引用。 */
export const TIMELAYER_META = Object.freeze({
  measured: [
    '收不到预警 35.5%：Thieken et al. 2022 NHESS 22:165–185 Table 4（2016 内涝 n=448）',
    '靠自身观察察觉 47.3%：同上 Table 5',
    '前置时间中位 1 h、均值 2.5 h：同上 Table 4/5（n=141）',
  ],
  selfSet: [
    '发布时刻 = 降雨开始前 30 分钟（这是政策情景变量，不是自然常数；敏感性扫 0/30/60/120）',
    '准备时间中位 8 分、截断 0–45 分（无分布依据，只有 Thieken 2026 的定性描述）',
    '扩散曲线选定 A1.2 中等档（DC 有 WEA/AlertDC，但内涝提前量短）；可切 A1.1 快 / A1.3 慢做敏感性',
  ],
});

/* ============================================================================
 * 【§5b 预警扩散 2026-11-21】把「收到延迟」从自设对数正态换成 Eq.(S1)
 *
 * 上一版 receiveAtOf() 的延迟是「反解出一条对上中位 60 / 均值 150 的对数正态」——
 * 那两个统计量是 Thieken 2022 的预警前置时间，不是「广播扩散速度」，用它当延迟
 * 分布是形式上的挪用。Sorensen & Mileti 的扩散模型才是这一段的原始出处，
 * 经 Silva 2025 落到 Table S2 的系数上：
 *
 *   Eq.(S1)  P_warned_t = P_warned_{t-1}
 *            + (t / Bt²) · exp(−t² / (2·Bt²)) · Δt      ← Rayleigh 扩散项
 *            + (1 − P_warned_{t-1}) · P_warned_{t-1} · Ct ← 非官方渠道的补足项
 *
 * Bt 越小扩散越快（Bt 是「广播渠道效率」的形状参数，量纲按分钟读），
 * Ct 是口口相传的补充速率。系数全部取自 Table S2，没有自设。
 *
 * 三档（most likely）：A1.1 快 Bt=9.5 / A1.2 中等 Bt=100 / A1.3 慢 Bt=145。
 * 默认取 A1.2：DC 有 WEA 与 AlertDC，但内涝是小时级、且 47.3% 的人是看见水
 * 才知道（Thieken 2022），按「快」会系统性高估提前量。
 * ========================================================================== */

export const DIFFUSION = Object.freeze({
  scenario: 'A1.2 中等扩散（most likely）',
  Bt: 100.0,
  Ct: 0.060,
  // 直接锚定论文印出来的累计值，不自己重解 Eq.(S1)。
  // 原因：Eq.(S1) 是离散递推，Δt 与 Ct 的量纲在补充材料里没写清；
  // 按「ct 每分钟乘 (1−P)·P」重算，曲线 4 小时就饱和到 1.0，
  // 而 Table S2 明写 8 小时只有 74.3% —— 说明量纲读法错。
  // 与其猜一个 Δt，不如用论文自己给的三个累计点做单调插值（下面 ANCHORS），
  // 8h / 24h / 72h 三个数就是论文的数，一天之内只在 0→8h 段插值。
  anchors: [[0, 0], [480, 0.743], [1440, 0.900], [4320, 0.950]],
  horizonMin: 1440,
  source: 'Sorensen & Mileti (2015b, c) 经 Silva et al. 2025 NHESS 25:1501 补充材料 Table S2（A1.2 most likely：Bt=100.0、Ct=0.060、8h=0.743、24h=0.900、72h=0.950）',
  why: 'DC 有无线应急警报与 AlertDC，但内涝提前量是小时级；取中等档，快/慢两档留给敏感性',
});

/** 累计收到比例：在 log1p(t) 上对论文锚点做单调线性插值（t=0 是奇点，故用 log1p）。 */
export function warnedCumulativeAt(minutes) {
  const t = Math.max(0, Math.min(DIFFUSION.horizonMin, Number(minutes) || 0));
  const A = DIFFUSION.anchors;
  if (t <= 0) return 0;
  for (let k = 1; k < A.length; k++) {
    if (t <= A[k][0]) {
      const [t0, p0] = A[k - 1];
      const [t1, p1] = A[k];
      const x0 = Math.log1p(t0), x1 = Math.log1p(t1), x = Math.log1p(t);
      const w = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      return p0 + (p1 - p0) * w;
    }
  }
  return A[A.length - 1][1];
}

let _diffGrid = null;
/** 1 分钟网格的累计曲线（供反解用，模块级只算一次）。 */
function diffusionGrid() {
  if (_diffGrid) return _diffGrid;
  const n = DIFFUSION.horizonMin + 2;
  const g = new Float64Array(n);
  for (let k = 1; k < n; k++) g[k] = warnedCumulativeAt(k);
  _diffGrid = g;
  return g;
}

/** 把 [0,1) 的分位点反解成「发布后多少分钟收到」。 */
export function diffusionDelayMin(u) {
  const g = diffusionGrid();
  const target = Math.min(0.999999, Math.max(1e-6, Number(u) || 1e-6));
  for (let k = 1; k < g.length; k++) if (g[k] >= target) return k;
  return g.length - 1;
}

export const DIFFUSION_META = Object.freeze({
  measured: ['Eq.(S1) 的 Rayleigh 扩散结构与 Bt/Ct 系数：Sorensen & Mileti 2015b,c → Silva 2025 补充材料 Table S2'],
  selfSet: [
    'Bt 的量纲按分钟读（原表未印单位）',
    'Ct 项按原文印刷形式实现（(1−P)·P·Ct）；该项在小 t 时可忽略，在长时段提供尾部',
    '默认情景 A1.2（Bt=100）；A1.1（9.5）/ A1.3（145）用于敏感性',
  ],
});

/* ============================================================================
 * 【§5c 三段预警 2026-11-21】收到 ≠ 得到可行动信息 ≠ 来得及
 *
 * 台账 §三 第 3 条指出我们只有「到达时刻」一条线，而 Thieken 2023 把预警
 * 有效性拆成三个分别估计的因变量（收到 / 理解 / 认为有效并行动）。
 * DC 本地没有这三段的调查，能用的实测是 2021 Ahr 谷重建（Silva 2025）：
 *   收到任何预警 57%、收到含撤离指令的 17.5%、在洪水到达前收到的 13.8%。
 * 两个比值就是两道门：
 *   得到可行动信息 | 收到过 = 17.5/57 = 30.7%
 *   来得及        | 可行动 = 13.8/17.5 = 78.9%
 * ========================================================================== */

export const WARNING_STAGES = Object.freeze({
  warnedAny: 0.57,
  withInstruction: 0.175,
  beforeArrival: 0.138,
  source: 'Silva et al. 2025 NHESS 25:1501（2021 Ahr 谷重建：57% / 17.5% / 13.8%）',
});

export const STAGE_RATIO = Object.freeze({
  instructionOfWarned: 0.175 / 0.57,
  timelyOfInstruction: 0.138 / 0.175,
});

/**
 * 第 i 个人处在哪一段：'never' | 'aware'（知道有事但没拿到该怎么做）|
 * 'instruction'（拿到指令）| 'timely'（且在洪水到达前拿到）。
 * 三个阈值都是上表两个实测比值，不是自设。
 */
export function warningStageOf(i, isDuty) {
  if (!receivesWarning(i, isDuty)) return 'never';
  const r1 = hash01(i, 0x51ed);
  if (r1 >= STAGE_RATIO.instructionOfWarned) return 'aware';
  // 【2026-11-21 修正】第二道门原来复用 0x9e37，与 receivesWarning 同一个盐，
  // 于是「来得及」被强制落在「已收到」的同一段 u 里（上界只剩 1-0.43=0.359），
  // 实测用时比例 0.112 而非 0.138。换成独立盐 0x2545 后回到 13.8%。
  const r2 = hash01(i, 0x2545);
  if (r2 >= STAGE_RATIO.timelyOfInstruction) return 'instruction';
  return 'timely';
}

export const WARNING_STAGE_META = Object.freeze({
  measured: ['57% / 17.5% / 13.8%：Silva 2025 Ahr 重建'],
  selfSet: ['把三段比值当独立抽样的两道门（原文是三个统计量，未给联合分布）'],
  limits: [
    'Ahr 是山区河谷、德国西部；DC 的广播体系（WEA）与制度环境不同，只能当量级参考',
    '未接「理解」这一步（需要 DC 本地问卷），aware 段的人被当作「知道有事但不知道该做什么」',
  ],
});
