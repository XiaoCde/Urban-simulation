# -*- coding: utf-8 -*-
"""算出 data\osm 下若干 .osm 文件的并集经纬度外接矩形（给 DCGIS 查询用）。

    python tools\tiles_bbox.py [目录或文件...]
"""
import glob
import os
import sys
import xml.etree.ElementTree as ET

_args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
_args = [a for a in _args if not a.startswith("-")] or \
        [a for a in sys.argv[1:] if not a.startswith("-") and os.path.exists(a)]
if not _args:
    _args = [r"D:\Users\asus\Desktop\项目\data\osm\tiles_dt"]

files = []
for a in _args:
    if os.path.isdir(a):
        files += sorted(glob.glob(os.path.join(a, "*.osm")))
    else:
        files.append(a)

s = w = n = e = None
nodes = 0
buildings = 0
for f in files:
    try:
        root = ET.parse(f).getroot()
    except Exception as ex:
        print("跳过 %s: %s" % (os.path.basename(f), ex))
        continue
    for el in root:
        if el.tag == "node":
            nodes += 1
            lat, lon = float(el.get("lat")), float(el.get("lon"))
            s = lat if s is None else min(s, lat)
            n = lat if n is None else max(n, lat)
            w = lon if w is None else min(w, lon)
            e = lon if e is None else max(e, lon)
        elif el.tag == "way":
            if any(t.tag == "tag" and t.get("k") == "building" for t in el):
                buildings += 1

print("文件 %d 个 / 节点 %d 个 / building way %d 条" % (len(files), nodes, buildings))
print("bbox (WGS84): 南 %.6f  西 %.6f  北 %.6f  东 %.6f" % (s, w, n, e))
print("WGS84 CSV   : %.6f,%.6f,%.6f,%.6f" % (w, s, e, n))
print("尺寸        : 南北 %.0f m  东西 %.0f m" % ((n - s) * 111320, (e - w) * 111320 * 0.78))
