# -*- coding: utf-8 -*-
"""探测 DCGIS 服务：能否拿到多边形几何 + 两层能否用 GLOBALID 关联。"""
import json
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
ROOT = ("https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/"
        "Facility_and_Structure/MapServer/")
BBOX = "-77.0175,38.8965,-77.017,38.897"


def get(layer, **kw):
    ps = {"where": "1=1", "geometry": BBOX, "geometryType": "esriGeometryEnvelope",
          "inSR": "4326", "spatialRel": "esriSpatialRelIntersects",
          "outSR": "4326", "f": "json"}
    ps.update(kw)
    url = ROOT + str(layer) + "/query?" + urllib.parse.urlencode(ps)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=90) as r:
        raw = r.read().decode("utf-8", "replace")
    try:
        return json.loads(raw)
    except Exception:
        return raw


print("=" * 78)
print("① 图层 1（Building Footprints 多边形）带几何")
d = get(1, outFields="OBJECTID,GLOBALID", returnGeometry="true",
        resultRecordCount="3")
print("  返回类型:", type(d).__name__, "features:", len(d.get("features", [])) if isinstance(d, dict) else "-")
if isinstance(d, dict):
    for f in d.get("features", [])[:2]:
        g = f.get("geometry", {})
        print("  OID=%s GID=%s rings=%d 首环点数=%d"
              % (f["attributes"]["OBJECTID"], f["attributes"]["GLOBALID"],
                 len(g.get("rings", [])), len(g.get("rings", [[]])[0])))

print()
print("=" * 78)
print("② 图层 2（3D）带几何 —— 看返回什么")
d = get(2, outFields="OBJECTID,GLOBALID,MAX_Z", returnGeometry="true",
        resultRecordCount="2")
print("  返回类型:", type(d).__name__)
if isinstance(d, dict):
    for f in d.get("features", [])[:2]:
        print("  属性:", f.get("attributes"))
        g = f.get("geometry", {})
        print("  几何键:", list(g.keys()))
        for k, v in g.items():
            if isinstance(v, str):
                print("     %s = <str %d 字符>" % (k, len(v)))
            else:
                print("     %s = %s" % (k, repr(v)[:120]))

print()
print("=" * 78)
print("③ 两层 GLOBALID 是否对得上（同一小块各取 40 个）")
a = get(1, outFields="GLOBALID", returnGeometry="false",
        resultRecordCount="40")
b = get(2, outFields="GLOBALID", returnGeometry="false",
        resultRecordCount="40")
sa = {f["attributes"]["GLOBALID"] for f in a.get("features", [])}
sb = {f["attributes"]["GLOBALID"] for f in b.get("features", [])}
print("  图层1 GLOBALID 数:", len(sa))
print("  图层2 GLOBALID 数:", len(sb))
print("  交集:", len(sa & sb))
if sa & sb:
    print("  样例:", list(sa & sb)[:3])

print()
print("=" * 78)
print("④ 图层 2 用 f=geojson 试试")
try:
    r = get(2, outFields="OBJECTID,MAX_Z", returnGeometry="true",
            resultRecordCount="2", f="geojson")
    if isinstance(r, dict):
        print("  成功, keys:", list(r.keys()))
        for f in r.get("features", [])[:1]:
            print("  geometry.type:", f.get("geometry", {}).get("type"))
    else:
        print("  非 JSON 前 200 字符:", r[:200])
except Exception as e:
    print("  失败:", e)
