#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把我们的积水图与 DC 官方内涝模型（1 年一遇）做空间一致性对照。

口径（必须一起报）：
  · 我们：50 mm/h、1 小时、稳态 L1 算例（data/flood/l1_1m/depth_l1.tif）；
  · 官方：Integrated Flood Model 1-Year Scenario（DC GIS 图层 11），
    含河道、潮位与管网，重现期口径与我们的一场雨不同；
  · 因此这是「空间格局是否一致」的对照，不是同一场事件的校验；
  · 官方 DEPTH 字段原值 0.5，单位未核实，这里只用「有没有」不用「多深」。

输出：命中（两者都有水）、我们独有、官方独有、CI/CSI。
"""
import json, os, math

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
G_LON0, G_LON_KM = -77.059998, 0.059998
G_LAT0, G_LAT_KM = 38.885003, 0.039996
S_X0, S_X_SPAN = -887.0, 5197.0
S_Y0, S_Y_SPAN = -597.0, 4451.0
CELL = 0.005          # 约 500 m，建多边形的空间索引
STRIDE = 20           # 20 m 采样


def scene_to_geo(x, y):
    return (G_LON0 + (x - S_X0) / S_X_SPAN * G_LON_KM,
            G_LAT0 + (y - S_Y0) / S_Y_SPAN * G_LAT_KM)


def rings_of(geom):
    t = geom.get("type"); cs = geom.get("coordinates") or []
    if t == "Polygon":
        return [cs]
    if t == "MultiPolygon":
        return cs
    return []


def inside(pt, polygon):
    x, y = pt; hit = False
    for ring in polygon:
        n = len(ring)
        for i in range(n):
            x1, y1 = ring[i][0], ring[i][1]
            x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
            if ((y1 > y) != (y2 > y)) and (x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-18) + x1):
                hit = not hit
    return hit


def main():
    import numpy as np
    from PIL import Image

    g = json.load(open(os.path.join(ROOT, "data/flood/l1_1m/params.json"), encoding="utf-8"))["grid"]
    x0, y1, step, cols, rows = g["x0"], g["y1"], g["step_m"], g["cols"], g["rows"]
    depth = np.array(Image.open(os.path.join(ROOT, "data/flood/l1_1m/depth_l1.tif")))

    fc = json.load(open(os.path.join(ROOT, "data/real/dc311/dc_flood_model_1yr.geojson"),
                        encoding="utf-8"))["features"]
    grid = {}
    for f in fc:
        for poly in rings_of(f.get("geometry") or {}):
            xs = [p[0] for p in poly[0]]; ys = [p[1] for p in poly[0]]
            for gx in range(int(math.floor(min(xs) / CELL)), int(math.floor(max(xs) / CELL)) + 1):
                for gy in range(int(math.floor(min(ys) / CELL)), int(math.floor(max(ys) / CELL)) + 1):
                    grid.setdefault((gx, gy), []).append(poly)

    def dc_has(x, z):
        lon, lat = scene_to_geo(x, z)
        for poly in grid.get((int(math.floor(lon / CELL)), int(math.floor(lat / CELL))), []):
            if inside((lon, lat), poly):
                return True
        return False

    both = ours = theirs = neither = 0
    for r in range(0, rows, STRIDE):
        for c in range(0, cols, STRIDE):
            x = x0 + c * step
            z = y1 - r * step
            a = depth[r, c] > 0.05
            b = dc_has(x, z)
            if a and b: both += 1
            elif a: ours += 1
            elif b: theirs += 1
            else: neither += 1

    tot = both + ours + theirs + neither
    prec = both / max(1, both + ours)
    rec = both / max(1, both + theirs)
    csi = both / max(1, both + ours + theirs)
    print("采样点 %d（%d m 间隔，覆盖整幅栅格）" % (tot, STRIDE))
    print("  两者都有水 : %6d" % both)
    print("  只有我们有 : %6d" % ours)
    print("  只有官方有 : %6d" % theirs)
    print("  都没有     : %6d" % neither)
    print("")
    print("  精确率（我们报的湿区里，官方也认的）: %.1f%%" % (100 * prec))
    print("  召回率（官方湿区里，我们覆盖到的）  : %.1f%%" % (100 * rec))
    print("  关键成功指数 CSI                     : %.3f" % csi)
    json.dump({"both": both, "ours_only": ours, "dc_only": theirs, "neither": neither,
               "precision": prec, "recall": rec, "csi": csi, "stride_m": STRIDE,
               "note": "50 mm/h 稳态算例 vs DC 官方 1 年一遇模型，只比空间格局"},
              open(os.path.join(ROOT, "data/derived/dc_model_agreement.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
