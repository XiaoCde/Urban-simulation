# -*- coding: utf-8 -*-
r"""KMZ 每个请求只回 1 栋楼（实测 n=1/5/20/100 都只返回 662 字节），
   22697 栋要 22697 次请求 → 不可行。换两条路：
     ① opendata.dc.gov 上有没有"Buildings 3D"的可下载包（shapefile/FileGDB），
        那样轮廓 + MAX_Z 一次到手，根本不用逐条请求。
     ② 直接解码 `binaryPatches` —— 看它的实际格式（第 12 字节处是 zlib 头 78 da）。
"""
import base64
import json
import urllib.parse
import urllib.request
import zlib

BASE = ("https://maps2.dcgis.dc.gov/dcgis/rest/services/"
        "DCGIS_DATA/Facility_and_Structure/MapServer")


def g(u):
    r = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(r, timeout=120).read()


def part1_search():
    print("=" * 78)
    print("① 在 ArcGIS Online / DC Hub 上找可下载的建筑 3D 数据")
    for q in ('title:"Buildings 3D"', 'title:"Building Footprints" owner:DCGIS',
              'DCGIS buildings tags:building'):
        u = ("https://www.arcgis.com/sharing/rest/search?f=json&num=20&q="
             + urllib.parse.quote(q))
        try:
            d = json.loads(g(u).decode())
            print("\n  查询 %r  共 %s 条" % (q, d.get("total")))
            for it in d.get("results", [])[:20]:
                print("    %-58s type=%-16s owner=%-14s id=%s"
                      % ((it.get("title") or "")[:58], it.get("type"),
                         it.get("owner"), it.get("id")))
        except Exception as e:
            print("  查询 %r 失败: %s" % (q, e))

    for u in ("https://opendata.dc.gov/api/feed/dcat-us/1.1.json",):
        try:
            d = json.loads(g(u).decode())
            ds = d.get("dataset", [])
            print("\n  opendata.dc.gov 数据集总数 %d" % len(ds))
            for it in ds:
                t = (it.get("title") or "")
                if any(k in t.lower() for k in ("building", "lidar", "3d")):
                    print("    %-62s %s" % (t[:62], (it.get("identifier") or "")[:40]))
        except Exception as e:
            print("  opendata feed 失败: %s" % e)


def part2_binary():
    print("\n" + "=" * 78)
    print("② 解码 binaryPatches")
    q = {"where": "MAX_Z>80", "outFields": "GIS_ID,MAX_Z", "returnGeometry": "true",
         "outSR": "4326", "f": "json", "resultRecordCount": "1"}
    d = json.loads(g("%s/2/query?%s" % (BASE, urllib.parse.urlencode(q))).decode())
    f = d["features"][0]
    print("   属性:", f["attributes"])
    b = base64.b64decode(f["geometry"]["binaryPatches"][0])
    print("   解码后 %d 字节；前 24 字节 hex: %s" % (len(b), b[:24].hex(" ")))
    import struct
    print("   int32@0   = %d (0x%08X)" % (struct.unpack_from("<i", b, 0)[0],
                                          struct.unpack_from("<I", b, 0)[0]))
    print("   int32@4   = %d" % struct.unpack_from("<i", b, 4)[0])
    print("   int32@8   = %d" % struct.unpack_from("<i", b, 8)[0])
    z = b.find(b"\x78\xda")
    if z < 0:
        z = b.find(b"\x78\x9c")
    print("   zlib 头位置 = %d" % z)
    if z >= 0:
        try:
            dec = zlib.decompress(b[z:])
            print("   解压后 %d 字节；前 64 字节 hex:\n     %s" % (len(dec), dec[:64].hex(" ")))
            print("   按 double 读前 8 个: %s"
                  % [round(struct.unpack_from("<d", dec, i * 8)[0], 6) for i in range(8)])
        except Exception as e:
            print("   zlib 解压失败:", e)


if __name__ == "__main__":
    part1_search()
    part2_binary()
