# -*- coding: utf-8 -*-
"""查清"整城地面为什么是绿的"——先量，不猜。

要回答三个问题：
  1. 现在的"地面"到底是几个物体？哪个物体最大？
  2. 绿（grass）材质摊在哪些物体上、总面积多少？
  3. OSM 真实的公园/草地多边形（vegetation）是不是独立物体、面积多少？

用法:
    D:\\blender\\blender.exe --background --python tools\\probe_ground.py -- <blend>
"""
import os
import sys
from collections import defaultdict

import bpy
from mathutils import Vector


def log(m):
    print("[gnd] %s" % m, flush=True)


def stats():
    """(material_name -> (物体数, 总面积 m^2))，面积用 XY 包围盒。"""
    by_mat = defaultdict(lambda: [0, 0.0])
    objs = []
    for o in bpy.data.objects:
        if o.type != "MESH" or o.data is None or not o.material_slots:
            continue
        mw = o.matrix_world
        cs = [mw @ Vector(c) for c in o.bound_box]
        xs = [c.x for c in cs]
        ys = [c.y for c in cs]
        a = max(0.0, max(xs) - min(xs)) * max(0.0, max(ys) - min(ys))
        names = [s.material.name if s.material else "(空)" for s in o.material_slots]
        key = names[0]
        by_mat[key][0] += 1
        by_mat[key][1] += a
        objs.append((a, o.name, key, len(o.data.polygons)))
    return by_mat, objs


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not argv:
        print(__doc__)
        return 1
    p = os.path.abspath(argv[0])
    bpy.ops.wm.open_mainfile(filepath=p)
    log("载入 %s（物体 %d）" % (os.path.basename(p), len(bpy.data.objects)))

    by_mat, objs = stats()
    total = sum(v[1] for v in by_mat.values())
    log("MESH 材质占用面积合计 %.1f km^2" % (total / 1e6))

    log("---- 按面积排序的材质（前 16）----")
    for k, (n, a) in sorted(by_mat.items(), key=lambda kv: -kv[1][1])[:16]:
        log("   %-30s 物体 %6d   面积 %8.3f km^2  占比 %5.1f%%"
            % (k[:30], n, a / 1e6, 100.0 * a / max(total, 1)))

    log("---- 单个面积最大的 12 个物体（这些就是'地面/底板'）----")
    for a, name, key, npoly in sorted(objs, key=lambda t: -t[0])[:12]:
        log("   %-26s %10.3f km^2  %5d 面  %s" % (name[:26], a / 1e6, npoly, key[:34]))

    log("---- 所有名字含 ground/grass/terrain 的物体 ----")
    for o in bpy.data.objects:
        ln = o.name.lower()
        if any(k in ln for k in ("ground", "grass", "terrain", "floor")):
            ms = ",".join(s.material.name if s.material else "-" for s in o.material_slots)
            log("   %-34s %-8s %s" % (o.name[:34], o.type, ms[:50]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
