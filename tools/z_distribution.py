# -*- coding: utf-8 -*-
"""量出 blosm 导入结果里顶点高度的真实分布。

关键问题：数据里有 3 Times Square = 169.2 m 这样的高楼，
导入出来的 mesh 里到底有没有对应的顶点？
"""
import os
import traceback

import addon_utils
import bpy

OSM = r"D:\Users\asus\Desktop\项目\data\osm\manhattan_times-square_556x435m.osm"

addon_utils.enable("blosm")

prefs = bpy.context.preferences.addons["blosm"].preferences
prefs.dataDir = r"D:\Users\asus\Desktop\项目\data\blosm_cache"
prefs.assetsDir = ""

a = bpy.context.scene.blosm
a.dataType = "osm"
a.osmSource = "file"
a.osmFilepath = OSM
a.mode = "3Dsimple"
a.buildings = True
a.singleObject = True
a.relativeToInitialImport = False
a.importForExport = False
a.loadMissingMembers = True

try:
    print("operator 返回:", bpy.ops.blosm.import_data())
except Exception:
    traceback.print_exc()

print("=" * 90)
for o in bpy.data.objects:
    if o.type != "MESH" or o.name == "Cube":
        continue
    zs = [v.co.z for v in o.data.vertices]
    zs.sort()
    print("物体: %s" % o.name)
    print("  顶点数 %d / 最低 Z %.2f / 最高 Z %.2f" % (len(zs), zs[0], zs[-1]))
    print("  Z > 10  的顶点数: %d" % sum(1 for z in zs if z > 10))
    print("  Z > 20  的顶点数: %d" % sum(1 for z in zs if z > 20))
    print("  Z > 50  的顶点数: %d" % sum(1 for z in zs if z > 50))
    print("  Z > 100 的顶点数: %d" % sum(1 for z in zs if z > 100))
    print("  最高的 12 个 Z 值: %s" % [round(z, 2) for z in zs[-12:]])
    print("  不同的 Z 值个数: %d" % len(set(round(z, 3) for z in zs)))
    print("-" * 90)

