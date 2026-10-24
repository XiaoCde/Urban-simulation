# -*- coding: utf-8 -*-
"""最小对照实验：两个手写建筑，一个带 height=100，一个不带 height。
用途：判断 blosm 到底认不认 `height` 标签，以及它能不能建出 way 形式的建筑。"""
import addon_utils
import bpy

OSM = r"D:\Users\asus\Desktop\项目\data\osm\_minimal_test.osm"

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
a.singleObject = False
a.relativeToInitialImport = False
a.importForExport = False
a.loadMissingMembers = False
a.levelHeight = 3.0

print(bpy.ops.blosm.import_data())
print("=" * 92)
for o in bpy.data.objects:
    if o.type == "MESH" and o.name != "Cube":
        zs = sorted(v.co.z for v in o.data.vertices)
        print("  %-40s 顶点=%3d  X=%6.2f Y=%6.2f  最高Z=%7.2f"
              % (o.name[:40], len(o.data.vertices), o.dimensions.x, o.dimensions.y, zs[-1] if zs else 0))
print("mesh 总数:", len([o for o in bpy.data.objects if o.type == "MESH" and o.name != "Cube"]))
