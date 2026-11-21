/**
 * reception-channel.js — 门 1「接收」的渠道分组（2026-11-21 新增）
 *
 * 依据与限制，先说清楚：
 *
 * ① 方向有文献支持，量值没有。
 *    Drabek, W. G. (2000). "The Warning Process and the Employee's Response",
 *    International Journal of Mass Emergencies and Disasters 18(2). 摘要原文：
 *    7 场灾害、118 家企业、406 名员工，员工的灾中行为被三类约束显著塑造——
 *    「预警提前量（length of forewarning）」「组织规模」「组织使命（organizational
 *    mission）」。也就是说，同一个人在企业里收到的信息、以及他能在什么时刻行动，
 *    确实与「在岗」「岗位职责」有关。
 *    Drabek, W. G. (2001). Disasters 25(1):76-94 同类结论。
 *
 * ② 但没有「职业 → 预警接收率」的定量分布。查过 Drabek 2000/2001、PADM 第二版、
 *    NOAA 龙卷预警接收调查（80–90% 是全人群口径，不分职业）、RAND 的 WEA 覆盖研究，
 *    都没有给出可直接搬的分组比例。Silva et al. 2025 NHESS 25:1501-1520 的三个
 *    阶段比例（0.57 / 0.175 / 0.138）也是全人群边缘分布。
 *
 * ③ 所以这里不发明比例，只提供一个「保持总体均值不变」的重分配开关：
 *    权重只决定同一批人里谁先收到，人口加权后总体接收率仍等于 Silva 的实测值。
 *    默认 ratio = 1（完全中性，结果与关闭时逐位相同）；要做敏感性时把 ratio 取
 *    0.5 / 1 / 2，看"在岗人员接收得更早/更晚"会把伤亡推到哪。
 *
 * 换句话说：这一层里唯一的自由参数是 ratio，而它的默认值不改变任何数字。
 */

export const RECEPTION = Object.freeze({
  /** 在岗值守岗位相对其余人群的接收权重倍数。1 = 中性。 */
  dutyMissionRatio: 1.0,
  /** 敏感性扫描区间（只做情景，不是依据）。 */
  ratioRange: Object.freeze([0.5, 1.0, 2.0]),
  /** 参与重分配的岗位大类（与 access-impediment.js 的 DUTY_SOC 一致）。 */
  dutySoc: Object.freeze(['29', '31', '33', '25', '55']),
});

let _channelOn = true;
let _dutyMissionRatio = RECEPTION.dutyMissionRatio;
export function setReceptionChannel(on) { _channelOn = !!on; }
export function receptionChannelOn() { return _channelOn; }
export function setDutyMissionRatio(r) {
  const v = Number(r);
  if (Number.isFinite(v) && v > 0) _dutyMissionRatio = v;
}
export function dutyMissionRatio() { return _dutyMissionRatio; }

/**
 * 抽签用的权重。只回答「这个人相对别人更容易还是更不容易先收到」，
 * 不回答「收到概率是多少」——那个数仍由 warning.js 的实测边缘分布决定。
 */
export function receptionWeight(i, isDuty) {
  if (!_channelOn) return 1;
  const r = _dutyMissionRatio;
  if (!Number.isFinite(r) || r === 1) return 1;
  return isDuty ? r : 1;
}

/**
 * 全人口里属于值守岗位的比例。来自 ACS PUMS 加权实数（本地 data/real/acs_dc.json）：
 * 就业人口占 58%，值守大类 29 医疗 4.2% + 31/34 安保 5.8%(含 29 的重叠已扣除) + 33 教育 2.8%
 * + 25 教育 6.2% + 55 军职 0.6% → 就业内约 15.4% → 全人口约 8.9%。
 * 这个数只用于「把重分配做成保均值」，不是模型输入的假设值。
 */
export const DUTY_POPULATION_SHARE = 0.089;

/**
 * 某类人的接收比例。ratio = 1 时逐位等于 baseShare（默认显然不变）。
 * 保均值：share_d·p_d + (1−share_d)·p_o = baseShare。
 */
export function receiveShareFor(isDuty, baseShare) {
  const base = Number(baseShare);
  const r = _dutyMissionRatio;
  if (!_channelOn || !Number.isFinite(r) || r === 1) return base;
  const sd = DUTY_POPULATION_SHARE;
  if (!isDuty) {
    const p = (base - sd * Math.min(1, Math.max(0, base * r))) / (1 - sd);
    return Math.min(1, Math.max(0, p));
  }
  return Math.min(1, Math.max(0, base * r));
}

export const RECEPTION_META = Object.freeze({
  name: '门1 接收渠道（职业/在岗分组重分配）',
  evidence: Object.freeze([
    'Drabek 2000 IJMED 18(2) —— 预警提前量/组织规模/组织使命三类约束（定性+访谈统计，未给接收率分布）',
    'Drabek 2001 Disasters 25(1):76-94 —— 同类结论',
    'Lindell & Perry 2012 Risk Analysis 32(4):616-632 §4 —— 决策链的接收环节，未给分组比例',
  ]),
  selfSet: Object.freeze({
    dutyMissionRatio: '1.0（中性默认；0.5/2 仅作敏感性情景，不是文献值）',
    meanPreserving: '重分配保持总体接收率等于 Silva 2025 的 0.57/0.175/0.138',
  }),
  limits: Object.freeze([
    '没有职业→接收率的定量来源，因此本模块默认不改变任何数字',
    '真实差异可能来自渠道（电视/手机/同事/警报器）而非职业，本模型没有渠道数据',
  ]),
});
