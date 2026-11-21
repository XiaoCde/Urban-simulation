/**
 * floors.js — 逐人楼层状态与楼层淹没判定（内核层，纯数值）。
 *
 * 【2026-11-16 用户要求】「人到家里边是几层，1/2/3/4 层接受的都不一样，
 *  每层楼容纳量也不一样，不要出现定位说在楼里、其实人在楼外」。
 *
 * 内核/显示边界：本文件只处理数字（层数、高程、容量、危险），不碰
 * window / document / three。建筑的真实属性（height_m / function /
 * area_m2）由显示层从真实建筑数据读出后传进来，本模块不 import 任何资源。
 *
 * 数据依据（写清楚，不混实测与自设）：
 *  · 建筑高度与功能：OpenStreetMap 建筑轮廓 + 高度，本地 web/assets/city/
 *    buildings.json（21,943 栋，全部带真实 height_m；来源见 from muse/数据来源.md）。
 *    这是真实的 DC 本地数据，不是全美分布。
 *  · 层高：按建筑功能分，办公 3.8 m / 住宅 2.7 m（Choi 2002，130 栋高层实测），
 *    没有分功能标注的建筑用 3.3 m（Muse 自算口径）。详见
 *    FLOOR_HEIGHT_BY_FUNCTION 的出处与外推限制。层数是 height_m ÷ 层高取整，
 *    是「由真实高度派生的估计」，不是逐层实测。
 *  · 楼层淹没判据：FLOODrisk 2016（E3S Web Conf, e3sconf_flood2016_19006）
 *    「水深 > 该层地板高程 + 基础高度，则该层人员失护」；USACE LifeSim /
 *    Silva 2025 亚尔河谷洪水研究用「最高层地板高度的三角分布」判淹没，
 *    能上屋顶则按屋顶。这些是文献里已有的判据形式。
 *  · 每层容纳量：每层占地面积 ÷ 人均楼面面积。人均面积第六轮已换实测
 *    （办公 CBECS 2018 / 住宅 2021 AHS），见 SELF_SET 注释。
 */

import { hash01 } from './draw.js';

/**
 * 层高，按建筑功能分（第六轮回件 条5a，Choi 2002 全文）：
 *   Choi, Y. S. (2002), "The Preliminary Design Guideline for Tall Building",
 *   Architectural Research 4(1):1–6，130 栋高层（芝加哥地区 + 全球地标）实测统计原文：
 *   "the most common floor-to-floor height for office is range from 3.5 to 4.1M
 *    … and the floor-to-floor height for residential and hotel function are
 *    ranges from 2.6 to 2.9M. Consequently, the average … should be 3.8M for
 *    office and 2.7M for residential & hotel."
 * 交叉印证：Jedwab, Barr & Brueckner (2022) *JUE* 132:103507 附录对 CTBUH
 * 19,132 栋高层回归，每层系数 3.8 m（95% CI [3.77, 3.87]）。
 *
 * 【必须写清的限制】该样本是**高层建筑**，且该附录自述对 80 m 以下建筑
 * "is likely unreliable"。DC 建筑存量以 2–4 层为主（本项目中位数 3 层），
 * 把高层的 3.8 / 2.7 套到低层属于外推。IBC §1208.2 / IRC §R305.1 只规定
 * 净高下限（7 ft 6 in / 7 ft），**没有任何 floor-to-floor 的规范值**。
 * 因此没有分功能标注的低层建筑仍用 3.3 m（Muse 2026-11-16 对本项目
 * buildings.json 的自算口径），三个值都保留、都能改。
 */
export const FLOOR_HEIGHT_BY_FUNCTION = Object.freeze({
  office: 3.8,        // Choi 2002 办公均值（3.5–4.1）
  residential: 2.7,   // Choi 2002 住宅/酒店均值（2.6–2.9）
  other: 3.3,         // 无分功能实测时用 Muse 自算口径
});

