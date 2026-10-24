# -*- coding: utf-8 -*-
"""探测 DCGIS "Buildings (Detailed Roof)"（图层 13）在指定 bbox 内的 ROOF_TYPE / 坡度分布。
用法: python tools\probe_roofs_bbox.py [south west north east]
"""
import json
import sys
import urllib.parse
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"}
BASE = "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Facility_and_Structure/MapServer/13/query"

BBOX = (38.885, -77.060, 38.925, -77.000)


def get(url):
    req = urllib.request.Request(url, headers=UA)
    return json.loads(urllib.request.urlopen(req, timeout=180).read().decode("utf-8"))


def count_in_bbox(where):
    s, w, n, e = BBOX
    params = {
        "where": where,
        "geometry": "%.6f,%.6f,%.6f,%.6f" % (w, s, e, n),
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "returnCountOnly": "true",
        "f": "json",
    }
    return get(BASE + "?" + urllib.parse.urlencode(params)).get("count", 0)


def main():
    global BBOX
    if len(sys.argv) == 5:
        BBOX = tuple(float(x) for x in sys.argv[1:5])
    print("bbox = %s" % (BBOX,))
    total = count_in_bbox("1=1")
    print("图层13 要素总数(bbox内) = %d" % total)
    print()
    vals = ["Unknown", "Saddle", "None", "Shed", "Pyramid_Hip", "Default", "Combination", "Butterfly"]
    print("ROOF_TYPE 分布:")
    for v in vals:
        try:
            n = count_in_bbox("ROOF_TYPE='%s'" % v)
        except Exception as ex:
            print("   %-14s 失败 %s" % (v, ex))
            continue
        print("   %-14s %8d   %5.1f%%" % (v, n, 100.0 * n / total if total else 0))
    print()
    print("SLOPE_MEAN 分档(Pyramid_Hip 之外):")
    for lo, hi in [(0, 0.5), (0.5, 2), (2, 5), (5, 15), (15, 30), (30, 90)]:
        where = "SLOPE_MEAN >= %s AND SLOPE_MEAN < %s" % (lo, hi)
        try:
            n = count_in_bbox(where)
        except Exception as ex:
            print("   %s 失败 %s" % (where, ex))
            continue
        print("   %5.1f-%-5.1f 度 %8d   %5.1f%%" % (lo, hi, n, 100.0 * n / total if total else 0))


if __name__ == "__main__":
    main()
