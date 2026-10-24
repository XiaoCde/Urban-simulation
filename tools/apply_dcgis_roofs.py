# -*- coding: utf-8 -*-
"""把 DCGIS 的官方屋顶数据写回 .osm 的 roof:shape / roof:height 标签。

数据源: data/dcgis/dc_downtown_roofs.jsonl (fetch_dcgis_roofs.py 产出)
  DCGIS Facility_and_Structure/MapServer 图层 13 "Buildings (Detailed Roof)"
  每行: {oid, roof(ROOF_TYPE), h(HOUSE_HEIGHT), alt, slope(SLOPE_MEAN),
         slope_min, slope_max, bbox}

===== 为什么要做这件事 =====
DC 的 OSM 数据里只有 55 / 22,020 栋带 roof:shape（0.2%）→ blosm 全部按面板默认
的 flat 渲，所以"全是平顶"。blosm/building/renderer.py:150 是插件里唯一按
roof:shape 标签挑形状的地方：roof = self.roofs.get(tags.get("roof:shape"), defaultRoof)。
blosm 支持的形状见 item/defs.py:2-14。

===== 最大风险（已规避）=====
blosm/building/roof/__init__.py:111-131 calculateDimensions()
    roofHeight = getRoofHeight()      # 优先读 roof:height
    z2 = getHeight()                   # 读 height
    roofVerticalPosition = z2 - roofHeight
    wallHeight = roofVerticalPosition - z1
    if wallHeight < 0.:  self.valid = False; return    # ← 整栋楼被丢掉！
所以 roof:height 必须 <= height。本脚本强制
    roof:height = max(1.0, min(3.0, height*0.4, width*0.4))
且 height < 3.5 m 的建筑一律保持平顶。

===== 匹配方式（实测对比见 check_roof_match.py）=====
屋顶图层只有 9,003 条记录，bbox 内 OSM 建筑有 21,899 栋。
  "质心落在外接框内" → 命中 21,157 (96.6%)，相当于把一条记录摊给 2.4 栋楼，
      大型联邦办公楼（1000-3000 m^2）也有 41.5% 被扣上坡顶 → 太松，不可信。
  "外接框 IoU" → 严格得多。
本脚本用【记录 → 建筑】的贪心一对一指派（每条记录最多用一次），比"建筑 → 记录"
更符合"一条 lidar 屋顶记录对应一栋楼"的事实，也避免同一条记录重复套用。

===== 未被屋顶图层覆盖的建筑怎么办（推断，不是实测）=====
屋顶图层只覆盖 dc_mall 的 39.5% / downtown 的约 41%。对其余建筑没有实测证据。
做法：用**已匹配样本**按 (building 标签组, 面积档) 统计 P(坡顶)，再对未匹配建筑
用**确定性哈希**按该概率决定是否加坡顶（可复现，不是每次跑都不一样）。
这是"热卡插补"式的统计推断，会在报告里明确标注为推断值而非实测值。

用法:
  python apply_dcgis_roofs.py <输入.osm> <roofs.jsonl> <输出.osm> [--iou 0.3] [--no-impute]
"""
import hashlib
import json
import math
import os
import sys
import xml.etree.ElementTree as ET

MIN_H_FOR_PITCH = 3.5
ROOF_H_MAX = 3.0
CELL = 0.0005
BANDS = [(0, 50), (50, 100), (100, 300), (300, 1000), (1000, 3000), (3000, 1e9)]


def band_of(area):
    for b in BANDS:
        if b[0] <= area < b[1]:
            return b
    return BANDS[-1]


def group_of(btag):
    if btag in ("house", "detached", "semidetached_house", "terrace", "bungalow"):
        return "house"
    if btag in ("garage", "garages", "shed", "hut", "cabin", "static_caravan"):
        return "outbuilding"
    if btag in ("apartments", "residential", "dormitory"):
        return "residential"
    return "other"


def load_roofs(path):
    rows, bad = [], 0
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            bb = d.get("bbox")
            if not bb:
                bad += 1
                continue
            x0, y0, x1, y1 = (float(v) for v in bb)
            rows.append({
                "x0": min(x0, x1), "x1": max(x0, x1),
                "y0": min(y0, y1), "y1": max(y0, y1),
                "roof": d.get("roof") or "Unknown",
                "slope": float(d.get("slope") or 0.0),
                "hh": float(d.get("h") or 0.0),
            })
    print("读入屋顶记录: %d 条可用, %d 条丢弃(无bbox)" % (len(rows), bad))
    return rows


