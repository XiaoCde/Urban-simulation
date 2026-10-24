# -*- coding: utf-8 -*-
r"""验证假设：3D 高度层（layer 2）的 `BldgPly_<N>` 指向的是
   **当前平面轮廓（Planimetrics_YYYY / Building Footprints）** 的主键，而不是
   Facility_and_Structure/MapServer/1 的 OBJECTID。

   如果成立：真实高度的覆盖率会从 29% 跳到接近 100%，而且平面轮廓层通常还自带高度字段。
"""
import json
import os
import urllib.parse
import urllib.request

HOST = "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA"
CAND = [
    ("Planimetrics_2023", "MapServer/1", "Building Footprints 2023"),
    ("Planimetrics_2021", "MapServer/1", "Building Footprints 2021"),
    ("Planimetrics_2017", "MapServer/1", "Building Footprints 2017"),
    ("Planimetrics_2013", "MapServer/4", "Building Footprints 2013"),
    ("Planimetrics_2015", "MapServer/6", "Building Footprints 2015"),
    ("Planimetrics_2005", "MapServer/0", "Building Footprints 2005"),
]
BBOX = "-77.059998,38.885003,-77.000000,38.924999"
ENV = dict(geometry=BBOX, geometryType="esriGeometryEnvelope", inSR="4326",
           outSR="4326", spatialRel="esriSpatialRelIntersects")
OUT = r"D:\Users\asus\Desktop\项目\data\dcgis"


def g(u, timeout=120):
    r = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(r, timeout=timeout).read()


def main():
    b3 = json.load(open(os.path.join(OUT, "buildings_3d.json"), encoding="utf-8"))
    n2 = set()
    for f in b3["features"]:
        gid = f["a"].get("GIS_ID") or ""
        if gid.startswith("BldgPly_"):
            try:
                n2.add(int(gid[len("BldgPly_"):]))
            except ValueError:
                pass
    print("layer 2 的 BldgPly_<N> ：%d 个，区间 [%d, %d]\n" % (len(n2), min(n2), max(n2)))

    for svc, lyr, title in CAND:
        url = "%s/%s/%s" % (HOST, svc, lyr)
        try:
            md = json.loads(g(url + "?f=json").decode())
        except Exception as e:
            print("%-26s 读取失败 %s" % (title, e))
            continue
        flds = [f["name"] for f in md.get("fields", [])]
        print("%-26s geom=%-10s maxRec=%-6s" % (title, md.get("geometryType"),
                                                md.get("maxRecordCount")))
        print("   fields: %s" % ",".join(flds))
        try:
            ids = json.loads(g(url + "/query?" + urllib.parse.urlencode(
                dict(ENV, where="1=1", returnIdsOnly="true", f="json"))).decode())
            oid = set(ids.get("objectIds") or [])
            hit = len(oid & n2)
            print("   框内 %d 条；与 BldgPly_<N> 交集 = %d / %d  (%.1f%%)"
                  % (len(oid), hit, len(n2), hit * 100.0 / max(1, len(n2))))
        except Exception as e:
            print("   查询失败 %s" % e)
        print()


if __name__ == "__main__":
    main()
