# -*- coding: utf-8 -*-
r"""把 DCGIS 各图层的编号空间对齐，找出真正能用的关联链。

已排除的错误假设：
    layer2.GIS_ID = "BldgPly_<N>"  →  N **不是** layer1.OBJECTID（只命中 35/22697）。
    GLOBALID 跨图层反查 → 0/2 命中（GLOBALID 是逐图层各自的，不能跨层关联）。

已知线索：
    layer 3 "Buildings - 3D 2013" 的 GIS_ID = "BldgPly_3D_<N>"，N ∈ [52522, 55973]
    layer 1 的 OBJECTID ∈ [53717, 59279]（部分样本）→ **区间是重叠的**
    layer 3 与 layer 13 有共同的 EGID（DC00018369 / DC00028634 / DC00039012 都出现过）

本脚本拉 layer 3 的属性，逐一验证下面三组交集：
    ① layer1.OBJECTID          ∩ layer3 的 BldgPly_3D_<N>
    ② layer3.EGID              ∩ layer13.EGID
    ③ layer2 的 BldgPly_<N>     ∩ layer3 的 BldgPly_3D_<N>
"""
import json
import os
import urllib.parse
import urllib.request

BASE = ("https://maps2.dcgis.dc.gov/dcgis/rest/services/"
        "DCGIS_DATA/Facility_and_Structure/MapServer")
BB = "-77.059998,38.885003,-77.000000,38.924999"
ENV = dict(geometry=BB, geometryType="esriGeometryEnvelope", inSR="4326",
           spatialRel="esriSpatialRelIntersects")
OUT = r"D:\Users\asus\Desktop\项目\data\dcgis"


def q(layer, **p):
    p.setdefault("outSR", "4326")
    p.setdefault("f", "json")
    u = "%s/%d/query?%s" % (BASE, layer, urllib.parse.urlencode(p))
    r = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    return json.loads(urllib.request.urlopen(r, timeout=120).read().decode())


def all_of(layer, fields):
    ids = q(layer, where="1=1", returnIdsOnly="true", **ENV).get("objectIds") or []
    out = []
    for i in range(0, len(ids), 1000):
        d = q(layer, where="1=1", outFields=fields, returnGeometry="false",
              objectIds=",".join(str(k) for k in ids[i:i + 1000]), **ENV)
        out.extend(f["attributes"] for f in d.get("features", []))
    return out


def num(gid, prefix):
    if gid and gid.startswith(prefix):
        try:
            return int(gid[len(prefix):])
        except ValueError:
            return None
    return None


def main():
    fp = json.load(open(os.path.join(OUT, "footprints.json"), encoding="utf-8"))
    oids = {f["a"]["OBJECTID"] for f in fp["features"]}
    print("layer 1 轮廓 OBJECTID : %d 条，区间 [%d, %d]" % (len(oids), min(oids), max(oids)))

    b3 = json.load(open(os.path.join(OUT, "buildings_3d.json"), encoding="utf-8"))
    n2 = {num(f["a"].get("GIS_ID"), "BldgPly_") for f in b3["features"]}
    n2.discard(None)
    print("layer 2 BldgPly_<N>   : %d 条，区间 [%d, %d]" % (len(n2), min(n2), max(n2)))

    rd = json.load(open(os.path.join(OUT, "roofs_detailed.json"), encoding="utf-8"))
    eg13 = {f["a"].get("EGID") for f in rd["features"]}
    eg13.discard(None)
    print("layer 13 EGID         : %d 个唯一值" % len(eg13))

    print("\n拉 layer 3（Buildings - 3D 2013）属性 …")
    l3 = all_of(3, "GIS_ID,EGID")
    n3 = {num(r.get("GIS_ID"), "BldgPly_3D_") for r in l3}
    n3.discard(None)
    eg3 = {r.get("EGID") for r in l3}
    eg3.discard(None)
    print("layer 3 记录 %d 条；BldgPly_3D_<N> %d 个，区间 [%s, %s]；EGID %d 个"
          % (len(l3), len(n3), min(n3) if n3 else "-", max(n3) if n3 else "-", len(eg3)))

    print("\n" + "=" * 78)
    print("① layer1.OBJECTID ∩ layer3.BldgPly_3D_<N> : %d / %d"
          % (len(oids & n3), len(n3)))
    print("② layer3.EGID     ∩ layer13.EGID          : %d / %d"
          % (len(eg3 & eg13), len(eg3)))
    print("③ layer2.BldgPly_<N> ∩ layer3.BldgPly_3D_<N>: %d / %d"
          % (len(n2 & n3), len(n2)))
    print("   layer2 区间 [%d, %d] vs layer3 区间 [%d, %d]"
          % (min(n2), max(n2), min(n3), max(n3)))


if __name__ == "__main__":
    main()
