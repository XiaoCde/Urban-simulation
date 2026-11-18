# -*- coding: utf-8 -*-
"""对比「楼有没有被淹」的两种口径，量化旧口径高估了多少。

旧口径（simple_drainage.py 现在用的）：建筑轮廓 bbox 内**任意一点**水深 > 5cm，
  就算整栋被淹。楼角有一洼水就报淹，系统性偏高。

新口径（本次要接的）：
  - 轮廓内水深要**淹过首层地面**才算进水。首层地面 = 基础高度（foundation）。
  - 用 DCGIS 3D 建筑的逐栋台基高（minz）作 foundation，截断到 [0, 1.2] m：
    1.2 m 是宽松上限，超过当 lidar 归一化的异常；下限 0 表示贴地。
  - 同时给出「统一按 DC 旧规 0.457 m」的对照，避免只依赖一个有偏差的数据源。

数据：
  - data/flood/l1_1m/depth_l1.tif   1 m 峰值水深（50 mm/h 一场雨）
  - data/flood/l1_1m/params.json    栅格原点与尺寸
  - data/derived/buildings_footprints.json  建筑轮廓（项目米坐标）
  - data/derived/building_foundation.json   DCGIS 逐栋台基高

输出：控制台对比 + data/derived/building_flood_compare.json
"""
import json
import os
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEPTH = os.path.join(ROOT, "data", "flood", "l1_1m", "depth_l1.tif")
PARAMS = os.path.join(ROOT, "data", "flood", "l1_1m", "params.json")
BLD = os.path.join(ROOT, "data", "derived", "buildings_footprints.json")
FOUND = os.path.join(ROOT, "data", "derived", "building_foundation.json")
OUT = os.path.join(ROOT, "data", "derived", "building_flood_compare.json")

# 和 simple_drainage.py 的过滤口径一致：有 building 标签、15<=面积<=60000
MIN_AREA, MAX_AREA = 15.0, 60000.0
WET = 0.05                      # 5 cm 起算"有水"
DC_CODE_FOUNDATION = 0.457      # DC 旧规 1.5 ft
FOUND_CAP = 1.20                # 逐栋台基高上限，超过按异常截断


def main():
    p = json.load(open(PARAMS, encoding="utf-8"))["grid"]
    x0, y1, step = p["x0"], p["y1"], p["step_m"]
    depth = np.array(Image.open(DEPTH))
    h, w = depth.shape
    print("水深栅格: %dx%d, 原点 x=%.1f y1=%.1f, step=%.1f m" % (w, h, x0, y1, step))

    bj = json.load(open(BLD, encoding="utf-8"))
    found = json.load(open(FOUND, encoding="utf-8"))

    stats = {"total": 0, "old": 0, "dcgis": 0, "code": 0,
             "old_only": 0, "matched_found": 0, "median_water_gt5": 0, "median_gt_found": 0}
    rows = []

    for b in bj.get("features", []):
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
        col0 = int(max(0, min(w - 1, (min(xs) - x0) / step)))
        col1 = int(max(0, min(w, (max(xs) - x0) / step)))
        row0 = int(max(0, min(h - 1, (y1 - max(ys)) / step)))
        row1 = int(max(0, min(h, (y1 - min(ys)) / step)))
        if col1 <= col0 or row1 <= row0:
            continue
        block = depth[row0:row1, col0:col1]
        stats["total"] += 1
        dmax = float(block.max())
        dmed = float(np.median(block))

        f = found.get(str(b.get("id")))
        fmin = 0.0
        if f:
            stats["matched_found"] += 1
            fmin = min(max(float(f.get("minz") or 0), 0.0), FOUND_CAP)

        old_wet = dmax > WET
        dcgis_wet = dmax > (fmin + WET)
        code_wet = dmax > (DC_CODE_FOUNDATION + WET)
        med_wet = dmed > WET

        if old_wet:
            stats["old"] += 1
        if dcgis_wet:
            stats["dcgis"] += 1
        if code_wet:
            stats["code"] += 1
        if med_wet:
            stats["median_water_gt5"] += 1
        if old_wet and not dcgis_wet:
            stats["old_only"] += 1

        if old_wet:
            rows.append({"id": b.get("id"), "max_depth": round(dmax, 3),
                         "median_depth": round(dmed, 3), "foundation": round(fmin, 3),
                         "dcgis_wet": dcgis_wet, "code_wet": code_wet})

    json.dump({"stats": stats, "rows": rows}, open(OUT, "w", encoding="utf-8"),
              ensure_ascii=False)
    print("=" * 64)
    print("参与统计的楼: %d 栋（有 building 标签、15–6万 m²）" % stats["total"])
    print("  旧口径（轮廓内任意点>5cm）        : %d 栋  ← 现在报表用的" % stats["old"])
    print("  中位水深>5cm（去边缘低洼）        : %d 栋" % stats["median_water_gt5"])
    print("  逐栋首层高（DCGIS, 截断≤1.2m）    : %d 栋" % stats["dcgis"])
    print("  统一 DC 规范 0.457m 首层高        : %d 栋" % stats["code"])
    print("  旧口径判淹、但逐栋首层高判不淹     : %d 栋  ← 高估部分" % stats["old_only"])
    print("  匹配到逐栋台基高的楼              : %d / %d = %.1f%%"
          % (stats["matched_found"], stats["total"],
             100.0 * stats["matched_found"] / max(1, stats["total"])))
    print("输出: %s" % OUT)


if __name__ == "__main__":
    main()
