/**
 * access-impediment.js — 门 5「阻碍」的真实数据接线（2026-11-21 新建）
 *
 * 起因：门 5 此前登记的现状是「没有数据源，恒不触发」。核查后发现两条阻碍
 * 是不需要任何自由参数的**结构性**事实，可以直接从 ACS 与场景状态算出来：
 *
 *   ① 没有私人车辆（ACS 户车数 = 0）
 *      Lindell & Perry 2012, Risk Analysis 32(4):616-632, §4 Situational Impediments
 *      原文列举的阻碍里第一条就是 "a lack of access to a personal vehicle
 *      (e.g., those who are routinely transit dependent or families in which one
 *      spouse has the only car during the workday)"。
 *      我们的 ACS 微样本里就有户车数（PUMS VEH），DC 加权后 27.1% 的人口住在
 *      没有车的户里（就业人口 26.6%）。这个数不是假设，是 Census 的。
 *
 *   ② 值守岗位在工作场所（组织使命决定的响应义务）
 *      Drabek 2000, Int. J. Mass Emergencies & Disasters 18(2)（DOI 10.1177/028072700001800202，
 *      摘要原文）与 Drabek 2001, Disasters 25(1):76-94：对 7 场灾害中 118 家企业
 *      406 名员工的访谈发现，员工在灾中的疏散行为被三类约束显著塑造——
 *      「预警提前量」「组织规模」「组织使命（organizational mission）」。
 *      其中组织使命是可落到人身上的：医疗（SOC 29/31）、安保（33）、教育（25）、
 *      军职（55）这几类岗位在灾害中属于响应方，人在岗时不能像普通居民一样撤回家。
 *
 * 这两条都不引入概率系数：命中就置 impediment，门 5 直接把「撤离」概率压到 0，
 * 剩下的是就地避险/垂直撤离，由场景里已有的上楼逻辑接管。
 *
 * 没有接上的（如实登记）：
 *   - 组织规模：我们的 ACS 微样本没有企业规模字段，接不了。
 *   - 残障（PUMS DIS）：微样本列里没有，要接得先改 tools/data/import_acs.py 重新导出。
 *   - 家庭分离：PADM §4 也列为阻碍，但我们的家庭是整户同时行动，没有可观测的分离时刻。
 */

/** 组织使命属于「响应方」的 SOC 两位数大类。 */
export const DUTY_SOC = Object.freeze({
  '29': '医疗执业与技术人员',
  '31': '医疗辅助',
  '33': '安保服务',
  '25': '教育与图书馆',
  '55': '军职',
});

export const IMPEDIMENT = Object.freeze({
  NONE: 'none',
  NO_VEHICLE: 'no_vehicle',
  ON_DUTY: 'on_duty',
  CARE_CHILD: 'care_child',
});

/**
 * ACS（PUMS）「与户主关系码」RELP 里代表「本人是户主或其配偶」的三个码。
 * 【2026-11-21 修】此前写的是 01/02 —— 那是**旧版 RELP 的码位**，ACS PUMS
 * 用的是 20 = 户主（reference person）、21 = 异性配偶、22 = 同性配偶。
 * 用错码直接导致这条判据恒不触发（实测加权命中 0 人）。已在
 * web/tests/check-care-child.mjs 里钉成回归，防再错。
 */
export const HOUSEHOLDER_RELP = Object.freeze(['20', '21', '22']);

