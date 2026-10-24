# -*- coding: utf-8 -*-
"""从 DCGIS 拉取华盛顿建筑的真实高度（lidar 3D 建筑层），用于替换 OSM 的随机层数。

数据源: DCGIS Facility_and_Structure/MapServer 图层 2 "Buildings - 3D"
  官方描述原文: "3D building multipatch created using lidar point cloud bare
  earth points and building points to create a normalized data surface."
  → MAX_Z 是"归一化"（裸地已扣除）后的建筑顶高，单位米，**就是真实建筑高度**。
  字段: OBJECTID / GIS_ID / MAX_Z / MIN_Z / MEDIAN_Z / MEAN_Z / STD_Z / DESCRIPTION

坑:
  1. 美国特勤局要求做了 redaction —— 其边界内所有点被移除（"All data returns
     were removed ... within the United States Secret Service redaction
     boundary"）→ 白宫一带 MAX_Z = 0.0，必须当缺失处理。
  2. 几何只以 binaryPatches（zlib 压缩的 ESRI multipatch）返回，顶点解不动；
     但**外接框（bbox）能解**，且在 WGS84 下完全正确 → 用 bbox 做匹配即可。
  3. 每页上限 1000 条，需 resultOffset 翻页。

用法:
  python fetch_dcgis_heights.py --test
  python fetch_dcgis_heights.py <south> <west> <north> <east> <输出.jsonl>
"""
import base64
import json
import os
import struct
import sys
import time
import urllib.parse
import urllib.request
import zlib

BASE = ("https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/"
        "Facility_and_Structure/MapServer/2/query")
PAGE = 1000
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"


def query(params, timeout=180):
    url = BASE + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def unwrap(bp):
    """binaryPatches -> 解压后的 shape 字节。"""
    raw = base64.b64decode(bp if isinstance(bp, str) else bp[0])
    if len(raw) < 12:
        return raw
    uncomp, comp = struct.unpack_from("<II", raw, 4)
    try:
        return zlib.decompress(raw[12:12 + comp])
    except Exception:
        return raw


def bbox_of(bp):
    """在解压后的 buffer 里扫出外接框（lon/lat/·/·）。
    ESRI 布局: [4字节 类型][4 个 double 的 bbox][numParts][numPoints]...
    扫描式实现，自带合理性校验，不依赖类型字段是否可读。"""
    buf = unwrap(bp)
    n = len(buf)
    for off in (4, 0):                                  # 常规位置优先
        if off + 32 > n:
            continue
        x0, y0, x1, y1 = struct.unpack_from("<4d", buf, off)
        if -77.6 < x0 < -76.4 and -77.6 < x1 < -76.4 and \
           38.4 < y0 < 39.5 and 38.4 < y1 < 39.5:
            return x0, y0, x1, y1
    return None


def base_params(bbox, offset=None):
    ps = {
        "where": "1=1",
        "geometry": bbox,
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "OBJECTID,MAX_Z,MIN_Z,MEDIAN_Z,DESCRIPTION",
        "returnGeometry": "true",
        "outSR": "4326",
        "orderByFields": "OBJECTID",
        "f": "json",
    }
    if offset is not None:
        ps["resultOffset"] = str(offset)
        ps["resultRecordCount"] = str(PAGE)
    return ps


def test():
    bbox = "-77.0175,38.8965,-77.017,38.897"
    ps = base_params(bbox)
    ps["resultRecordCount"] = "3"
    t0 = time.time()
    d = query(ps, timeout=60)
    print("耗时 %.1f s   返回 %d 条" % (time.time() - t0, len(d.get("features", []))))
    for f in d["features"]:
        a = f["attributes"]
        bb = bbox_of(f["geometry"]["binaryPatches"])
        print("  OID=%-6s MAX_Z=%-8.2f bbox=%s"
              % (a["OBJECTID"], a["MAX_Z"],
                 tuple(round(v, 6) for v in bb) if bb else None))
    print("exceededTransferLimit:", d.get("exceededTransferLimit"))
    print("error:", d.get("error"))


def fetch(bbox, out_path):
    offset = 0
    total, no_bbox, zero = 0, 0, 0
    t0 = time.time()
    d = os.path.dirname(os.path.abspath(out_path))
    if d:
        os.makedirs(d, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        while True:
            ps = base_params(bbox, offset)
            for attempt in range(4):
                try:
                    d = query(ps)
                    break
                except Exception as e:
                    wait = 2 ** attempt
                    print("  第 %d 次失败(%s)，%d s 后重试" % (attempt + 1, e, wait),
                          flush=True)
                    time.sleep(wait)
            else:
                print("  放弃 offset=%d" % offset, flush=True)
                break
            if "error" in d:
                print("  API 错误:", d["error"], flush=True)
                break
            feats = d.get("features", [])
            if not feats:
                break
            for f in feats:
                a = f["attributes"]
                bb = bbox_of(f["geometry"]["binaryPatches"]) \
                    if f.get("geometry") else None
                if bb is None:
                    no_bbox += 1
                mz = a.get("MAX_Z")
                if mz is not None and mz <= 0.0:
                    zero += 1
                fh.write(json.dumps({
                    "oid": a.get("OBJECTID"),
                    "maxz": mz,
                    "minz": a.get("MIN_Z"),
                    "medz": a.get("MEDIAN_Z"),
                    "desc": a.get("DESCRIPTION"),
                    "bbox": bb,
                }, ensure_ascii=False) + "\n")
            total += len(feats)
            fh.flush()
            offset += PAGE
            print("  已取 %d 条 (无bbox %d, MAX_Z<=0 %d)  %.0f s"
                  % (total, no_bbox, zero, time.time() - t0), flush=True)
            if not d.get("exceededTransferLimit"):
                break
    print("完成: %d 条 -> %s  (%.0f s)" % (total, out_path, time.time() - t0))
    print("  无 bbox: %d    MAX_Z<=0（含特勤局遮蔽）: %d" % (no_bbox, zero))


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--test":
        test()
        return
    if len(sys.argv) < 6:
        print(__doc__)
        return
    s, w, n, e = (float(x) for x in sys.argv[1:5])
    out = os.path.abspath(sys.argv[5])
    fetch("%f,%f,%f,%f" % (w, s, e, n), out)


main()
