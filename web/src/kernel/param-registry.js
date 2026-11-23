/**
 * param-registry.js — 全项目「正在跑的常数」的唯一登记表 + 机检入口
 *
 * 【为什么需要这张表】2026-11-21 之前的依据是分散的：决策链在
 * docs/依据台账.md、伤亡链在 kernel/thresholds.js 的注释、人群在
 * kernel/params.js、从众在 kernel/crowd-threshold.js、时间层在
 * docs/时间层设计_2026-11-20.md。想回答「这个数凭什么」得同时翻五份文档，
 * 拼不起来；更糟的是新加一个常数不会被任何人拦住——正是这一周反复出现的
 * 「静默恒不触发」那类问题的温床。
 *
 * 这张表做三件事：
 *   ① 每个在跑常数一条，写清性质（真实数据集／文献实测／推导／自设／工程参数）、
 *      出处、以及**为什么是这个数**（自设项必须写，不许「经验取值」四个字了事）；
 *   ② 用 get() 读运行时真值，与表里登记的值比对，防漂移；
 *   ③ 用 probe 在源文件里找字面量，防「表里有一条、代码里已经没了」或反过来。
 *
 * 机检：`node tests/check-param-evidence.mjs`（退出码非 0 即不合格）。
 * 出表：`node tools/check/param-table.mjs > docs/参数依据表_V7_2026-11-21.md`
 *
 * 【性质的定义，报告里照抄】
 *   real      真实数据集里量出来的（ACS/NHTS/DC311…），可指到列名
 *   measured  已发表文献里的实测值或估计系数，可指到表号/页码
 *   derived   由上面两类按一个明确公式推出来的中间量（公式必须写出来）
 *   selfSet   三轮检索没有一手依据，为让仿真能往下走自己定的；必须写 why 与 sens
 *   engineering 动画/交互/渲染参数，不进任何科研结论；写清楚「改了只影响观感」
 *   retired   已删除的自设项，留档防止有人再加回来
 */

import { MEASURED, MEASURED_SOURCES, SELF_SET, BODY, casualtyScale } from './thresholds.js';
import {
  KNOWLEDGE_LOGIT, ACTION_LOGIT, EVACUATION_LOGIT, MOBILISATION, SCALING,
  EXPERIENCE_LINK, RETIRED_SELF_SET, THREAT_OF_HAZARD,
} from './choice-model.js';
import { CASCADE } from './crowd-threshold.js';
import { ACCESS, ACCESS_META, DUTY_SOC, HOUSEHOLDER_RELP } from './access-impediment.js';
import { WARNING_MEASURED, WARNING_SELF_SET, TIMELAYER } from './warning.js';
import { RECEPTION, DUTY_POPULATION_SHARE } from './reception-channel.js';
import { PEER_NETWORK } from './peer-network.js';
import { flowHrOn } from './flow-hazard.js';

export const KINDS = Object.freeze({
  real: '真实数据集',
  measured: '文献实测值',
  derived: '按公式推导',
  selfSet: '目前自己定的',
  engineering: '工程/表现参数',
  retired: '已退役',
});

/** 链条分组，出表时按这个顺序排。 */
export const CHAINS = Object.freeze([
  'population', 'warning', 'cognition', 'mobilisation', 'choice', 'crowd',
  'impediment', 'casualty', 'vehicle', 'river', 'engineering',
]);

const RE = (s) => new RegExp(s);

