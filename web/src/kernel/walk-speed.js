/**
 * walk-speed.js — 年龄别舒适步速，来自实测 meta 分析。
 *
 * 【之前】citizen.js 的 AGE_BANDS 里 9 档各带一个 walk 倍率
 * （0.46 / 0.84 / 1.06 / 1.08 / 1.04 / 0.98 / 0.86 / 0.70 / 0.56），
 * 全是项目自己定的，导师在录音里点名过「老人小孩步速不一样」要有依据。
 *
 * 【现在】20 岁及以上改用 Bohannon & Andrews 2011 的实测年龄 × 性别
 * 舒适步速均值（Table 2，41 篇研究、23,111 人）。
 * 第四轮 QC2 还更正了引文：正确是 Bohannon & Andrews, Physiotherapy
 * 97:182–189 (2011)，不是之前清单里写的 Bohannon & Williams / JGPT。
 *
 * 【20 岁以下】该 meta 分析最小的年龄档是 20–29 岁，没有儿童／青少年数据。
 * 这一部分仍用项目自设倍率，必须显式标「目前自己定的」，不能混进实测里报。
 *
 * 【动画基准】motion-units.js 的 WALK.BASE = 1.35 m/s 是 Mixamo walk clip
 * 的设计步速，只用于动画 timeScale；Weidmann 1993 实测的无阻自由速度
 * 是 1.34 m/s，两者接近但不是同一个量，别互相冒用。
 */
import { BOHANNON_GAIT, WEIDMANN } from './evidence-tables.js';

/**
 * 实测舒适步速，单位 m/s。
 * @returns {number|null} 20 岁以下返回 null（原文无数据），调用方须改用自设值并标注。
 */
export function measuredComfortableSpeedMs(age, female = false) {
  const a = Number(age);
  if (!Number.isFinite(a) || a < 20) return null;
  let cell = BOHANNON_GAIT.cells[0];
  for (const c of BOHANNON_GAIT.cells) {
    if (a >= c.from) cell = c;
  }
  const cmPerSec = female ? cell.female : cell.male;
  return cmPerSec / 100;
}

/** 供验收与文档引用：实测表的分档与来源。 */
export const WALK_SPEED_META = Object.freeze({
  measured: {
    source: BOHANNON_GAIT.source,
    ages: '20–29 / 30–39 / 40–49 / 50–59 / 60–69 / 70–79 / 80–99',
    unit: 'cm/s，除以 100 得 m/s',
    note: '每格样本量在原文 Table 2，范围 83–8,591；第四轮回件未逐格取到，不写死 n',
  },
  freeFlow: WEIDMANN,
  selfSet: [
    '20 岁以下没有实测步速，沿用项目自设的年龄倍率',
    '经验、洪水经历对步速的折减（0.88 + 经验×0.22）是工程处理',
    '跑步倍率与体力、疲劳的关联仍是自设',
  ],
  example20sMale: measuredComfortableSpeedMs(25, false),
  example80sFemale: measuredComfortableSpeedMs(85, true),
});
