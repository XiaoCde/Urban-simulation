# -*- coding: utf-8 -*-
r"""两件事：
 ① layer 13（Detailed Roof）的 `BldgPly_3D_Roof_<M>` 里的 M，是不是也是
    Planimetrics_2023 的 OBJECTID？如果是，真实屋顶坡度覆盖率也能拉满。
 ② Planimetrics_2023 服务里还有没有别的带高度字段的图层。
"""
import json
import os
import urllib.parse
import urllib.request

P23 = "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Planimetrics_2023/MapServer"
BBOX = "-77.059998,38.885003,-77.000000,38.924999"
ENV = dict(geometry=BBOX, geometryType="esriGeometryEnvelope", inSR="4326",
           outSR="4326", spatialRel="esriSpatialRelIntersects")
OUT = r"D:\Users\asus\Desktop\项目\data\dcgis"


def g(u, timeout=120):
    r = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(r, timeout=timeout).read()


def main():
    root = json.loads(g(P23 + "?f=json").decode())
    print("Planimetrics_2023 图层：")
    for L in root.get("layers", []):
        md = json.loads(g("%s/%d?f=json" % (P23, L["id"])).decode())
        flds = [f["name"] for f in md.get("fields", [])]
        hgt = [f for f in flds if any(k in f.upper() for k in ("HEIGHT", "ELEV", "_Z", "ROOF"))]
        print("  %2d %-32s geom=%-16s 高度相关字段=%s"
              % (L["id"], L["name"], md.get("geometryType"), hgt or "-"))

    ids = set(json.loads(g("%s/1/query?%s" % (P23, urllib.parse.urlencode(
        dict(ENV, where="1=1", returnIdsOnly="true", f="json")))).decode())["objectIds"])
    print("\nPlanimetrics_2023/1 框内 OBJECTID：%d 个，区间 [%d, %d]"
          % (len(ids), min(ids), max(ids)))

    rd = json.load(open(os.path.join(OUT, "roofs_detailed.json"), encoding="utf-8"))
    m13 = set()
    for f in rd["features"]:
        gid = f["a"].get("GIS_ID") or ""
        if gid.startswith("BldgPly_3D_Roof_"):
            try:
                m13.add(int(gid[len("BldgPly_3D_Roof_"):]))
            except ValueError:
                pass
    print("layer13 BldgPly_3D_Roof_<M>：%d 个，区间 [%d, %d]" % (len(m13), min(m13), max(m13)))
    print("★ 与 Planimetrics_2023 OBJECTID 交集 = %d / %d  (%.1f%%)"
          % (len(m13 & ids), len(m13), len(m13 & ids) * 100.0 / max(1, len(m13))))

    # 再顺手确认：layer13 的 9,002 条里有多少能通过 M 直接落到 2023 轮廓上
    eg = {}
    for f in rd["features"]:
        gid = f["a"].get("GIS_ID") or ""
        if gid.startswith("BldgPly_3D_Roof_"):
            try:
                eg[int(gid[len("BldgPly_3D_Roof_"):])] = f["a"]
            except ValueError:
                pass
    sample = [k for k in list(eg)[:5]]
    for k in sample:
        print("   示例 M=%d → %s" % (k, {kk: vv for kk, vv in eg[k].items()
                                        if kk in ("SLOPE_MEAN", "ROOF_TYPE",
                                                  "HOUSE_HEIGHT", "ALTITUDE_MAX", "EGID")}))


if __name__ == "__main__":
    main()