/**
 * 照护责任：单亲带一个未成年孩子。
 *
 * 【逻辑推导，不是自设】三个真实字段就能把「单亲带娃」唯一确定下来：
 *   ① 户内有未成年(1/0) = 1     —— ACS 户级变量，户内至少有一个 18 岁以下
 *   ② 户规模 = 2                —— 户内只有两个人
 *   ③ 本人 18–87 岁             —— 本人是成年人（另一个只能是那个未成年人）
 * ①②③ 同时成立 ⇒ 这户就是「一个成年人 + 一个未成年」，即单亲带娃。
 * 关系码 20/21/22 再核一遍「本人是户主或配偶」，把寄住的成年亲属排除掉。
 *
 * 户规模 ≥ 3 的户无法从微样本判断是「两个大人 + 一个孩子」（双亲）还是
 * 「一个大人 + 两个孩子」（单亲），所以**不判**，宁可漏判也不猜 —— 这一条
 * 是本项的口径边界，答辩要主动说，别等导师问。
 *
 * 为什么照护责任要进门 5：PADM（Lindell & Perry 2012, §4）把阻碍定义在
 * **行动实施**环节；家长在灾害里不是「不想走」，而是「不能一个人先走」。
 * 这是仿真里唯一能把「惦记楼内孩子」落成可观测行为的地方。
 *
 * 覆盖率（本地 ACS 加权实测）：1.21% 的加权人口命中，见
 * ACCESS_META.measured.careChildShare；按这个数报，不要凭感觉。
 */
export function careChildDutyOf(real) {
  if (!real) return false;
  const age = Number(real.age);
  if (!Number.isFinite(age) || age < 18 || age >= 88) return false;
  if (!real.hasMinor) return false;
  if (Number(real.householdSize) !== 2) return false;
  return HOUSEHOLDER_RELP.includes(String(real.relationship || '').trim());
}

export const ACCESS = Object.freeze({
  /**
   * 步行撤离的距离上限（米）。
   * 【半自设】PADM 只说「没有车」是阻碍，没给距离门槛。取 2 km 的理由：
   * 常速 1.2 m/s 走过去约 28 分钟，雨天、涉水、还要带家人，再远就不现实；
   * DC 常规步行通勤距离的量级也在这个范围。配 1 / 2 / 4 km 敏感性。
   */
  walkLimitM: 2000.0,
  walkLimitRangeM: [1000, 2000, 4000],
  /**
   * 「孩子已经在身边」的距离阈值（米）。同户合成户里，未成年成员与家长的
   * 水平距离小于这个值，就算已经带上了一起走。9 m ≈ 一个门牌到门口的尺度
   * （与 goal.js 的 ARRIVE_R 同量级），【半自设】。
   */
  childWithM: 9.0,
});

export const ACCESS_META = Object.freeze({
  gates: {
    on_duty: '人在工作场所 且 SOC ∈ DUTY_SOC → 值守，不撤离回家',
    no_vehicle: '户车数 = 0 且场景无车 且 目标距离 > walkLimitM → 无车受阻',
    care_child: '照护责任（单亲带一个未成年）+ 孩子此刻不在身边 → 不单独撤离，先接孩子；'
      + '危险度到 most（FD2321「danger for most」）时自保优先，阻碍解除',
  },
  measured: {
    zeroVehicleShare: 0.271,
    zeroVehicleShareEmployed: 0.266,
    dutySocShareOfEmployed: { '29+31': 0.058, '25': 0.062, '33': 0.028, '55': 0.006 },
    careChildShare: 0.0121,
    careChildShareNote: '户内有未成年 × 户规模=2 × 关系码 20/21/22 × 18–87 岁，按 PWGTP 加权；'
      + '只覆盖「户内两个人」这一可判定子集，是下限不是单亲全口径',
    source: 'ACS 2020-2024 5-Year PUMS, DC (psam_p11.csv)，按 PWGTP 加权，本地 data/real/acs_dc.json',
  },
  selfSet: [
    'walkLimitM = 2000（PADM 未给距离门槛；配 1/2/4 km 敏感性）',
    '「在岗」判据用场景里的 where === "work"，是执行层状态，不是新假设',
    '照护责任用「户内有未成年 + 户规模=2 + 关系码 20/21/22」推出（逻辑上唯一：一大人一未成年），'
    + '不是自设系数；未覆盖户规模≥3 的户（分不清单亲双亲）',
    'childWithM = 9 m（孩子与家长水平距离在此之内算已带上，与 goal.js ARRIVE_R 同量级）',
  ],
  sources: [
    'Lindell & Perry (2012), The Protective Action Decision Model, Risk Analysis 32(4):616-632, §4',
    'Drabek (2000), Pattern Differences in Disaster-Induced Employee Evacuations, IJMED 18(2), DOI 10.1177/028072700001800202',
    'Drabek (2001), Disaster Warning and Evacuation Responses by Private Business Employees, Disasters 25(1):76-94',
    'ACS 2020-2024 5-Year PUMS DC：户内有未成年（PUMS 派生）、与户主关系码（RELP）、户规模（NP）',
  ],
  limits: [
    '组织规模（Drabek 三类约束之一）无数据，未接',
    '残障（PUMS DIS）不在微样本列里，未接',
    '家庭分离（PADM §4）在整户同时行动的设定下没有可观测时刻，未接',
    '照护责任只覆盖「户内两个人」的可判定子集；户规模≥3 的户分不清单亲还是双亲，未判',
    '孩子身份来自合成同户（ACS 无户号），不是真实亲子关系；拿到真实户号应替换',
    '执行层「先回家接孩子」的导航未接：命中时只把「一个人先撤」压到 0，'
      + '危险度到 most 后自保优先解除（与 on_duty 同一条解除口径）',
  ],
});

