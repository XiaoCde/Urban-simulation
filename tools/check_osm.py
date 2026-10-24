# -*- coding: utf-8 -*-
"""列出 .osm 文件里每栋建筑的属性，用于核对 blosm 导入结果是否合理。"""
import sys
import xml.etree.ElementTree as ET

path = sys.argv[1] if len(sys.argv) > 1 else \
    r"D:\Users\asus\Desktop\项目\data\osm\manhattan_times-square_556x435m.osm"

root = ET.parse(path).getroot()

nodes = {}
for n in root.findall("node"):
    nodes[n.get("id")] = (float(n.get("lat")), float(n.get("lon")))

ways = []
rels = []
for w in root.findall("way"):
    t = {c.get("k"): c.get("v") for c in w.findall("tag")}
    if "building" in t or "building:part" in t:
        ways.append((w, t))
for r in root.findall("relation"):
    t = {c.get("k"): c.get("v") for c in r.findall("tag")}
    if "building" in t:
        rels.append((r, t))

print("=" * 100)
print("文件: %s" % path)
print("节点 %d 个 / way %d 条 / building way %d 条 / building relation %d 个"
      % (len(nodes), len(root.findall("way")), len(ways), len(rels)))
print("=" * 100)

rows = []
for w, t in ways:
    nds = [nd.get("ref") for nd in w.findall("nd")]
    pts = [nodes[i] for i in nds if i in nodes]
    lat = sum(p[0] for p in pts) / len(pts)
    lon = sum(p[1] for p in pts) / len(pts)
    rows.append({
        "name": t.get("name", ""),
        "btype": t.get("building", ""),
        "height": t.get("height", ""),
        "levels": t.get("building:levels", ""),
        "min_h": t.get("min_height", t.get("building:min_level", "")),
        "roof": t.get("roof:shape", ""),
        "bin": t.get("nycdoitt:bin", ""),
        "nverts": len(pts),
        "lat": lat,
        "lon": lon,
        "addr": (t.get("addr:street", "") + " " + t.get("addr:housenumber", "")).strip(),
    })

rows.sort(key=lambda r: -float(r["height"]) if r["height"] else 0)

hdr = "%-34s %-12s %8s %6s %6s %-10s %3s %-22s" % (
    "名称", "building", "height", "层数", "min_h", "roof:shape", "点", "地址")
print(hdr)
print("-" * 100)
for r in rows:
    print("%-34s %-12s %8s %6s %6s %-10s %3d %-22s" % (
        (r["name"] or "(无名)")[:34], r["btype"][:12], r["height"] or "-",
        r["levels"] or "-", r["min_h"] or "-", r["roof"] or "-",
        r["nverts"], r["addr"][:22]))

print("-" * 100)
n_h = sum(1 for r in rows if r["height"])
n_l = sum(1 for r in rows if r["levels"])
n_both_none = sum(1 for r in rows if not r["height"] and not r["levels"])
n_roof = sum(1 for r in rows if r["btype"] == "roof")
n_min = sum(1 for r in rows if r["min_h"])
print("有 height: %d / 有 building:levels: %d / 两者都没有: %d"
      % (n_h, n_l, n_both_none))
print("building=roof(只有屋顶没有墙): %d / 带 min_height 或 building:min_level: %d"
      % (n_roof, n_min))
print("有名字: %d / 有 nycdoitt:bin: %d"
      % (sum(1 for r in rows if r["name"]), sum(1 for r in rows if r["bin"])))

if rels:
    print("-" * 100)
    print("building relation:")
    for r, t in rels:
        print("  id=%s type=%s building=%s height=%s levels=%s outer=%d"
              % (r.get("id"), t.get("type"), t.get("building", ""),
                 t.get("height", "-"), t.get("building:levels", "-"),
                 sum(1 for m in r.findall("member") if m.get("role") == "outer")))
