# -*- coding: utf-8 -*-
"""在 ArcGIS Hub / DC 开放数据里找"带高度字段的建筑轮廓"图层。"""
import json
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def hub_search(q):
    url = ("https://hub.arcgis.com/api/v3/datasets?"
           + urllib.parse.urlencode({"q": q, "page[size]": "12",
                                     "fields[datasets]": "name,title,url,orgId"}))
    try:
        d = fetch(url)
    except Exception as e:
        print("  搜索失败:", e)
        return []
    out = []
    for item in d.get("data", []):
        a = item.get("attributes", {})
        out.append((a.get("title"), a.get("url") or a.get("slug")))
    return out


queries = [
    "Washington DC building footprints height",
    "DCGIS building footprints",
    "District of Columbia buildings 3D",
    "building footprints height",
]
for q in queries:
    print("=" * 78)
    print("查询:", q)
    for t, u in hub_search(q):
        print("   - %s  |  %s" % (t, u))

# 直接试 DCGIS 里可能带高度的其他服务
print()
print("=" * 78)
print("列出 DCGIS_DATA 目录下的所有服务（找建筑相关）")
try:
    d = fetch("https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA?f=json")
    print("  顶层键:", list(d.keys()))
    print("  服务数:", len(d.get("services", [])))
    for s in d.get("services", []):
        nm = s.get("name", "")
        if any(k in nm.lower() for k in ("build", "struct", "facility", "lidar", "elevation", "3d")):
            print("   *", s.get("type"), nm)
except Exception as e:
    print("  失败:", e)
