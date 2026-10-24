# -*- coding: utf-8 -*-
r"""把 DCGIS 的**真实实测**数据写回 OSM 分块，让 blosm 建出华盛顿真实的房子。

════════════════════════════════════════════════════════════════════════
数据来源与连接方式（全部已实测确认）
════════════════════════════════════════════════════════════════════════
    data/dcgis/footprints.json      layer 1 "Building Footprints"
                                    普通多边形，主键 OBJECTID —— 用来做空间定位
    data/dcgis/buildings_3d.json    layer 2 "Buildings - 3D"（2024-03-01 lidar）
                                    GIS_ID = "BldgPly_<N>"，MAX_Z / MIN_Z —— 真实高度
    data/dcgis/roofs_detailed.json  layer 13 "Buildings (Detailed Roof)"（2005-2013 影像）
                                    GIS_ID = "BldgPly_3D_Roof_<M>"，SLOPE_MEAN / ROOF_TYPE
                                    —— 真实屋顶坡度

    链路：OSM 建筑中心点 --点在多边形内--> layer1 轮廓(OBJECTID=N)
          --BldgPly_N--> layer2 的 MAX_Z  = 真实高度（米）
          --BldgPly_3D_Roof_N--> layer13 的 SLOPE_MEAN = 真实屋顶坡度（度）

    `MIN_Z` 实测都贴着裸地面（0.0 / 0.03 / 1.57 / 3.96），所以高度取
    `MAX_Z - min(MIN_Z, 1.0)`：减掉最多 1 米的地面噪声，避免把地形起伏算进楼高。

════════════════════════════════════════════════════════════════════════
写回的标签
════════════════════════════════════════════════════════════════════════
    height        真实建筑高度（米）—— blosm 读它来定楼高
    roof:shape    按真实坡度判档：<3°→flat，3~15°→hipped，≥15°→gabled
                  （`ROOF_TYPE == "Pyramid_Hip"` 一律 hipped）
    dcgis:slope   真实平均坡度（度），留档以便复查
    dcgis:objectid  layer1 的 OBJECTID，留档以便复查 / 二次 join

    注意：`ROOF_TYPE` **不能**单独当平/坡判据 —— 全 DC 66% 是 "Default" 但真平顶
    只有 26%，坡度必须看 `SLOPE_MEAN`。

用法:
    python tools\enrich_osm_with_dcgis.py                # 处理 tiles_dt → tiles_dt_real
    python tools\enrich_osm_with_dcgis.py --limit 2      # 只处理前 2 块（快测）
"""
import json
import math
import os
import sys
import time
import xml.etree.ElementTree as ET

DCGIS = r"D:\Users\asus\Desktop\项目\data\dcgis"
IN_DIR = r"D:\Users\asus\Desktop\项目\data\osm\tiles_dt"
OUT_DIR = r"D:\Users\asus\Desktop\项目\data\osm\tiles_dt_real"
CELL = 0.002          # 空间索引格边长（度），约 220 m


# ───────────────────────────── 几何工具 ─────────────────────────────
def centroid(pts):
    """多边形顶点平均值（够用；建筑轮廓都是凸凹不深的简单形状）。"""
    if not pts:
        return None
    sx = sum(p[0] for p in pts) / len(pts)
    sy = sum(p[1] for p in pts) / len(pts)
    return sx, sy


def contains(poly, x, y):
    """射线法：点 (x, y) 是否在多边形内。"""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-18) + xi):
            inside = not inside
        j = i
    return inside


def poly_area(poly):
    a = 0.0
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        a += x1 * y2 - x2 * y1
    return abs(a) * 0.5


class Index:
    """按经纬网格索引图层 1 的轮廓，查询时只看邻近格子。"""

    def __init__(self, polys):
        self.polys = polys
        self.grid = {}
        self.area = [poly_area(p) for p in polys]
        for i, p in enumerate(polys):
            xs = [q[0] for q in p]
            ys = [q[1] for q in p]
            x0, x1 = int(math.floor(min(xs) / CELL)), int(math.floor(max(xs) / CELL))
            y0, y1 = int(math.floor(min(ys) / CELL)), int(math.floor(max(ys) / CELL))
            for cx in range(x0, x1 + 1):
                for cy in range(y0, y1 + 1):
                    self.grid.setdefault((cx, cy), []).append(i)

    def lookup(self, x, y):
        """返回命中的轮廓下标，多个命中时取面积最大的那个。"""
        cand = self.grid.get((int(math.floor(x / CELL)), int(math.floor(y / CELL))))
        if not cand:
            return None
        best, best_a = None, -1.0
        for i in cand:
            if self.area[i] > best_a and contains(self.polys[i], x, y):
                best, best_a = i, self.area[i]
        return best


# ───────────────────────────── 数据装载 ─────────────────────────────
def load(name):
    path = os.path.join(DCGIS, name + ".json")
    if not os.path.exists(path):
        raise SystemExit("缺少 %s —— 先跑 tools\\fetch_dcgis.py" % path)
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def id_of(gis_id, prefix):
    if not gis_id or not gis_id.startswith(prefix):
        return None
    try:
        return int(gis_id[len(prefix):])
    except ValueError:
        return None


def roof_shape(slope, rtype):
    """坡度 → OSM `roof:shape` 取值（blosm 认 flat/gabled/hipped/pyramidal/...）。"""
    if rtype == "Pyramid_Hip":
        return "hipped"
    if slope is None:
        return None
    if slope < 3.0:
        return "flat"
    if slope < 15.0:
        return "hipped"
    return "gabled"


