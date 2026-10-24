# -*- coding: utf-8 -*-
"""探测 DCGIS "Buildings (Detailed Roof)"（图层 13）的 ROOF_TYPE 分布。
用法: python tools\probe_roofs.py
"""
import json
import urllib.parse
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"}
BASE = "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Facility_and_Structure/MapServer/13/query"


def get(url):
    req = urllib.request.Request(url, headers=UA)
    return json.loads(urllib.request.urlopen(req, timeout=120).read().decode("utf-8"))


def count(where):
    params = urllib.parse.urlencode({"where": where, "returnCountOnly": "true", "f": "json"})
    return get(BASE + "?" + params).get("count", 0)


def main():
    vals = ["Unknown", "Saddle", "None", "Shed", "Pyramid_Hip", "Default", "Combination", "Butterfly"]
    print("ROOF_TYPE 全城计数（图层 13）:")
    tot = 0
    for v in vals:
        try:
            n = count("ROOF_TYPE='%s'" % v)
        except Exception as e:
            print("   %-14s 查询失败: %s" % (v, e))
            continue
        tot += n
        print("   %-14s %8d" % (v, n))
    print("   以上合计 %d" % tot)
    try:
        print("   全部要素     %d" % count("1=1"))
    except Exception as e:
        print("   全部要素查询失败: %s" % e)


if __name__ == "__main__":
    main()
