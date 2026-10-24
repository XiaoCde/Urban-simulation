# -*- coding: utf-8 -*-
r"""把 DCGIS 的真实屋顶形状补齐到 .osm —— 用 2024 lidar 实测的屋顶隆起高度。

════════════════════════════════════════════════════════════════════════
为什么需要这一步
════════════════════════════════════════════════════════════════════════
    之前只给 11,733 / 21,899 栋写了 roof:shape（来自 layer 13 "Detailed Roof"
    的 SLOPE_MEAN 空间匹配，覆盖率受该图层 2005-2013 立体影像的覆盖范围限制），
    剩下 10,266 栋走了 blosm 的默认值 `flat` → 整片看起来像"棺材盒"。

    这次换一把**覆盖 100% 的真尺子**：layer 2 "Buildings - 3D"（2024-03-01 lidar）
    的逐栋点云统计量。`MAX_Z - MEDIAN_Z` 就是 lidar 直接量到的**屋面相对中位面的隆起**：
        平屋顶（含女儿墙） → 隆起接近 0
        双坡/四坡屋面      → 隆起 1~5 m（就是脊高）
    layer 2 的 `BldgPly_<N>` 与 Planimetrics_2023/1 的 OBJECTID **100% 对齐**，
    所以这把尺子对整个框都有效。

判定规则（阈值来自实测分布的拐点，全部是"量出来的"不是"猜的"）：
    有 layer 13 真实坡度 → 用坡度：<3° flat / 3~15° hipped / ≥15° gabled
    否则用 lidar 隆起 rise = MAX_Z - MEDIAN_Z：
        rise < 0.5 m            → flat   （平顶）
        0.5 ~ 1.2 m             → hipped （低坡四坡）
        ≥ 1.2 m                 → gabled （双坡，roof:height = rise）
    兜底护栏：总高 > 30 m 且 rise < 3 m 的当平顶（DC 高层写字楼是方盒子，
              隆起来自退台塔楼而不是坡屋面）

用法:
    python tools\apply_dcgis_roofshape.py <输入.osm> <heights.jsonl> <roofs.jsonl> <输出.osm>
"""
import json
import math
import os
import sys
import xml.etree.ElementTree as ET

LAT_M, LON_M = 110540.0, 111320.0 * math.cos(math.radians(38.905))
MAX_ROOF_SPAN_M = 150.0      # layer 13 的框超过这个尺度就不是单栋屋顶，丢弃


class Grid:
    """按经纬度格子索引外接框；查询一个点时返回覆盖它的所有记录。"""

    def __init__(self, rows, cell=0.0005):
        self.cell = cell
        self.d = {}
        for r in rows:
            x0, y0, x1, y1 = r[0], r[1], r[2], r[3]
            for cx in range(int(math.floor(x0 / cell)), int(math.floor(x1 / cell)) + 1):
                for cy in range(int(math.floor(y0 / cell)), int(math.floor(y1 / cell)) + 1):
                    self.d.setdefault((cx, cy), []).append(r)

    def find(self, lon, lat, expand=0.0):
        cx, cy = int(math.floor(lon / self.cell)), int(math.floor(lat / self.cell))
        out = []
        for k in ((cx, cy), (cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1),
                  (cx - 1, cy - 1), (cx + 1, cy - 1), (cx - 1, cy + 1), (cx + 1, cy + 1)):
            for (x0, y0, x1, y1, *rest) in self.d.get(k, ()):
                if (x0 - expand) <= lon <= (x1 + expand) and \
                   (y0 - expand) <= lat <= (y1 + expand):
                    out.append((rest, (x1 - x0) * LON_M, (y1 - y0) * LAT_M))
        return out


def load_jsonl(path, fields):
    rows, bad = [], 0
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        bb = d.get("bbox")
        vals = [d.get(f) for f in fields]
        if not bb or any(v is None for v in vals):
            bad += 1
            continue
        rows.append(tuple(float(x) for x in bb) + tuple(_num(v) for v in vals))
    print("  %s: %d 条可用, %d 条丢弃" % (os.path.basename(path), len(rows), bad))
    return rows


def _num(v):
    """roof 字段是字符串（Default/Shed/...），数值字段转 float，转不动就原样留着。"""
    try:
        return float(v)
    except (TypeError, ValueError):
        return v


