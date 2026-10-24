# -*- coding: utf-8 -*-
r"""拉 Planimetrics_2023 的 `Building Footprints - 2023` 多边形几何。

════════════════════════════════════════════════════════════════════════
为什么是这一层（这是全流程的关键钥匙）
════════════════════════════════════════════════════════════════════════
    layer 2 "Buildings - 3D"（2024-03-01 lidar）的主键形如 `BldgPly_<N>`，
    而 Facility_and_Structure/MapServer/1 的 OBJECTID **对不上**（只命中 35/22,697）。

    实测发现：`N` 真正指向的是
      DCGIS_DATA/Planimetrics_2023/MapServer/**1**  Building Footprints - 2023
    框内 22,697 条多边形，与 `BldgPly_<N>` 的交集 = **22,697 / 22,697 = 100.0%**。

    于是最终链路（全部是主键 join，不需要空间匹配 heights）：
      Planimetrics_2023/1 的 OBJECTID = N
        --BldgPly_N-->  layer 2 的 MAX_Z / MIN_Z / MEDIAN_Z   ← 真实高度、真实屋顶隆起
        --BldgPly_3D_N--> 不行（那套编号属于 Facility_and_Structure/1）

    屋顶坡度另外走一条已验证的链路（覆盖约 29%）：
      Facility_and_Structure/1 的 OBJECTID
        --BldgPly_3D_<N>-->  layer 3 "Buildings - 3D 2013" 的 EGID
        --EGID-->            layer 13 "Buildings (Detailed Roof)" 的 SLOPE_MEAN / ROOF_TYPE

    ⚠ 踩坑：`resultOffset` 分页**不可靠**（22,791 条只翻回 3,999 条），
      必须用 returnIdsOnly + objectIds 分批。

用法:
    python tools\fetch_p23.py
"""
import json
import os
import time
import urllib.parse
import urllib.request

URL = ("https://maps2.dcgis.dc.gov/dcgis/rest/services/"
       "DCGIS_DATA/Planimetrics_2023/MapServer/1/query")
BBOX = (-77.059998, 38.885003, -77.000000, 38.924999)
OUT = r"D:\Users\asus\Desktop\项目\data\dcgis\p23_footprints.json"
PAGE = 700
FIELDS = "OBJECTID,DESCRIPTION,FEATURECODE,CAPTUREYEAR"


def get(url, tries=4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            last = e
            print("    重试 %d/%d %s" % (i + 1, tries, e))
            time.sleep(2 + 3 * i)
    raise RuntimeError("拉取失败: %s" % last)


def outer_ring(geom):
    if not geom:
        return None
    best, best_a = None, -1.0
    for r in geom.get("rings") or []:
        pts = [(round(float(p[0]), 7), round(float(p[1]), 7)) for p in r if len(p) >= 2]
        if len(pts) < 3:
            continue
        a = 0.0
        for i in range(len(pts)):
            x1, y1 = pts[i]
            x2, y2 = pts[(i + 1) % len(pts)]
            a += x1 * y2 - x2 * y1
        a = abs(a) * 0.5
        if a > best_a:
            best, best_a = pts, a
    return best


def main():
    t0 = time.time()
    w, s, e, n = BBOX
    env = {"geometry": "%.6f,%.6f,%.6f,%.6f" % (w, s, e, n),
           "geometryType": "esriGeometryEnvelope", "inSR": "4326", "outSR": "4326",
           "spatialRel": "esriSpatialRelIntersects"}
    ids = get("%s?%s" % (URL, urllib.parse.urlencode(
        dict(env, where="1=1", returnIdsOnly="true", f="json")))).get("objectIds") or []
    print("Building Footprints 2023：框内 %d 条，按 %d 一批取几何" % (len(ids), PAGE))

    rows = []
    for i in range(0, len(ids), PAGE):
        q = dict(env, objectIds=",".join(str(k) for k in ids[i:i + PAGE]),
                 outFields=FIELDS, returnGeometry="true", f="json")
        d = get("%s?%s" % (URL, urllib.parse.urlencode(q)))
        if "error" in d:
            raise RuntimeError(d["error"])
        for f in d.get("features", []):
            ring = outer_ring(f.get("geometry"))
            if ring:
                rows.append({"a": f["attributes"], "p": ring})
        print("  批 %3d/%d → 累计 %d" % (i // PAGE + 1, (len(ids) + PAGE - 1) // PAGE, len(rows)))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump({"layer": "Planimetrics_2023/1", "bbox": list(BBOX), "fields": FIELDS,
               "geom": True, "count": len(rows), "features": rows},
              open(OUT, "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    oids = {r["a"]["OBJECTID"] for r in rows}
    print("\n→ %s" % OUT)
    print("   %d 条多边形，%.1f MB，OBJECTID 区间 [%d, %d]"
          % (len(rows), os.path.getsize(OUT) / 1048576, min(oids), max(oids)))
    print("   耗时 %.0f 秒" % (time.time() - t0))


if __name__ == "__main__":
    main()
