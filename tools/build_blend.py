# -*- coding: utf-8 -*-
"""在命令行里把修好的 .osm 导入成一个完整的 .blend，直接交给用户打开。"""
import addon_utils
import bpy

OSM = r"D:\Users\asus\Desktop\项目\data\osm\manhattan_times-square_556x435m.osm"
OUT = r"D:\Users\asus\Desktop\项目\out\manhattan_times-square_31buildings.blend"

# 清掉默认立方体
for o in list(bpy.data.objects):
    if o.type == "MESH" and o.name == "Cube":
        bpy.data.objects.remove(o, do_unlink=True)

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
a.singleObject = False          # 每栋楼一个独立物体，方便后面清点和处理
a.relativeToInitialImport = False
a.importForExport = False
a.loadMissingMembers = False

print(bpy.ops.blosm.import_data())

ms = [o for o in bpy.data.objects if o.type == "MESH"]
print("建出的 mesh 物体数: %d" % len(ms))

bpy.ops.wm.save_as_mainfile(filepath=OUT)
print("已保存: %s" % OUT)