/** 统一层高，保留给旧接口与对照；实际按功能取值。 */
export const FLOOR_HEIGHT_M = 3.3;
/**
 * PNNL-26949 p.20 给出的层高均值 3.95 m（2012 CBECS，4,548 栋），仅作对照，不进运行时分档。
 * 【2026-11-17 更正性质】这不是实测层高：PNNL 报告 p.17 明写 CBECS 既没有 floor-to-floor
 * height 也没有 building height，3.95 m 是用 floor-to-ceiling height 加 presumed 假设估算出来的。
 * 本常量标「模型跑出来的数（不是实测）」，不能与 Choi 2002 的实测分功能层高混为一谈。
 */
export const FLOOR_HEIGHT_PNNL_26949_M = 3.95;

/**
 * 【2026-11-16 第六轮回件】人均楼面面积换成实测口径，不再自设。
 *
 * 办公：EIA CBECS 2018 Table B1（principal building activity = Office 行）
 *   16,662 百万 sq ft / 32,843 千人 = **507 sq ft/worker**（均值；Table B16 中位数 609）。
 *   口径按 EIA 术语表："Floorspace: All the area enclosed by the exterior walls
 *   … including … basements, hallways, lobbies, stairways, and elevator shafts"
 *   ——是 gross 口径，与本项目「每层占地面积」同量级，可直接除。
 *   换算：507 × 0.092903 = 47.1 m²/worker。
 *
 * 住宅：2021 AHS 全国中位数（HUD 新闻稿 pr22-192，2022-09-29）
 *   租赁户 **500 square feet per person** → 46.5 m²/人。
 *   DC 都会区自己的静态原表只到 1998 年（H170/98-18 Table 2-3，
 *   Square Feet per Person 中位 895），且该表**只统计独立式单户与移动房屋**，
 *   不含多户公寓（表注 "Does not include multiunits, cooperatives or condominiums"），
 *   不能代表 DC 的城市公寓存量。DC 近年数值只在 Census 交互式 Table Creator，
 *   没有静态原表。所以住宅用全国租赁中位数，并在台账标明这是全国口径。
 *
 * 其他：两者之间取中，标注为工程取值（没有对应的分功能实测）。
 */
export const SELF_SET = Object.freeze({
  /** 人均楼面面积 m²/人。前两项是实测/官方统计换算值，other 是工程取值。 */
  floorAreaPerPerson: { residential: 46.5, office: 47.1, other: 46.8 },
  /**
   * 首层地板高出室外地面的基础高度。
   * DC 20 DCMR Ch.31（2025-06-20 生效的最终规则）§3107.3：设计洪水高程
   * DFE = BFE + 2 ft freeboard 与 500 年洪水高程取高；§3109.1 住宅最低楼层
   * 须达 DFE。旧规 20 DCMR §3105.2/3105.3 为 BFE 以上 **1.5 ft（0.457 m）**。
   * 【限制】这些条文只管**洪泛区内的新建与实质改造**，不是全城建筑都有抬高；
   * 本项目没有「建筑—洪泛区」匹配数据，统一取 1.5 ft 属外推，已标在台账。
   * 新规的 2 ft（0.610 m）作为对照常量保留。
   */
  foundationHeightM: 0.457,
  foundationHeightDc2025M: 0.610,
  /** 楼层门牌分配时，地面层算 1 层。 */
  groundFloorIsOne: true,
});

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * 【逐栋首层高 2026-11-20】FEMA 分位数校正表（web/assets/city/foundation_fema.json）。
 *
 * 为什么要有：`SELF_SET.foundationHeightM` 是「全城统一 1.5 ft」，它来自 DC 洪泛区
 * 新建建筑的 DFE 条款，**不是全城建筑实测**。tools/calibrate_foundation_fema.py 用
 * FEMA 2015 默认台基值按分位数映射到逐栋，值域 0.30–1.22 m；用统一 0.457 会让
 * 室内一层进水差 3–4 倍（docs/首层标高校正_2026-11-18.md：淹楼数 163 vs 540 vs 3358）。
 *
 * 性质：三组占比（A_全国河岸 / B_老城排屋 / C_商业为主）是**假设**，不是 DC 实测；
 * 这里只是把已经算好的逐栋值接进运行时，不新增任何假设。
 */
