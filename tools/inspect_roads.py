# -*- coding: utf-8 -*-
r"""Day 2.1 侦察（**只读**，不保存场景）：out\dc_real3_clean.blend 里的道路 CURVE 长什么样。

要回答四件事，全部给可核对的数字：
  1. 24,673 条曲线是不是「一条 way = 一个对象」？每个对象几条样条、多少控制点？
  2. 路是不是平的（z 是否常数）？这决定人行道能不能直接在 XY 上做偏移。
  3. 对象上有没有 OSM 标签（lanes / maxspeed / highway）？
     没有标签就没有「边带车道数/限速」，计划表 2.1 的验收标准只能换等价指标。
  4. 物体名前缀直方图 + 含 footway/sidewalk 的条数 —— 直接回答 2.2。

用法:
    blender --background --python tools\inspect_roads.py
"""
import traceback
from collections import Counter

import bpy
from mathutils import Vector

SRC = "D:/Users/asus/Desktop/项目/out/dc_real3_clean.blend"

bpy.ops.wm.open_mainfile(filepath=SRC)

objs = list(bpy.data.objects)
print("[recon] 物体总数 %d" % len(objs))
print("[recon] 按类型 %s" % sorted(Counter(o.type for o in objs).items()))

curves = [o for o in objs if o.type == "CURVE"]
meshes = [o for o in objs if o.type == "MESH"]
print("[recon] CURVE %d / MESH %d" % (len(curves), len(meshes)))


def prefix(name):
    for ch in ("_", ".", " "):
        if ch in name:
            head = name.split(ch)[0]
            if head:
                return head
    return name


print("[recon] 曲线名前缀 TOP20：")
for k, v in Counter(prefix(o.name) for o in curves).most_common(20):
    print("          %-34s %6d" % (k, v))

print("[recon] 全名样例（前 12 条 + 名字含 element 的前 6 条）：")
for o in curves[:12]:
    print("          %s" % o.name)
els = [o.name for o in curves if o.name.startswith("element")][:6]
for nm in els:
    print("          [element] %s" % nm)

# ---------------------------------------------------------------- 曲线结构
n_2d = n_3d = 0
n_spline_hist = Counter()
n_points_hist = Counter()
tot_points = 0
zmin_all, zmax_all = 1e18, -1e18
zspan_per = []
bevel_modes = Counter()
bevel_objs = Counter()
extrude_hist = Counter()
offset_hist = Counter()
res_u_hist = Counter()
spline_types = Counter()
attrs_hist = Counter()
tag_keys = Counter()
sample_tags = []
n_bevel_depth = Counter()
fill_hist = Counter()
err = 0

for o in curves:
    try:
        d = o.data
        if d is None:
            continue
        if getattr(d, "dimensions", "?") == "2D":
            n_2d += 1
        else:
            n_3d += 1
        n_spline_hist[len(d.splines)] += 1
        mw = o.matrix_world
        pts = 0
        zmn, zmx = 1e18, -1e18
        for sp in d.splines:
            spline_types[sp.type] += 1
            if sp.type == "BEZIER":
                seq = [bp.co for bp in sp.bezier_points]
            else:
                seq = [p.co for p in sp.points]
            pts += len(seq)
            for co in seq:
                w = mw @ co
                if w.z < zmn:
                    zmn = w.z
                if w.z > zmx:
                    zmx = w.z
        tot_points += pts
        n_points_hist[pts // 10 * 10] += 1
        if zmn < 1e17:
            zmin_all = min(zmin_all, zmn)
            zmax_all = max(zmax_all, zmx)
            zspan_per.append(zmx - zmn)
        bevel_modes[getattr(d, "bevel_mode", "?")] += 1
        if getattr(d, "bevel_object", None) is not None:
            bevel_objs[d.bevel_object.name] += 1
        extrude_hist[round(getattr(d, "extrude", 0.0), 3)] += 1
        offset_hist[round(getattr(d, "offset", 0.0), 3)] += 1
        res_u_hist[getattr(d, "resolution_u", -1)] += 1
        n_bevel_depth[round(getattr(d, "bevel_depth", 0.0), 3)] += 1
        fill_hist[getattr(d, "fill_mode", "?")] += 1
        attrs_hist[tuple(sorted(o.keys()))] += 1
        for k in o.keys():
            tag_keys[k] += 1
        if len(sample_tags) < 6:
            sample_tags.append((o.name, {k: str(o[k])[:44] for k in o.keys()}))
    except Exception:
        err += 1
        if err <= 3:
            print("[recon] !! 处理 %s 出错 %s" % (o.name, traceback.format_exc().splitlines()[-1]))

print("[recon] 维度 2D=%d 3D=%d（异常 %d 条）" % (n_2d, n_3d, err))
print("[recon] 每对象样条数直方图 %s" % sorted(n_spline_hist.items())[:15])
print("[recon] 控制点总数 %d，平均 %.2f 点/条" % (tot_points, tot_points / max(1, len(curves))))
print("[recon] 控制点数分桶(//10*10) %s" % sorted(n_points_hist.items())[:20])
print("[recon] 全部控制点世界 Z 范围 %.3f ~ %.3f" % (zmin_all, zmax_all))
if zspan_per:
    flat = sum(1 for s in zspan_per if s < 1e-4)
    srt = sorted(zspan_per)
    print("[recon] 自 z 跨度<0.1mm 的条数 %d/%d；中位 %.4f 最大 %.4f"
          % (flat, len(zspan_per), srt[len(srt) // 2], srt[-1]))
print("[recon] 样条类型 %s" % sorted(spline_types.items()))
print("[recon] bevel_mode %s" % sorted(bevel_modes.items()))
print("[recon] bevel_object 引用 %s" % bevel_objs.most_common(5))
print("[recon] bevel_depth %s" % sorted(n_bevel_depth.items())[:8])
print("[recon] extrude %s" % sorted(extrude_hist.items())[:8])
print("[recon] offset %s" % sorted(offset_hist.items())[:8])
print("[recon] resolution_u %s" % sorted(res_u_hist.items())[:8])
print("[recon] fill_mode %s" % sorted(fill_hist.items()))

print("[recon] 自定义属性组合 TOP10:")
for combo, cnt in attrs_hist.most_common(10):
    print("          %-56s %6d" % (str(combo)[:56], cnt))
print("[recon] 自定义属性键频次 TOP40:")
for k, v in tag_keys.most_common(40):
    print("          %-28s %6d" % (k, v))
print("[recon] 标签样例:")
for nm, kv in sample_tags:
    print("          %-26s %s" % (nm[:26], kv))

# ---------------------------------------------------------------- 建筑与地面
zs = []
for o in meshes[:3000]:
    mw = o.matrix_world
    for c in o.bound_box:
        zs.append((mw @ Vector(c)).z)
if zs:
    print("[recon] 抽样 3000 个 MESH 的世界 Z 范围 %.2f ~ %.2f" % (min(zs), max(zs)))

# ---------------------------------------------------------------- 人行道专查
for key in ("footway", "sidewalk", "cycleway", "path", "pedestrian", "steps"):
    hit = [o.name for o in curves if key in o.name.lower()]
    print("[recon] 名字含 %-10s 的曲线：%d 条  %s"
          % (key, len(hit), hit[:3]))

print("[recon] 结束")
