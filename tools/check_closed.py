# -*- coding: utf-8 -*-
"""检查 .osm 里的 building way 是不是闭合的（第一个节点 == 最后一个节点）。

blosm 只把闭合的 way 当作建筑轮廓；不闭合的会被判为无效、直接丢掉。
"""
import sys
import xml.etree.ElementTree as ET

path = sys.argv[1] if len(sys.argv) > 1 else \
    r"D:\Users\asus\Desktop\项目\data\osm\manhattan_times-square_556x435m.osm"

root = ET.parse(path).getroot()

closed, opened = [], []
for w in root.findall("way"):
    t = {c.get("k"): c.get("v") for c in w.findall("tag")}
    if "building" not in t:
        continue
    nds = [nd.get("ref") for nd in w.findall("nd")]
    rec = (t.get("name") or "(无名)", t.get("building"), len(nds), t.get("height", "-"))
    (closed if nds and nds[0] == nds[-1] else opened).append(rec)

print("闭合的 building way: %d" % len(closed))
print("不闭合的 building way: %d" % len(opened))
if opened:
    print("-" * 70)
    for r in opened:
        print("  不闭合 -> %-32s building=%-10s 点数=%-3d height=%s" % r)
print("-" * 70)
for r in closed[:8]:
    print("  闭合   -> %-32s building=%-10s 点数=%-3d height=%s" % r)
