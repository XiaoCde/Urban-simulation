# -*- coding: utf-8 -*-
"""用 FEMA 的默认台基高度重设逐栋首层高，替代原先「截断到 1.2 m」的拍脑袋处理。

为什么这么做
------------
`building_foundation.json` 里的 minz 来自 DCGIS lidar 3D 建筑的最低点，
中位数 1.86 m，而 FEMA 的规范值里最高也就是桩基 2.13–2.44 m，
中位建筑不可能是桩基。所以 minz 有系统偏差，不能直接当首层高。

FEMA 2015 给了一套按基础类型的默认「一楼地面高于相邻地坪」值
（经 Frontiers 文章 Table 3 转引，原始出处 FEMA 2015）：

    平板基础 slab on grade        0.30 m
    填土 fill                      0.70 m
    架空层 crawl space        0.91–1.22 m
    地下室 basement               1.22 m
    柱梁 pier / post and beam 1.52–1.83 m
    桩 / 实心墙 pile, solid wall 2.13–2.44 m

做法：分位数映射（quantile mapping）。按 minz 排序，最低的一批当平板基础、
往上一批当架空层、最高的当有地下室，绝对值换成 FEMA 的规范值。
好处是保留逐栋相对高低（排序不变），去掉 lidar 的系统偏差；
代价是「哪个比例属于哪种基础」是一个假设，所以跑三组分布看敏感性。

三组假设（DC 本地的建筑基础类型分布没找到，如实标为假设）：
  A 全国河岸地区（FEMA 2015 的路易斯安那样本）：平板 57%、架空 38%、地下室 5%
  B 老城区排屋为主（DC 的 row house 普遍带地下室）：平板 40%、填土 5%、架空 25%、地下室 30%
  C 商业区为主：平板 75%、架空 15%、地下室 10%

输出
----
data/derived/building_foundation_fema.json   三组假设的逐栋值
data/derived/foundation_calibration.json     分布统计与淹楼数对比
"""
import json
import os
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FOUND = os.path.join(ROOT, "data", "derived", "building_foundation.json")
BLD = os.path.join(ROOT, "data", "derived", "buildings_footprints.json")
DEPTH = os.path.join(ROOT, "data", "flood", "l1_1m", "depth_l1.tif")
PARAMS = os.path.join(ROOT, "data", "flood", "l1_1m", "params.json")
OUT_FOUND = os.path.join(ROOT, "data", "derived", "building_foundation_fema.json")
OUT_STAT = os.path.join(ROOT, "data", "derived", "foundation_calibration.json")

MIN_AREA, MAX_AREA = 15.0, 60000.0
WET = 0.05
DC_CODE_FOUNDATION = 0.457          # 现在的默认值（DC 旧规 1.5 ft），作对照
OLD_CAP = 1.20                      # 原方案：截断上限，作对照

# FEMA 2015 默认值（m）。架空层取 0.91 与 1.22 的中点；桩与实心墙取低值。
FEMA_VAL = {
    "slab": 0.30,
    "fill": 0.70,
    "crawl": 1.07,
    "basement": 1.22,
}

# 三种假设，键顺序即「从低到高」的拼装顺序
SCENARIOS = {
    "A_全国河岸": [("slab", 0.57), ("crawl", 0.38), ("basement", 0.05)],
    "B_老城排屋": [("slab", 0.40), ("fill", 0.05), ("crawl", 0.25), ("basement", 0.30)],
    "C_商业为主": [("slab", 0.75), ("crawl", 0.15), ("basement", 0.10)],
}


def quantile_map(values_sorted, mix):
    """按给定占比把排序后的值切成若干段，每段赋一个规范值。返回等长数组。"""
    n = len(values_sorted)
    out = np.empty(n, dtype=float)
    start = 0
    for name, share in mix:
        cnt = int(round(n * share))
        if name == mix[-1][0]:
            cnt = n - start                       # 最后一段吃掉余数，避免累计误差
        end = min(n, start + cnt)
        out[start:end] = FEMA_VAL[name]
        start = end
    if start < n:
        out[start:] = FEMA_VAL[mix[-1][0]]
    return out


