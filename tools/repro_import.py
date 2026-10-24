# -*- coding: utf-8 -*-
"""在无界面模式下用用户当前的 blosm 设置重跑一次导入，并把每个物体的真实尺寸打印出来。

目的：回答"导入出来的楼到底有没有高低差"，而不是靠肉眼看截图。
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
a.singleObject = True           # 跟用户现在的设置一致：合并成一个物体
a.relativeToInitialImport = False
a.importForExport = False

print("文件存在: %s  大小: %s" % (os.path.isfile(OSM), os.path.getsize(OSM)))
print("mode=%s  buildings=%s  singleObject=%s  osmSource=%s"
      % (a.mode, a.buildings, a.singleObject, a.osmSource))

print("=" * 90)
try:
    print("operator 返回:", bpy.ops.blosm.import_data())
except Exception:
    traceback.print_exc()

print("=" * 90)
print("场景里的所有物体（Z 就是高度，单位米）")
print("=" * 90)
for o in sorted(bpy.data.objects, key=lambda x: -x.dimensions.z):
    d = o.dimensions
    nv = len(o.data.vertices) if o.type == "MESH" else "-"
    print("%-56s %-7s X=%8.2f Y=%8.2f Z=%8.2f  verts=%s"
          % (o.name[:56], o.type, d.x, d.y, d.z, nv))
print("-" * 90)
print("物体总数: %d" % len(bpy.data.objects))
