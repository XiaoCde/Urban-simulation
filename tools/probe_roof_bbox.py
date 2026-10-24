# -*- coding: utf-8 -*-
"""排查 fetch_dcgis_roofs.py 的 bbox 提取是否可靠。

疑点: check_roof_match.py 报"外接框面积分位 50%/90%/99% 都是 0.0 m^2"，
      但同时又有 9,003 条记录、合计 12.61 km^2 → 少数记录巨大、多数退化。
      这会让"按最小外接框匹配"挑到错误的记录。

要查:
  1. geometry.binaryPatches 到底是 str 还是 list？如果是 list，之前只取了 [0]，
     就等于只算了第一个 patch 的 bbox。
  2. 每条记录的字节数、解压后长度、解出的 4 个 double。
  3. 结论: 某些 multipatch 的 offset 4 不是 bbox（比如是 Z 范围或别的头）。

用法: python probe_roof_bbox.py
"""
import base64
import json
import struct
import urllib.parse
import urllib.request
import zlib

BASE = ("https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/"
        "Facility_and_Structure/MapServer/13/query")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"


def query(params, timeout=180):
    url = BASE + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def unwrap(bp):
    raw = base64.b64decode(bp)
    if len(raw) < 12:
        return raw, None, None
    uncomp, comp = struct.unpack_from("<II", raw, 4)
    try:
        return zlib.decompress(raw[12:12 + comp]), uncomp, comp
    except Exception:
        return raw, uncomp, comp


def main():
    ps = {
        "where": "1=1",
        "geometry": "-77.0175,38.8965,-77.0170,38.8970",
        "geometryType": "esriGeometryEnvelope", "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "OBJECTID,ROOF_TYPE,HOUSE_HEIGHT,SLOPE_MEAN",
        "returnGeometry": "true", "outSR": "4326", "f": "json",
        "resultRecordCount": "3",
    }
    d = query(ps)
    print("返回 %d 条" % len(d.get("features", [])))
    for f in d["features"]:
        g = f.get("geometry") or {}
        print("\n--- OID=%s %s ---" % (f["attributes"]["OBJECTID"], f["attributes"]["ROOF_TYPE"]))
        print("geometry keys:", list(g.keys()))
        bp = g.get("binaryPatches")
        print("binaryPatches 类型:", type(bp).__name__,
              "长度:", len(bp) if bp is not None else None)
        items = bp if isinstance(bp, list) else [bp]
        for i, item in enumerate(items[:4]):
            raw = base64.b64decode(item)
            print("  patch[%d] base64 长 %d -> 原始 %d 字节" % (i, len(item), len(raw)))
            print("    前 16 字节 hex:", raw[:16].hex())
            if len(raw) >= 12:
                u, c = struct.unpack_from("<II", raw, 4)
                print("    uncompressedSize=%d compressedSize=%d  (12+comp=%d)" % (u, c, 12 + c))
            buf, _, _ = unwrap(item)
            print("    解压后 %d 字节" % len(buf))
            # 顺序试每个 offset，打印全部 4 个 double
            for off in (0, 4, 8, 12, 16):
                if off + 32 > len(buf):
                    continue
                a, b, cc, dd = struct.unpack_from("<4d", buf, off)
                ok = (-77.6 < a < -76.4 and -77.6 < cc < -76.4 and
                      38.4 < b < 39.5 and 38.4 < dd < 39.5)
                print("      off=%-3d (%.7f, %.7f, %.7f, %.7f) %s"
                      % (off, a, b, cc, dd, "<= 看起来是经纬度bbox" if ok else ""))
    print("\nexceededTransferLimit:", d.get("exceededTransferLimit"))
    print("error:", d.get("error"))


main()
