#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""用 DC 311 的积水报修记录，检验我们水模型的空间格局对不对。

做法（只看空间重叠，不做事件配对）：
  1. 311 的每条报修有经纬度，按项目同一套线性投影换成场景坐标；
  2. 在 1 m 水深栅格上取该点的模拟水深；
  3. 报两个数：报修点落在「模拟有积水」的比例（命中率），
     以及全图有积水的格子占比（基准率）。命中率明显高于基准率，
     才说明我们的积水位置不是随便撒的。

口径限制（必须写清楚，不能当成「跟现实完全对上了」）：
  · 311 记录跨多个年份、多种降雨，我们的栅格只是一场 50 mm/h 的稳态算例，
    不是同一场雨，所以这是**空间格局**的对照，不是事件强度校验；
  · 「DC Water - Customer Flooding」多为进屋/返水类报修，不等于路面积水；
  · 报修本身有报告偏差（人口密、住户多的街区报得多）。
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 与 tools/add_dc_features.py 同一套投影常数
G_LON0, G_LON_KM = -77.059998, 0.059998
G_LAT0, G_LAT_KM = 38.885003, 0.039996
S_X0, S_X_SPAN = -887.0, 5197.0
S_Y0, S_Y_SPAN = -597.0, 4451.0


def geo_to_scene(lon, lat):
    return (S_X0 + (lon - G_LON0) / G_LON_KM * S_X_SPAN,
            S_Y0 + (lat - G_LAT0) / G_LAT_KM * S_Y_SPAN)


def main():
    raw = json.load(open(os.path.join(ROOT, "data/real/dc311/flood_requests_raw.json"), encoding="utf-8"))
    params = json.load(open(os.path.join(ROOT, "data/flood/l1_1m/params.json"), encoding="utf-8"))
    g = params["grid"]
    x0, y1, step, cols, rows = g["x0"], g["y1"], g["step_m"], g["cols"], g["rows"]

    import numpy as np
    from PIL import Image
    depth = np.array(Image.open(os.path.join(ROOT, "data/flood/l1_1m/depth_l1.tif")))
    if depth.shape != (rows, cols):
        print("栅格尺寸与 params 不符:", depth.shape, (rows, cols)); sys.exit(1)

    # 基准率：全图有水的格子占比
    base = {}
    for t in (0.05, 0.30):
        base[t] = float((depth > t).sum()) / depth.size

    pts = []
    for year, rows_ in raw.items():
        for r in rows_:
            lat, lon = r.get("LATITUDE"), r.get("LONGITUDE")
            if not (isinstance(lat, (int, float)) and isinstance(lon, (int, float))):
                continue
            if not (38.80 < lat < 38.99 and -77.12 < lon < -76.90):
                continue
            x, z = geo_to_scene(lon, lat)
            pts.append({"year": year, "x": x, "z": z, "id": r.get("SERVICEREQUESTID"),
                        "addr": r.get("STREETADDRESS"), "date": r.get("ADDDATE")})

    inside, outside = [], 0
    for p in pts:
        c = int((p["x"] - x0) / step)
        rI = int((y1 - p["z"]) / step)
        if 0 <= c < cols and 0 <= rI < rows:
            p["d"] = float(depth[rI, c])
            inside.append(p)
        else:
            outside += 1

    # 同一地址多次报修只算一次（按 10 m 网格去重），避免一条街的重复单拉高命中率
    seen = set(); uniq = []
    for p in inside:
        k = (round(p["x"] / 10), round(p["z"] / 10))
        if k in seen:
            continue
        seen.add(k); uniq.append(p)

    def rate(lst, t):
        return (sum(1 for p in lst if p["d"] > t) / len(lst)) if lst else float("nan")

    print("311 有效点 %d 个（域内 %d，域外 %d），按 10 m 去重后 %d 个"
          % (len(pts), len(inside), outside, len(uniq)))
    print("")
    print("阈值 | 报修点命中率 | 全图基准率 | 提升倍数")
    for t in (0.05, 0.30):
        h, b = rate(uniq, t), base[t]
        print("%.2f m | %8.1f%% | %7.1f%% | %.2f×"
              % (t, 100 * h, 100 * b, (h / b) if b > 0 else float("nan")))
    print("")
    depths = sorted(p["d"] for p in uniq)
    if depths:
        q = lambda f: depths[min(len(depths) - 1, int(len(depths) * f))]
        print("报修点处模拟水深（去重后）：中位 %.3f m，75 分位 %.3f，90 分位 %.3f，最大 %.3f"
              % (q(0.5), q(0.75), q(0.9), depths[-1]))
        print("完全没水（模拟 0）的报修点：%d 个（%.1f%%）"
              % (sum(1 for d in depths if d <= 0.001), 100 * sum(1 for d in depths if d <= 0.001) / len(depths)))

    # 按年份
    print("")
    for y in sorted(raw):
        sub = [p for p in uniq if p["year"] == str(y) or p["year"] == y]
        if sub:
            print("  %s：去重后 %3d 个，命中(>5cm) %.1f%%" % (y, len(sub), 100 * rate(sub, 0.05)))

    out = {"points": uniq, "base_rate": base,
           "note": "311 跨年记录 vs 单一 50 mm/h 稳态算例，只作空间格局对照"}
    json.dump(out, open(os.path.join(ROOT, "data/real/dc311/validation_points.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("\n逐点结果已写 data/real/dc311/validation_points.json")


if __name__ == "__main__":
    main()