# ───────────────────────────── 主流程 ─────────────────────────────
def set_tag(elem, key, value):
    for t in elem.findall("tag"):
        if t.get("k") == key:
            t.set("v", value)
            return False
    t = ET.SubElement(elem, "tag")
    t.set("k", key)
    t.set("v", value)
    return True


def process(path, out_path, index, id2h, id2slope, stats):
    tree = ET.parse(path)
    root = tree.getroot()

    nodes = {}
    for e in root.findall("node"):
        try:
            nodes[e.get("id")] = (float(e.get("lon")), float(e.get("lat")))
        except (TypeError, ValueError):
            pass

    for way in root.findall("way"):
        tags = {t.get("k") for t in way.findall("tag")}
        if "building" not in tags:
            continue
        stats["ways"] += 1

        pts = []
        for nd in way.findall("nd"):
            p = nodes.get(nd.get("ref"))
            if p:
                pts.append(p)
        c = centroid(pts)
        if c is None:
            stats["no_geom"] += 1
            continue

        idx = index.lookup(*c)
        if idx is None:
            stats["no_poly"] += 1
            continue
        oid = index.polys_id[idx]
        stats["matched"] += 1

        # ① 真实高度
        h = None
        rec = id2h.get(oid)
        if rec:
            max_z, min_z = rec
            if max_z is not None:
                base = min(min_z, 1.0) if min_z is not None and min_z >= 0 else 0.0
                cand = max_z - base
                if 3.0 <= cand <= 400.0:
                    h = cand
        if h is not None:
            set_tag(way, "height", "%.2f" % h)
            stats["height"] += 1
        else:
            stats["no_height"] += 1

        # ② 真实屋顶坡度
        rec2 = id2slope.get(oid)
        if rec2:
            slope, rtype = rec2
            set_tag(way, "dcgis:slope", "%.2f" % slope if slope is not None else "")
            rs = roof_shape(slope, rtype)
            if rs:
                set_tag(way, "roof:shape", rs)
                stats["roof"] += 1
                stats.setdefault("rs_" + rs, 0)
                stats["rs_" + rs] += 1
        else:
            stats["no_roof"] += 1

        set_tag(way, "dcgis:objectid", str(oid))

    ET.ElementTree(root).write(out_path, encoding="utf-8", xml_declaration=True)


def main():
    t0 = time.time()
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    print("装载 DCGIS …")
    fp = load("footprints")
    b3 = load("buildings_3d")
    rd = load("roofs_detailed")

    polys, polys_id = [], []
    for f in fp["features"]:
        p = f.get("p")
        if p and len(p) >= 3:
            polys.append([(float(q[0]), float(q[1])) for q in p])
            polys_id.append(f["a"]["OBJECTID"])
    print("  layer 1 轮廓 %d 条" % len(polys))

    id2h = {}
    for f in b3["features"]:
        n = id_of(f["a"].get("GIS_ID"), "BldgPly_")
        if n is not None:
            id2h[n] = (f["a"].get("MAX_Z"), f["a"].get("MIN_Z"))
    print("  layer 2 高度 %d 条" % len(id2h))

    id2slope = {}
    for f in rd["features"]:
        n = id_of(f["a"].get("GIS_ID"), "BldgPly_3D_Roof_")
        if n is not None:
            id2slope[n] = (f["a"].get("SLOPE_MEAN"), f["a"].get("ROOF_TYPE"))
    print("  layer 13 屋顶 %d 条" % len(id2slope))

    # ★ 关键自检：layer13 的编号空间到底是不是 layer1 的 OBJECTID？
    hit13 = sum(1 for n in id2slope if n in polys_id)
    print("  ★ layer13 的编号命中 layer1 OBJECTID：%d / %d" % (hit13, len(id2slope)))

    print("建空间索引 …")
    index = Index(polys)
    index.polys_id = polys_id
    print("  %d 个格子" % len(index.grid))

    files = sorted(f for f in os.listdir(IN_DIR) if f.endswith(".osm"))
    if limit:
        files = files[:limit]
    os.makedirs(OUT_DIR, exist_ok=True)

    stats = {k: 0 for k in ("ways", "matched", "height", "no_height", "roof",
                            "no_roof", "no_poly", "no_geom")}
    for i, fn in enumerate(files, 1):
        out = os.path.join(OUT_DIR, fn)
        process(os.path.join(IN_DIR, fn), out, index, id2h, id2slope, stats)
        print("  [%2d/%d] %s" % (i, len(files), fn))

    print("\n" + "=" * 78)
    print("建筑 way 总数      : %d" % stats["ways"])
    print("匹配到 DCGIS 轮廓  : %d  (%.1f%%)" % (stats["matched"],
          stats["matched"] * 100.0 / max(1, stats["ways"])))
    print("写到真实 height    : %d  (%.1f%%)" % (stats["height"],
          stats["height"] * 100.0 / max(1, stats["ways"])))
    print("写到 roof:shape    : %d  (%.1f%%)" % (stats["roof"],
          stats["roof"] * 100.0 / max(1, stats["ways"])))
    for k in sorted(stats):
        if k.startswith("rs_"):
            print("    %-8s : %d" % (k[3:], stats[k]))
    print("没匹配到轮廓       : %d" % stats["no_poly"])
    print("轮廓里没有高度     : %d" % stats["no_height"])
    print("轮廓里没有屋顶     : %d" % stats["no_roof"])
    print("耗时 %.1f 秒" % (time.time() - t0))
    print("输出目录 %s" % OUT_DIR)


if __name__ == "__main__":
    main()
