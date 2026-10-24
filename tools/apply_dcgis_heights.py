# -*- coding: utf-8 -*-
"""把 DCGIS 的真实建筑高度写回 .osm 的 height 标签。

逻辑:
  1. 读 fetch_dcgis_heights.py 产出的 .jsonl（每行一栋楼，含 maxz 与 WGS84 外接框）
  2. 流式解析 .osm，对每条 building way / relation 算质心（WGS84）
  3. 用网格索引找落在该质心上的 DCGIS 外接框，命中则写 height=MAX_Z
  4. 输出新 .osm（原文件不动），并打印统计

为什么以 MAX_Z 为准:
  blosm 的 building/roof/__init__.py:156 getHeight() 优先读 height 标签，
  有 height 就不再用随机层数 → 一次修复"83% 无高度"与"63% 被标成 house 导致矮化"。

用法:
  python apply_dcgis_heights.py <输入.osm> <heights.jsonl> <输出.osm>
"""
import json
import math
import os
import sys
import xml.etree.ElementTree as ET

# 合理性区间：低于 2 m 的当作噪声/遮蔽，高于 400 m 的当作异常
MIN_OK, MAX_OK = 2.0, 400.0


def load_heights(path):
    rows = []
    bad = 0
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            bb = d.get("bbox")
            mz = d.get("maxz")
            if not bb or mz is None:
                bad += 1
                continue
            if not (MIN_OK <= mz <= MAX_OK):
                bad += 1
                continue
            rows.append((bb[0], bb[1], bb[2], bb[3], float(mz)))
    print("读入高度记录: %d 条可用, %d 条丢弃(无bbox/遮蔽/异常)" % (len(rows), bad))
    return rows


class Grid:
    """按经纬度格子索引外接框，查询一个点时返回覆盖它的所有框。"""

    def __init__(self, rows, cell=0.0005):
        self.cell = cell
        self.d = {}
        for x0, y0, x1, y1, mz in rows:
            for cx in range(int(math.floor(x0 / cell)), int(math.floor(x1 / cell)) + 1):
                for cy in range(int(math.floor(y0 / cell)), int(math.floor(y1 / cell)) + 1):
                    self.d.setdefault((cx, cy), []).append((x0, y0, x1, y1, mz))

    def find(self, lon, lat, expand=0.0):
        """返回覆盖该点的框；expand 允许质心略微偏出（米级误差）。"""
        cx, cy = int(math.floor(lon / self.cell)), int(math.floor(lat / self.cell))
        out = []
        for k in ((cx, cy), (cx - 1, cy), (cx + 1, cy),
                  (cx, cy - 1), (cx, cy + 1),
                  (cx - 1, cy - 1), (cx + 1, cy - 1),
                  (cx - 1, cy + 1), (cx + 1, cy + 1)):
            for cand in self.d.get(k, ()):
                x0, y0, x1, y1, mz = cand
                if (x0 - expand) <= lon <= (x1 + expand) and \
                   (y0 - expand) <= lat <= (y1 + expand):
                    out.append(mz)
        return out


def parse(path):
    """流式解析 .osm，返回 nodes dict 与 ways/relations 列表。"""
    nodes = {}
    ways = []       # (way_element, [node ids])
    rels = []
    for event, el in ET.iterparse(path, events=("end",)):
        if el.tag == "node":
            nodes[el.get("id")] = (float(el.get("lon")), float(el.get("lat")))
            el.clear()
        elif el.tag == "way":
            ids = [nd.get("ref") for nd in el.findall("nd")]
            tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
            ways.append((el, ids, tags))
        elif el.tag == "relation":
            members = [(m.get("type"), m.get("ref"), m.get("role"))
                       for m in el.findall("member")]
            tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
            rels.append((el, members, tags))
    return nodes, ways, rels


def centroid(ids, nodes):
    pts = [nodes[i] for i in ids if i in nodes]
    if not pts:
        return None
    return (sum(p[0] for p in pts) / len(pts),
            sum(p[1] for p in pts) / len(pts))


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        return
    src, hpath, dst = sys.argv[1], sys.argv[2], sys.argv[3]

    rows = load_heights(hpath)
    grid = Grid(rows)

    tree = ET.parse(src)
    root = tree.getroot()
    ways = root.findall("way")
    rels = root.findall("relation")

    nodes = {}
    for n in root.findall("node"):
        nodes[n.get("id")] = (float(n.get("lon")), float(n.get("lat")))

    # 1) 建筑 way
    n_bld = n_hit = n_skipped_has = 0
    for w in ways:
        tags = {t.get("k"): t.get("v") for t in w.findall("tag")}
        if "building" not in tags:
            continue
        n_bld += 1
        if "height" in tags:
            n_skipped_has += 1
            continue
        c = centroid([nd.get("ref") for nd in w.findall("nd")], nodes)
        if c is None:
            continue
        hits = grid.find(c[0], c[1])
        if not hits:
            hits = grid.find(c[0], c[1], expand=0.00005)   # 放宽约 5 m
        if hits:
            h = max(hits)      # 一栋楼落在多个框里时取最高
            ET.SubElement(w, "tag", {"k": "height", "v": "%.2f" % h})
            n_hit += 1

    # 2) 建筑 relation（multipolygon）
    n_rel = n_rel_hit = 0
    way_ids_by_rel = {}
    for r in rels:
        tags = {t.get("k"): t.get("v") for t in r.findall("tag")}
        if "building" not in tags:
            continue
        n_rel += 1
        if "height" in tags:
            continue
        ids = [m.get("ref") for m in r.findall("member")
               if m.get("type") == "way"]
        c = centroid(ids, nodes)
        if c is None:
            continue
        hits = grid.find(c[0], c[1])
        if not hits:
            hits = grid.find(c[0], c[1], expand=0.00005)
        if hits:
            ET.SubElement(r, "tag", {"k": "height", "v": "%.2f" % max(hits)})
            n_rel_hit += 1

    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    tree.write(dst, encoding="utf-8", xml_declaration=True)

    print()
    print("=" * 70)
    print("建筑 way : 共 %d 栋，原本已有 height %d 栋，本次补上 %d 栋，仍缺 %d 栋"
          % (n_bld, n_skipped_has, n_hit, n_bld - n_skipped_has - n_hit))
    print("建筑 rel : 共 %d 个，本次补上 %d 个" % (n_rel, n_rel_hit))
    print("输出     : %s (%.1f MB)"
          % (dst, os.path.getsize(dst) / 1048576.0))
    covered = n_skipped_has + n_hit + n_rel_hit
    total = n_bld + n_rel
    print("高度覆盖率: %d / %d = %.1f%%"
          % (covered, total, 100.0 * covered / max(total, 1)))


main()