let FOUNDATION = null;   // { byId: Map<string, number>, scenario, defaultM, coverage }

/** 注册逐栋首层高表（由 web/src/terrain.js 在读完 buildings.json 后调用）。 */
export function setFoundationTable(table) {
  FOUNDATION = table && table.byId && typeof table.byId.get === 'function' ? table : null;
}

/** 这张表是否已注册（没有注册时全部退回 SELF_SET，行为与旧版一致）。 */
export function foundationReady() { return !!FOUNDATION; }

/**
 * 某栋楼的首层高（m）。找不到就给统一默认值，并把来源标出来：
 * 'fema' = 逐栋分位数校正值，'default' = 全城统一 1.5 ft。
 * @param {string|number} id 建筑 id（buildings.json 的 b.id）
 */
export function foundationMFor(id) {
  const key = id === undefined || id === null ? '' : String(id);
  if (FOUNDATION && key && FOUNDATION.byId.has(key)) {
    return { m: FOUNDATION.byId.get(key), source: 'fema', scenario: FOUNDATION.scenario };
  }
  return { m: SELF_SET.foundationHeightM, source: 'default', scenario: null };
}

/**
 * 地下室（2026-11-17 新增）。
 *
 * 【为什么必须有这一层】Thieken 等 2026（*Earth's Future* 14(9):e2026EF008695）
 * 逐例重建了 2021 年 7 月德比两国全部 224 名死者：室内 131 人里，**29 人死在
 * 地下室（22.1%）**、7 人死在地下层公寓（从一层往下走进去的那种），而且多数
 * 是去抢救财物、查看水泵、开始清淤时被水困住的。本项目此前只有地上层
 * （层数 = 建筑高度 ÷ 层高），地下室这条路完全不存在，等于把这 22% 抹掉了。
 *
 * 【不做什么】没有华盛顿特区建筑的地下室比例、面积、窗井与排水形式，
 * 所以**不逐栋判定有没有地下室**，而是给每个"在家"的人一个可以下去的地下
 * 空间，深浅与进水条件都用下面的值。这是**目前自己定的**，不是实测。
 */
export const BASEMENT = Object.freeze({
  /**
   * 地下室地板在室外地坪以下的深度 m。
   * 【2026-11-21 由拍的数改为推导】净高取下限 2.13 m（IBC 1208.2 可居住空间
   * 最小净高 7 ft），加楼板与垫层 0.1 m → 2.23 m，取 2.2。
   * 净高这条规范本会话未核原文，标「半自设」；深度对伤亡的影响已在 A/B 里
   * 看过（凡是地下室进水，人都在 2.2 m 水深里，改 1.8/2.6 只移动时间不移动结局）。
   */
  depthM: 2.2,
  /** 室外地面积水超过这个值，地下室就算进水（经窗井、门洞、下水倒灌）。 */
  entryDepthM: 0.05,
  /**
   * 在家、脚下已见水的人里，下地下室的比例。
   * 【目前自己定的】没有实测的"下地下室比例"，只知道死亡里有 22% 在地下室；
   * 拿死亡份额反推下去的比例是错的（下而不死的人远多于死的），所以这里不反推。
   * 【2026-11-21】仍无 DC 实测，定位为「情景参数」：0.35 是工程判断（回家的人里
   * 约三分之一会去关泵、搬东西），必须配敏感性 0.20 / 0.50 一起报，不能单独引用。
   */
  goesDownShare: 0.35,
  /** 下去待多久（分钟），在区间内均匀取。抢救财物、查水泵这类动作的量级。 */
  stayMin: [10, 25],
});

