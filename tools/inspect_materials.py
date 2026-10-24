# -*- coding: utf-8 -*-
"""查材质到底长什么样 —— 为什么渲染是全灰。"""
import sys

import bpy

path = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.open_mainfile(filepath=path)

print("=" * 80)
print("材质总数:", len(bpy.data.materials))
for m in list(bpy.data.materials)[:60]:
    dc = tuple(round(v, 3) for v in m.diffuse_color)
    print("  %-24s use_nodes=%-5s  diffuse=%s  users=%d" % (m.name, m.use_nodes, dc, m.users))
    if m.use_nodes and m.node_tree:
        for n in m.node_tree.nodes:
            if n.type == "BSDF_PRINCIPLED":
                bc = tuple(round(v, 3) for v in n.inputs["Base Color"].default_value)
                print("        Principled base=%s" % (bc,))

# 抽查一个建筑物体，看它的材质槽
print()
print("--- 建筑物体材质检查 ---")
n = 0
for o in bpy.data.objects:
    if o.type != "MESH":
        continue
    zs = [c.z for c in o.bound_box]
    if max(zs) - min(zs) < 2:
        continue
    mats = [s.material.name if s.material else None for s in o.material_slots]
    print("  %-46s slots=%s" % (o.name[:46], mats))
    n += 1
    if n >= 12:
        break