def iou(a, b):
    ix0, iy0 = max(a["x0"], b["x0"]), max(a["y0"], b["y0"])
    ix1, iy1 = min(a["x1"], b["x1"]), min(a["y1"], b["y1"])
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    inter = (ix1 - ix0) * (iy1 - iy0)
    ua = (a["x1"] - a["x0"]) * (a["y1"] - a["y0"])
    ub = (b["x1"] - b["x0"]) * (b["y1"] - b["y0"])
    return inter / max(ua + ub - inter, 1e-18)


def shape_from_record(roof, slope):
    """实测记录 -> roof:shape；返回 None 表示平顶"""
    if roof == "Pyramid_Hip":
        return "pyramidal"
    if roof in ("Saddle", "Combined", "Combination"):
        return "gabled"
    if roof in ("Butterfly", "Unknown", "Shed"):
        return None
    if slope is None or slope < 2.0:
        return None
    return "gabled"


def geo_area_m2(bb, lat):
    return abs(bb["x1"] - bb["x0"]) * 111320.0 * math.cos(math.radians(lat)) * \
           abs(bb["y1"] - bb["y0"]) * 110540.0


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        return
    src, rpath, dst = sys.argv[1], sys.argv[2], sys.argv[3]
    iou_min = 0.30
    if "--iou" in sys.argv:
        iou_min = float(sys.argv[sys.argv.index("--iou") + 1])
    impute = "--no-impute" not in sys.argv

    records = load_roofs(rpath)
    tree = ET.parse(src)
    root = tree.getroot()
    nodes = {n.get("id"): (float(n.get("lon")), float(n.get("lat")))
             for n in root.findall("node")}

    # ---- 1) 收集建筑 ----
    blds = []
    for w in list(root.findall("way")) + list(root.findall("relation")):
        tags = {t.get("k"): t.get("v") for t in w.findall("tag")}
        if "building" not in tags:
            continue
        if w.tag == "way":
            pts = [nodes[i] for i in (nd.get("ref") for nd in w.findall("nd")) if i in nodes]
        else:
            ids = [m.get("ref") for m in w.findall("member") if m.get("type") == "way"]
            pts = [nodes[i] for i in ids if i in nodes]
        if len(pts) < 3:
            continue
        bb = {"x0": min(p[0] for p in pts), "x1": max(p[0] for p in pts),
              "y0": min(p[1] for p in pts), "y1": max(p[1] for p in pts)}
        lat = (bb["y0"] + bb["y1"]) / 2.0
        try:
            height = float(tags["height"]) if "height" in tags else None
        except (ValueError, TypeError):
            height = None
        blds.append({
            "el": w, "tags": tags, "bb": bb, "lat": lat,
            "area": geo_area_m2(bb, lat), "height": height,
            "width": math.sqrt(max(geo_area_m2(bb, lat), 1.0)),
            "gid": group_of(tags.get("building") or "yes"),
        })
    print("建筑: %d 栋" % len(blds))

    # ---- 2) 空间索引 + 贪心一对一指派（记录 -> 建筑）----
    grid = {}
    for i, b in enumerate(blds):
        cx = int(math.floor(((b["bb"]["x0"] + b["bb"]["x1"]) / 2) / CELL))
        cy = int(math.floor(((b["bb"]["y0"] + b["bb"]["y1"]) / 2) / CELL))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                grid.setdefault((cx + dx, cy + dy), []).append(i)

    pairs = []
    for ri, r in enumerate(records):
        cx0, cx1 = int(math.floor(r["x0"] / CELL)), int(math.floor(r["x1"] / CELL))
        cy0, cy1 = int(math.floor(r["y0"] / CELL)), int(math.floor(r["y1"] / CELL))
        cand = set()
        for cx in range(cx0, cx1 + 1):
            for cy in range(cy0, cy1 + 1):
                cand.update(grid.get((cx, cy), ()))
        for bi in cand:
            v = iou(r, blds[bi]["bb"])
            if v >= iou_min:
                pairs.append((v, ri, bi))
    pairs.sort(reverse=True)
    used_r, used_b, assign = set(), set(), {}
    for v, ri, bi in pairs:
        if ri in used_r or bi in used_b:
            continue
        used_r.add(ri)
        used_b.add(bi)
        assign[bi] = (ri, v)
    print("IoU>=%.2f 一对一匹配: %d 对（占建筑 %.1f%%）"
          % (iou_min, len(assign), 100.0 * len(assign) / max(len(blds), 1)))

    # ---- 3) 匹配质量诊断: 记录 HOUSE_HEIGHT 与 OSM height 是否一致 ----
    diffs, n_cmp = [], 0
    for bi, (ri, v) in assign.items():
        h1, h2 = blds[bi]["height"], records[ri]["hh"]
        if h1 and h2:
            n_cmp += 1
            diffs.append(abs(h1 - h2) / max(h1, 1.0))
    if diffs:
        diffs.sort()
        print("匹配质量: %d 对可比高度, 相对差 中位=%.1f%% 75%%=%.1f%% 90%%=%.1f%%"
              % (n_cmp, 100 * diffs[len(diffs) // 2],
                 100 * diffs[int(0.75 * len(diffs))], 100 * diffs[int(0.9 * len(diffs))]))

    # ---- 4) 实测样本的 P(坡顶) 分档统计 ----
    stat = {}
    for bi, (ri, v) in assign.items():
        key = (blds[bi]["gid"], band_of(blds[bi]["area"]))
        s = shape_from_record(records[ri]["roof"], records[ri]["slope"])
        d = stat.setdefault(key, [0, 0])
        d[1] += 1
        if s:
            d[0] += 1
    print()
    print("实测样本 P(坡顶) 分档（用于对未覆盖建筑做插补）:")
    print("  %-12s %-16s %6s %7s %8s" % ("标签组", "面积(m^2)", "样本", "坡顶", "P(坡顶)"))
    for key in sorted(stat, key=lambda k: (k[0], k[1][0])):
        p, t = stat[key]
        if t >= 20:
            print("  %-12s %-16s %6d %7d %7.1f%%"
                  % (key[0], "%d-%d" % (key[1][0], int(key[1][1]) if key[1][1] < 1e9 else 999999),
                     t, p, 100.0 * p / t))

    # ---- 5) 写标签 ----
    def stable_rand(gid, salt):
        h = hashlib.md5(("%s:%s" % (gid, salt)).encode()).hexdigest()
        return int(h[:8], 16) / float(0xFFFFFFFF)

    n_measured = n_imputed = n_pitch = n_low = n_noh = n_flat = 0
    shapes = {}
    for bi, b in enumerate(blds):
        if "roof:shape" in b["tags"]:
            continue
        shape = None
        if bi in assign:
            ri, v = assign[bi]
            shape = shape_from_record(records[ri]["roof"], records[ri]["slope"])
            n_measured += 1
        elif impute:
            key = (b["gid"], band_of(b["area"]))
            d = stat.get(key)
            if d and d[1] >= 20:
                p = d[0] / float(d[1])
                if p > 0.0 and stable_rand(b["el"].get("id") or str(bi), key[0]) < p:
                    shape = "gabled" if p < 0.95 else "gabled"
                    n_imputed += 1
        if shape is None:
            n_flat += 1
            continue
        if b["height"] is None:
            n_noh += 1
            continue
        if b["height"] < MIN_H_FOR_PITCH:
            n_low += 1
            continue
        rh = max(1.0, min(ROOF_H_MAX, b["height"] * 0.4, b["width"] * 0.4))
        if b["height"] - rh < 0.05:
            n_low += 1
            continue
        ET.SubElement(b["el"], "tag", {"k": "roof:shape", "v": shape})
        ET.SubElement(b["el"], "tag", {"k": "roof:height", "v": "%.2f" % rh})
        n_pitch += 1
        shapes[shape] = shapes.get(shape, 0) + 1

    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    tree.write(dst, encoding="utf-8", xml_declaration=True)

    print()
    print("=" * 74)
    print("建筑总数              : %d" % len(blds))
    print("有实测屋顶记录        : %d" % n_measured)
    print("  其中统计插补的      : %d" % n_imputed)
    print("写成坡顶              : %d (%.1f%%)" % (n_pitch, 100.0 * n_pitch / max(len(blds), 1)))
    print("  高度缺失跳过        : %d" % n_noh)
    print("  高度不足跳过        : %d" % n_low)
    print("保持平顶              : %d" % n_flat)
    for k, v in sorted(shapes.items(), key=lambda kv: -kv[1]):
        print("    roof:shape=%-12s %d" % (k, v))
    print("输出: %s (%.1f MB)" % (dst, os.path.getsize(dst) / 1048576.0))


main()
