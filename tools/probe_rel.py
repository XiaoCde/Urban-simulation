# -*- coding: utf-8 -*-
r"""两条最后的路：① 图层之间有没有 ESRI relationship class（有的话让服务端替我 join）；
② DC 在 ArcGIS Online 上有没有别的"带高度的建筑轮廓"数据。
"""
import json
import urllib.parse
import urllib.request

BASE = ("https://maps2.dcgis.dc.gov/dcgis/rest/services/"
        "DCGIS_DATA/Facility_and_Structure/MapServer")


def g(u):
    r = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    return json.loads(urllib.request.urlopen(r, timeout=120).read().decode())


def main():
    for L in (1, 2, 3, 13, 17):
        d = g("%s/%d?f=json" % (BASE, L))
        rel = d.get("relationships") or []
        print("layer %2d %-28s relationships=%d %s"
              % (L, d.get("name"), len(rel),
                 [(r.get("id"), r.get("relatedTableId"), r.get("name")) for r in rel]))

    print("\n--- ArcGIS Online 上 DC 的建筑数据 ---")
    q = ('owner:DCGIS AND (building OR buildings OR footprint)')
    u = ("https://www.arcgis.com/sharing/rest/search?f=json&num=40&q="
         + urllib.parse.quote(q))
    d = g(u)
    for it in d.get("results", []):
        print("  [%s] %-58s type=%-16s id=%s"
              % (it.get("owner"), (it.get("title") or "")[:58],
                 it.get("type"), it.get("id")))


if __name__ == "__main__":
    main()