def shape_from_slope(slope, rtype):
    if slope < 3.0:
        return "flat"
    if rtype == "Pyramid_Hip":
        return "hipped"
    if rtype in ("Saddle", "Shed", "Butterfly"):
        return "gabled"
    return "gabled" if slope >= 15.0 else "hipped"


def main():
    if len(sys.argv) < 5:
        print(__doc__)
        return
    src, hpath, rpath, dst = sys.argv[1:5]

    print("读入 DCGIS 记录:")
    roofs = load_jsonl(rpath, ["slope", "h", "alt", "roof"])
    heights = load_jsonl(hpath, ["maxz", "minz", "medz"])
    grid_roof = Grid(roofs)
    grid_h = Grid(heights)

    rel_path = os.path.join(os.path.dirname(os.path.abspath(hpath)), "dc_downtown_roofs.jsonl")
    print("\n解析 %s ..." % src)
    tree = ET.parse(src)
    root = tree.getroot()
    nodes = {n.get("id"): (float(n.get("lon")), float(n.get("lat")))
             for n in root.findall("node")}

    stat = {"已有二保持": 0, "由坡度定": 0, "由lidar隆起定": 0, "无匹配": 0}
    hs = []

    for w in root.findall("way"):
        tags = {t.get("k"): t.get("v") for t in w.findall("tag")}
        if "building" not in tags:
            continue
        if "height" in tags:
            try:
                hs.append(float(tags["height"]))
            except ValueError:
                pass
        if tags.get("roof:shape"):
            stat["已有二保持"] += 1
            continue

        ids = [nd.get("ref") for nd in w.findall("nd")]
        pts = [nodes[i] for i in ids if i in nodes]
        if not pts:
            stat["无匹配"] += 1
            continue
        lon = sum(p[0] for p in pts) / len(pts)
        lat = sum(p[1] for p in pts) / len(pts)

        shape = rh = None
        # ① layer 13 的真实坡度（只信尺度合理的框）
        hits = [h for h in grid_roof.find(lon, lat)
                if h[1] < MAX_ROOF_SPAN_M and h[2] < MAX_ROOF_SPAN_M]
        if not hits:
            hits = [h for h in grid_roof.find(lon, lat, expand=0.00005)
                    if h[1] < MAX_ROOF_SPAN_M and h[2] < MAX_ROOF_SPAN_M]
        if hits:
            (slope, hh, alt, rtype), _, _ = max(hits, key=lambda t: t[0][0])
            shape = shape_from_slope(slope, rtype)
            rh = min(max(hh - (alt - hh), 1.0), 12.0) if hh > 0 else None
            stat["由坡度定"] += 1

        # ② 退到 lidar 的 MAX_Z - MEDIAN_Z
        if shape is None:
            hits = grid_h.find(lon, lat) or grid_h.find(lon, lat, expand=0.00005)
            if hits:
                (maxz, minz, medz), _, _ = max(hits, key=lambda t: t[0][0])
                rise = maxz - medz
                hgt = maxz - min(minz, 1.0)
                if hgt > 30.0 and rise < 3.0:
                    shape, rh = "flat", None
                elif rise < 0.5:
                    shape, rh = "flat", None
                elif rise < 1.2:
                    shape, rh = "hipped", round(min(max(rise, 1.0), 3.0), 2)
                else:
                    shape, rh = "gabled", round(min(rise, 6.0), 2)
                stat["由lidar隆起定"] += 1
            else:
                stat["无匹配"] += 1

        if shape:
            ET.SubElement(w, "tag", {"k": "roof:shape", "v": shape})
            if rh and shape != "flat":
                ET.SubElement(w, "tag", {"k": "roof:height", "v": "%.2f" % rh})

    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    tree.write(dst, encoding="utf-8", xml_declaration=True)

    hs.sort()
    print()
    print("=" * 72)
    for k, v in stat.items():
        print("  %-14s %d" % (k, v))
    if hs:
        print("  高度分布(共 %d 栋有 height): min %.1f  P25 %.1f  中位 %.1f  P75 %.1f  max %.1f m"
              % (len(hs), hs[0], hs[len(hs) // 4], hs[len(hs) // 2],
                 hs[3 * len(hs) // 4], hs[-1]))
    print("  输出 %s (%.1f MB)" % (dst, os.path.getsize(dst) / 1048576.0))


main()
