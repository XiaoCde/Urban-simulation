# -*- coding: utf-8 -*-
import bpy
S = r"D:\Users\asus\Desktop\项目\out\manhattan_250m_solid.blend"
bpy.ops.wm.open_mainfile(filepath=S)

print("类型统计:")
from collections import Counter
print(" ", Counter(o.type for o in bpy.data.objects))

print("=" * 88)
print("抽样：被转成网格的道路")
props = [o for o in bpy.data.objects if o.type == "MESH" and o.dimensions.z <= 2]
props.sort(key=lambda o: -len(o.data.vertices))
for o in props[:8]:
    print("  %-42s 顶点=%5d 面=%5d  X=%7.1f Y=%7.1f Z=%6.3f" % (
        o.name[:42], len(o.data.vertices), len(o.data.polygons),
        o.dimensions.x, o.dimensions.y, o.dimensions.z))
print("  ...")
print("  道路类网格物体总数: %d" % len(props))

print("=" * 88)
print("抽样：建筑（应该完全没被动过）")
bld = [o for o in bpy.data.objects if o.type == "MESH" and o.dimensions.z > 2]
bld.sort(key=lambda o: -o.dimensions.z)
for o in bld[:6]:
    print("  %-42s 顶点=%5d 面=%5d  高=%7.2f m" % (o.name[:42], len(o.data.vertices), len(o.data.polygons), o.dimensions.z))
print("  建筑总数: %d" % len(bld))
