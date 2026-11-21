/**
 * 从众的阈值规则（2026-11-21，替换加性系数；同日用论文完整阶梯重拟合）
 *
 * 【为什么要换】
 * 旧实现把「同伴是否留下」当成 Borowski 2023 Table 4 里的一个加性系数 7.76：
 * 效用里多一项 +7.76 × peersStay。问题有两个：
 *   ① 7.76 的估计情境是「受访者自我中心社会网络里最多 5 人的选择比例」，
 *      是一个问卷情景变量，它度量的是"我身边的人都留下了"对"我也留下"的
 *      平均偏效应，不是"多少人走了我才跟"的阈值；
 *   ② 加性项在数学上不可能产生级联（cascade）：一个人的决定只被外生给定的
 *      比例影响，而不会让别人的比例随之变化。疏散行为的核心恰恰是级联。
 * 因此从众这一项改用阈值规则：当身边已撤走的比例跨过个人阈值 θ_i 时，
 * 这个人转向保护行动。这是 Hasan & Ukkusuri (2011, Transp Res Rec) 的
 * 社会影响级联模型，也是 Yang/Mao/Metcalf (2019) 阶梯填充实验的机制。
 *
 * 【θ_i 的分布从哪来：Rufat et al. 2024, Environ. Sci. Policy 162:103925, Fig.2】
 * 原文（n=2976，巴黎 2018 洪水后六个月）阶梯题的完整五档，不是三档：
 *   邻里已撤 10% → 12% 会自发撤离；1/3 → 累计 27%；一半 → 46%；
 *   2/3 → 60%；90% → 69%。
 * 三档拟合（Beta 0.85/0.75，SSE 4.7e-4）在 90% 处会给出 ~1.00，与原文 0.69
 * 差得离谱——因为阶梯本身有天花板：一部分人（原文 12% 明确拒绝、7% 说不清）
 * 在任何比例下都不会自发走。所以模型改成
 *     P(自发撤离 | 已撤比例 x) = pInf · I_x(a, b)，pInf < 1
 * 三点拟合换成五点 + 一个饱和上限，三参数数值最小二乘解得
 *     a = 1.13, b = 1.60, pInf = 0.720, SSE = 3.2e-3
 * 拟合值 0.086 / 0.308 / 0.454 / 0.578 / 0.699 vs 数据 0.12 / 0.27 / 0.46 / 0.60 / 0.69。
 * 均值阈值 θ = a/(a+b) = 0.414（只对"会响应的人"有意义）。
 *
 * 【必须跟结果一起说的限制】
 * ① 原始数据是 2018 年巴黎的声明意愿（stated intention），不是 DC 的实测撤离；
 *    方法卡自己把它列进"不可搬的数"。这里只用它定形状，不当校准值。
 * ② 三个参数拟合五个点，样本外没有验证；换 Beta 以外的分布也能同样拟合。
 *    所以阈值分布只作先验，敏感性扫 a/b 的 0.5–2 倍。
 * ③ 模型里"身边"目前是 ACS 户内同伴 + 120 m 邻里（crowd-life.js），
 *    与问卷的"最多 5 人社会网络"不是同一个集合，只能算同构替换。
 * ④ pInf=0.72 与门 5（阻碍/根本不走）在语义上相邻，两者不要重复惩罚：
 *    这里只管"自发跟随"，不管"被淹了才走"。
 */
export const CASCADE = Object.freeze({
  a: 1.13,
  b: 1.60,
  pInf: 0.720,
  meanTheta: 1.13 / (1.13 + 1.60),
  sse: 0.0032,
  fitPoints: [[0.10, 0.12], [1 / 3, 0.27], [0.50, 0.46], [2 / 3, 0.60], [0.90, 0.69]],
  source: 'Rufat et al. 2024, Environ. Sci. Policy 162:103925, Fig.2（n=2976，巴黎 2018 洪水后六个月的阶梯题）',
  mechanism: 'Hasan & Ukkusuri 2011 社会影响级联；Yang/Mao/Metcalf 2019 阶梯填充实验',
});

/**
 * 同一篇论文的「看到什么才走」阶梯（Fig.2 另一题，声明意愿）：
 * 不在任何威胁下 → 只有 8% 会立刻走；城里部分被淹 20%；上班地点/学校被淹 31%；
 * 自己那条街被淹 45%；自家楼下地下室被淹 54%；33% 表示"只有自己家被淹了才走"；
 * 另有 12% 拒绝作答、7% 不确定。
 *
 * 【2026-11-21 A6】这条阶梯**没有接进代码，也不打算在这一版接**：门 2（风险识别）
 * 用的是 FD2321 物理危险度分级，与「看到什么才承认有威胁」的声明意愿曲线语义不同，
 * 硬接就是同一件事记两次账。原来这里有一个 `export const RUFAT_CUE_LADDER = {…,
 * wired: false}` —— 实测全项目零引用，留着只会让人以为这条通路已经打开。已删除，
 * 数字留在这段注释里作候选证据（同一份记录见 docs/公式核查_2026-11-21.md:151）。
 * 真要接，先回答：它与 FD2321 分级谁在前、谁在后。
 */

