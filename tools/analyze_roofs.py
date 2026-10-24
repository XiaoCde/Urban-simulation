# -*- coding: utf-8 -*-
"""统计华盛顿 DC 源数据里的"屋顶相关标签"覆盖情况。

回答的问题：blosm 出来的房子为什么几乎全是平顶 —— 是数据没有屋顶信息，
还是真实如此？

    python tools\analyze_roofs.py [tiles_dir]
"""
import glob
import os
import sys
import xml.etree.ElementTree as ET
from collections import Counter

_argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
TILES = (_argv[0] if _argv
         else next((a for a in sys.argv[1:] if not a.startswith("-") and a.endswith(("\\", "/")) or
                    (not a.startswith("-") and os.path.isdir(a))), None)
         or r"D:\Users\asus\Desktop\项目\data\osm\tiles_dt")

ROOF_KEYS = ["roof:shape", "roof:height", "roof:levels", "roof:angle",
             "roof:material", "roof:colour", "building:roof:shape"]
OTHER_KEYS = ["building:levels", "height", "building:height", "min_height",
              "building:colour", "building:material", "start_date", "addr:housenumber",
              "nycdoitt:bin", "dcgis:bin"]

files = sorted(glob.glob(os.path.join(TILES, "*.osm")))
print("分析 %d 个分块: %s" % (len(files), TILES))

total = 0
buildings = 0
roof_shape_vals = Counter()
building_vals = Counter()
cover = Counter()
by_type_roof = Counter()      # building 类型 -> 该类型里有 roof:shape 的栋数
by_type_total = Counter()     # building 类型 -> 总栋数

for f in files:
    try:
        root = ET.parse(f).getroot()
    except Exception as e:
        print("  跳过 %s: %s" % (os.path.basename(f), e))
        continue
    for el in root:
        if el.tag == "node":
            total += 1
        elif el.tag == "way":
            tags = {}
            for t in el:
                if t.tag == "tag":
                    tags[t.get("k")] = t.get("v")
            if "building" not in tags:
                continue
            buildings += 1
            bv = tags.get("building", "?")
            building_vals[bv] += 1
            by_type_total[bv] += 1
            for k in ROOF_KEYS + OTHER_KEYS:
                if k in tags:
                    cover[k] += 1
            rs = tags.get("roof:shape")
            if rs:
                roof_shape_vals[rs] += 1
                by_type_roof[bv] += 1

print("=" * 84)
print("节点 %d 个 / 带 building 标签的 way **%d** 栋" % (total, buildings))
print("=" * 84)

print("\n【一】屋顶标签覆盖（分母 = %d 栋）" % buildings)
for k in ROOF_KEYS:
    n = cover[k]
    print("  %-20s %6d 栋   %5.2f%%" % (k, n, n / buildings * 100 if buildings else 0))

print("\n【二】其他几何/属性标签覆盖")
for k in OTHER_KEYS:
    n = cover[k]
    print("  %-20s %6d 栋   %5.2f%%" % (k, n, n / buildings * 100 if buildings else 0))

print("\n【三】roof:shape 的取值分布（共 %d 栋有这个标签）" % sum(roof_shape_vals.values()))
for v, n in roof_shape_vals.most_common(20):
    print("  %-16s %6d" % (v, n))

print("\n【四】building 类型分布 Top 20")
for v, n in building_vals.most_common(20):
    print("  %-16s %6d   (%.1f%%)   其中带 roof:shape 的 %d 栋"
          % (v, n, n / buildings * 100, by_type_roof.get(v, 0)))

print("\n【五】坡屋顶可能性最高的几类，实际有多少标了 roof:shape")
for v in ("house", "detached", "semidetached_house", "terrace", "residential",
          "apartments", "church", "school", "garage", "garages", "yes"):
    t = by_type_total.get(v, 0)
    if t:
        r = by_type_roof.get(v, 0)
        print("  %-20s 共 %6d 栋，有 roof:shape %5d 栋 (%.2f%%)" % (v, t, r, r / t * 100))
