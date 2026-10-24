# -*- coding: utf-8 -*-
r"""继续找"带真实高度的建筑轮廓"。三条线索：
   A. DC 的 "2022 Building Footprints" / "2016 Building Footprints" 要素服务有没有高度字段
   B. "Buildings 3D Scene - 2024" 场景服务的几何怎么取
   C. `binaryPatches` 到底是不是 zlib 包着的 shp multipatch（能解就能拿到全部 22,697 栋）
"""
import base64
import json
import struct
import sys
import urllib.parse
import urllib.request
import zlib

AGO = "https://www.arcgis.com/sharing/rest"


def g(u, timeout=120):
    r = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(r, timeout=timeout).read()


def item_layer(layer_no, only=("2022 Building Footprints", "2016 Building Footprints",
                               "Buildings 3D Scene - 2024", "Buildings 3D Scene - 2022",
                               "2022 Building Footprints (Cartographic)")):
    print("=" * 78)
    print("A/B. 通过 ArcGIS Online 搜 DC 的建筑服务并看字段")
    q = 'owner:DCGISopendata AND (buildings OR "building footprints")'
    d = json.loads(g("%s/search?f=json&num=60&q=%s"
                     % (AGO, urllib.parse.quote(q))).decode())
    seen = set()
    for it in d.get("results", []):
        t = it.get("title") or ""
        if only and t not in only:
            continue
        if it["id"] in seen:
            continue
        seen.add(it["id"])
        print("\n  ● %s   [%s]  id=%s" % (t, it.get("type"), it["id"]))
        try:
            meta = json.loads(g("%s/content/items/%s?f=json" % (AGO, it["id"])).decode())
            url = meta.get("url") or (meta.get("url") or "")
            print("    url = %s" % url)
            if not url:
                continue
            base = url.rstrip("/")
            root = json.loads(g(base + "?f=json").decode())
            layers = root.get("layers") or []
            print("    layers = %s" % [(L["id"], L["name"]) for L in layers[:6]])
            for L in layers[:layer_no]:
                md = json.loads(g("%s/%d?f=json" % (base, L["id"])).decode())
                flds = [f["name"] for f in md.get("fields", [])]
                print("      layer %d %-28s geom=%-18s fields=%s"
                      % (L["id"], L["name"], md.get("geometryType"),
                         ",".join(flds)[:300]))
        except Exception as e:
            print("    读取失败: %s" % e)


def part_c():
    print("\n" + "=" * 78)
    print("C. binaryPatches 格式")
    BASE = ("https://maps2.dcgis.dc.gov/dcgis/rest/services/"
            "DCGIS_DATA/Facility_and_Structure/MapServer")
    q = {"where": "MAX_Z>80", "outFields": "GIS_ID,MAX_Z", "returnGeometry": "true",
         "outSR": "4326", "f": "json", "resultRecordCount": "1"}
    d = json.loads(g("%s/2/query?%s" % (BASE, urllib.parse.urlencode(q))).decode())
    f = d["features"][0]
    print("   属性:", f["attributes"])
    b = base64.b64decode(f["geometry"]["binaryPatches"][0])
    print("   %d 字节，前 20 字节 hex: %s" % (len(b), b[:20].hex(" ")))
    print("   int32@0=0x%08X  @4=%d  @8=%d"
          % (struct.unpack_from("<I", b, 0)[0],
             struct.unpack_from("<i", b, 4)[0], struct.unpack_from("<i", b, 8)[0]))
    z = -1
    for h in (b"\x78\xda", b"\x78\x9c", b"\x78\x01"):
        z = b.find(h)
        if z >= 0:
            break
    print("   zlib 头位置 = %d" % z)
    if z >= 0:
        try:
            dec = zlib.decompress(b[z:])
            print("   解压后 %d 字节，前 80 字节 hex:\n     %s" % (len(dec), dec[:80].hex(" ")))
            print("   前 6 个 double = %s"
                  % [round(struct.unpack_from("<d", dec, i * 8)[0], 6) for i in range(6)])
            print("   前 6 个 int32  = %s"
                  % [struct.unpack_from("<i", dec, i * 4)[0] for i in range(6)])
        except Exception as e:
            print("   解压失败:", e)


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "abc"
    if "a" in which:
        item_layer(4)
    if "c" in which:
        part_c()