/** 这个人这次会不会下地下室。确定性哈希，同一个人永远同一答案。 */
export function goesToBasement(i, share = BASEMENT.goesDownShare) {
  const s = Number(share);
  // 【修 2026-11-17】share 为 NaN 时比较恒 false、>1 时恒 true，都不该发生。
  const p = Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : BASEMENT.goesDownShare;
  return hash01(i, 0x5bd1) < p;
}

/** 下去待多少分钟。 */
export function basementStayMin(i) {
  const [a, b] = BASEMENT.stayMin;
  return a + (b - a) * hash01(i, 0x1b87);
}

/** 地下室地板相对室外地坪的高程（负数，米）。 */
export function basementElevationM() {
  return -BASEMENT.depthM;
}

/** 建筑功能 → 容纳量档。OSM function 字符串里的关键词粗分，标注为工程映射。 */
export function occupancyClass(fn = '') {
  const f = String(fn || '').toLowerCase();
  if (/apartment|residential|house|dormitory|hotel|terrace|detached|cabin/.test(f)) return 'residential';
  if (/office|commercial|retail|government|civic|school|university|hospital/.test(f)) return 'office';
  return 'other';
}

/** 按建筑功能取层高（见 FLOOR_HEIGHT_BY_FUNCTION 的出处与限制）。 */
export function floorHeightFor(functionName) {
  const cls = occupancyClass(functionName);
  return FLOOR_HEIGHT_BY_FUNCTION[cls] || FLOOR_HEIGHT_BY_FUNCTION.other;
}

/**
 * 由真实建筑高度派生层数（不是逐层实测，是高度/层高的估计）。
 * @param {number} heightM 建筑真实高度 height_m
 * @param {number} [floorHeightM] 显式层高；不给就按 functionName 取
 * @param {string} [functionName] 建筑功能字符串
 * @returns {number} 层数，至少 1
 */
export function floorsFromHeight(heightM, floorHeightM = null, functionName = '') {
  const h = Number(heightM);
  if (!Number.isFinite(h) || h <= 0) return 1;
  const fh = Number.isFinite(floorHeightM) && floorHeightM > 0
    ? floorHeightM : floorHeightFor(functionName);
  return Math.max(1, Math.round(h / (fh > 0 ? fh : FLOOR_HEIGHT_M)));
}

/**
 * 某层的地板高程（相对建筑室外地面，米）。1 层 = 基础高度，往上每层加层高。
 * @param {number} floor 层号，从 1 开始
 * @param {number} [foundation] 基础高度
 * @param {number} [floorHeightM] 该建筑的层高
 */
export function floorElevationM(floor, foundation = SELF_SET.foundationHeightM,
  floorHeightM = FLOOR_HEIGHT_M) {
  // 【修 2026-11-17】层号与基础高度都要挡非有限值：floor=Infinity 会算出
  // Infinity 高程，foundation=NaN 会污染整栋楼的全部楼层判定。
  const rawFloor = Number(floor);
  const f = Number.isFinite(rawFloor) ? Math.max(1, Math.floor(rawFloor)) : 1;
  const rawBase = Number(foundation);
  const base = Number.isFinite(rawBase) ? rawBase : SELF_SET.foundationHeightM;
  const fh = Number.isFinite(floorHeightM) && floorHeightM > 0 ? floorHeightM : FLOOR_HEIGHT_M;
  return base + (f - 1) * fh;
}

/**
 * 每栋楼每层的名义容纳人数。
 *
 * 【2026-11-16 修正一处口径错误】buildings.json 的 area_m2 是
 * **占地面积（footprint）**，不是总楼面面积 GFA——它由
 * tools/export_buildings.py 从 Blender 模型量得，输出字段名就是
 * footprint_area_m2，方法为各面环投影面积。旧实现写 area / floors / per，
 * 等于把占地当成总楼面再摊到每层，**每层容量被低估了「层数」倍**
 * （3 层楼只剩三分之一）。现在按「每层面积 ≈ 占地面积」算。
 * 这条修正会让同样一栋楼能装更多人，属于纠正，不是调参。
 *
 * @param {object} b 建筑对象，需含 area_m2 / function / height_m
 */
