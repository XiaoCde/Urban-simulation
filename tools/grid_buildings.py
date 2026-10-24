# -*- coding: utf-8 -*-
r"""Day 3.1 的前置：用**真数据**选街面机位所在的街区（Blender 只负责数建筑，只读）。

为什么要单独数建筑：
    只按"人行道里程最密"选点会选到国家广场 —— 那里人行道很密但**一栋楼都没有**，
    10 个人走在空地上，一眼就是假的。计划表 §四 的原则是"人数必须和地点相称"，
    所以判据必须是 **人行道密度 + 建筑密度** 两个都被满足。
    建筑在 blend 里、人行道在 dc_streets.json 里，两边分开算，再在纯 python 里合。

输出：data\streets\dc_buildings_grid.json
    {"cell": 150.0,
     "counts": {"i,j": 建筑数},
     "hmax":   {"i,j": 该格最高建筑（米）},
     "htot":   {"i,j": 该格高度之和（米）}}

用法:
    blender --background --python tools\grid_buildings.py
"""
import json
import os
from collections import defaultdict

import bpy
from mathutils import Vector

SRC = "D:/Users/asus/Desktop/项目/out/dc_real3_clean.blend"
OUT = "D:/Users/asus/Desktop/项目/data/streets/dc_buildings_grid.json"
CELL = 150.0

bpy.ops.wm.open_mainfile(filepath=SRC)

meshes = [o for o in bpy.data.objects if o.type == "MESH"]
print("[grid] MESH 物体 %d" % len(meshes))

counts = defaultdict(int)
hmax = defaultdict(float)
htot = defaultdict(float)
n_used = 0
skipped = 0

for o in meshes:
    try:
        mw = o.matrix_world
        cs = [mw @ Vector(c) for c in o.bound_box]
        zs = [c.z for c in cs]
        h = max(zs) - min(zs)
        # 地面是巨大的薄板（z 跨度≈0），不是建筑，别把它算进密度
        if h < 2.0:
            skipped += 1
            continue
        cx = sum(c.x for c in cs) / 8.0
        cy = sum(c.y for c in cs) / 8.0
        key = "%d,%d" % (int(cx // CELL), int(cy // CELL))
        counts[key] += 1
        htot[key] += h
        if h > hmax[key]:
            hmax[key] = h
        n_used += 1
    except Exception:
        skipped += 1

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as fh:
    json.dump({"cell": CELL,
               "counts": counts,
               "hmax": {k: round(v, 2) for k, v in hmax.items()},
               "htot": {k: round(v, 1) for k, v in htot.items()}},
              fh, ensure_ascii=False, separators=(",", ":"))

print("[grid] 计入建筑 %d 个（跳过薄板/异常 %d 个），占用格子 %d 个"
      % (n_used, skipped, len(counts)))
print("[grid] 写出 %s（%.2f MB）"
      % (OUT, os.path.getsize(OUT) / 1048576.0))
top = sorted(counts.items(), key=lambda kv: -kv[1])[:12]
print("[grid] 建筑最密的 12 格（i,j -> 建筑数 / 最高 / 高度和）：")
for k, v in top:
    print("          %-12s %4d 栋  最高 %6.1f m  高度和 %8.1f m"
          % (k, v, hmax[k], htot[k]))
print("[grid] 结束")
