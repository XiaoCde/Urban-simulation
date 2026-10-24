# -*- coding: utf-8 -*-
"""看一眼 DCGIS multipatch 图层在 f=json 下到底返回什么几何结构。"""
import json
import urllib.parse
import urllib.request

BASE = ("https://maps2.dcgis.dc.gov/dcgis/rest/services/"
        "DCGIS_DATA/Facility_and_Structure/MapServer")
BBOX = "-77.059998,38.885003,-77.000000,38.924999"


def q(layer, extra):
    p = {"where": "1=1", "geometry": BBOX, "geometryType": "esriGeometryEnvelope",
         "inSR": "4326", "outFields": "*", "returnGeometry": "true",
         "resultRecordCount": "2", "f": "json"}
    p.update(extra)
    url = "%s/%d/query?%s" % (BASE, layer, urllib.parse.urlencode(p))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


for layer in (13, 2):
    for extra in ({"outSR": "4326"}, {}):
        print("=" * 78)
        print("layer %d  extra=%s" % (layer, extra))
        try:
            d = q(layer, extra)
        except Exception as e:
            print("  失败: %s" % e)
            continue
        if "error" in d:
            print("  服务错误: %s" % d["error"])
            continue
        print("  geometryType=%s  spatialReference=%s" % (d.get("geometryType"), d.get("spatialReference")))
        for f in d.get("features", [])[:2]:
            g = f.get("geometry")
            print("  attributes keys: %s" % list(f.get("attributes", {}).keys())[:20])
            if g is None:
                print("  geometry = None")
                continue
            print("  geometry keys  : %s" % list(g.keys()))
            for k, v in g.items():
                if isinstance(v, list):
                    print("     %s: list len=%d  第一项=%s" % (k, len(v), json.dumps(v[0])[:160]))
                else:
                    print("     %s = %s" % (k, v))
