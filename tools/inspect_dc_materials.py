# -*- coding: utf-8 -*-
"""看 DC 那版 .blend 里到底有哪些材质、什么颜色、Z 分布如何。

    D:\blender\blender.exe --background --python tools\inspect_dc_materials.py -- <blend>
"""
import os
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
BLEND = argv[0] if argv else r"D:\Users\asus\Desktop\项目\out\dc_downtown_v2.blend"

bpy.ops.wm.open_mainfile(filepath=BLEND)
print("[open] %s" % BLEND)

print("=" * 80)
print("材质总数: %d" % len(bpy.data.materials))
for m in bpy.data.materials:
    c = m.diffuse_color
    bsdf = None
    base = None
    if m.use_nodes and m.node_tree:
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            base = tuple(round(x, 3) for x in bsdf.inputs["Base Color"].default_value)
    print("  %-28s diffuse=(%.3f,%.3f,%.3f)  principled=%s"
          % (m.name, c[0], c[1], c[2], base))

print("=" * 80)
print("物体类型统计:")
kinds = {}
for o in bpy.data.objects:
    kinds[o.type] = kinds.get(o.type, 0) + 1
print("  %s" % kinds)

print("=" * 80)
print("材质用量 Top 25:")
usage = {}
for o in bpy.data.objects:
    if o.type != "MESH":
        continue
    for s in o.material_slots:
        if s.material:
            usage[s.material.name] = usage.get(s.material.name, 0) + 1
for name, n in sorted(usage.items(), key=lambda kv: -kv[1])[:25]:
    print("  %-28s %d" % (name, n))

print("=" * 80)
zs = []
lo = [1e18] * 3
hi = [-1e18] * 3
for o in bpy.data.objects:
    if o.type != "MESH" or not o.data.vertices:
        continue
    for v in o.data.vertices:
        w = o.matrix_world @ v.co
        for i in range(3):
            lo[i] = min(lo[i], w[i])
            hi[i] = max(hi[i], w[i])
    zs.append((lo[2], hi[2]))
print("场景包围盒: (%.1f, %.1f, %.1f) -> (%.1f, %.1f, %.1f)" % (lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]))
print("尺寸: X=%.1f m  Y=%.1f m  Z=%.1f m" % (hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]))
