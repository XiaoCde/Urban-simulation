# -*- coding: utf-8 -*-
import bpy
S = r"D:\Users\asus\Desktop\项目\out\manhattan_250m_full.blend"
O = r"D:\Users\asus\Desktop\项目\out\manhattan_250m_roads-free.blend"
bpy.ops.wm.open_mainfile(filepath=S)
before = len(bpy.data.objects)
# 删掉所有曲线（道路/铁路/栏杆）和它们的空容器
for o in list(bpy.data.objects):
    if o.type in {"CURVE", "EMPTY"}:
        bpy.data.objects.remove(o, do_unlink=True)
print("物体 %d -> %d" % (before, len(bpy.data.objects)))
bpy.ops.wm.save_as_mainfile(filepath=O)
print("已保存:", O)
