# -*- coding: utf-8 -*-
r"""测 DCGIS 各图层之间到底靠什么关联。

背景：layer 2 的 `GIS_ID = "BldgPly_<N>"` 曾被误当成 layer 1 的 OBJECTID，
      实测只命中 35/22697 → 编号空间不同，那个"主键"不成立。
      但三个 3D 图层（2/3/13）与轮廓图层（1）**都有 GLOBALID**，
      GLOBALID 是 ESRI 设计用来跨图层稳定关联的 GUID，值得一试。
"""
import json
import urllib.parse
import urllib.request

BASE = ("https://maps2.dcgis.dc.gov/dcgis/rest/services/"
        "DCGIS_DATA/Facility_and_Structure/MapServer")
BB = "-77.059998,38.885003,-77.000000,38.924999"
ENV = dict(geometry=BB, geometryType="esriGeometryEnvelope", inSR="4326",
           spatialRel="esriSpatialRelIntersects")


def q(layer, **p):
    p.setdefault("outSR", "4326")
    p.setdefault("f", "json")
    u = "%s/%d/query?%s" % (BASE, layer, urllib.parse.urlencode(p))
    r = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    return json.loads(urllib.request.urlopen(r, timeout=120).read().decode())


def main():
    d2 = q(2, where="MAX_Z>80", outFields="GLOBALID,MAX_Z,GIS_ID",
           returnGeometry="false", resultRecordCount="8", **ENV)
    rows = d2.get("features", [])
    print("layer 2 高层（MAX_Z>80）取 %d 条：" % len(rows))
    for f in rows:
        a = f["attributes"]
        print("   MAX_Z=%-8s GIS_ID=%-18s GLOBALID=%s" % (a["MAX_Z"], a["GIS_ID"], a["GLOBALID"]))
    gl = [f["attributes"]["GLOBALID"] for f in rows]
    if not gl:
        print("没取到样例，退出")
        return

    ins = ",".join("'%s'" % g for g in gl)
    for layer, flds in ((1, "GLOBALID,OBJECTID,DESCRIPTION,CAPTUREYEAR"),
                        (3, "GLOBALID,EGID,GIS_ID"),
                        (13, "GLOBALID,EGID,SLOPE_MEAN,ROOF_TYPE")):
        d = q(layer, where="GLOBALID IN (%s)" % ins, outFields=flds,
              returnGeometry="false", **ENV)
        fs = d.get("features", [])
        print("\nlayer %d 用 GLOBALID 反查：命中 %d / %d" % (layer, len(fs), len(gl)))
        for f in fs[:8]:
            print("   ", f["attributes"])

    # 再测：GIS_ID 在 layer 3 里的形态
    d3 = q(3, where="1=1", outFields="GIS_ID,EGID", returnGeometry="false",
           resultRecordCount="5", **ENV)
    print("\nlayer 3 的 GIS_ID 样例：")
    for f in d3.get("features", []):
        print("   ", f["attributes"])


if __name__ == "__main__":
    main()
