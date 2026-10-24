# -*- coding: utf-8 -*-
"""把场景里所有 CURVE 转成 MESH，跳过 way_profiles 模板，并把结果另存。"""
import bpy

SRC = r"D:\Users\asus\Desktop\项目\out\manhattan_250m_full.blend"
DST = r"D:\Users\asus\Desktop\项目\out\manhattan_250m_solid.blend"

bpy.ops.wm.open_mainfile(filepath=SRC)

SKIP = {"way_profiles"}          # 断面模板，不转
curves = [o for o in bpy.data.objects if o.type == "CURVE" and o.name not in SKIP]
meshes_before = [o for o in bpy.data.objects if o.type == "MESH"]
print("场景: 曲线 %d 条（待转），网格 %d 个（建筑，不动）" % (len(curves), len(meshes_before)))

bpy.ops.object.select_all(action="DESELECT")
for o in curves:
    o.select_set(True)
bpy.context.view_layer.objects.active = curves[0]

bpy.ops.object.convert(target="MESH")

left = [o for o in bpy.data.objects if o.type == "CURVE" and o.name not in SKIP]
print("转换完成，剩余未转曲线: %d" % len(left))

mesh_now = [o for o in bpy.data.objects if o.type == "MESH"]
total_faces = sum(len(o.data.polygons) for o in mesh_now)
print("现在网格物体 %d 个，总面数 %d" % (len(mesh_now), total_faces))
print("其中建筑有高度的（Z>2）个数: %d" % len([o for o in mesh_now if o.dimensions.z > 2]))

bpy.ops.wm.save_as_mainfile(filepath=DST)
print("已保存:", DST)
