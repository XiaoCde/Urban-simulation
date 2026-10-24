# -*- coding: utf-8 -*-
r"""只读探针：掀开一栋楼看它的面结构 —— 屋顶到底在哪、用的什么材质、墙顶在哪。

为什么必须先看这个：
    第 1 档要给檐口换材质、把檐口顶面沉到屋顶以下，就必须知道
    **"楼体最高处"到底是屋脊还是檐口**。blosm 的楼是一个 mesh 里含屋顶，
    如果 maxz 是屋脊，那我把檐口放在 maxz 就会**悬在屋顶斜坡上方**，
    那不是"屋顶怪"，那是"房子顶上一根浮空的砖条"。

**只读**，不保存。

用法:
    D:\blender\blender.exe --background --python tools\probe_building.py -- <blend> [抽样栋数]
"""
import os
import sys
from collections import Counter, defaultdict

import bpy

SHORT = (5.0, 15.0)      # ① 的连排屋候选高度区间


def log(m):
    print("[pb] %s" % m, flush=True)


def face_info(o):
    """把物体所有面归纳成 (法线朝向, z 区间, 材质名) 的统计。"""
    me = o.data
    mw = o.matrix_world
    m3 = mw.to_3x3()
    slots = [s.material.name if s.material else "(无)" for s in o.material_slots]
    buckets = defaultdict(lambda: [0, 0.0, 1e9, -1e9])   # key -> [面数, 面积和, zmin, zmax]
    for p in me.polygons:
        n = (m3 @ p.normal).normalized()
        if abs(n.z) > 0.85:
            d = "水平(顶/底)"
        elif n.z > 0.15:
            d = "斜坡朝上"
        elif n.z < -0.15:
            d = "斜坡朝下"
        else:
            d = "竖直(墙)"
        nm = slots[p.material_index] if p.material_index < len(slots) else "(越界)"
        z = [((mw @ me.vertices[i].co).z) for i in p.vertices]
        k = (d, nm)
        b = buckets[k]
        b[0] += 1
        b[1] += p.area
        b[2] = min(b[2], min(z))
        b[3] = max(b[3], max(z))
    zs = [(mw @ v.co).z for v in me.vertices]
    return min(zs), max(zs), buckets


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not argv:
        print(__doc__)
        return 1
    n = int(argv[1]) if len(argv) > 1 else 6
    bpy.ops.wm.open_mainfile(filepath=os.path.abspath(argv[0]))
    log("打开 %s" % os.path.basename(argv[0]))

    # ---- 1. 抽样连排屋，摊开面结构 ----
    log("=" * 74)
    log("1) 抽样 %d 栋【连排屋高度区间 %.0f-%.0f m】的楼，摊开面结构" % (n, SHORT[0], SHORT[1]))
    shown = 0
    for o in bpy.data.objects:
        if shown >= n:
            break
        if o.type != "MESH" or not o.data or len(o.data.polygons) > 400:
            continue
        z0, z1, bk = face_info(o)
        h = z1 - z0
        if not (SHORT[0] <= h <= SHORT[1]):
            continue
        log("")
        log("   %-34s 高 %.1f m   z %.2f ~ %.2f   共 %d 面" % (o.name, h, z0, z1, len(o.data.polygons)))
        for (d, nm), (c, a, za, zb) in sorted(bk.items(), key=lambda kv: -kv[1][1]):
            log("      %-10s %-36s %3d 面 %8.1f m2  z %.2f~%.2f"
                % (d, nm, c, a, za, zb))
        shown += 1

    # ---- 2. 屋顶材质到底铺在哪些面上（用更宽的判定：|n.z|>0.5 算屋顶）----
    log("=" * 74)
    log("2) 屋顶材质铺在什么上面（判定阈值放宽到与水平面夹角 <60 度）")
    stat = Counter()
    roofsolid = Counter()
    for o in bpy.data.objects:
        if o.type != "MESH" or not o.data or not o.material_slots:
            continue
        me = o.data
        m3 = o.matrix_world.to_3x3()
        slots = [s.material.name if s.material else "" for s in o.material_slots]
        hasroof = any(s.startswith("tex_roof") for s in slots)
        topfaces = []
        for p in me.polygons:
            nz = (m3 @ p.normal).normalized().z
            if nz > 0.5:
                topfaces.append(p)
        if not topfaces:
            continue
        zs = [(o.matrix_world @ v.co).z for v in me.vertices]
        zmax = max(zs) if zs else 0
        h = (zmax - min(zs)) if zs else 0
        bucket = "低层(<15m)" if h < 15 else ("中层(15-35m)" if h < 35 else "高层(>=35m)")
        topmats = Counter(slots[p.material_index] if p.material_index < len(slots) else "?" for p in topfaces)
        kind = next(iter(topmats))
        if hasroof:
            stat["有屋顶材质槽的楼"] += 1
        else:
            stat["无屋顶材质槽的楼"] += 1
            roofsolid[(bucket, kind)] += 1
    for k, v in stat.items():
        log("   %-24s %6d 栋" % (k, v))
    log("   --- 没有屋顶材质槽的楼，它们的顶面用的是什么：")
    for (b, m), c in sorted(roofsolid.items(), key=lambda kv: -kv[1])[:14]:
        log("      %-14s %-38s %6d 栋" % (b, m, c))
    return 0


if __name__ == "__main__":
    sys.exit(main())
