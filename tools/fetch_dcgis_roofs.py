# -*- coding: utf-8 -*-
"""从 DCGIS 拉取华盛顿建筑的屋顶信息（Detailed Roof 图层），用于写入 OSM 的 roof:shape。

数据源: DCGIS Facility_and_Structure/MapServer 图层 13 "Buildings (Detailed Roof)"
  字段:
    ROOF_TYPE      屋顶类型 (Default/Shed/Saddle/Pyramid_Hip/Combination/Butterfly/Unknown)
    HOUSE_HEIGHT   建筑高度（地面到顶，米）
    ALTITUDE_MAX   顶部绝对高程（米）
    SLOPE_MEAN     平均屋面坡角（度）★ 判断"平顶还是坡顶"最可靠
    SLOPE_MIN / SLOPE_MAX / SURFACE_TOTALE / SURFACE_TOTALE_XY
    EGID / GIS_ID

  ⚠ 图层 13 只覆盖 DC 的一部分建筑（bbox 内 9,002 / 22,792 ≈ 39.5%），
    没覆盖的只能保持默认。

坑（与 fetch_dcgis_heights.py 相同）:
  * 几何只以 binaryPatches（zlib 压缩的 ESRI multipatch）返回 → 顶点解不动，
    但偏移 4 处的 4 个 double 外接框是对的，够做空间匹配。
  * 每页上限 1000 条，需 resultOffset 翻页。

用法:
  python fetch_dcgis_roofs.py --test
  python fetch_dcgis_roofs.py <south> <west> <north> <east> <输出.jsonl>
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
        "Facility_and_Structure/MapServer/13/query")
PAGE = 1000
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
FIELDS = "OBJECTID,ROOF_TYPE,HOUSE_HEIGHT,ALTITUDE_MAX,SLOPE_MEAN,SLOPE_MIN,SLOPE_MAX,EGID,GIS_ID"


def query(params, timeout=180):
    url = BASE + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def unwrap(bp):
    raw = base64.b64decode(bp if isinstance(bp, str) else bp[0])
    if len(raw) < 12:
        return raw
    uncomp, comp = struct.unpack_from("<II", raw, 4)
    try:
        return zlib.decompress(raw[12:12 + comp])
    except Exception:
        return raw


def bbox_of(bp):
    buf = unwrap(bp)
    n = len(buf)
    for off in (4, 0):
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
        "outFields": FIELDS,
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
    ps["resultRecordCount"] = "4"
    t0 = time.time()
    d = query(ps, timeout=60)
    print("耗时 %.1f s   返回 %d 条" % (time.time() - t0, len(d.get("features", []))))
    for f in d["features"]:
        a = f["attributes"]
        bp = f["geometry"]["binaryPatches"] if f.get("geometry") else None
        bb = bbox_of(bp) if bp else None
        print("  OID=%-6s ROOF=%-12s HOUSE_H=%-7.2f ALT=%-7.2f SLOPE=%-6.2f bbox=%s"
              % (a["OBJECTID"], a["ROOF_TYPE"], a.get("HOUSE_HEIGHT") or 0,
                 a.get("ALTITUDE_MAX") or 0, a.get("SLOPE_MEAN") or 0,
                 tuple(round(v, 6) for v in bb) if bb else None))
    print("exceededTransferLimit:", d.get("exceededTransferLimit"))
    print("error:", d.get("error"))


def fetch(bbox, out_path):
    offset, total, no_bbox = 0, 0, 0
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
                    print("  第 %d 次失败(%s)，%d s 后重试" % (attempt + 1, e, wait), flush=True)
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
                bp = f["geometry"]["binaryPatches"] if f.get("geometry") else None
                bb = bbox_of(bp) if bp else None
                if bb is None:
                    no_bbox += 1
                fh.write(json.dumps({
                    "oid": a.get("OBJECTID"),
                    "roof": a.get("ROOF_TYPE"),
                    "h": a.get("HOUSE_HEIGHT"),
                    "alt": a.get("ALTITUDE_MAX"),
                    "slope": a.get("SLOPE_MEAN"),
                    "slope_min": a.get("SLOPE_MIN"),
                    "slope_max": a.get("SLOPE_MAX"),
                    "bbox": bb,
                }, ensure_ascii=False) + "\n")
            total += len(feats)
            fh.flush()
            offset += PAGE
            print("  已取 %d 条 (无bbox %d)  %.0f s" % (total, no_bbox, time.time() - t0), flush=True)
            if not d.get("exceededTransferLimit"):
                break
    print("完成: %d 条 -> %s  (%.0f s)" % (total, out_path, time.time() - t0))
    print("  无 bbox: %d" % no_bbox)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--test":
        test()
        return
    if len(sys.argv) < 6:
        print(__doc__)
        return
    s, w, n, e = (float(x) for x in sys.argv[1:5])
    fetch("%f,%f,%f,%f" % (w, s, e, n), os.path.abspath(sys.argv[5]))


main()