export function capacityPerFloor(b) {
  const cls = occupancyClass(b && b.function);
  const raw = Number(b && b.area_m2);
  // 【修 2026-11-17】area=Infinity 会让 cap=Infinity，所有人被塞进第 1 层，
  // 且 capacity 序列化成 null。非有限面积按「无面积」处理，人判室外。
  const area = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  const per = SELF_SET.floorAreaPerPerson[cls] || SELF_SET.floorAreaPerPerson.other;
  // 每层面积按占地面积取；没有面积时给 0（不会被分配到这层）。
  return area > 0 && Number.isFinite(per) && per > 0
    ? Math.max(1, Math.floor(area / per)) : 0;
}

/**
 * 给一个人分配楼层：同一栋楼的人按容量逐层填，超过总容量的站在室外（不会被
 * 错误标成「在楼里」——这正是用户说的定位矛盾）。确定性：同样的 i 与
 * 楼内序号永远分到同一层。
 *
 * @param {object} b 建筑对象
 * @param {number} ordinal 这个人在该楼内的序号（0 起）
 * @returns {{indoor:boolean, floor:number, elevationM:number, capacity:number,
 *            totalFloors:number, floorHeightM:number, reason:string}}
 */
export function assignFloor(b, ordinal) {
  const fh = floorHeightFor(b && b.function);
  const floors = floorsFromHeight(b && b.height_m, fh);
  const cap = capacityPerFloor(b);
  const n = Math.max(0, Math.floor(Number(ordinal) || 0));
  if (cap <= 0 || n >= cap * floors) {
    // 楼里放不下 → 明确判为室外，不把人硬塞进楼里造成「定位在楼里、显示在楼外」。
    return { indoor: false, floor: 0, elevationM: 0, capacity: cap,
      totalFloors: floors, floorHeightM: fh,
      foundationM: foundationMFor(b && b.id).m, foundationSource: 'n/a', foundationScenario: null,
      reason: '该楼按面积估算的容量已满，人在室外' };
  }
  const floor = Math.floor(n / cap) + 1;
  // 【逐栋首层高 2026-11-20】用这栋楼自己的首层高，不再无条件用全城统一值。
  const fm = foundationMFor(b && b.id);
  return { indoor: true, floor, elevationM: floorElevationM(floor, fm.m, fh),
    capacity: cap, totalFloors: floors, floorHeightM: fh,
    foundationM: fm.m, foundationSource: fm.source, foundationScenario: fm.scenario,
    reason: `按楼体面积估算容量，分配到第 ${floor} 层` };
}

/**
 * 淹没判据：水淹到多深才算「危险」，不是水一过地板就算。
 *
 * 出处：USACE HEC-LifeSim 2.0 技术参考手册 CPD-97a（2020）§4.2.3 与 Table 4-3。
 * 原文把判据分三种，按人的行动能力和有没有上屋顶区分：
 *   A. High hazard depth from floor —— 从该层**地板**起算，用于行动不便者，
 *      默认 4–6 ft 三角分布、5 ft 最佳估计（1.22 / 1.52 / 1.83 m）。
 *      原文假设：行动不便者能到最高层（可借助他人），但不攀爬、不游泳。
 *   B. High hazard depth from ceiling —— 从该层**天花板**往下量，用于能行动
 *      但没上屋顶的人（含进阁楼的），默认 0.5–1.5 ft、1 ft 最佳
 *      （0.15 / 0.30 / 0.46 m）。原文假设：人会爬到东西上保持在水面以上。
 *   C. High hazard depth on roof —— 屋顶以上 3–5 ft（1.22 m 最佳），用于上了
 *      屋顶的人。本项目没有「上屋顶」这个动作，不实现 C。
 *
 * 换成本项目用的量：B 是「离天花板还有多薄」，等价于「水离该层地板有多深」，
 * 即 层高 − 1 ft。层高按住宅 2.74 m（Choi 2002 的 2.7 m；LifeSim 默认 9 ft
 * = 2.74 m，两处独立数据吻合）算，B 的阈值约 2.44 m。
 *
 * 【为什么这条重要】上一版是「水深一超过顶层地板就判楼内无处可退」，
 * 哪怕只淹到脚踝。按 LifeSim 的判据，站在房间里水到膝盖还算低危险，
 * 要接近天花板才是高危险。改过来之后「顶层被淹」不再等于「马上会死」。
 *
 * 【没实现的部分】LifeSim 还有 C（上屋顶）和建筑倒塌判据（水深×流速超阈值
 * 就倒塌、倒塌判高危险）。本项目没有流速场、也没有「上屋顶」动作，
 * 这两块算不了，会让高危险（被冲走 / 被埋）这一类伤亡缺失，见 fatality.js。
 */
