/**
 * household.js — 把「逐人抽样的 ACS 记录」合成成户。
 *
 * 为什么要单独一个文件：户不是装饰。户规模 + 户内有未成年 + 与户主关系码
 * 决定门 5 的照护责任（access-impediment.js 的 careChildDutyOf），户车数
 * 决定 hasCar 与「有没有车开」（social-circles.js / traffic.js），同户还构成
 * 同伴网络的家庭边（peer-network.js）。这些字段一旦互相矛盾，上面三条链路
 * 全部跟着漂。
 *
 * ACS microsample 没有户号（SERIALNO），「谁和谁一户」只能合成。合成方式
 * 决定了内部是否自洽，这就是本文件的全部内容。
 *
 * 旧做法（连续切块）：从第 k 个人开始、按他自己的 householdSize 往后切一块。
 * 2000 人实测的后果——
 *   · 64.3% 的户里成员各自记录的户规模不一致；
 *   · 60.4% 的户里户车数冲突；
 *   · 52.5% 的「户内有未成年」冲突；
 *   · 45.1% 的户出现「有车且有驾照的成员数 > 户车数」，合计 544 张驾照对
 *     397 辆户车（1.37×）。
 *
 * 现在的做法：按 (户规模, 户车数, 户内有未成年) 三元组分组。同户成员的三条
 * 记录完全一致，组内不可能再冲突。桶里人数凑不满整户时，余下的人各自成
 * 1 人户，并把 sizeOf 写成 1（否则门 5 会把「记录说 2 口人」的落单人误判成
 * 单亲带娃）。代价：桶余数部分的人户规模与自己的记录不同，逐条计数、不藏。
 *
 * 分布影响（2000 人实测）：户规模 1/2/3/4/5 = 552/278/118/72/50，
 * 旧法 538/274/117/72/55 —— 逐档仍与 ACS 记录接近。
 */

const MAX_HH = 5;      // Borowski 2023 QA9 的自我中心网络上限
const MAX_VEH = 4;     // PUMS VEH 的现实上限（5+ 归并）

function hsOf(r) {
  const v = Number(r && r.householdSize);
  return Number.isFinite(v) && v >= 1 ? Math.min(MAX_HH, Math.floor(v)) : 1;
}

function vehOf(r) {
  const v = Number(r && r.householdVehicles);
  return Number.isFinite(v) && v >= 0 ? Math.min(MAX_VEH, Math.floor(v)) : 0;
}

function minorOf(r) {
  return (r && (r.hasMinor === true || r.hasMinor === 1)) ? 1 : 0;
}

/**
 * @param {Array<{householdSize?:number, householdVehicles?:number, hasMinor?:boolean|number}>} records
 * @returns {{groups:number[][], sizeOf:number[], stats:object}}
 *   groups[i] = 第 i 个户的成员下标（长度 1–5）
 *   sizeOf[i] = 第 i 个户的最终户规模（= groups[i].length）
 */
export function groupHouseholds(records) {
  const list = Array.isArray(records) ? records : [];
  const buckets = new Map();
  for (let i = 0; i < list.length; i++) {
    const key = hsOf(list[i]) + '|' + vehOf(list[i]) + '|' + minorOf(list[i]);
    let arr = buckets.get(key);
    if (!arr) buckets.set(key, arr = []);
    arr.push(i);
  }
  const groups = [];
  const stats = {
    households: 0, bySize: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    leftoverPersons: 0, rewrittenSize: 0,
    conflictVehicles: 0, conflictMinor: 0,
  };
  // 按 key 排序遍历，保证同输入同输出（可复现，测试要对拍）。
  for (const key of [...buckets.keys()].sort()) {
    const idxs = buckets.get(key);
    const hs = hsOf(list[idxs[0]]);
    for (let k = 0; k < idxs.length; k += hs) {
      const grp = idxs.slice(k, k + hs);
      if (grp.length < hs) {
        // 桶余数：凑不成整户的人各自成 1 人户。不能留成「2 人户、两人记录都
        // 说 3 口人」——门 5 的照护责任只要求「户规模=2 且有未成年」，
        // 这种残缺户会被误判成单亲带娃。成 1 人户后户规模与成员记录一致
        // （都写成 1），代价是这些人没有同户同伴，逐条计数。
        for (const one of grp) {
          groups.push([one]);
          stats.households++;
          stats.bySize[1] = (stats.bySize[1] || 0) + 1;
          stats.leftoverPersons++;
          stats.rewrittenSize++;
        }
        continue;
      }
      groups.push(grp);
      stats.households++;
      stats.bySize[grp.length] = (stats.bySize[grp.length] || 0) + 1;
    }
  }
  // 自检：分完之后户内两条记录必须零冲突（测试会再独立核一次）。
  for (const g of groups) {
    if (new Set(g.map((i) => vehOf(list[i]))).size > 1) stats.conflictVehicles++;
    if (new Set(g.map((i) => minorOf(list[i]))).size > 1) stats.conflictMinor++;
  }
  return { groups, sizeOf: groups.map((g) => g.length), stats };
}

export const HOUSEHOLD_META = {
  source: 'ACS 2020–2024 5-Year PUMS（DC），逐人记录里的 户规模 / 户车数 / 户内有未成年',
  method: '按 (户规模, 户车数, 户内有未成年) 三元组分组，桶内顺序切块；余数成 1 人户',
  why: 'ACS microsample 无户号（SERIALNO），「谁和谁一户」必须合成；三元组分组是'
    + '让合成户内部不再互相矛盾的最小改动',
  selfSet: [
    '「谁和谁一户」仍是合成的：同三元组的人被排在一起，不是真实家庭关系',
    '桶余数（实测 2.8% 的人）各自成 1 人户，其户规模与自己的 ACS 记录不同，已逐条计数',
    '户内角色（户主/配偶/子女）沿用各自的 RELP，不按合成户重排',
  ],
  effect: '同户成员的三条记录一致 ⇒ 门5 照护责任、户车数、家车分配不再互相打架',
};