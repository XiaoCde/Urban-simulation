# -*- coding: utf-8 -*-
"""快速看 layer 17 / 1 的字段与几何键，判断能不能拿到 EGID + 普通多边形。"""
import json
import urllib.parse
import urllib.request

BASE = ("https://maps2.dcgis.dc.gov/dcgis/rest/services/"
        "DCGIS_DATA/Facility_and_Structure/MapServer")
BBOX = "-77.059998,38.885003,-77.000000,38.924999"


def q(layer, **extra):
    p = {"where": "1=1", "geometry": BBOX, "geometryType": "esriGeometryEnvelope",
         "inSR": "4326", "outSR": "4326", "outFields": "*", "returnGeometry": "true",
         "resultRecordCount": "2", "f": "json"}
    p.update(extra)
    url = "%s/%d/query?%s" % (BASE, layer, urllib.parse.urlencode(p))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode("utf-8"))


for layer in (17, 1):
    print("=" * 76)
    try:
        d = q(layer, )
    except Exception as e:
        print("layer %d 失败: %s" % (layer, e))
        continue
    if "error" in d:
        print("layer %d 服务错误: %s" % (layer, d["error"].get("message")))
        continue
    print("layer %d  geometryType=%s" % (layer, d.get("geometryType")))
    fs = d.get("features", [])
    if fs:
        print("  属性字段: %s" % list(fs[0].get("attributes", {}).keys()))
        print("  属性值  : %s" % json.dumps(fs[0].get("attributes", {}), ensure_ascii=False)[:300])
        g = fs[0].get("geometry")
        if g is None:
            print("  geometry=None")
        else:
            print("  几何键  : %s" % list(g.keys()))
            for k, v in g.items():
                if isinstance(v, list):
                    head = json.dumps(v[0])[:120] if v else "空"
                    print("     %s: len=%d 首=%s" % (k, len(v), head))
                else:
                    print("     %s = %s" % (k, v))
    try:
        c = q(layer, returnCountOnly="true", returnGeometry="false")
        print("  bbox 内要素数 = %s" % c.get("count"))
    except Exception as e:
        print("  count 失败 %s" % e)