/** 全部登记项。`expect` 是文档里印的值，`get` 是运行时真值，机检要求两者一致。 */
export const ENTRIES = [
  /* ---------------- population：人群画像 ---------------- */
  {
    id: 'pop.columns', chain: 'population', label: 'ACS 微样本保留列数', unit: '列',
    expect: 10, kind: 'real',
    source: 'data/real/acs_dc.json —— 原始 PUMS 人表 285 列，本项目保留年龄/五岁带/性别/SOC 大类/'
      + 'JWTRNS/户内有无未成年/户车数/户规模/与户主关系码/PWGTP 共 10 列',
    why: '只保留进模型的列。未保留的 275 列不是「数据没有」，是不参与任何公式，'
      + '删掉只为把文件压到可提交体积（回答「是数据集只有几项还是项目只挑了几项」）。',
    sens: '不适用（元数据）',
    probe: { file: 'tools/check/acs-fidelity.mjs', re: RE('COLUMNS_KEPT|285') },
  },
  {
    id: 'pop.rows', chain: 'population', label: 'ACS 微样本行数 / 加权人数', unit: '行 / 人',
    expect: [32505, 681294], kind: 'real',
    source: 'ACS 2020–2024 5-Year PUMS, District of Columbia（U.S. Census Bureau, release 2026-03-05）',
    why: '行数是抽样记录数，加权人数按 PWGTP 得出；仿真逐人从这 32,505 条真实记录里按权重抽，'
      + '不是先拍边际分布再独立抽属性，所以户车数/户规模/与户主关系之间天然自洽。',
    sens: '人数 400/1000 两档已跑；抽样噪声基准 ±1.6pp',
    probe: { file: 'tools/check/acs-fidelity.mjs', re: RE('microsample\\.rows|weightSum|WEIGHT') },
  },
  {
    id: 'pop.tvd', chain: 'population', label: '六维总变差距离上限', unit: '—',
    expect: 0.05, kind: 'selfSet',
    source: 'web/tests/check-real-population.mjs 的合格线（实测六维 0.009–0.031）',
    why: '0.05 是项目自己划的「算一致」线：n=1000 时二项抽样噪声本身就有 ±1.6pp，'
      + '取 5pp 让 95% 的抽样波动落在合格区内，同时还能抓住 30pp 级别的结构性错误。',
    sens: '实测值已有：六维 0.009/0.012/0.031 等，全部低于线；换线只改红绿不改数值',
    probe: { file: 'web/tests/check-real-population.mjs', re: RE('0\\.05') },
  },
  {
    id: 'pop.stature', chain: 'population', label: '身高查表（按年龄×性别）', unit: 'cm',
    expect: 'BODY.heightCmByAge', kind: 'measured',
    source: 'CDC/NCHS, NHANES III Anthropometric Reference (Series 3, No. 39), Tables 7/9/11',
    why: '用于把「水深」换算到人体部位（膝/腰/胸/颈），不是用来判定死亡。',
    sens: '不适用（查表）',
    get: () => Object.keys(BODY.heightCmByAge).length,
    probe: { file: 'web/src/kernel/thresholds.js', re: RE('heightCmByAge') },
  },
  {
    id: 'pop.airway', chain: 'population', label: '气道高度 / 身高', unit: '—',
    expect: 0.85, kind: 'selfSet',
    source: 'BODY.airwayOfHeight',
    why: '成年人立姿口鼻高度约占身高 0.85（1.70 m 人约 1.45 m），用于判断水漫到口鼻的位置；'
      + '解剖测量里这个比例在 0.83–0.87 之间随头型变，取中值。敏感性 0.85/0.90 已内建。',
    sens: '0.85 与 0.90 两档可切（BODY.airwaySens）',
    get: () => BODY.airwayOfHeight,
    probe: { file: 'web/src/kernel/thresholds.js', re: RE('airwayOfHeight') },
  },

  /* ---------------- warning：预警接收与时间 ---------------- */
  {
    id: 'warn.received', chain: 'warning', label: '收到任何预警的比例', unit: '—',
    expect: 0.57, kind: 'measured',
    source: 'Silva et al. 2025, NHESS 25:1501–1520, Table S2（Ahr 2021 逐人重建）',
    why: '三段比例 0.57 / 0.175 / 0.138 来自同一事件同一样本，混用别篇的 35.5% 会让第二段失去分母。',
    sens: 'neverWarnedShareAlt=0.355（Thieken 2022 表 4）留作敏感性口径',
    get: () => Number((1 - WARNING_MEASURED.neverWarnedShare).toFixed(2)),
    probe: { file: 'web/src/kernel/warning.js', re: RE('neverWarnedShare') },
  },
  {
    id: 'warn.lead', chain: 'warning', label: '预警前置时间（中位 / 均值）', unit: '分钟',
    expect: [60, 150], kind: 'measured',
    source: 'Thieken et al. 2022, NHESS 22:165–185, Table 4/5（前置时间 n=141）',
    why: '论文只给中位数与均值两个统计量，因此用对数正态反解形状（μ=ln60，σ²=2ln(150/60)）；'
      + '分布形式是自设，两个矩是实测。',
    sens: '截断 5–600 分钟自设；前置时间整体 ×0.5/×2 属时间层敏感性',
    get: () => [WARNING_MEASURED.leadMedianMin, WARNING_MEASURED.leadMeanMin],
    probe: { file: 'web/src/kernel/warning.js', re: RE('leadMedianMin') },
  },
  {
    id: 'warn.ownObs', chain: 'warning', label: '靠自己看到水才察觉的比例', unit: '—',
    expect: 0.473, kind: 'measured',
    source: 'Thieken et al. 2022, Table 5（察觉方式；同表官方天气预警 13.6%、邻里告知 7.6%）',
    why: '内涝里最多的一类不是被广播叫醒的。这个数决定了「预警时刻挂在本地点见水之前」的形状。',
    sens: '不适用（实测边缘比例，只用于描述）',
    get: () => WARNING_MEASURED.awareByOwnObservation,
    probe: { file: 'web/src/kernel/warning.js', re: RE('awareByOwnObservation') },
  },
  {
    id: 'warn.wet', chain: 'warning', label: '「看见水了」的本地水深', unit: 'm',
    expect: 0.03, kind: 'selfSet',
    source: 'WARNING_SELF_SET.wetThresholdM',
    why: '3 cm 是「路面有明水、鞋底开始湿」的量级，低于此只有潮湿痕迹；取 0.03 而不是 0.05，'
      + '是因为 0.05 已被水深分档用作「薄水」界，若同值会让「看见」与「危险」两个语义重叠。',
    sens: '0.02/0.03/0.05 三档可切（改一个数即可，未单独跑批）',
    get: () => WARNING_SELF_SET.wetThresholdM,
    probe: { file: 'web/src/kernel/warning.js', re: RE('wetThresholdM') },
  },
  {
    id: 'warn.publish', chain: 'warning', label: '官方发布时刻提前量', unit: '分钟',
    expect: 30, kind: 'selfSet',
    source: 'TIMELAYER.publishLeadBeforeRainMin（时间层，默认关闭）',
    why: '内涝没有「登陆前 36 小时」那种提前量：暴雨预警通常是降雨开始前半小时到一小时发布。'
      + '取 30 分钟是这一族工况的工程默认，不是任何一篇论文的实测值。',
    sens: '时间层打开后与 0/30/60 对比属待跑敏感性',
    get: () => TIMELAYER.publishLeadBeforeRainMin,
    probe: { file: 'web/src/kernel/warning.js', re: RE('publishLeadBeforeRainMin') },
  },
  {
    id: 'warn.prep', chain: 'warning', label: '收到 → 动身的准备时间（中位 / 均值）', unit: '分钟',
    expect: [8, 20], kind: 'selfSet',
    source: 'TIMELAYER.prepMedianMin/prepMeanMin',
    why: '关阀、拿证件、叫家人的时间。Thieken 2026 只有定性描述（准备行为与救命行为要分开），'
      + '没有分布；8/20 分钟对应「多数人十分钟内动身、少数人拖半小时」。',
    sens: '待扫：4/38、8/20、16/40 三组',
    get: () => [TIMELAYER.prepMedianMin, TIMELAYER.prepMeanMin],
    probe: { file: 'web/src/kernel/warning.js', re: RE('prepMedianMin') },
  },

  /* ---------------- cognition：认知层（Thieken S2） ---------------- */
  {
    id: 'cog.female', chain: 'cognition', label: '认知层 女性', unit: 'log-odds',
    expect: 0.493, kind: 'measured',
    source: 'Thieken et al. 2023, NHESS 23:973–990, Table S2（p=0.000）',
    why: '原文印刷值，直接进知识得分。',
    sens: '不适用（实测系数）',
    get: () => KNOWLEDGE_LOGIT.coefficients.female,
    probe: { file: 'web/src/kernel/choice-model.js', re: RE('female: 0\\.493') },
  },
  {
    id: 'cog.official', chain: 'cognition', label: '认知层 官方预警', unit: 'log-odds',
    expect: 0.571, kind: 'measured',
    source: 'Thieken et al. 2023, Table S2（p=0.006，基准 = 未收到预警）',
    why: '官方渠道与自观察分开测；这道系数就是「广播叫醒」相对「自己看见」的差。',
    sens: '不适用',
    get: () => KNOWLEDGE_LOGIT.coefficients.officialWarning,
    probe: { file: 'web/src/kernel/choice-model.js', re: RE('officialWarning: 0\\.571') },
  },
  {
    id: 'cog.warnInfo', chain: 'cognition', label: '认知层 非官方预警信息', unit: 'log-odds',
    expect: 0.147, kind: 'measured',
    source: 'Thieken et al. 2023, Table S2（p=0.028）',
    why: '系数是实测，但输入恒 0 —— 见 UNWIRED_INPUTS.warningInformation。',
    sens: '若启用，最大影响 exp(0.147)≈1.16× 动员速度（上界）',
    get: () => KNOWLEDGE_LOGIT.coefficients.warningInformation,
    probe: { file: 'web/src/kernel/choice-model.js', re: RE('warningInformation: 0\\.147') },
  },
  {
    id: 'cog.surprise', chain: 'cognition', label: '认知层 意外（surprise）', unit: 'log-odds',
    expect: -0.648, kind: 'measured',
    source: 'Thieken et al. 2023, Table S2',
    why: '原文印刷值：被「没想到会淹」打懵的人知识得分更低。输入由 cohort 按'
      + '「远处积水比脚下深 8 cm 以上」判 0.6、否则 0.1（半自设，见 behavior.surprise）。',
    sens: '不适用（系数实测）',
    get: () => KNOWLEDGE_LOGIT.coefficients.surprise,
    probe: { file: 'web/src/kernel/choice-model.js', re: RE('surprise: -0\\.648') },
  },
  {
    id: 'cog.prior', chain: 'cognition', label: '认知层 既往洪水次数阶梯', unit: 'log-odds',
    expect: { 0: 0, 1: 0.68, 2: 0.901, 3: 2.01, 4: 2.001 }, kind: 'measured',
    source: 'Thieken et al. 2023, Table S2（有序 logit 的 0/1/2/3/4+ 档）',
    why: '4 次以上相对 0 次约 7.4 倍优势比——这是全模型最强的单因子。',
    sens: '不适用',
    get: () => KNOWLEDGE_LOGIT.priorFloods,
    probe: { file: 'web/src/kernel/choice-model.js', re: RE('priorFloods') },
  },

  /* ---------------- mobilisation：门3 启动 ---------------- */
  {
    id: 'mob.points', chain: 'mobilisation', label: '动员率实测点（8/24/72 h）', unit: '—',
    expect: [0.888, 0.957, 0.986], kind: 'measured',
    source: 'Silva et al. 2025, NHESS 25:1501–1520, Table S2（A1.1 Fast, most likely）',
    why: '绝对概率直接用印刷值插值，不用自设 S 形曲线——旧版那条 (t/b)^a 曲线的取整误差'
      + '会让 8 小时端偏 5pp 以上。',
    sens: '不适用',
    get: () => Object.values(MOBILISATION.observedRate),
    probe: { file: 'web/src/kernel/choice-model.js', re: RE('observedRate') },
  },
  {
    id: 'mob.kappa', chain: 'mobilisation', label: '经验 → 动员的自由标量 κ', unit: '—',
    expect: 1.0, kind: 'selfSet',
    source: 'EXPERIENCE_LINK.kappa（唯一自由标量；可 ?kappa= / SIM_KAPPA=）',
    why: '真正从文献来的是结构（经验→知识→更快动员，Thieken S2/S3）与系数，'
      + '差的只是跨论文 logit 的尺度比 λ（Swait & Louviere 1993）。κ=1 等于假设 λ=1、'
      + '只在人群内做相对调整；这是明说的假设，不是拟合出来的数。',
    sens: 'κ ∈ {0.5, 1, 2} 是必做敏感性（运行时可设）',
    get: () => EXPERIENCE_LINK.kappa,
    probe: { file: 'web/src/kernel/choice-model.js', re: RE('kappa: 1\\.0') },
  },
  {
    id: 'mob.ref', chain: 'mobilisation', label: '参考人（锚点）', unit: '—',
    expect: 'priorFloods=1, official=false, surprise=0.1, floodImpact=0, female=false', kind: 'selfSet',
    source: 'EXPERIENCE_LINK.reference',
    why: '相对调整必须有锚。取「1 次经历」而不是 0 次，是因为 DC 有长期内涝史、'
      + '0 次的人在样本里是少数；锚在人群中段，避免整体概率被系统性抬高或压低。',
    sens: '锚改 0 次 / 2 次会让全城动员速度整体平移（未单独跑批）',
    get: () => Object.values(EXPERIENCE_LINK.reference.note ? EXPERIENCE_LINK.reference : {}).length,
    probe: { file: 'web/src/kernel/choice-model.js', re: RE('reference: Object\\.freeze') },
  },
  {
    id: 'mob.clip', chain: 'mobilisation', label: '经验倍数截断', unit: '×',
    expect: [0.25, 4], kind: 'selfSet',
    source: 'EXPERIENCE_LINK.ratioClip',
    why: '纯数值保护：k_i 极端组合（4 次经历 + 官方预警 + 意外）能让 exp(κΔk) 到 10 倍以上，'
      + '乘到动员率上会瞬间饱和。0.25/4 保证最慢的人也还在动、最快的人也不瞬移。',
    sens: '不改（κ 敏感性时 κ=2 仍不会越界）',
    get: () => EXPERIENCE_LINK.ratioClip.slice(),
    probe: { file: 'web/src/kernel/choice-model.js', re: RE('ratioClip') },
  },

  /* ---------------- choice：选择层（Borowski Table 4） ---------------- */
  {
    id: 'ch.asc', chain: 'choice', label: '撤离 ASC', unit: '效用',
    expect: 4.22, kind: 'measured',
    source: 'Borowski & Stathopoulos 2023, Table 4（p=0.000；Stay ASC 固定 0）',
    why: '原文印刷值。它决定「无任何属性时基线撤离倾向」，clogit 的 ASC 必须留。',
    sens: '不适用',
    get: () => EVACUATION_LOGIT.evacuateASC,
    probe: { file: 'web/src/kernel/choice-model.js', re: RE('evacuateASC: 4\\.22') },
  },
  {
    id: 'ch.peersRide', chain: 'choice', label: '同伴乘车比例', unit: '效用',
    expect: [-1.27, 1.91], kind: 'measured',
    source: 'Borowski & Stathopoulos 2023, Table 4（mean −1.27, t=−5.10；SD 1.91）+ 第四轮 QA9 变量定义',
    why: '变量是「参照群体里选择乘车撤离的比例」，仿真里可观测代理是 ped.inVehicle'
      + '（见 kernel/peer-share.js）。旧版恒 0 是因为没人给它赋值，不是因为没有这条理论路径。',
    sens: '威胁交互 moderate +0.50 / extreme +1.11（实测）',
    get: () => [EVACUATION_LOGIT.coefficients.peersRide, EVACUATION_LOGIT.coefficients.peersRideSD],
    probe: { file: 'web/src/kernel/choice-model.js', re: RE('peersRide') },
  },
  {
    id: 'ch.peersStay', chain: 'choice', label: '同伴留下比例', unit: '效用',
    expect: [7.76, 10.87], kind: 'measured',
    source: 'Borowski & Stathopoulos 2023, Table 4（mean 7.76, WTP −271.13；SD 10.87）',
    why: '符号为正且极大：同伴都留下时，撤离效用被抬起来的意思是「留下来陪家人」这一路'
      + '在效用里等价于高成本；截断在设计范围 0–0.8（Borowski 实验设计上限）。',
    sens: '威胁交互 moderate −9.27 / extreme −21.13（实测，会把正效应压反）',
    get: () => [EVACUATION_LOGIT.coefficients.peersStay, EVACUATION_LOGIT.coefficients.peersStaySD],
    probe: { file: 'web/src/kernel/choice-model.js', re: RE('peersStay: 7\\.76') },
  },
  {
    id: 'ch.age', chain: 'choice', label: '年龄（以均值 48、SD 13.2 标准化）', unit: '效用',
    expect: [0.21, 48.0, 13.2], kind: 'measured',
    source: 'Borowski & Stathopoulos 2023, Table 4（0.21）+ Table S1 印刷样本均值/标准差',
    why: '年龄必须标准化后再乘系数，否则 0.21 × 65 会直接压过 ASC；中心与离散度取原文样本，'
      + '不取 DC 的（系数是在那个样本上估的）。',
    sens: '不适用',
    get: () => [EVACUATION_LOGIT.coefficients.age, SCALING.ageCentre, SCALING.ageScale],
    probe: { file: 'web/src/kernel/choice-model.js', re: RE('age: 0\\.21') },
  },
  {
    id: 'ch.costUnit', chain: 'choice', label: '成本计量单位', unit: '美元',
    expect: 100, kind: 'derived',
    source: 'kernel/attributes.js COST_UNIT_USD，由 Borowski 的 WTP 32.78 美元/英里反解',
    why: '原文成本系数是「每 100 美元」的尺度；用 32.78 美元/英里的 WTP 把绕路英里折成美元，'
      + '再除以 100 进入效用，量纲才对得上 −3.71。',
    formula: 'cost = detourMiles × 32.78 / 100',
    sens: '不适用（量纲换算）',
    probe: { file: 'web/src/kernel/attributes.js', re: RE('COST_UNIT_USD') },
  },
  {
    id: 'ch.attrRange', chain: 'choice', label: '属性设计范围截断', unit: '—',
    expect: 'peersStay 0–0.8，peersRide 0–1，cost/travel/wait/walk 按 Table 3',
    kind: 'measured',
    source: 'Borowski & Stathopoulos 2023, Table 3（stated-choice 实验设计范围）',
    why: '线性效用只在设计范围内成立。超出范围外推（例如同伴留下 1.0）会把 7.76 放大成荒谬值，'
      + '所以按设计上限截断，并在报告里写明这是截断而非实测。',
    sens: '不适用',
    probe: { file: 'web/src/kernel/attributes.js', re: RE('BOROWSKI_DESIGN|设计范围') },
  },

  /* ---------------- crowd：从众 ---------------- */
  {
    id: 'crowd.pInf', chain: 'crowd', label: '级联饱和概率 p∞', unit: '—',
    expect: 0.720, kind: 'derived',
    source: 'kernel/crowd-threshold.js 五点最小二乘拟合 Rufat et al. 2024, ESP 162:103925 Fig.2',
    formula: 'P(跟随) = p∞ · I_x(a,b)，x = 已离开比例；a=1.13, b=1.60 同为拟合值，SSE 3.2e-3',
    why: '论文给了五档「看到什么才走」的实测阶梯（12/27/46/60/69%），我们不是抄一个数，'
      + '而是学它的方法——用 Beta 累积分布去拟合这五档，得到连续曲线。这样「越来越多人走才跟着走」'
      + '与「有人始终不走」同时成立，也是导师点出的「从众缺理论依据」的正面回答。',
    sens: '拟合残差 SSE 3.2e-3；改 a/b 会把中段斜率拉陡/压平。'
      + '渠道口径实测（2026-11-21 夜，300 人 × 300 分 × 同 seed，u_p120_s0 17:00 起跑）：'
      + '阈值级联（默认）死 8、Borowski 加性系数死 11、完全关闭死 10；三档都把「车内 5 + 地下室 1」钉住，'
      + '差别全在室外：阈值档没有「被困致死」，另两档分别出现 3 例与 1 例——说明从众渠道决定的是'
      + '「有人被劝走还是被劝留」，不是车内死亡那一批人。',
    get: () => CASCADE.pInf,
    probe: { file: 'web/src/kernel/crowd-threshold.js', re: RE('pInf') },
  },
  {
    id: 'crowd.theta', chain: 'crowd', label: '个体阈值分布 θ', unit: '—',
    expect: [0.85, 0.75], kind: 'derived',
    formula: 'theta_i ~ Beta(a=0.85, b=0.75)，均值 b/(a+b)=0.469；每人的阈值全天不变（hash 定）',
    source: 'kernel/crowd-threshold.js ；阈值级联机制见 Hasan & Ukkusuri 2011, TR-C 19(6)',
    why: '每人一个「我什么时候跟着走」的阈值，均值约 0.53、两侧都有质量：'
      + '一部分人极早走（θ 小），一部分人几乎最后才走。Hasan & Ukkusuri 的阈值级联是这套机制'
      + '的已发表形式，我们只把阈值分布换成与内涝数据一致的形状。',
    sens: '不适用（分布形状由拟合反推）',
    probe: { file: 'web/src/kernel/crowd-threshold.js', re: RE('BETA|theta') },
  },
  {
    id: 'peer.maxPeers', chain: 'crowd', label: '参照群体人数上限', unit: '人',
    expect: 5, kind: 'measured',
    source: 'Borowski 2023 第四轮问卷 QA9：自我中心网络由姓名生成题引出，**至多 5 人**',
    why: '同伴比例变量（Share peers choosing ride / staying）就是这个「至多 5 人」的网络里算出来的；'
      + '超过 5 人的同伴集合不在问卷设计里，硬给 8–10 人等于改掉原论文的口径。',
    sens: '不适用（问卷设计上限）',
    get: () => PEER_NETWORK.maxPeers,
    probe: { file: 'web/src/kernel/peer-network.js', re: RE('maxPeers: 5,') },
  },
  {
    id: 'peer.shortRange', chain: 'crowd', label: '邻里半径 d_sr', unit: 'm',
    expect: 120, kind: 'selfSet',
    source: 'Kuhlman et al. 2020 AAMAS 19:654–662 §2.2 + Table 1（扫 40/70/100 m）；我们的街区尺度更大',
    why: '短程半径决定「谁算邻居」。Kuhlman 的合成人口是 VA Beach，他们扫 0.04/0.07/0.10 km；'
      + 'DC 排屋街区进深更宽，取 120 m 对应「同一排房子 + 街对面」，属他们扫过的区间外推一档。'
      + '**这两个数（半径与长程边数）不是文献最优值，是区间内的取值。**',
    sens: '扫 60 / 120 / 240 m：改半径换的是「谁进圈」，人数上限不变；结果见 docs/同伴网络_2026-11-22.md',
    get: () => PEER_NETWORK.shortRangeM,
    probe: { file: 'web/src/kernel/peer-network.js', re: RE('shortRangeM: 120,') },
  },
  {
    id: 'peer.longRangeQ', chain: 'crowd', label: '每人长程边数 q', unit: '条',
    expect: 1, kind: 'selfSet',
    source: 'Kuhlman et al. 2020 AAMAS §2.2 + Table 1（q 扫 0/2/4/8/16/32）；我们受 5 人上限约束',
    why: '长程边代表「不在附近但会联系的人」（远亲/同乡/线上）。Kuhlman 的合成人口里 q 可以到 32 条，'
      + '因为他们的网络不受 5 人上限约束；我们的参照群体上限是 Borowski 问卷的 5 人，'
      + '所以只能留 1 条，其余名额给邻里与同事。',
    sens: '扫 q=0/1/2：q=0 时长程边消失、同伴集合缩到「同户+同事+邻居」',
    get: () => PEER_NETWORK.longRangeQ,
    probe: { file: 'web/src/kernel/peer-network.js', re: RE('longRangeQ: 1,') },
  },
  {
    id: 'peer.longRangePower', chain: 'crowd', label: '长程边距离衰减指数 r', unit: '—',
    expect: 2, kind: 'measured',
    source: 'Kleinberg 2000, Nature 406:845–851（可导航小世界的最优指数 r=2）',
    why: '长程边不是均匀随机，而是按 d^-r 衰减：越远的联系人越少。r=2 是 Kleinberg 的可导航性结论，'
      + '属方法常数，不是我们拟合出来的。',
    sens: '不适用（方法常数）',
    get: () => PEER_NETWORK.longRangePower,
    probe: { file: 'web/src/kernel/peer-network.js', re: RE('longRangePower: 2,') },
  },
  {
    id: 'peer.extraTies', chain: 'crowd', label: '同户之外的同伴目标数', unit: '条',
    expect: 3, kind: 'selfSet',
    source: '自设：目标度数 = ACS 同户人数 + 3（同事 1 / 长程 1 / 邻里补满）',
    why: '文献只给了「至多 5 人」这个上限，没给三类接触各几条。5 个名额减去同户人数，'
      + '剩下的给非家庭接触；DC 户规模均值小（单人户三成），所以多数人手里有 2–3 个非家庭名额。'
      + '拆成「同事 1 / 长程 1 / 邻里补满」是为了让三类接触都真的发生（第一版先补邻里，'
      + '结果 workEdges=0、longRangeEdges=0，两个机制「看着接了、实际从不发生」）。',
    sens: '扫 extraTies=1/3/5（对应人均度数降到约 2 / 4.5 / 5）',
    get: () => PEER_NETWORK.extraTies,
    probe: { file: 'web/src/kernel/peer-network.js', re: RE('extraTies: 3,') },
  },
  {
    id: 'peer.workQuota', chain: 'crowd', label: '同事名额', unit: '条',
    expect: 1, kind: 'selfSet',
    source: '自设（与 peer.extraTies 同一预算分配）；同事关系来自 SOC→场所映射与办公楼分配',
    why: '工作边的「谁和谁是同事」有数据（同办公楼），但「同事里算几个同伴」没有数据；'
      + '留 1 条，避免同一栋楼被连成完全图、把邻里名额吃光。',
    sens: '扫 0/1/2（0 = 完全不要工作边，回到「同户+邻居」的旧口径）',
    get: () => PEER_NETWORK.workQuota,
    probe: { file: 'web/src/kernel/peer-network.js', re: RE('workQuota: 1,') },
  },

  /* ---------------- impediment：门5 阻碍 ---------------- */
  {
    id: 'imp.dutySoc', chain: 'impediment', label: '值守岗位 SOC 大类', unit: '—',
    expect: ['25', '29', '31', '33', '55'], kind: 'measured',
    source: 'Drabek 2000, IJMED 18(2) / Drabek 2001, Disasters 25(1):76-94（组织使命约束三类）',
    why: '医疗/安保/教育/军职在灾中被要求守岗，方向有文献支持；具体哪几个 SOC 码是'
      + '按 2018 SOC 大类人工映射（半自设），量值靠 ACS 加权人口比例给出 8.9%。',
    sens: '不适用（人群比例来自 ACS）',
    get: () => DUTY_SOC.codes ? DUTY_SOC.codes.slice() : Object.keys(DUTY_SOC),
    probe: { file: 'web/src/kernel/access-impediment.js', re: RE('DUTY_SOC') },
  },
  {
    id: 'imp.relp', chain: 'impediment', label: '户主关系码（PUMS RELP）', unit: '—',
    expect: ['20', '21', '22'], kind: 'real',
    source: 'PUMS 2024 5-Year 数据字典 RELP：20 户主、21 异性配偶、22 同性配偶',
    why: '**曾经写错**：按旧版 RELP 写成 01/02 ⇒ 加权命中 0 人 ⇒ 照护门静默恒不触发。'
      + '改成 20/21/22 后实测 1.21%（8256 人）。这条保留在表里就是为了让下一个人别重犯。',
    sens: '不适用（编码字典）',
    get: () => HOUSEHOLDER_RELP.slice(),
    probe: { file: 'web/src/kernel/access-impediment.js', re: RE('HOUSEHOLDER_RELP') },
  },
  {
    id: 'imp.care', chain: 'impediment', label: '照护责任判定（单亲带娃）', unit: '—',
    expect: 0.0121, kind: 'derived',
    source: 'ACS 微样本 户内有无未成年 × 户规模 × RELP 现场重算（web/tests/check-care-child.mjs）',
    formula: '年龄 18–87 ∧ hasMinor=1 ∧ 户规模=2 ∧ RELP∈{20,21,22} → 单亲带娃',
    why: '户内只有两人才有一个未成年，那个人只能是户主/配偶 ⇒ 没有另一个大人可以看孩子。'
      + '户规模≥3 不判（分不清两大人一娃还是一大人两娃），宁可漏判 1.21% 也不乱判。',
    sens: '1.21% 是实测重算值，非自设；若放开户规模≥3，比例会升到约 4%（未跑批）',
    get: () => ACCESS_META.measured.careChildShare,
    probe: { file: 'web/src/kernel/access-impediment.js', re: RE('careChildShare') },
  },
  {
    id: 'imp.walkLimit', chain: 'impediment', label: '无车者步行可达上限', unit: 'm',
    expect: 2000, kind: 'selfSet',
    source: 'ACCESS.walkLimitM',
    why: 'ACS 只给「户车数=0」，不给「走得到多远」。2 km 约 25 分钟步行，是城市里'
      + '「应急但可行」的量级；超过这个距离的无车者才会被判为受阻碍（不改概率，只改姿态为步行）。',
    sens: '1/2/4 km 三档已内建为敏感性',
    get: () => ACCESS.walkLimitM,
    probe: { file: 'web/src/kernel/access-impediment.js', re: RE('walkLimitM') },
  },
  {
    id: 'imp.childWith', chain: 'impediment', label: '「孩子在身边」判定半径', unit: 'm',
    expect: 9.0, kind: 'selfSet',
    source: 'ACCESS.childWithM',
    why: '与 goal.js 的 ARRIVE_R 同量级：9 m 内算「就在身边、拉得上手」，超出就算走散了。'
      + '取 9 而不是 2，是因为同一栋楼的门厅/楼道尺度就在十几米。',
    sens: '4.5/9/18 m 三档待扫',
    get: () => ACCESS.childWithM,
    probe: { file: 'web/src/kernel/access-impediment.js', re: RE('childWithM') },
  },
  {
    id: 'imp.reception', chain: 'impediment', label: '在岗接收权重倍数', unit: '×',
    expect: 1.0, kind: 'selfSet',
    source: 'RECEPTION.dutyMissionRatio（保均值重分配，默认中性）',
    why: '没有「职业→接收率」的定量分布，所以默认 1.0 = 完全不改任何数字；'
      + '0.5/2 只作情景，不是为了凑结果。DUTY_POPULATION_SHARE=0.089 来自 ACS 加权。',
    sens: '0.5/1/2 三档（1 为默认，结果逐位相同）',
    get: () => RECEPTION.dutyMissionRatio,
    probe: { file: 'web/src/kernel/reception-channel.js', re: RE('dutyMissionRatio') },
  },

  /* ---------------- casualty：伤亡链 ---------------- */
  {
    id: 'cas.dvAdult', chain: 'casualty', label: '成人失稳 D·V 限值', unit: 'm²/s',
    expect: 1.2, kind: 'measured',
    source: 'Cox, Shand & Blacka 2010, ARR Project 10 Stage 1 P10/S1/006；分级见 Smith et al. 2014 WRL TR 2014/07',
    why: 'H3 分级里「所有人极端危险」的限值，不是实测个体失稳深度——这两者的区别'
      + '在第四轮 QB1 已被核过，报告里不能混说。',
    sens: '成人 0.6/0.8/1.2 三档都在表内（low/trained/extreme）',
    get: () => MEASURED.instabilityDV.extreme,
    probe: { file: 'web/src/kernel/thresholds.js', re: RE('adultLow') },
  },
  {
    id: 'cas.dvChild', chain: 'casualty', label: '儿童失稳 D·V 限值', unit: 'm²/s',
    expect: 0.4, kind: 'measured',
    source: 'Cox, Shand & Blacka 2010, ARR Project 10 Stage 1 P10/S1/006（H2 儿童低危险限值）',
    why: '儿童重心低、体重轻，同一水流条件下 D·V 0.4 就已不稳。',
    sens: '不适用',
    get: () => MEASURED.instabilityDV.childLow,
    probe: { file: 'web/src/kernel/thresholds.js', re: RE('childLow') },
  },
  {
    id: 'cas.hr', chain: 'casualty', label: 'HR 危险度界值', unit: '—',
    expect: [0.75, 1.25, 2.0], kind: 'measured',
    source: 'DEFRA/EA 2006 FD2320 规划口径（0.75/1.25/2.0）；FD2321 为 2.5，两套不可混引',
    why: 'HR = d(v+0.5) + DF。取 FD2320 那套，因为它的分档正好对上「低/中/高/极高」四档，'
      + '而 FD2321 的 2.5 是为「significant danger」单独立的口径。',
    sens: '不适用（界值随口径固定）',
    get: () => [MEASURED.hazardRating.moderate, MEASURED.hazardRating.significant, MEASURED.hazardRating.extreme],
    probe: { file: 'web/src/kernel/thresholds.js', re: RE('hazardRating') },
  },
  {
    id: 'cas.exposure', chain: 'casualty', label: '致死暴露时长（成人 / 儿童）', unit: 's',
    expect: [150, 80], kind: 'selfSet',
    source: 'SELF_SET.casualty.exposureSecAdult/exposureSecChild',
    why: '三轮检索没有「失稳后多久死亡」的定量函数：Jonkman 的水深→死亡率曲线是另一条链'
      + '（第四轮 QB3 已核），ARR 只到危险分级。150 s 对应「在水中站不稳、被冲倒后两分半内'
      + '无法自救」；儿童减半是因为体力与身高双低。**这是全项目最需要被质疑的数字**，'
      + '所以整组 ×0.5/×2 的敏感性必须跑，且在报告里不许把它当实测。',
    sens: '×0.5 / ×2 必跑（未跑，属待补）',
    get: () => [SELF_SET.casualty.exposureSecAdult, SELF_SET.casualty.exposureSecChild],
    probe: { file: 'web/src/kernel/thresholds.js', re: RE('exposureSecAdult') },
  },
  {
    id: 'cas.scaleKnob', chain: 'casualty', label: '暴露时长的敏感性倍数（旋钮）', unit: '×',
    expect: 1.0, kind: 'selfSet',
    source: 'thresholds.js setCasualtyScale()；?casscale=0.5|2 / SIM_CAS_SCALE=0.5|2',
    why: '暴露时长本身没依据（见上一条），所以必须有一个不改源码就能乘 0.5/2 的旋钮；'
      + '默认 1.0 逐位等于表内值。没有旋钮等于「敏感性只能靠改源码」，不可复现。',
    sens: '0.5 / 1 / 2 三档实测（u_p120_s0，300 人，17:00 起跑 300 分，seed 20261117）：'
      + '死亡 9 / 8 / 4，车内死亡 7 / 5 / 1，弃车 0 / 2 / 6 —— 拉长耐久主要救车里的命，'
      + '地下室与路面涉水那几条几乎不动（1 / 2 / 1）',
    get: () => casualtyScale(),
    probe: { file: 'web/src/kernel/thresholds.js', re: RE('setCasualtyScale') },
  },
  {
    id: 'cas.slip', chain: 'casualty', label: '涉水滑倒概率', unit: '—',
    expect: 0.30, kind: 'selfSet',
    source: 'SELF_SET.slipProbability',
    why: '没有实测研究给「走水的人多久滑一次」。0.30 取的是「明显湿滑但不至于必摔」的中间值：'
      + '低于 0.2 等于水不滑（不合常识），高于 0.5 等于人人摔（也不合常识）。旧版 0.14–0.60 '
      + '全区间都没依据，现在只留一个中间值并登记敏感性。',
    sens: '0.15/0.30/0.60 三档待扫。已实测两端（2026-11-21 夜，300 人 × 300 分 × 同 seed）：'
      + '关闭判据受伤 5 → 0、死亡 8 → 7（少的那 1 例是路面涉水）；把成人失稳下界抬到 1.4 后'
      + '死亡仍 8、受伤 5 → 7。即滑倒判据主要决定「受伤这条链」，死亡数对它的敏感度是 ±1。',
    get: () => SELF_SET.slipProbability,
    probe: { file: 'web/src/kernel/thresholds.js', re: RE('slipProbability') },
  },
  {
    id: 'cas.wadingDepth', chain: 'casualty', label: '状态标签：在涉水 / 深水', unit: 'm',
    expect: [0.35, 0.90], kind: 'measured',
    source: 'Li et al. 2026, J. Hydrology 672:135395 步速实测折点（0.35 m 折半、0.90 m 最深档）',
    why: '标签用实测折点，不再用拍脑袋的 0.3/0.8：0.35 m 是步速第一次掉到 0.52 倍的深度，'
      + '0.90 m 之后没有实测、模型进入外推，所以标「深水」而不是另设一条死亡判据。',
    sens: '不适用',
    get: () => [SELF_SET.wadingDepthM, SELF_SET.deepWaterM],
    probe: { file: 'web/src/kernel/thresholds.js', re: RE('wadingDepthM') },
  },
  {
    id: 'cas.wadeSpeed', chain: 'casualty', label: '涉水自由流步速', unit: 'm/s',
    expect: { '0': 1.67, '0.35': 0.86, '0.60': 0.84, '0.90': 0.81 }, kind: 'measured',
    source: 'Li et al. 2026, 静水受控实验 188 人（正文 §3.2）',
    why: '分档实测，中间线性插值（插值方式是工程选择）。',
    sens: '不适用',
    get: () => MEASURED.wadingFreeSpeed,
    probe: { file: 'web/src/kernel/thresholds.js', re: RE('wadingFreeSpeed') },
  },

  /* ---------------- vehicle：车辆 ---------------- */
  {
    id: 'veh.small', chain: 'vehicle', label: '小型车被推 / 漂浮深度', unit: 'm',
    expect: [0.15, 0.60], kind: 'measured',
    source: 'Smith, Modra, Tucker, Cox & Felder 2017, WRL TR 2017/07, UNSW（全尺寸拖曳水池）',
    why: '全尺寸实验值优先于 NOAA 的公众宣传口径（15/30/46–61 cm）。',
    sens: '不适用',
    get: () => [MEASURED.vehicle.smallCarPushM, MEASURED.vehicle.smallCarFloatM],
    probe: { file: 'web/src/kernel/thresholds.js', re: RE('smallCarPushM') },
  },
  {
    id: 'veh.large', chain: 'vehicle', label: '大型车失稳 / 漂浮深度', unit: 'm',
    expect: [0.45, 0.95], kind: 'measured',
    source: 'Smith, Modra, Tucker, Cox & Felder 2017, WRL Technical Report 2017/07, UNSW（全尺寸实验）',
    why: '大车更高更重，失稳与漂浮深度都往后推。',
    sens: '不适用',
    get: () => [MEASURED.vehicle.largeCarInstabilityM, MEASURED.vehicle.largeCarFloatM],
    probe: { file: 'web/src/kernel/thresholds.js', re: RE('largeCarInstabilityM') },
  },
  {
    id: 'veh.abandon', chain: 'vehicle', label: '弃车耗时', unit: '分钟',
    expect: 2, kind: 'selfSet',
    source: 'docs/依据台账.md 四：弃车 2 分钟自设',
    why: '解安全带、开门、下车、抱起孩子，两分钟是常识量级；没有实测。'
      + '这个数直接决定「车淹到 0.6 m 后还有没有机会跑」，因此属必扫敏感性。',
    sens: '1/2/4 分钟三档待扫',
    probe: { file: 'web/src/incidents.js', re: RE('弃车时刻') },
  },

  /* ---------------- engineering：不进结论的表现参数 ---------------- */
  {
    // 【2026-11-23 模型审计】决策层危险度是否计入流速：默认 0（不计）。
    // 计不计是**口径**问题不是数值问题：不计时行为层按静水算 HR，伤亡层按
    // 真实流速判冲走，两层对同一时刻给出不同水情。改成 1 需要整批重跑。
    id: 'flow.hrInDecision', chain: 'engineering', label: '决策层危险度是否计入流速（0=否 / 1=是）',
    unit: '开关', expect: 0, kind: 'engineering',
    source: 'FD2321 TR1 Table 3.1 / FD2320 的危险度定义都含流速项（HR = d(v+0.5) + 碎屑因子）',
    why: '默认关是为了让 2026-11-21 以来的全部结果（V6.1 / V6.2 / 消融 / 跨驱动）'
      + '保持可复现；打开后门2 的危险等级会整体上移，属另一版口径，不与历史结果混引。'
      + '这一项不进结论，只决定用哪一版水情口径。',
    sens: '开 / 关两版必须分别整批重跑；单跑一两个工况不能代替',
    get: () => (flowHrOn() ? 1 : 0),
    probe: { file: 'web/src/kernel/flow-hazard.js', re: RE('let _flowHrMode = false;') },
  },
  {
    id: 'pop.hhMax', chain: 'population', label: '合成户规模上限', unit: '人',
    expect: 5, kind: 'measured',
    source: 'Borowski 2023 第四轮问卷 QA9（自我中心网络至多 5 人）+ ACS PUMS 户规模分布',
    why: '户规模是门5 照护责任的判据之一（户规模=2 且有未成年 ⇒ 单亲带娃），'
      + '上限必须与同伴网络一致，否则同户成员会漏出参照群体。',
    sens: '不适用（问卷设计上限）',
    get: () => 5,
    probe: { file: 'web/src/kernel/household.js', re: RE('const MAX_HH = 5;') },
  },
  {
    id: 'eng.height', chain: 'engineering', label: '模型身高（男 / 女）', unit: 'm',
    expect: [1.82, 1.68], kind: 'engineering',
    source: 'web/src/ped.js TARGET_H_MALE/TARGET_H_FEMALE（对齐 Mixamo 骨架的绑定尺度）',
    why: '这是把动画骨架缩放到场景单位用的，不是人群身高分布；人群身高走 BODY 查表。'
      + '改成别的值只影响画面里的人高矮，不影响任何判定。',
    sens: '不适用',
    probe: { file: 'web/src/ped.js', re: RE('TARGET_H_MALE') },
  },
  {
    id: 'eng.fleeDepth', chain: 'engineering', label: '「齐踝就不再往前走」的表现阈值', unit: 'm',
    expect: 0.12, kind: 'engineering',
    source: 'web/src/ped.js FLEE_DEPTH',
    why: '只用于动画层「走到这里停住张望」，实际决策由 kernel 的深度分档与 D·V 判据负责。'
      + '保留 0.12 是因为低于这个深度在水面高度上几乎看不出。',
    sens: '不适用',
    probe: { file: 'web/src/ped.js', re: RE('FLEE_DEPTH') },
  },
  {
    id: 'eng.refuge', chain: 'engineering', label: '找人避难的搜索半径', unit: 'm',
    expect: [620, 220], kind: 'engineering',
    source: 'web/src/ped.js REFUGE_MAX / RAIN_REFUGE_MAX',
    why: '620 m 是「最近避难所再远就不找了」的通勤尺度，220 m 是躲雨尺度。'
      + '工程参数：影响的是画面里往哪走，不进入任何科研结论。',
    sens: '不适用',
    probe: { file: 'web/src/ped.js', re: RE('REFUGE_MAX') },
  },
  {
    id: 'eng.gait', chain: 'engineering', label: '步态最短时长（走 / 张望）', unit: 's',
    expect: [2.2, 0.8], kind: 'engineering',
    source: 'web/src/ped.js WALK_MIN_SEC / LOOK_MIN_SEC',
    why: '防止动画在两态间高频抖动；2.2 s 是一次 Mixamo walking 循环的长度，0.8 s 是转身。',
    sens: '不适用',
    probe: { file: 'web/src/ped.js', re: RE('WALK_MIN_SEC') },
  },

  /* ---------------- 微行为：影响判定但被标为半自设 ---------------- */
  {
    id: 'behavior.sightM', chain: 'engineering', label: '视距（晴 / 雨）', unit: 'm',
    expect: [40, 18, 76], kind: 'selfSet',
    source: 'web/src/cohort.js sightM = clamp(base 40 + 加成, 18, 76)',
    why: '视距决定「提前多久看到前方积水」，是行为输入而不是判据。40 m 是街区尺度下'
      + '「一眼看到路口尽头」的量级，18 m 对应暴雨夜、76 m 对应雨后初晴。没有实测来源，'
      + '但它只影响看水的早晚，不改变门 1–5 的任何阈值。',
    sens: '40/20/80 三档待扫（只影响 timing，不改结论方向）',
    probe: { file: 'web/src/cohort.js', re: RE('sightM') },
  },
  {
    id: 'behavior.surprise', chain: 'engineering', label: '意外事件的判定阈与取值', unit: '—',
    expect: [0.08, 0.6, 0.1], kind: 'selfSet',
    source: 'web/src/cohort.js surprise = farDepth > depthAhead + 0.08 ? 0.6 : 0.1',
    why: '「远处比脚下深 8 cm」定义为「没想到」：8 cm 是路缘石高度的一半，低于这个差'
      + '肉眼分不出；取值 0.6/0.1 对应 Thieken 有序 logit 里 surprise 变量的 0/1 二值'
      + '（系数 −0.648 是实测），0.6 而不是 1 是为了不让二值变量把线性预测子推爆。',
    sens: '0.30/0.6 两档待扫',
    probe: { file: 'web/src/cohort.js', re: RE('0\\.08') },
  },
  {
    id: 'behavior.micro', chain: 'engineering', label: '微行为阈（绕路/等待/放弃）', unit: '—',
    expect: [0.04, 0.35, 8, 0.02, 0.01], kind: 'engineering',
    source: 'web/src/cohort.js blocked/overdue/stuck/wait/wading 判定',
    why: '0.04 m 深才认为「脚下有障碍」——低于 FD2321 第一档 0.20 m，所以它对判定层'
      + '无作用，只影响步态与绕路动画；0.35 是「迟到 21 分钟」；stuck 8 是心跳超时；'
      + '0.02/0.01 是「看见水」的显示阈。全部为表现/交互阈值。',
    sens: '不适用（已在 0.20 m 危险档之下，改它不改判定）',
    probe: { file: 'web/src/cohort.js', re: RE('depthAhead > 0\\.04') },
  },

  /* ---------------- river：河道/风暴潮驱动（Python 内核侧，2026-11-22 新增） ----------------
   * 这三条**没有 get()**：真值在 tools/flood/shallow2d.py 里，JS 读不到。机检对它们的
   * 约束靠 probe（源文件里字面量必须还在）+ source/why/sens 的完整性；一旦 Python 侧改了
   * 默认值，probe 会红，逼着人回来改这张表。
   */
  {
    id: 'riv.overtopCw', chain: 'river', label: '漫堤入城堰流系数 Cw', unit: 'm^0.5/s',
    expect: 1.7, kind: 'measured',
    source: 'USACE EM 1110-2-1601（宽顶堰）与通用水力学教科书的宽顶堰系数 '
      + 'Cw = 1.7 m^0.5/s（SI），q = Cw·L·H^1.5；另见 EurOtop 2018 对堰流段的口径说明',
    why: '河道增水要能淹进街道，只能把漫堤写成显式源项：numba 通量门 hfm < h_min 会把'
      + '「河格 h=0 → 干陆格」这一侧门掉（实测 --p-mm-h 0 --surge-m 8 湿区 0.00 ha、'
      + '倒灌 0.0000 Mm³）。堰流是标准做法，Cw 用教科书值 1.7，不另调参。',
    sens: 'Cw 0.7 / 1.7 / 2.6 三档（±60%）必须扫；漫堤量对 Cw 是一次的线性关系',
    probe: { file: 'tools/flood/shallow2d.py', re: RE('--river-overtop-cw') },
  },
  {
    id: 'riv.bankCrest', chain: 'river', label: '护岸堤顶高程（默认取 FEMA BFE 最低值）', unit: 'm NAVD88',
    expect: 3.658, kind: 'real',
    source: 'data/derived/water.json（2026 年从 DCGIS 拉取）→ levels.BFE_min_m = 3.658；'
      + '来源图层 DCGIS Environment_Flood/MapServer/5，V_DATUM=NAVD88（FEMA FIS 2020 年版本）；'
      + 'MSL_m=0.046 是 NOAA CO-OPS 8594900 的 1983–2001 常年均值',
    why: '不设堤顶就是「无护岸」：Isabel 2.71 m 增水会灌成 63.7 ha、进 79 Mm³，'
      + '与 2003 年特区实况（17th St 堤防未漫堤）矛盾。用 FEMA 洪泛区最低基准高程当堤顶，'
      + '低于堤顶只顶托排水、高于堤顶才漫。',
    sens: '堤顶 ±0.5 m（3.16/3.66/4.16）决定「哪几档增水会漫」，必须连同增水档一起扫',
    probe: { file: 'tools/flood/shallow2d.py', re: RE('--river-bank-m') },
  },
  {
    id: 'riv.overtopDefault', chain: 'river', label: '漫堤开关默认值（0=关）', unit: '—',
    expect: 0.0, kind: 'engineering',
    source: 'tools/flood/shallow2d.py 的 --river-overtop-cw default=0.0',
    why: '默认关闭，保证历史 12 套工况与全部已有结果逐位不变；只有跨驱动实验显式打开。'
      + '这条只影响「跑哪套驱动」，不进任何已有结论。',
    sens: '不适用（开关）',
    probe: { file: 'tools/flood/shallow2d.py', re: RE('river-overtop-cw\\", type=float, default=0\\.0') },
  },
];

