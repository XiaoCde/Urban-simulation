# -*- coding: utf-8 -*-
"""在场景里选中所有类型为 CURVE 的物体（等价于"按类型选择 → 曲线"）。"""
import bpy
S = r"D:\Users\asus\Desktop\项目\out\manhattan_250m_full.blend"
bpy.ops.wm.open_mainfile(filepath=S)

bpy.ops.object.select_all(action="DESELECT")
curves = [o for o in bpy.data.objects if o.type == "CURVE"]
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
for o in curves:
    o.select_set(True)
if curves:
    bpy.context.view_layer.objects.active = curves[0]

print("已选中曲线物体: %d 个" % len(curves))
print("未选中的网格物体（建筑）: %d 个" % len(meshes))
print("其中被误选的网格物体: %d 个" % len([o for o in meshes if o.select_get()]))