/** 从众机制开关：'threshold' 用阈值级联；'coefficient' 回到 Borowski 加性系数（旧口径）；
 * 'off' 把两条渠道都关掉（同伴系数敏感性的一根端点）。
 * 默认值来自这里，运行时可用 setCrowdMode 改（?crowd=coefficient / SIM_CROWD=off）。 */
export const CROWD_MODE = 'threshold';
let _mode = CROWD_MODE;
export function setCrowdMode(m) {
  const s = String(m || '').trim().toLowerCase();
  if (s === 'threshold' || s === 'coefficient' || s === 'off') _mode = s;
}
export function crowdModeNow() { return _mode; }

/** 个人稳定哈希 → [0,1)，用于抽 θ_i（同一个人全天同一个阈值）。 */
function hashU(i, salt = 0x2f6b) {
  let h = (Number(i) | 0) ^ salt;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h = Math.imul(h ^ (h >>> 13), 0x9e3779b1);
  h ^= h >>> 16;
  return ((h >>> 0) % 1000003) / 1000003;
}

/**
 * 正则化不完全 Beta 函数 I_x(a,b)（Numerical Recipes 的 betai + 连分式 betacf）。
 * 用数值积分在中点法下会在 x→0（a<1 时密度发散）系统性低估，直接把 θ 反解偏大，
 * 所以这里用连分式，精度 ~1e-10。
 */
function betacf(a, b, x) {
  const MAXIT = 200, EPS = 3e-12, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function betaCdf(x, a = CASCADE.a, b = CASCADE.b) {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta) / a;
  // x < (a+1)/(a+b+2) 时直接用连分式，否则用对称式
  if (x < (a + 1) / (a + b + 2)) return front * betacf(a, b, x);
  return 1 - Math.exp(b * Math.log(1 - x) + a * Math.log(x) - lbeta) / b * betacf(b, a, 1 - x);
}

function logGamma(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z, y = z, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += g[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

let _thetaTable = null;
/** Beta 分位表：把 u∈[0,1) 反解成 θ（表按 2000 点算一次）。 */
function thetaTable() {
  if (_thetaTable) return _thetaTable;
  const n = 2000;
  const t = new Float64Array(n + 1);
  let prev = 0;
  for (let k = 1; k <= n; k++) {
    const x = k / n;
    let p = 0;
    try { p = betaCdf(x); } catch { p = prev; }
    if (!(p >= prev)) p = prev;
    t[k] = p;
    prev = p;
  }
  _thetaTable = t;
  return t;
}

/**
 * 这个人会不会自发跟随（pInf=0.72）。
 * 与 θ 用不同盐的哈希，保证两件事独立；对同一个人全天不变。
 */
export function crowdResponsiveOf(i) {
  return hashU(i, 0x5f2d) < CASCADE.pInf;
}

/**
 * 第 i 个人的从众阈值 θ_i（0–1，越小越容易被带动）。
 * 不会自发跟随的人返回 Infinity —— 任何"已撤比例"都跨不过去，
 * 这样 crowdTriggered 的调用点不必多一个参数。
 */
export function crowdThresholdOf(i) {
  if (!crowdResponsiveOf(i)) return Infinity;
  const u = Math.min(0.999999, Math.max(1e-6, hashU(i)));
  const t = thetaTable();
  for (let k = 1; k < t.length; k++) {
    if (t[k] >= u) return k / (t.length - 1);
  }
  return 1;
}

/** 已撤比例跨过个人阈值 → 级联触发。 */
export function crowdTriggered(departedShare, theta) {
  const d = Number(departedShare);
  const th = Number(theta);
  if (!Number.isFinite(d) || !Number.isFinite(th)) return false;
  return d >= th;
}

export const CROWD_META = Object.freeze({
  form: 'threshold',
  measured: [
    'Rufat 2024 Fig.2 五档阶梯（10%/1/3/50%/2/3/90% → 12/27/46/60/69%）；Hasan & Ukkusuri 2011 级联机制',
    '同一图里 12% 明确拒绝撤离、7% 说不清 —— pInf 的天花板就来自这两类人',
  ],
  fitted: ['Beta(a=1.13, b=1.60) 加饱和上限 pInf=0.720：五点最小二乘，SSE 0.0032'],
  selfSet: [
    '三参数拟合五个点，自由度仍不足；只作先验，敏感性扫 a/b 的 0.5–2 倍与 pInf 的 ±0.1',
    '"身边"取 ACS 户内同伴 + 120 m 邻里，与问卷"最多 5 人网络"同构替换',
  ],
  limits: [
    '原始数据为 2018 巴黎声明意愿，方法卡标为"不可搬的数"',
    '阈值触发后是否真的出门，仍由 Borowski 选择层与门 5 阻碍共同决定',
    'pInf 与门 5 语义相邻，不要重复施加同一类"根本不走"的惩罚',
  ],
});
