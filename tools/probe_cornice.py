# -*- coding: utf-8 -*-
r"""只读探针：查"屋檐（檐口）与屋顶是不是共面打架"，以及檐口用了哪个材质。

背景（为什么怀疑这里）：
    tools\add_dc_features.py 把檐口方块的中心放在 `maxz - CORNICE_H/2`，
    也就是檐口**顶面正好在楼体最高处 maxz**。而楼体自己的**屋顶面也在 maxz**。
    两个面完全共面 -> 渲染时 z-fighting（闪、锯齿）。
    同时檐口写进了 `wall_slot`（外墙材质），而屋顶面用的是屋顶材质 ->
    屋顶边缘会突然出现一圈"外墙砖纹"，这就是"屋顶看着奇怪"的头号嫌疑。

做法：随机抽 N 栋"有 2 个以上材质槽"的建筑，取出所有位于 maxz 附近的面，
      打印它们的法线朝向和材质名。

**只读**，不保存。

用法:
    D:\\blender\\blender.exe --background --python tools\\probe_cornice.py -- <blend> [抽样栋数]
"""
import os
import sys
from collections import Counter

import bpy

EPS = 0.02          # z 容差（米）


def log(m):
    print("[cor] %s" % m, flush=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not argv:
        print(__doc__)
        return 1
    n_target = int(argv[1]) if len(argv) > 1 else 8
    bpy.ops.wm.open_mainfile(filepath=os.path.abspath(argv[0]))
    log("打开 %s" % os.path.basename(argv[0]))

    rows = []
    stat = Counter()
    for o in bpy.data.objects:
        if o.type != "MESH" or not o.data or len(o.material_slots) < 2:
            continue
        me = o.data
        mw = o.matrix_world
        m3 = mw.to_3x3()
        zs = [(mw @ v.co).z for v in me.vertices]
        if not zs:
            continue
        zmax = max(zs)
        zmin = min(zs)
        top = []
        for p in me.polygons:
            c = mw @ p.center
            if abs(c.z - zmax) <= EPS:
                top.append(p)
        if not top:
            continue
        up = [p for p in top if (m3 @ p.normal).normalized().z > 0.9]
        slot_names = [s.material.name if s.material else "(无)" for s in o.material_slots]
        mats = Counter(slot_names[p.material_index] if p.material_index < len(slot_names)
                       else "(越界)" for p in up)
        stat["检查的楼"] += 1
        if len(up) > 1:
            stat["maxz 处有多个朝上的面（共面嫌疑）"] += 1
        km = list(mats)
        if any(k.startswith("tex_roof") for k in km):
            stat["顶面含屋顶材质"] += 1
        if any(k.startswith("tex_wall") for k in km):
            stat["顶面含外墙材质"] += 1
        if len(rows) < n_target:
            rows.append((o.name, zmax - zmin, len(me.polygons), slot_names, len(top), len(up), dict(mats)))

    log("=" * 72)
    log("抽样结果（每栋：高 / 面数 / 材质槽 / maxz 处的面数 / 朝上的面数 / 这些面的材质）")
    for name, h, nf, sn, nt, nu, mm in rows:
        log("   %-28s 高%5.1f m  %4d 面" % (name, h, nf))
        log("      材质槽: %s" % sn)
        log("      z=maxz 处 %d 个面，其中朝上 %d 个 -> %s" % (nt, nu, mm))
    log("=" * 72)
    log("统计（共 %d 栋多槽建筑）" % stat["检查的楼"])
    for k in ("maxz 处有多个朝上的面（共面嫌疑）", "顶面含屋顶材质", "顶面含外墙材质"):
        log("   %-36s %6d 栋" % (k, stat[k]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