/** SOC 两位数大类是否属于响应方岗位。 */
export function isDutyMission(socCode) {
  const s = String(socCode == null ? '' : socCode).trim();
  return Object.prototype.hasOwnProperty.call(DUTY_SOC, s);
}

/** 这个人是否有私人车辆可用（ACS 户车数 + 场景发车状态）。 */
export function vehicleFree(k) {
  if (!k) return false;
  const vehicles = Number(k.householdVehicles);
  const known = Number.isFinite(vehicles);
  const noCar = !k.hasCar;
  // 户车数缺失（PUMS VEH = NA，约 5%）时不判——宁可不触发，也不拿缺数据当无车。
  return known && vehicles === 0 && noCar;
}

/**
 * 门 5 的阻碍判定。
 * @param k 执行层 kernel（含 socCode / householdVehicles / hasCar）
 * @param s 当前状态（含 atWork / distGoal 米）
 * @returns { id, reason, detail } 或 null
 */
export function impedimentOf(k, s) {
  const st = s || {};
  if (st.impediment && st.impediment !== IMPEDIMENT.NONE) {
    return { id: st.impediment, reason: '状态里显式给了阻碍', detail: {} };
  }
  if (st.atWork === true && isDutyMission(k && k.socCode)) {
    const soc = String((k && k.socCode) || '');
    return {
      id: IMPEDIMENT.ON_DUTY,
      reason: '值守岗位在岗，不能撤离回家（Drabek 2000「组织使命」约束）',
      detail: { socCode: soc, socLabel: DUTY_SOC[soc] || '' },
    };
  }
  // 照护责任排在值守之后、无车之前：孩子不在身边是不能「一个人先走」，
  // 这件事比「用什么走」更根本。注意它不是「永远不走」——危险度到 most
  // 时由 choice-model 的门 5 按同一条解除口径放行（威胁上来要重启决策）。
  if (k && k.careChildDuty === true && st.minorWith !== true) {
    return {
      id: IMPEDIMENT.CARE_CHILD,
      reason: '单亲带未成年孩子，孩子此刻不在身边 → 不能一个人先撤（PADM §4 阻碍：照护责任）',
      detail: {
        childPos: st.childPos || null,
        childWithM: ACCESS.childWithM,
        householdSize: k.householdSize,
      },
    };
  }
  if (vehicleFree(k)) {
    const metres = Math.max(0, Number(st.distGoal) || 0);
    if (metres > ACCESS.walkLimitM) {
      return {
        id: IMPEDIMENT.NO_VEHICLE,
        reason: '户内无车，目标距离超出步行上限（PADM §4 车辆可得性阻碍）',
        detail: { metres, walkLimitM: ACCESS.walkLimitM },
      };
    }
  }
  return null;
}
