# -*- coding: utf-8 -*-
"""对比 DCGIS 各建筑图层的覆盖度（同一 bbox 内）。
用法: python tools\probe_coverage.py
"""
import json
import urllib.parse
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"}
B = "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Facility_and_Structure/MapServer"
S, W, N, E = 38.885, -77.060, 38.925, -77.000


def count(layer, where="1=1"):
    params = {
        "where": where,
        "geometry": "%.6f,%.6f,%.6f,%.6f" % (W, S, E, N),
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "returnCountOnly": "true",
        "f": "json",
    }
    url = "%s/%d/query?%s" % (B, layer, urllib.parse.urlencode(params))
    req = urllib.request.Request(url, headers=UA)
    return json.loads(urllib.request.urlopen(req, timeout=180).read().decode("utf-8")).get("count", 0)


def main():
    for lid, name in [(1, "Building Footprints"), (2, "Buildings - 3D"), (13, "Buildings (Detailed Roof)"),
                      (3, "Buildings - 3D 2013"), (17, "Unique Building Identifier")]:
        try:
            print("图层 %-3d %-28s %8d" % (lid, name, count(lid)))
        except Exception as e:
            print("图层 %-3d %-28s 失败 %s" % (lid, name, e))
    print()
    print("图层13 有 HOUSE_HEIGHT 的:", count(13, "HOUSE_HEIGHT > 0"))
    print("图层2  有 MAX_Z>0 的:   ", count(2, "MAX_Z > 0"))


if __name__ == "__main__":
    main()
