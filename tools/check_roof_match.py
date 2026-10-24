# -*- coding: utf-8 -*-
"""比较两种"OSM 建筑 <-> DCGIS 屋顶记录"匹配方式，并按建筑规模分档。

方式 A: 质心落在屋顶外接框内（当前 apply_dcgis_roofs.py 的做法）
方式 B: 外接框 IoU 最大且 >= 阈值（更严格，避免把小楼匹配到大楼的屋顶记录）

关键要回答: 被标成"坡顶"的建筑里，有多少是 >1000 m^2 的大楼？
（DC 市中心大楼主是联邦办公楼，坡顶扣到它们头上会显得更假。）

用法: python check_roof_match.py <输入.osm> <roofs.jsonl>
"""
import json
import math
import sys
import xml.etree.ElementTree as ET

CELL = 0.0005


def load_roofs(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            bb = d.get("bbox")
            if not bb:
                continue
            x0, y0, x1, y1 = (float(v) for v in bb)
            rows.append({
                "x0": min(x0, x1), "x1": max(x0, x1),
                "y0": min(y0, y1), "y1": max(y0, y1),
                "roof": d.get("roof") or "Unknown",
                "slope": float(d.get("slope") or 0.0),
                "h": float(d.get("h") or 0.0),
            })
    d = {}
    for r in rows:
        for cx in range(int(math.floor(r["x0"] / CELL)), int(math.floor(r["x1"] / CELL)) + 1):
            for cy in range(int(math.floor(r["y0"] / CELL)), int(math.floor(r["y1"] / CELL)) + 1):
                d.setdefault((cx, cy), []).append(r)
    return rows, d


def area_m2(lon0, lat0, lon1, lat1):
    return (abs(lon1 - lon0) * 111320.0 * math.cos(math.radians(lat0))) * \
           (abs(lat1 - lat0) * 110540.0)


def iou(a, b):
    ix0, iy0 = max(a["x0"], b["x0"]), max(a["y0"], b["y0"])
    ix1, iy1 = min(a["x1"], b["x1"]), min(a["y1"], b["y1"])
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    inter = (ix1 - ix0) * (iy1 - iy0)
    ua = (a["x1"] - a["x0"]) * (a["y1"] - a["y0"])
    ub = (b["x1"] - b["x0"]) * (b["y1"] - b["y0"])
    return inter / max(ua + ub - inter, 1e-18)


def candidates(grid, lon, lat):
    cx, cy = int(math.floor(lon / CELL)), int(math.floor(lat / CELL))
    out = set()
    for k in ((cx, cy), (cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1),
              (cx - 1, cy - 1), (cx + 1, cy - 1), (cx - 1, cy + 1), (cx + 1, cy + 1)):
        for r in grid.get(k, ()):
            out.add(id(r))
    byid = {}
    for k in ((cx, cy), (cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1),
              (cx - 1, cy - 1), (cx + 1, cy - 1), (cx - 1, cy + 1), (cx + 1, cy + 1)):
        for r in grid.get(k, ()):
            byid[id(r)] = r
    return list(byid.values())


def main():
    src, rpath = sys.argv[1], sys.argv[2]
    rows, grid = load_roofs(rpath)
    print("屋顶记录: %d 条" % len(rows))

    root = ET.parse(src).getroot()
    nodes = {n.get("id"): (float(n.get("lon")), float(n.get("lat")))
             for n in root.findall("node")}

    bands = [(0, 50), (50, 100), (100, 300), (300, 1000), (1000, 3000), (3000, 1e9)]
    for mode in ("A 质心包含", "B IoU>=0.3", "B IoU>=0.5"):
        per = {b: [0, 0] for b in bands}     # [坡顶, 总数]
        nmatch = ntot = 0
        for w in root.findall("way"):
            tags = {t.get("k"): t.get("v") for t in w.findall("tag")}
            if "building" not in tags:
                continue
            pts = [nodes[i] for i in (nd.get("ref") for nd in w.findall("nd")) if i in nodes]
            if len(pts) < 3:
                continue
            ntot += 1
            lon = sum(p[0] for p in pts) / len(pts)
            lat = sum(p[1] for p in pts) / len(pts)
            bb = {"x0": min(p[0] for p in pts), "x1": max(p[0] for p in pts),
                  "y0": min(p[1] for p in pts), "y1": max(p[1] for p in pts)}
            ab = area_m2(bb["x0"], lat, bb["x1"], bb["y1"])
            cands = candidates(grid, lon, lat)
            if not cands:
                continue
            if mode == "A 质心包含":
                hit = [r for r in cands if r["x0"] <= lon <= r["x1"] and r["y0"] <= lat <= r["y1"]]
                r = min(hit, key=lambda r: (r["x1"] - r["x0"]) * (r["y1"] - r["y0"])) if hit else None
            else:
                thr = 0.3 if "0.3" in mode else 0.5
                best = max(cands, key=lambda r: iou(bb, r))
                r = best if iou(bb, best) >= thr else None
            if r is None:
                continue
            nmatch += 1
            pitched = (r["roof"] in ("Saddle", "Combination", "Pyramid_Hip")) or \
                      (r["slope"] >= 2.0 and r["roof"] not in ("Butterfly", "Unknown", "Shed"))
            for b in bands:
                if b[0] <= ab < b[1]:
                    per[b][1] += 1
                    if pitched:
                        per[b][0] += 1
                    break

        print("\n=== %s ===" % mode)
        print("  匹配 %d / %d 栋 (%.1f%%)" % (nmatch, ntot, 100.0 * nmatch / ntot))
        print("  %-16s %7s %7s %7s" % ("建筑面积(m^2)", "总数", "坡顶", "坡顶占比"))
        for b in bands:
            n, t = per[b]
            if not t:
                continue
            print("  %-16s %7d %7d %6.1f%%"
                  % ("%d-%d" % (b[0], int(b[1]) if b[1] < 1e9 else 999999),
                     t, n, 100.0 * n / t))


main()
