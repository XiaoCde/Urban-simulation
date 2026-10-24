# -*- coding: utf-8 -*-
r"""找 DC "Buildings 3D" 的**可下载包**。理由：
  逐条 REST 请求拿不现实（KMZ 每次只回 1 栋；binaryPatches 是 delta 压缩流，硬啃不划算），
  而 DC 开放数据平台通常会提供 shapefile / FileGDB 整包下载。
  shapefile 的 MultiPatch(类型 31) 是标准二进制，带 X/Y/Z，pyshp 能直接读 —— 一次下载全城，
  拿到**真实轮廓 + 真实高度**。
"""
import json
import urllib.parse
import urllib.request

AGO = "https://www.arcgis.com/sharing/rest"


def g(u, timeout=90):
    r = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(r, timeout=timeout).read()


def main():
    print("=" * 78)
    print("① ArcGIS Online 上 DCGISopendata 的建筑 3D 条目")
    for q in ('title:"Buildings 3D" owner:DCGISopendata',
              'owner:DCGISopendata AND type:"Scene Service"',
              'owner:DCGISopendata AND (buildings OR building)'):
        d = json.loads(g("%s/search?f=json&num=50&q=%s"
                         % (AGO, urllib.parse.quote(q))).decode())
        print("\n  查询 %r → %s 条" % (q, d.get("total")))
        for it in d.get("results", []):
            print("    id=%-34s type=%-16s %s"
                  % (it["id"], it.get("type"), (it.get("title") or "")[:56]))
            try:
                m = json.loads(g("%s/content/items/%s?f=json" % (AGO, it["id"])).decode())
                if m.get("url"):
                    print("        url = %s" % m["url"])
            except Exception:
                pass

    print("\n" + "=" * 78)
    print("② 试 opendata.dc.gov 的 Hub 下载接口（几种常见包格式）")
    hub = "https://opendata.dc.gov/api/download/v1/items/%s/%s?layers=0"
    ids = ["6e4d654b86f043f799e63c04a3f190ca", "ef1ae182e09c42a9a6ceac8c1185bb8a"]
    for iid in ids:
        for fmt in ("shapefile", "filegdb", "geojson", "csv"):
            u = hub % (iid, fmt)
            try:
                req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=90) as r:
                    head = r.read(16)
                    cl = r.headers.get("Content-Length")
                    print("    %s %-10s → HTTP %s  %s 字节  头 %s"
                          % (iid[:8], fmt, r.status, cl, head[:8]))
            except Exception as e:
                print("    %s %-10s → 失败 %s" % (iid[:8], fmt, e))


if __name__ == "__main__":
    main()