export const SUBMERGENCE = Object.freeze({
  /** A：行动不便者，从该层地板起算（米），三角分布下/最佳/上。 */
  limitedMobilityFromFloorM: { min: 1.219, best: 1.524, max: 1.829 },
  /** B：能行动者，从该层天花板往下量（米）。 */
  ableBodiedFromCeilingM: { min: 0.152, best: 0.305, max: 0.457 },
  /**
   * 行动不便的年龄近似。**65 岁两边是 LifeSim 的口径**（CPD-97a 把人口分成
   * under 65 / over 65 两层，行动不便者按 A 类判据单独处理）；
   * **13 岁这条是【目前自己定的】**——原文没有给儿童的行动能力分界，也没有
   * 说儿童一律算行动不便。这里只是取「小学毕业前后」这个常识分界，用来让
   * 儿童走更严格的 A 类判据（从地板起算 1.52 m）。要改就改这里。
   */
  limitedMobilityAge: { under: 13, over: 65 },
  source: 'USACE HEC-LifeSim 2.0 Technical Reference Manual, CPD-97a（2020）, '
    + '§4.2.3 Submergence Criteria 与 Table 4-3',
});

/**
 * 这一层的水要积到多深才算高危险。
 * @param {object} o
 * @param {boolean} o.limitedMobility 是否行动不便（年龄近似）
 * @param {number} o.floorHeightM 该楼层高
 * @returns {number} 从该层地板起算的阈值（米）
 */
export function submergenceThresholdM(o = {}) {
  const fh = Number.isFinite(o.floorHeightM) && o.floorHeightM > 0
    ? o.floorHeightM : FLOOR_HEIGHT_M;
  if (o.limitedMobility) return SUBMERGENCE.limitedMobilityFromFloorM.best;
  // 能行动：水离天花板还有 1 ft 就是高危险 → 从地板起算 = 层高 − 0.305
  return Math.max(0.30, fh - SUBMERGENCE.ableBodiedFromCeilingM.best);
}

/** 年龄近似行动能力（LifeSim 的 under/over 65 口径）。 */
export function limitedMobilityByAge(age) {
  const a = Number(age);
  if (!Number.isFinite(a)) return false;
  return a < SUBMERGENCE.limitedMobilityAge.under || a > SUBMERGENCE.limitedMobilityAge.over;
}

/**
 * 楼层淹没判定（内核判定，纯函数）。
 * 水深相对室外地面；某层地板高程 + 基础高度被水淹没，该层失护。
 * 能往更高且未被淹的层转移就转移；连顶层都被淹才判溺亡。
 *
 * @param {object} o
 * @param {number} o.waterDepthM 室外地面水深
 * @param {number} o.currentFloor 当前层
 * @param {number} o.totalFloors 楼总层数
 * @param {number} o.foundationM 基础高度（默认 DC 旧规 1.5 ft）
 * @param {number} o.floorHeightM 该建筑层高（按功能取，默认 3.3）
 * @returns {{status:'safe'|'moveUp'|'drowning', targetFloor:number,
 *            safeFloor:number, reason:string}}
 */
