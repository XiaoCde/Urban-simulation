# -*- coding: utf-8 -*-
"""解 DCGIS 3D 建筑层 binaryPatches：外层是 zlib 压缩的 ESRI shape。"""
import base64
import json
import struct
import urllib.parse
import urllib.request
import zlib

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
URL = ("https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/"
       "Facility_and_Structure/MapServer/2/query")


def get(**kw):
    ps = {"where": "1=1", "f": "json", "outSR": "4326",
          "returnGeometry": "true", "inSR": "4326"}
    ps.update(kw)
    req = urllib.request.Request(URL + "?" + urllib.parse.urlencode(ps),
                                 headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def unwrap(bp):
    """返回解压后的 shape 字节。"""
    raw = base64.b64decode(bp if isinstance(bp, str) else bp[0])
    print("   外层字节:", len(raw), "  头 12 字节:", raw[:12].hex())
    if len(raw) < 12:
        return raw
    magic = raw[:4].hex()
    uncomp, comp = struct.unpack_from("<II", raw, 4)
    print("   magic=%s  uncompressed=%d  compressed=%d  (12+%d=%d)"
          % (magic, uncomp, comp, comp, 12 + comp))
    try:
        out = zlib.decompress(raw[12:12 + comp])
        print("   解压成功:", len(out), "字节")
        return out
    except Exception as e:
        print("   zlib 失败:", e)
        return raw


def parse_shape(buf, label=""):
    off = 0

    def i32():
        nonlocal off
        v = struct.unpack_from("<i", buf, off)[0]
        off += 4
        return v

    def f64():
        nonlocal off
        v = struct.unpack_from("<d", buf, off)[0]
        off += 8
        return v

    st = i32()
    info = {"shapeType": st}
    if st == 0:
        return info
    info["bbox"] = tuple(f64() for _ in range(4))
    nparts, npoints = i32(), i32()
    info["nparts"], info["npoints"] = nparts, npoints
    info["parts"] = [i32() for _ in range(nparts)]
    pts = [(f64(), f64()) for _ in range(npoints)]
    info["xy0"] = pts[0]
    zmin, zmax = f64(), f64()
    info["zmin"], info["zmax"] = zmin, zmax
    zs = [f64() for _ in range(npoints)]
    info["z_calc_min"], info["z_calc_max"] = min(zs), max(zs)
    info["bytes_used"], info["bytes_total"] = off, len(buf)
    return info


print("=" * 78)
d = get(geometry="-77.0175,38.8965,-77.017,38.897",
        geometryType="esriGeometryEnvelope", spatialRel="esriSpatialRelIntersects",
        outFields="OBJECTID,MAX_Z", resultRecordCount="2")
for f in d["features"]:
    print("OBJECTID=%s  MAX_Z=%s" % (f["attributes"]["OBJECTID"],
                                     f["attributes"]["MAX_Z"]))
    buf = unwrap(f["geometry"]["binaryPatches"])
    try:
        info = parse_shape(buf)
        for k, v in info.items():
            print("   %-14s %s" % (k, v))
    except Exception as e:
        print("   解析失败:", type(e).__name__, e)
    print()

print("=" * 78)
print("试一个高一点的楼（之前查到 MAX_Z=47.5 的 OBJECTID 36184 附近）")
