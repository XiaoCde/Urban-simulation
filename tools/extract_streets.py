# -*- coding: utf-8 -*-
r"""Day 2.1 Step 1 —— 把 out\dc_real3_clean.blend 里的 24,673 条道路/人行道曲线
连同**物体级 OSM 标签**一次性导出成纯数据文件（**只读 blend，不保存**）。

为什么要有这一步：
    计划表的硬规矩是「ped_fsm / ped_sim 不 import bpy」。拓扑、寻路、人行道
    偏移都是纯算法，如果直接在 Blender 里写，就没法单测、也没法几秒钟重跑一遍。
    所以把 bpy 的活压缩到最小：**只做「读曲线 -> 写文件」这一件事**，
    后面所有几何/图论/寻路全部在纯 python 里做。

输出：data\streets\dc_streets.json
    {
      "crs": "本地米制，与 blend 世界坐标一致",
      "profiles": {剖面名: [[x, y], ...]},          # 断面模板（决定路的宽度/路缘高度）
      "ways": [                                      # 一条 way = 一个对象（已实测 1:1）
        {"id": OSM way id, "name": ..., "h": highway 值, "f": footway 值,
         "prof": 引用的剖面名, "z": 该对象控制点的世界 Z,
         "lanes": ..., "maxspeed": ..., "surface": ..., "oneway": ...,
         "sw_l": sidewalk:left, "sw_r": sidewalk:right, "sw_b": sidewalk:both,
         "cross": crossing 值, "pts": [[x, y], ...]}
      ]
    }

用法:
    blender --background --python tools\extract_streets.py
"""
import json
import os
from collections import Counter

import bpy

SRC = "D:/Users/asus/Desktop/项目/out/dc_real3_clean.blend"
OUT = "D:/Users/asus/Desktop/项目/data/streets/dc_streets.json"

# 对象级 OSM 标签 -> 输出字段名（只挑拓扑/导航真正用得到的，别把 40 个 tiger:* 全搬走）
KEYMAP = {
    "id": "id",
    "name": "name",
    "highway": "h",
    "footway": "f",
    "crossing": "cross",
    "lanes": "lanes",
    "maxspeed": "maxspeed",
    "surface": "surface",
    "oneway": "oneway",
    "sidewalk:left": "sw_l",
    "sidewalk:right": "sw_r",
    "sidewalk:both": "sw_b",
    "sidewalk": "sw",
    "service": "service",
    "access": "access",
    "bicycle": "bicycle",
    "lit": "lit",
    "HFCS": "hfcs",
    "bridge": "bridge",
    "tunnel": "tunnel",
}

bpy.ops.wm.open_mainfile(filepath=SRC)

curves = [o for o in bpy.data.objects if o.type == "CURVE"]
print("[extract] CURVE 对象 %d" % len(curves))

profiles = {}
ways = []
n_prof = 0
skipped = 0

for o in curves:
    d = o.data
    if d is None:
        skipped += 1
        continue

    # ---- 剖面模板对象（名字 profile_*）：它自己不是路，是别人引用的断面 ----
    if o.name.startswith("profile_"):
        n_prof += 1
        pts = []
        for sp in d.splines:
            if sp.type == "BEZIER":
                pts.extend([tuple(round(v, 4) for v in bp.co[:2]) for bp in sp.bezier_points])
            else:
                pts.extend([tuple(round(v, 4) for v in p.co[:2]) for p in sp.points])
        profiles[o.name] = pts
        continue

    mw = o.matrix_world
    pts = []
    zs = []
    for sp in d.splines:
        if sp.type == "BEZIER":
            seq = [bp.co for bp in sp.bezier_points]
        else:
            seq = [p.co for p in sp.points]
        for co in seq:
            w = mw @ co
            pts.append([round(w.x, 4), round(w.y, 4)])
            zs.append(w.z)
    if len(pts) < 2:
        skipped += 1
        continue

    rec = {"z": round(sum(zs) / len(zs), 4), "pts": pts}
    if d.bevel_object is not None:
        rec["prof"] = d.bevel_object.name
    for src_key, dst_key in KEYMAP.items():
        if src_key in o.keys():
            rec[dst_key] = o[src_key]
    ways.append(rec)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
blob = {
    "source": SRC,
    "profiles": profiles,
    "ways": ways,
}
with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(blob, fh, ensure_ascii=False, separators=(",", ":"))

size = os.path.getsize(OUT)
print("[extract] 剖面模板 %d 个，道路/人行道 way %d 条，跳过 %d 条"
      % (len(profiles), len(ways), skipped))
print("[extract] 写出 %s（%.1f MB）" % (OUT, size / 1048576.0))

# ---------------------------------------------------------------- 摘要（给人看的）
print("[extract] 剖面名 -> 控制点数（前 12）")
for k, v in sorted(profiles.items(), key=lambda kv: -len(kv[1]))[:12]:
    xs = [p[0] for p in v]
    ys = [p[1] for p in v]
    print("          %-28s %3d 点  x %7.3f~%7.3f  y %6.3f~%6.3f"
          % (k, len(v), min(xs), max(xs), min(ys), max(ys)))

print("[extract] highway 值分布：")
for k, v in Counter(w.get("h", "(无)") for w in ways).most_common(25):
    print("          %-22s %6d" % (k, v))

print("[extract] footway 值分布：")
for k, v in Counter(w.get("f", "(无)") for w in ways).most_common(15):
    print("          %-22s %6d" % (k, v))

# 关键判据：可步行网络的规模 —— 决定 Day 2 能不能直接用人行道真几何
WALK_H = {"footway", "path", "pedestrian", "steps", "cycleway", "crossing",
          "living_street", "track", "service"}
walk = [w for w in ways if w.get("h") in WALK_H]
print("[extract] 可步行候选（highway in %s）= %d 条" % (sorted(WALK_H), len(walk)))
print("[extract]   其中带 footway=* 的 = %d 条"
      % len([w for w in walk if w.get("f")]))
print("[extract]   其中带 crossing=* 的 = %d 条"
      % len([w for w in walk if w.get("cross")]))
for prof_name in sorted(set(w.get("prof", "") for w in walk)):
    n = len([w for w in walk if w.get("prof") == prof_name])
    print("[extract]   剖面 %-28s %6d 条" % (prof_name, n))
print("[extract] 有 lanes 的 way %d 条 / 有 maxspeed 的 %d 条 / 有 name 的 %d 条"
      % (len([w for w in ways if w.get("lanes")]),
         len([w for w in ways if w.get("maxspeed")]),
         len([w for w in ways if w.get("name")])))
print("[extract] z 值分布（前 10）%s"
      % Counter(round(w["z"], 3) for w in ways).most_common(10))
print("[extract] 结束")