def main():
    found = json.load(open(FOUND, encoding="utf-8"))
    bld = json.load(open(BLD, encoding="utf-8"))
    p = json.load(open(PARAMS, encoding="utf-8"))["grid"]
    x0, y1, step = p["x0"], p["y1"], p["step_m"]
    depth = np.array(Image.open(DEPTH))
    h, w = depth.shape

    # ---- 1. 先给所有匹配到的建筑排个序，算出三组假设的规范值 ----
    keys = list(found.keys())
    raw = np.array([float(found[k].get("minz") or 0.0) for k in keys])
    order = np.argsort(raw, kind="stable")
    keys_sorted = [keys[i] for i in order]

    per_scenario = {}
    for name, mix in SCENARIOS.items():
        vals = quantile_map(np.sort(raw), mix)
        per_scenario[name] = dict(zip(keys_sorted, vals))

    # ---- 2. 逐栋判淹 ----
    counters = {}
    for name in list(SCENARIOS) + ["原方案_截断1.2", "DC规范_0.457", "无首层高_旧口径"]:
        counters[name] = 0
    total, matched = 0, 0

    for b in bld.get("features", []):
        tag = (b.get("building") or "").strip()
        area = float(b.get("footprint_area_m2") or 0)
        if not tag or area < MIN_AREA or area > MAX_AREA:
            continue
        rings = b.get("rings") or []
        if not rings or len(rings[0]) < 3:
            continue
        pts = rings[0]
        xs = [q[0] for q in pts]
        ys = [q[1] for q in pts]
        c0 = int(max(0, min(w - 1, (min(xs) - x0) / step)))
        c1 = int(max(0, min(w, (max(xs) - x0) / step)))
        r0 = int(max(0, min(h - 1, (y1 - max(ys)) / step)))
        r1 = int(max(0, min(h, (y1 - min(ys)) / step)))
        if c1 <= c0 or r1 <= r0:
            continue
        dmax = float(depth[r0:r1, c0:c1].max())
        total += 1

        bid = str(b.get("id"))
        f = found.get(bid)
        if f:
            matched += 1
            raw_v = min(max(float(f.get("minz") or 0.0), 0.0), OLD_CAP)
        else:
            raw_v = DC_CODE_FOUNDATION

        if dmax > WET:
            counters["无首层高_旧口径"] += 1
        if dmax > raw_v + WET:
            counters["原方案_截断1.2"] += 1
        if dmax > DC_CODE_FOUNDATION + WET:
            counters["DC规范_0.457"] += 1
        for name in SCENARIOS:
            v = per_scenario[name].get(bid, DC_CODE_FOUNDATION)
            if dmax > v + WET:
                counters[name] += 1

    # ---- 3. 分布统计 ----
    def describe(arr):
        a = np.sort(np.asarray(arr, dtype=float))
        q = lambda p_: float(np.percentile(a, p_ * 100))
        return {"min": round(float(a[0]), 3), "p10": round(q(0.10), 3),
                "median": round(q(0.50), 3), "p90": round(q(0.90), 3),
                "mean": round(float(a.mean()), 3), "max": round(float(a[-1]), 3)}

    stats = {
        "total_buildings_counted": total,
        "matched_foundation": matched,
        "raw_dcgis_minz": describe(raw),
        "scenarios": {},
        "counts": counters,
    }
    for name in SCENARIOS:
        vals = [per_scenario[name][k] for k in keys]
        stats["scenarios"][name] = {
            "mix": SCENARIOS[name],
            "distribution": describe(vals),
            "flooded_buildings": counters[name],
        }

    json.dump({"stats": stats,
               "per_scenario": {n: {k: round(float(v), 3) for k, v in d.items()}
                                for n, d in per_scenario.items()}},
              open(OUT_STAT, "w", encoding="utf-8"), ensure_ascii=False)
    json.dump({"note": "三组假设的逐栋首层高（m），来源见 docs/首层标高校正_2026-11-18.md",
               "scenarios": SCENARIOS,
               "per_scenario": {n: {k: round(float(v), 3) for k, v in d.items()}
                                for n, d in per_scenario.items()}},
              open(OUT_FOUND, "w", encoding="utf-8"), ensure_ascii=False)

    # ---- 4. 打印 ----
    print("=" * 66)
    print("逐栋台基高：原始 DCGIS 与三组 FEMA 校正后")
    print("-" * 66)
    r = stats["raw_dcgis_minz"]
    print("原始 DCGIS minz  : 中位 %.2f  p90 %.2f  最大 %.2f  ← 有系统偏差" %
          (r["median"], r["p90"], r["max"]))
    for name in SCENARIOS:
        d = stats["scenarios"][name]["distribution"]
        print("%-14s : 中位 %.2f  均值 %.2f  p90 %.2f" % (name, d["median"], d["mean"], d["p90"]))
    print("-" * 66)
    print("淹楼数（50 mm/h 那场雨，参与统计 %d 栋）" % total)
    print("  无首层高（轮廓任意点>5cm） : %5d 栋   ← 最早的口径" % counters["无首层高_旧口径"])
    print("  原方案（DCGIS 截断≤1.2m）  : %5d 栋   ← 昨天用的" % counters["原方案_截断1.2"])
    for name in SCENARIOS:
        print("  %-12s（FEMA 校正） : %5d 栋" % (name, counters[name]))
    print("  DC 规范统一 0.457m         : %5d 栋" % counters["DC规范_0.457"])
    print("-" * 66)
    print("匹配到逐栋数据的楼: %d / %d = %.1f%%" % (matched, total, 100.0 * matched / max(1, total)))
    print("输出: %s" % OUT_STAT)


if __name__ == "__main__":
    main()
