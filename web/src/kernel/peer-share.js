/**
 * peer-share.js — 参照群体（egalitarian 自我中心网络）里「留下 / 搭车 / 步行撤离」的占比。
 *
 * 【为什么单独成文件】Borowski & Stathopoulos 2023 Table 4 的两个同伴变量
 * 定义是**非空间**的：受访者被告知其自我中心社会网络（最多 5 人）里
 * 各方案的百分比。项目里的参照群体由 crowd-life.js 合成（同户 + 3 个
 * 120 m 内邻居），规模接近「最多 5 人」，可以直接按状态分类。
 * 以前这两项在 live-agent.js 里就地算，只有 peersStay 一条，peersRide
 * 从来没赋值 → 论文的 −1.27（p=0.000）与 threat × peersRide 交互项
 * 恒乘 0，属于「系数挂着、通路是死的」。现在两条都在这里算，且有纯函数
 * 单测（web/tests/check-peer-share.mjs）。
 *
 * 【分类口径，逐条对应论文的四个方案】
 *   · ride    —— 此刻坐在车里（ped.inVehicle）：论文的「选择乘车撤离」
 *   · walk    —— 已经在跑/已到避险点、但不是坐车：步行撤离
 *   · stay    —— 剩下的（还在正常活动/原地）：论文的「留下来」
 * 旧实现把「开车走的人」算进 stay（只排除 mode=flee/shelter），
 * 于是同伴开车走了反而抬高 stay 占比，方向和论文相反；这里一并修掉。
 */

const FLEEING = new Set(['flee', 'shelter']);

/**
 * @param {Array<{mode?:string, inVehicle?:boolean}>} states 参照群体成员此刻的状态
 * @returns {{total:number, ride:number, walk:number, stay:number,
 *            peersRide:number, peersStay:number}}
 */
export function peerShares(states) {
  const list = Array.isArray(states) ? states.filter(Boolean) : [];
  const total = list.length;
  if (!total) {
    // 参照群体为空（独居且周边无邻居）时给 0：论文的 0 = 没人选该方案，
    // 不等于「所有人留下」。这一点和旧实现一致，也是 2026-11-19 修过的坑。
    return { total: 0, ride: 0, walk: 0, stay: 0, peersRide: 0, peersStay: 0 };
  }
  let ride = 0, walk = 0, stay = 0;
  for (const s of list) {
    if (s.inVehicle === true) { ride++; continue; }
    const m = String(s.mode || '');
    if (FLEEING.has(m)) { walk++; continue; }
    stay++;
  }
  return {
    total, ride, walk, stay,
    peersRide: ride / total,
    peersStay: stay / total,
  };
}

export const PEER_SHARE_META = {
  source: 'Borowski & Stathopoulos 2023, Natural Hazards Review 24(1):04022045, Table 4 + 第四轮 QA9 公开定义',
  definition: '自我中心社会网络中「选择乘车撤离 / 留下来」的比例，非空间半径人数；设计范围 同伴留下 0–0.8、同伴搭车 0–1',
  network: 'crowd-life.js 合成参照群体：同户成员 + 120 m 内最多 3 个邻居（规模≈论文的「最多 5 人」）',
  selfSet: [
    '「乘车」用在车状态 ped.inVehicle 判定，是本仿真唯一可观测的「选 ride」代理',
    '邻居配对是按住址就近生成，不是真实社会网络调查；拿到真实网络数据应替换',
  ],
};