/**
 * 【未接线的输入】系数有出处、但输入恒 0 —— 与 A3 的 peersRide 同一类问题。
 * 登记在这里的意思是：不允许「看着接了、实际乘 0」而不说；每条必须写清
 * 上界影响与「要什么数据才能接」。
 */
export const UNWIRED_INPUTS = [
  {
    id: 'warningInformation',
    where: 'kernel/choice-model.js 认知层系数 0.147 → cohort.js:200 warningInformation: s.warningInformation || 0',
    whyZero: '全项目没有一处给它赋值。要接必须先在文献里找到「非官方渠道预警信息」的可观测代理量'
      + '（邻里/媒体传播覆盖率），不能拍一个 0–1 数字。',
    effectBound: '若全部人取 1：认知得分 +0.147 ⇒ 动员速度 ×exp(0.147)≈1.16 倍（上界，方向为更快）',
    liftRequires: '一份按人群给的非官方渠道覆盖调查（例如「邻里告知 7.6%」这种分渠道比例），'
      + '并说明它与 Thieken 问卷变量的口径对应关系',
    status: '未启用（已在 CHOICE_META.limits 与原位注释登记）',
  },
  {
    id: 'mobilityImpairment',
    where: '门5 IMPEDIMENT 里没有 DIS 这一条；kernel/access-impediment.js limits 已写「DIS 不在微样本列」',
    whyZero: 'ACS 微样本 10 列里没有残疾（DIS）字段，无法派生「行动受限」。',
    effectBound: '未知量级：DIS 人群占美国成人约 12–25%（口径差异大），若接入会把一部分人'
      + '锁在「不能走」姿态，伤亡与撤离都会变，必须整族重跑才能引用',
    liftRequires: 'ACS 带 DIS 的微样本（同 PUMS 表即可加列），或 DC 本地残障登记',
    status: '未接入（报告里必须说「门5 只接三条：无车/值守/照护」）',
  },
];

/** 覆盖检查用：每个模块至少要有一条登记，防止新链条整条裸奔。 */
export const MONITORED = Object.freeze([
  'web/src/kernel/thresholds.js',
  'web/src/kernel/choice-model.js',
  'web/src/kernel/crowd-threshold.js',
  'web/src/kernel/access-impediment.js',
  'web/src/kernel/warning.js',
  'web/src/kernel/reception-channel.js',
  'web/src/kernel/peer-network.js',
  'web/src/cohort.js',
  'web/src/ped.js',
]);

export const REGISTRY_META = Object.freeze({
  version: 'V7 草案 2026-11-21',
  rule: '每个在跑常数一条；自设项必须写 why（为什么是这个数）与 sens（怎么扫敏感性）；'
    + '实测项必须指到表号；工程参数必须写明「不进结论」。',
  check: 'node tests/check-param-evidence.mjs；出表 node tools/check/param-table.mjs',
});