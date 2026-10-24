# -*- coding: utf-8 -*-
"""验证当前磁盘上的主 .osm 文件是不是已经修好（元素顺序），并实际导入一次看结果。"""
import xml.etree.ElementTree as ET

import addon_utils
import bpy

OSM = r"D:\Users\asus\Desktop\项目\data\osm\manhattan_times-square_556x435m.osm"

root = ET.parse(OSM).getroot()
order = [e.tag for e in list(root)]
first_node = order.index("node") if "node" in order else 10 ** 9
first_way = order.index("way") if "way" in order else 10 ** 9
print("元素顺序（前 8）:", order[:8])
print("第一个 node 在第 %d 位，第一个 way 在第 %d 位 → %s"
      % (first_node, first_way, "✅ 已修好" if first_node < first_way else "❌ 还是坏的"))

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

print(bpy.ops.blosm.import_data())
print("=" * 92)
ms = [o for o in bpy.data.objects if o.type == "MESH" and o.name != "Cube"]
print("mesh 物体数: %d" % len(ms))
for o in sorted(ms, key=lambda x: -x.dimensions.z):
    print("  %-46s 顶点=%4d X=%7.1f Y=%7.1f 最高Z=%7.2f"
          % (o.name[:46], len(o.data.vertices), o.dimensions.x, o.dimensions.y, o.dimensions.z))