/** 楼层扫描的工程上限。【目前自己定的】只用于挡住病态输入（无限层数／极端高度），
 *  不参与任何正常计算：真实建筑最多百余层，远低于此值。 */
const MAX_FLOOR_SCAN = 1000;

export function floodFloor(o) {
  const rawW = Number(o && o.waterDepthM);
  const w = Number.isFinite(rawW) ? Math.max(0, rawW) : 0;
  const rawTotal = Number(o && o.totalFloors);
  // 【修 2026-11-17】totalFloors=Infinity 原先会让 targetFloor 变成 Infinity；
  // 极大有限值还会让下面的逐层扫描跑不完成。统一夹到工程上限内。
  const total = Number.isFinite(rawTotal)
    ? Math.max(1, Math.min(MAX_FLOOR_SCAN, Math.floor(rawTotal) || 1)) : 1;
  const cur = clamp(Math.floor(Number(o && o.currentFloor) || 1), 1, total);
  const base = Number.isFinite(o && o.foundationM)
    ? o.foundationM : SELF_SET.foundationHeightM;
  const fh = Number.isFinite(o && o.floorHeightM) && o.floorHeightM > 0
    ? o.floorHeightM : FLOOR_HEIGHT_M;
  const elev = (f) => floorElevationM(f, base, fh);
  const floorWet = (f) => w > elev(f);
  if (!floorWet(cur)) {
    return { status: 'safe', targetFloor: cur, safeFloor: cur,
      reason: `第 ${cur} 层地板高程 ${elev(cur).toFixed(2)} m 高于水深 ${w.toFixed(2)} m` };
  }
  // 当前层被淹：找最高的未被淹层往上转移。
  let best = 0;
  for (let f = total; f >= 1; f--) {
    if (!floorWet(f)) { best = f; break; }
  }
  if (best > cur) {
    return { status: 'moveUp', targetFloor: best, safeFloor: best,
      reason: `第 ${cur} 层已被淹，往未被淹的第 ${best} 层转移` };
  }
  if (best >= 1) {
    // 走到这里说明「最高的未淹层」不高于当前层：当前层被淹，却没找到更高的
    // 干层。楼层高程随层数单调递增、水又从下往上淹，按理进不来；真进来了只
    // 能是层高／基础高度给错。旧实现在这里返回 moveUp 到 best —— 会把人往
    // **楼下**送，方向和危险相反。改成按无路可退处理，宁可保守也不逆着水走。
    return { status: 'drowning', targetFloor: cur, safeFloor: 0,
      reason: `第 ${cur} 层已进水，且没有更高的干层（最高未淹层为第 ${best} 层），按楼内无处可退处理` };
  }
  return { status: 'drowning', targetFloor: cur, safeFloor: 0,
    reason: `水已淹到顶层（总 ${total} 层），楼内无处可退` };
}

/**
 * 【2026-11-16 Muse 回件】DC 建筑层数带分布（对本地 buildings.json 自算，
 * n=21,943 栋，层数 = round(height_m/3.3)，最小 1 层）。
 * 性质：由真实高度派生的**自算分布**，不是逐层实测、也不是官方发布的楼层统计。
 * 本地文件：from muse/DC待定五项数据包/dc-pending-20261116/01-DC楼层分布-自算.csv
 * 原始高度带分布（height_m，栋数/占比）也一并保留，改层高假设可重算。
 */
