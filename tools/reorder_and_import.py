# -*- coding: utf-8 -*-
"""检查曼哈顿那份 .osm 的元素顺序，并测试"把 node 全部挪到最前面"能不能救回来。"""
import xml.etree.ElementTree as ET

import addon_utils
import bpy

SRC = r"D:\Users\asus\Desktop\项目\data\osm\manhattan_times-square_556x435m.osm"
DST = r"D:\Users\asus\Desktop\项目\data\osm\_reordered_nodes-first.osm"

tree = ET.parse(SRC)
root = tree.getroot()
order = [e.tag for e in list(root)]
print("原始元素顺序（前 15）：", order[:15])
print("原始元素顺序（后 5）：", order[-5:])
nodes = [e for e in root if e.tag == "node"]
ways = [e for e in root if e.tag == "way"]
rels = [e for e in root if e.tag == "relation"]
print("统计: node=%d  way=%d  relation=%d" % (len(nodes), len(ways), len(rels)))

for e in list(root):
    root.remove(e)
for e in nodes + ways + rels:
    root.append(e)
tree.write(DST, encoding="utf-8", xml_declaration=True)
print("已写出重排文件:", DST)

# ---------------- 用重排后的文件再导一次 ----------------
addon_utils.enable("blosm")
prefs = bpy.context.preferences.addons["blosm"].preferences
prefs.dataDir = r"D:\Users\asus\Desktop\项目\data\blosm_cache"
prefs.assetsDir = ""

a = bpy.context.scene.blosm
a.dataType = "osm"
a.osmSource = "file"
a.osmFilepath = DST
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
