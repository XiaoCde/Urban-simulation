# -*- coding: utf-8 -*-
r"""最后确认：multipatch（layer 2/13）的几何到底能不能拿到手。

试三种可能：f=kmz（KML，通常带经纬度）、f=pbf（新式二进制）、
以及把 f=json 的原始响应原样打出来看有没有任何坐标字段。
能不能拿到 layer 2 的几何，决定了"真实高度"能覆盖 39% 还是 99% 的房子。
"""
import json
import urllib.parse
import urllib.request

BASE = ("https://maps2.dcgis.dc.gov/dcgis/rest/services/"
        "DCGIS_DATA/Facility_and_Structure/MapServer")


def raw(layer, **p):
    p.setdefault("outSR", "4326")
    u = "%s/%d/query?%s" % (BASE, layer, urllib.parse.urlencode(p))
    r = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(r, timeout=120).read()


def main():
    # ① f=json 原始响应，看有没有坐标
    b = raw(2, where="MAX_Z>80", outFields="GIS_ID,MAX_Z", returnGeometry="true",
            f="json", resultRecordCount="1")
    d = json.loads(b.decode("utf-8"))
    f = (d.get("features") or [{}])[0]
    print("① f=json 的 feature 顶层键 :", list(f.keys()))
    geo = f.get("geometry") or {}
    print("   geometry 的键          :", list(geo.keys()))
    for k, v in geo.items():
        if isinstance(v, list):
            print("   %s: list len=%d  前 60 字符 %s" % (k, len(v), str(v)[:60]))
        else:
            print("   %s: %s" % (k, str(v)[:80]))

    # ② f=kmz
    try:
        b = raw(2, where="MAX_Z>80", outFields="GIS_ID,MAX_Z", returnGeometry="true",
                f="kmz", resultRecordCount="1")
        print("\n② f=kmz  → %d 字节, 头部 %s" % (len(b), b[:120]))
    except Exception as e:
        print("\n② f=kmz 失败:", e)

    # ③ f=pbf
    try:
        b = raw(2, where="MAX_Z>80", outFields="GIS_ID,MAX_Z", returnGeometry="true",
                f="pbf", resultRecordCount="1")
        print("\n③ f=pbf  → %d 字节, 头部 %s" % (len(b), b[:60]))
    except Exception as e:
        print("\n③ f=pbf 失败:", e)

    # ④ 有没有 FeatureServer（同一份数据的 feature service，几何支持更好）
    for u in ("https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Facility_and_Structure/FeatureServer?f=json",
              "https://maps2.dcgis.dc.gov/dcgis/rest/services?f=json"):
        try:
            d = json.loads(urllib.request.urlopen(
                urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}),
                timeout=90).read().decode())
            print("\n④ %s\n   folders=%s services=%s"
                  % (u, d.get("folders"), (d.get("services") or [])[:6]))
        except Exception as e:
            print("\n④ %s 失败: %s" % (u, e))


if __name__ == "__main__":
    main()