export const DC_FLOOR_DISTRIBUTION = Object.freeze({
  source: '项目 web/assets/city/buildings.json（OSM 建筑轮廓+高度，经 blosm 导入），21,943 栋',
  sourceFile: 'from muse/DC待定五项数据包/dc-pending-20261116/01-DC楼层分布-自算.csv',
  nature: '由真实高度自算的估算分布（统一按 3.3 m/层），不是逐层实测，也不是官方统计',
  note: '第六轮起层高改为按功能取（办公 3.8 / 住宅 2.7 / 其他 3.3），本分布仍按统一 3.3 m 记录，'
    + '只作历史对照；实际运行时的层数按功能层高逐栋算，与本表会有出入。',
  floorHeightAssumptionM: 3.3,
  heightBands: [
    { band: '0-4 m', count: 986, pct: 4.5 }, { band: '4-7 m', count: 1433, pct: 6.5 },
    { band: '7-10 m', count: 7386, pct: 33.7 }, { band: '10-13 m', count: 5981, pct: 27.3 },
    { band: '13-20 m', count: 3953, pct: 18.0 }, { band: '20-35 m', count: 1264, pct: 5.8 },
    { band: '35-65 m', count: 937, pct: 4.3 }, { band: '65-100 m', count: 2, pct: 0.0 },
    { band: '>100 m', count: 1, pct: 0.0 },
  ],
  floorBands: [
    { floors: '1', count: 1490, pct: 6.8 }, { floors: '2', count: 3237, pct: 14.8 },
    { floors: '3', count: 8371, pct: 38.1 }, { floors: '4', count: 4882, pct: 22.2 },
    { floors: '5', count: 1437, pct: 6.5 }, { floors: '6-10', count: 1571, pct: 7.2 },
    { floors: '11-20', count: 952, pct: 4.3 }, { floors: '21-40', count: 2, pct: 0.0 },
    { floors: '41+', count: 1, pct: 0.0 },
  ],
  caveat: '个别高度为 OSM 标注异常值（最大 169.3 m），21 层以上尾部不可直接当真',
});

/** 供验收与文档引用。 */
export const FLOOR_META = Object.freeze({
  measured: [
    '建筑高度、功能、面积：OpenStreetMap，本地 buildings.json（21,943 栋，真实 height_m）',
    '层高（按功能）：办公 3.8 m、住宅/酒店 2.7 m —— Choi 2002, Architectural Research 4(1):1–6，130 栋高层实测统计（办公 3.5–4.1，住宅 2.6–2.9）',
    '层高交叉印证：Jedwab, Barr & Brueckner 2022, JUE 132:103507 附录（CTBUH 19,132 栋回归，每层 3.8 m，95% CI [3.77, 3.87]）',
    '人均楼面面积（办公 47.1 m²/worker）：EIA CBECS 2018 Table B1，Office 507 sq ft/worker，gross 口径',
    '人均楼面面积（住宅 46.5 m²/人）：2021 AHS 全国租赁中位数 500 sq ft/person（HUD pr22-192），全国口径不是 DC 本地',
    '首层基础高度 0.457 m：DC 20 DCMR §3105.2/3105.3（旧规，BFE + 1.5 ft）',
    '楼层淹没判据形式：FLOODrisk 2016 e3sconf_floor2016_19006；USACE LifeSim / Silva 2025',
  ],
  derived: '层数 = 真实高度 ÷ 按功能取的层高，四舍五入；这是由实测高度派生的估计，不是逐层实测',
  limits: [
    'Choi 2002 的层高样本是高层建筑；DC 存量以 2–4 层为主，套用属外推。IBC/IRC 只规定净高下限，没有 floor-to-floor 规范值',
    '住宅人均面积用的是全国租赁中位数，不是 DC 本地；DC 本地静态原表只到 1998 且只含独立式单户',
    'DC 首层抬高条文只约束洪泛区内新建与实质改造，本项目无建筑—洪泛区匹配数据，统一取值属外推；2025 新规为 2 ft（0.610 m）',
  ],
  selfSet: [
    '其他类人均 46.8 m²/人：住宅与办公两端之间取中，没有分功能实测',
    '建筑功能到容量档的映射（关键词粗分）：工程映射',
  ],
});
