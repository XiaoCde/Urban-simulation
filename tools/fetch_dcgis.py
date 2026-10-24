# -*- coding: utf-8 -*-
r"""从 DCGIS 拉华盛顿**真实**的建筑高度，并找到能跟 OSM 建起来的确定性连接键。

════════════════════════════════════════════════════════════════════════
★ 关键发现：`BldgPly_<N>` 就是那把钥匙
════════════════════════════════════════════════════════════════════════
    layer 1  "Building Footprints"  平面轮廓，**普通多边形，rings 正常返回**，主键 OBJECTID
    layer 2  "Buildings - 3D"       2024-03-01 lidar，`GIS_ID = "BldgPly_<N>"`，MAX_Z/MIN_Z
    layer 13 "Buildings (Detailed Roof)"  屋顶坡度，`GIS_ID = "BldgPly_3D_Roof_<M>"`

    实测验证（本例）：layer 2 的 `BldgPly_2656` / `BldgPly_2679` / `BldgPly_2952`
    → layer 1 的 `OBJECTID = 2656 / 2679 / 2952` **全部命中且 DESCRIPTION="Building"**。
    所以 **「layer1.OBJECTID  =  layer2.GIS_ID 里的数字」** 是成立的确定性主键，
    不需要空间匹配（layer 1 的多边形本来就是这份 3D 数据的底面）。

    → 于是链路是：
        OSM 建筑中心点 --点在多边形内--> layer1 轮廓 --OBJECTID--> BldgPly_N --MAX_Z--> 真实高度
      并且 `MIN_Z` 实测都在 0 附近（已经归一化到裸地面），所以 **MAX_Z 本身就约等于建筑高度**。

════════════════════════════════════════════════════════════════════════
踩过的三个坑
════════════════════════════════════════════════════════════════════════
  1. layer 2 / layer 13 是 **multipatch**，`f=geojson` 会**静默返回空 features**（实测 72 字节），
     而 `f=json` 返回的几何是 **base64 的 `binaryPatches`**，不是 `rings` —— 标准库解不了。
     所以那两个图层**只要属性**（returnGeometry=false），几何一律从 layer 1 拿。
  2. `returnCentroid=true` **不生效**（实测返回的 feature 里没有 centroid 键）。
  3. `maxRecordCount = 1000`，必须 `resultOffset` 翻页。
  4. 图层坐标系是 EPSG:26985，用 inSR=4326 + outSR=4326 让服务端投影，省掉 pyproj。

用法:
    python tools\fetch_dcgis.py
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

BASE = ("https://maps2.dcgis.dc.gov/dcgis/rest/services/"
        "DCGIS_DATA/Facility_and_Structure/MapServer")
BBOX = (-77.059998, 38.885003, -77.000000, 38.924999)   # tools\tiles_bbox.py 实测
PAGE = 1000
OUT = r"D:\Users\asus\Desktop\项目\data\dcgis"

JOBS = [
    # name, layer, 要不要几何, 字段
    ("footprints", 1, True,
     ["OBJECTID", "DESCRIPTION", "FEATURECODE"]),
    ("buildings_3d", 2, False,
     ["GIS_ID", "MAX_Z", "MIN_Z", "MEDIAN_Z", "FEATURECODE", "DESCRIPTION"]),
    ("roofs_detailed", 13, False,
     ["GIS_ID", "EGID", "SLOPE_MEAN", "SLOPE_MIN", "SLOPE_MAX", "ROOF_TYPE",
      "ALTITUDE_MAX", "HOUSE_HEIGHT", "SURFACE_TOTALE", "SURFACE_TOTALE_XY"]),
]


def get(url, tries=4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            last = e
            print("      重试 %d/%d %s" % (i + 1, tries, e))
            time.sleep(2 + 3 * i)
    raise RuntimeError("拉取失败: %s" % last)


def outer_ring(geom):
    if not geom:
        return None
    best, best_a = None, -1.0
    for r in geom.get("rings") or []:
        pts = [(round(float(p[0]), 7), round(float(p[1]), 7)) for p in r if len(p) >= 2]
        if len(pts) < 3:
            continue
        a = 0.0
        for i in range(len(pts)):
            x1, y1 = pts[i]
            x2, y2 = pts[(i + 1) % len(pts)]
            a += x1 * y2 - x2 * y1
        a = abs(a) * 0.5
        if a > best_a:
            best, best_a = pts, a
    return best


def fetch(name, layer, want_geom, fields):
    w, s, e, n = BBOX
    print("\n=== %s  (layer %d) ===" % (name, layer))
    env = {"geometry": "%.6f,%.6f,%.6f,%.6f" % (w, s, e, n),
           "geometryType": "esriGeometryEnvelope", "inSR": "4326", "outSR": "4326",
           "spatialRel": "esriSpatialRelIntersects"}

    # ★ resultOffset 分页**不可靠**（实测 layer 1 在框内 22,791 条却只翻回 3,999 条）。
    #   可靠做法：先用 returnIdsOnly 拿全部主键，再按 objectIds 分批取记录。
    ids = get("%s/%d/query?%s" % (BASE, layer, urllib.parse.urlencode(
        dict(env, where="1=1", returnIdsOnly="true", f="json")))).get("objectIds") or []
    print("    框内共 %d 条，按 %d 一批取回" % (len(ids), PAGE))

    common = dict(env, outFields=",".join(fields),
                  returnGeometry="true" if want_geom else "false", f="json")
    rows, page = [], 0
    for i in range(0, len(ids), PAGE):
        chunk = ids[i:i + PAGE]
        q = dict(common, objectIds=",".join(str(k) for k in chunk))
        resp = get("%s/%d/query?%s" % (BASE, layer, urllib.parse.urlencode(q)))
        if isinstance(resp, dict) and "error" in resp:
            raise RuntimeError(resp["error"])
        batch = resp.get("features", [])
        for f in batch:
            a = f.get("attributes", {})
            if want_geom:
                ring = outer_ring(f.get("geometry"))
                if not ring:
                    continue
                rows.append({"a": a, "p": ring})
            else:
                rows.append({"a": a})
        page += 1
        print("    第 %2d 批 +%d → 累计 %d / %d" % (page, len(batch), len(rows), len(ids)))

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name + ".json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"layer": layer, "bbox": list(BBOX), "fields": fields,
                   "geom": want_geom, "count": len(rows), "features": rows},
                  fh, ensure_ascii=False, separators=(",", ":"))
    print("  → %s  (%d 条, %.1f MB)" % (path, len(rows), os.path.getsize(path) / 1048576))
    return rows


def main():
    print("bbox(WGS84) = 西%.6f 南%.6f 东%.6f 北%.6f" % BBOX)
    out = {}
    for name, layer, want_geom, fields in JOBS:
        out[name] = fetch(name, layer, want_geom, fields)

    # 立刻做两次自检
    fp = {r["a"]["OBJECTID"] for r in out["footprints"]}
    ids13 = set()
    h2 = {}
    for r in out["buildings_3d"]:
        gid = r["a"].get("GIS_ID") or ""
        if gid.startswith("BldgPly_"):
            try:
                h2[int(gid[len("BldgPly_"):])] = r["a"].get("MAX_Z")
            except ValueError:
                pass
    for r in out["roofs_detailed"]:
        gid = r["a"].get("GIS_ID") or ""
        if gid.startswith("BldgPly_3D_Roof_"):
            try:
                ids13.add(int(gid[len("BldgPly_3D_Roof_"):]))
            except ValueError:
                pass

    print("\n" + "=" * 78)
    print("layer 1 轮廓           : %d" % len(fp))
    print("layer 2 高度记录       : %d" % len(h2))
    print("layer 13 屋顶记录      : %d" % len(ids13))
    print("★ layer2 的 BldgPly_N 命中 layer1 OBJECTID : %d / %d"
          % (sum(1 for k in h2 if k in fp), len(h2)))
    print("★ layer13 的 BldgPly_3D_Roof_N 命中 layer1 OBJECTID : %d / %d"
          % (sum(1 for k in ids13 if k in fp), len(ids13)))

    # 交叉验证：同号 N 在 layer2(MAX_Z) 与 layer13(ALTITUDE_MAX) 上是否一致
    alt = {}
    for r in out["roofs_detailed"]:
        gid = r["a"].get("GIS_ID") or ""
        if gid.startswith("BldgPly_3D_Roof_"):
            try:
                alt[int(gid[len("BldgPly_3D_Roof_"):])] = r["a"].get("ALTITUDE_MAX")
            except ValueError:
                pass
    pairs = [(h2[k], alt[k]) for k in set(h2) & set(alt)
             if h2[k] is not None and alt[k] is not None]
    if pairs:
        import statistics
        d = [abs(a - b) for a, b in pairs]
        close = sum(1 for x in d if x <= 1.0)
        print("★ 同号交叉验证（layer2 MAX_Z vs layer13 ALTITUDE_MAX）: 配对 %d 组，"
              "差值中位 %.2f m，≤1 m 的占 %.1f%%" % (len(pairs), statistics.median(d),
                                                    close * 100.0 / len(pairs)))
    print("完成。")


if __name__ == "__main__":
    main()
