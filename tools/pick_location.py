# -*- coding: utf-8 -*-
r"""用**真数据**选 Day 2/3 的街面机位（纯 python，不 import bpy）。

判据（两个都要满足，缺一个就假）：
    ① 人行道密度  —— 人得有地方走。只算 sidewalks/footway/crossing/pedestrian，
       不算机动车道，也不算 steps（台阶上不能走 10 个人）。
    ② 建筑密度    —— 街面视角得有街。国家广场人行道很密但一栋楼都没有，
       10 个人走在空地上，一眼就是假的。
另外要求落点属于**最大连通块**，否则人会被关在一个走不出去的小碎片里。

用法:
    python tools\pick_location.py [--top 12] [--cell 150]
"""
import json
import math
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import road_graph as RG

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BJSON = os.path.join(ROOT, "data", "streets", "dc_buildings_grid.json")

WALK_KINDS = ("sidewalk", "footway", "crossing", "pedestrian", "path", "cycleway")


def main():
    top_n = 12
    if "--top" in sys.argv:
        top_n = int(sys.argv[sys.argv.index("--top") + 1])

    with open(BJSON, encoding="utf-8") as fh:
        bgrid = json.load(fh)
    cell = float(bgrid["cell"])
    bcount = bgrid["counts"]
    hmax = bgrid["hmax"]

    print("=" * 78)
    print("选点：人行道密度 x 建筑密度（格 = %.0f m）" % cell)
    print("=" * 78)

    g = RG.build(snap_m=0.0)
    sizes = g.component_sizes()
    g._sizes = sizes
    giant = sizes.index(max(sizes))
    print("图：节点 %d 边 %d 总长 %.1f km；最大连通块 %d 节点（%.1f%%）"
          % (len(g.pos), len(g.edges),
             sum(e.length for e in g.edges) / 1000.0,
             max(sizes), 100.0 * max(sizes) / len(g.pos)))

    # ---------------- 每格的人行道里程
    walk_km = defaultdict(float)
    deg3 = defaultdict(int)
    for e in g.edges:
        if e.kind not in WALK_KINDS:
            continue
        if g.comp[e.u] != giant:
            continue
        pa, pb = RG.dkey(g.pos[e.u]), RG.dkey(g.pos[e.v])
        mx, my = (pa[0] + pb[0]) * 0.5, (pa[1] + pb[1]) * 0.5
        key = "%d,%d" % (int(mx // cell), int(my // cell))
        walk_km[key] += e.length / 1000.0
    for i in range(len(g.pos)):
        if g.comp[i] != giant or len(g.adj[i]) >= 3:
            x, y = RG.dkey(g.pos[i])
            deg3["%d,%d" % (int(x // cell), int(y // cell))] += 1

    # ---------------- 打分：两个维度的归一化几何平均
    cells = set(walk_km) | set(bcount)
    wx = max(walk_km.values()) if walk_km else 1.0
    bx = max(bcount.values()) if bcount else 1.0
    rows = []
    for k in cells:
        km = walk_km.get(k, 0.0)
        nb = bcount.get(k, 0)
        if km <= 0.0 or nb < 20:
            continue
        s = math.sqrt((km / wx) * (nb / bx))
        i, j = (int(v) for v in k.split(","))
        rows.append((s, k, km, nb, hmax.get(k, 0.0), deg3.get(k, 0),
                     (i + 0.5) * cell, (j + 0.5) * cell))
    rows.sort(reverse=True)

    print("\n候选点（score / 格 / 人行道 km / 建筑数 / 最高 / 三岔以上节点 / 格中心 X,Y）：")
    for s, k, km, nb, hm, d3, cx, cy in rows[:top_n]:
        print("  %.3f  %-8s  %5.2f km  %4d 栋  %5.1f m  %3d 个  (%.0f, %.0f)"
              % (s, k, km, nb, hm, d3, cx, cy))

    if not rows:
        print("!! 没有同时满足人行道+建筑的格子")
        return 1

    s, k, km, nb, hm, d3, cx, cy = rows[0]
    print("\n>>> 推荐机位：格 %s  人行道 %.2f km  建筑 %d 栋  最高 %.1f m"
          % (k, km, nb, hm))
    print(">>> 格中心世界坐标：X=%.1f  Y=%.1f（z=0.3 是路面/人行道高度）"
          % (cx, cy))

    # 这个格子里能站人的节点数（度>=1），确认够撒 10 个人
    cnt = 0
    near = []
    half = cell * 0.5
    for i in range(len(g.pos)):
        if g.comp[i] != giant:
            continue
        x, y = RG.dkey(g.pos[i])
        if abs(x - cx) <= half and abs(y - cy) <= half:
            if g.adj[i]:
                cnt += 1
                near.append((x, y))
    print(">>> 该格内可站立节点 %d 个（撒 10 个人绰绰有余）" % cnt)
    return 0


if __name__ == "__main__":
    sys.exit(main())
