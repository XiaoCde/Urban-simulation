# -*- coding: utf-8 -*-
r"""用 `f=kmz` 把 DCGIS 的 multipatch 建筑几何取回来 —— 这是拿到"真实建筑轮廓 + 真实高度"
的唯一可行途径（`f=json` 只给 base64 的 `binaryPatches`，`f=geojson` 直接返回空）。

════════════════════════════════════════════════════════════════════════
为什么必须走这条路
════════════════════════════════════════════════════════════════════════
    layer 2 "Buildings - 3D"（2024-03-01 lidar）在框内有 **22,697** 栋，
    几乎是全量；但它是 multipatch，**取不到 rings 几何**，而它的编号
    `BldgPly_<N>` 又**不是** layer 1 的 OBJECTID（实测只命中 35/22,697），
    所以没法用主键 join，也没法做点在多边形内。
    → `f=kmz` 返回的 KML 里既有 **经纬度**（三角形化的顶点），
      `<description>` 的 HTML 表格里又有 **全部属性字段**。两者一起就够做空间匹配了。

取回来的东西（每栋楼）：
    f ：属性字典（layer 2 是 GIS_ID/MIN_Z/MAX_Z；layer 13 是 EGID/SLOPE_MEAN/ROOF_TYPE/...）
    c ：顶点平均得到的中心点 [lon, lat]（匹配用）
    b ：外接矩形 [minlon, minlat, maxlon, maxlat]
    n ：顶点数（用来排除异常形状）

用法:
    python tools\fetch_dcgis_kmz.py 2       # 取 layer 2（真实高度，约 22,697 栋）
    python tools\fetch_dcgis_kmz.py 13      # 取 layer 13（真实屋顶坡度，约 9,002 栋）
    python tools\fetch_dcgis_kmz.py 2 --limit 3   # 只跑 3 批，快速验证
"""
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

BASE = ("https://maps2.dcgis.dc.gov/dcgis/rest/services/"
        "DCGIS_DATA/Facility_and_Structure/MapServer")
BBOX = "-77.059998,38.885003,-77.000000,38.924999"
OUT = r"D:\Users\asus\Desktop\项目\data\dcgis"
BATCH = 100
KML = "{http://www.opengis.net/kml/2.2}"
FIELDS = {2: "GIS_ID,MIN_Z,MAX_Z,MEDIAN_Z,FEATURECODE,DESCRIPTION",
          3: "GIS_ID,EGID",
          13: "GIS_ID,EGID,SLOPE_MEAN,SLOPE_MIN,SLOPE_MAX,ROOF_TYPE,ALTITUDE_MAX,HOUSE_HEIGHT"}


def get(url, tries=4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except Exception as e:
            last = e
            time.sleep(1.5 + 2 * i)
    raise RuntimeError("拉取失败: %s" % last)


def parse_desc(html):
    """把 `<td>Field Name</td><td>Value</td>` 的表格解析成 dict（标签做归一化）。"""
    out = {}
    if not html:
        return out
    parts = html.split("<td>")
    for i in range(len(parts) - 1):
        label = parts[i].split("</td>")[0].strip()
        val = parts[i + 1].split("</td>")[0].strip()
        if label and val and label != "Field Name":
            out[label] = val
    return out


def parse_kmz(blob):
    """KMZ → [{'f': {...}, 'c': [lon,lat], 'b': [...], 'n': int}]"""
    z = zipfile.ZipFile(io.BytesIO(blob))
    name = "doc.kml" if "doc.kml" in z.namelist() else z.namelist()[0]
    root = ET.fromstring(z.read(name))
    out = []
    for pm in root.iter(KML + "Placemark"):
        desc = pm.find(KML + "description")
        f = parse_desc(desc.text if desc is not None else None)
        pts = []
        for co in pm.iter(KML + "coordinates"):
            for tok in (co.text or "").split():
                bits = tok.split(",")
                if len(bits) >= 2:
                    try:
                        pts.append((float(bits[0]), float(bits[1])))
                    except ValueError:
                        pass
        if not pts:
            continue
        uniq = list(dict.fromkeys(pts))
        xs = [p[0] for p in uniq]
        ys = [p[1] for p in uniq]
        out.append({"f": f,
                    "c": [sum(xs) / len(xs), sum(ys) / len(ys)],
                    "b": [min(xs), min(ys), max(xs), max(ys)],
                    "n": len(uniq)})
    return out


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    layer = int(sys.argv[1])
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    fields = FIELDS[layer]

    env = {"geometry": BBOX, "geometryType": "esriGeometryEnvelope", "inSR": "4326",
           "outSR": "4326", "spatialRel": "esriSpatialRelIntersects"}
    ids = json.loads(get("%s/%d/query?%s" % (BASE, layer, urllib.parse.urlencode(
        dict(env, where="1=1", returnIdsOnly="true", f="json")))).decode())["objectIds"]
    print("layer %d：框内 %d 栋，按 %d 一批取 KMZ" % (layer, len(ids), BATCH))

    path = os.path.join(OUT, "kmz_layer%d.json" % layer)
    feats, done = [], set()
    if os.path.exists(path):
        old = json.load(open(path, encoding="utf-8"))
        feats = old["features"]
        done = set(old.get("done", []))
        print("  续跑：已有 %d 栋、%d 批" % (len(feats), len(done)))

    batches = [ids[i:i + BATCH] for i in range(0, len(ids), BATCH)]
    if limit:
        batches = batches[:limit]
    t0 = time.time()
    for bi, b in enumerate(batches):
        if str(bi) in done:
            continue
        q = dict(env, objectIds=",".join(str(k) for k in b),
                 outFields=fields, returnGeometry="true", f="kmz")
        blob = get("%s/%d/query?%s" % (BASE, layer, urllib.parse.urlencode(q)))
        got = parse_kmz(blob)
        feats.extend(got)
        done.add(str(bi))
        if bi % 10 == 0 or bi == len(batches) - 1:
            print("  批 %3d/%d  +%d → %d 栋  (%.1f MB, %.0f 秒)"
                  % (bi + 1, len(batches), len(got), len(feats),
                     len(blob) / 1048576, time.time() - t0))
        if bi % 20 == 0:
            json.dump({"layer": layer, "count": len(feats), "done": sorted(done),
                       "features": feats}, open(path, "w", encoding="utf-8"),
                      ensure_ascii=False, separators=(",", ":"))

    json.dump({"layer": layer, "count": len(feats), "done": sorted(done),
               "features": feats}, open(path, "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    print("\n→ %s  (%d 栋, %.1f MB, %.0f 秒)"
          % (path, len(feats), os.path.getsize(path) / 1048576, time.time() - t0))


if __name__ == "__main__":
    main()
