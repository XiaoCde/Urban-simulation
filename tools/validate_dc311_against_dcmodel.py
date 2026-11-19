#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""用 DC 官方「Integrated Flood Model」成果，检验两件事：
  1. 我们的坐标换算对不对（311 点是否落在 DC 自己的内涝范围里）；
  2. 我们的水模型格局对不对（同一批点，我们算的 vs DC 算的）。

为什么要这一步：直接用 311 对比我们自己的图，得到的是「几乎全部落干区」。
在把结论写成「我们的水模型错了」之前，必须先排除坐标换算错——
办法是拿同一批点去撞第三方（DC 官方）的成果：如果对官方也撞不上，
那是坐标或点位的问题；如果对官方撞得上、对我们撞不上，才是我们的问题。

数据：
  DC GIS，Environment_Flood / Integrated Flood Model 1-Year Scenario（图层 11），
  字段 DEPTH（英尺？米？按值 0.5 判断应为英尺，下面按原值报，不做换算猜测）。
  https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Environment_Flood/MapServer/11
"""
import json, os, math, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEOJSON = os.path.join(ROOT, "data/real/dc311/dc_flood_model_1yr.geojson")
URL = ("https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Environment_Flood/"
       "MapServer/11/query?where=1%3D1&outFields=DEPTH&outSR=4326&returnGeometry=true"
       "&f=geojson&resultRecordCount=2000&resultOffset={}")


def fetch_all():
    if os.path.exists(GEOJSON):
        d = json.load(open(GEOJSON, encoding="utf-8"))
        if len(d.get("features", [])) >= 4500:
            return d
    feats, off = [], 0
    while True:
        with urllib.request.urlopen(URL.format(off), timeout=120) as r:
            d = json.load(r)
        f = d.get("features", [])
        if not f:
            break
        feats.extend(f)
        off += len(f)
        print("  已取 %d 条" % off, flush=True)
        if len(f) < 2000:
            break
    out = {"type": "FeatureCollection", "features": feats}
    json.dump(out, open(GEOJSON, "w", encoding="utf-8"), ensure_ascii=False)
    return out


def rings_of(geom):
    t = geom.get("type")
    cs = geom.get("coordinates") or []
    if t == "Polygon":
        return [cs]
    if t == "MultiPolygon":
        return cs
    return []


def inside(pt, polygon):
    """射线法，处理洞。"""
    x, y = pt
    hit = False
    for ring in polygon:
        n = len(ring)
        for i in range(n):
            x1, y1 = ring[i][0], ring[i][1]
            x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
            if ((y1 > y) != (y2 > y)) and (x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-18) + x1):
                hit = not hit
    return hit


def main():
    d = fetch_all()
    feats = d["features"]
    print("DC 官方 1 年一遇内涝多边形：%d 个" % len(feats))

    # 建网格索引（0.005 度 ≈ 500 m）加速
    cell = 0.005
    grid = {}
    for f in feats:
        for poly in rings_of(f.get("geometry") or {}):
            xs = [p[0] for p in poly[0]]; ys = [p[1] for p in poly[0]]
            for gx in range(int(math.floor(min(xs)/cell)), int(math.floor(max(xs)/cell))+1):
                for gy in range(int(math.floor(min(ys)/cell)), int(math.floor(max(ys)/cell))+1):
                    grid.setdefault((gx, gy), []).append((poly, f["properties"].get("DEPTH")))

    raw = json.load(open(os.path.join(ROOT, "data/real/dc311/flood_requests_raw.json"), encoding="utf-8"))
    pts = []
    seen = set()
    for y, rows in raw.items():
        for r in rows:
            la, lo = r.get("LATITUDE"), r.get("LONGITUDE")
            if not (isinstance(la, (int, float)) and isinstance(lo, (int, float))):
                continue
            if not (38.80 < la < 38.99 and -77.12 < lo < -76.90):
                continue
            k = (round(lo, 4), round(la, 4))
            if k in seen:
                continue
            seen.add(k)
            pts.append((lo, la, r.get("SERVICECODEDESCRIPTION"), y))

    inside_n = 0
    depths = []
    for lo, la, t, y in pts:
        for poly, dep in grid.get((int(math.floor(lo/cell)), int(math.floor(la/cell))), []):
            if inside((lo, la), poly):
                inside_n += 1
                if isinstance(dep, (int, float)):
                    depths.append(dep)
                break
    print("")
    print("311 去重后 %d 点，落在 DC 官方 1 年一遇内涝范围内：%d 个（%.1f%%）"
          % (len(pts), inside_n, 100 * inside_n / max(1, len(pts))))
    if depths:
        depths.sort()
        print("这些点的官方 DEPTH 取值：最小 %.2f，中位 %.2f，最大 %.2f（原字段值）"
              % (depths[0], depths[len(depths)//2], depths[-1]))


if __name__ == "__main__":
    main()
