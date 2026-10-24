# -*- coding: utf-8 -*-
"""对照验证：整块导入 vs 分两块导入，世界坐标包围盒是否一致。

模式 A（relativeToInitialImport=True）预期两块拼出来的总范围 == 整块导入的范围。
"""
import bpy
import addon_utils
from mathutils import Vector

FULL = r"D:\Users\asus\Desktop\项目\data\osm\manhattan_250m_full.osm"
WEST = r"D:\Users\asus\Desktop\项目\data\osm\_tile_west.osm"
EAST = r"D:\Users\asus\Desktop\项目\data\osm\_tile_east.osm"


def setup():
    addon_utils.enable("blosm")
    prefs = bpy.context.preferences.addons["blosm"].preferences
    prefs.dataDir = r"D:\Users\asus\Desktop\项目\data\blosm_cache"
    prefs.assetsDir = ""
    a = bpy.context.scene.blosm
    a.dataType = "osm"
    a.osmSource = "file"
    a.mode = "3Dsimple"
    a.buildings = True
    a.singleObject = False
    a.loadMissingMembers = False
    return a


def bbox_all():
    xs, ys, zs = [], [], []
    n = 0
    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        n += 1
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            xs.append(w.x)
            ys.append(w.y)
            zs.append(w.z)
    return (min(xs), max(xs), min(ys), max(ys), min(zs), max(zs), n) if xs else None


def show(tag, r):
    if not r:
        print("%-14s 无网格" % tag)
        return
    print("%-14s 建筑 %2d 个   X %8.2f ~ %8.2f (宽 %.1f)   Y %8.2f ~ %8.2f (宽 %.1f)   Z %.2f ~ %.2f"
          % (tag, r[6], r[0], r[1], r[1] - r[0], r[2], r[3], r[3] - r[2], r[4], r[5]))


# 1) 整块
bpy.ops.wm.read_homefile(use_empty=True)
a = setup()
a.relativeToInitialImport = True
a.osmFilepath = FULL
bpy.ops.blosm.import_data()
full = bbox_all()
show("整块导入", full)

# 2) 分两块（模式 A）
bpy.ops.wm.read_homefile(use_empty=True)
a = setup()
a.relativeToInitialImport = True
a.osmFilepath = WEST
bpy.ops.blosm.import_data()
west = bbox_all()
a.osmFilepath = EAST
bpy.ops.blosm.import_data()
both = bbox_all()
show("西块", west)
show("西+东", both)

print()
print("== 结论 ==")
print("整块 X %.2f~%.2f  vs  分块 X %.2f~%.2f   →  X 偏差 %.2f / %.2f m"
      % (full[0], full[1], both[0], both[1], abs(full[0] - both[0]), abs(full[1] - both[1])))
print("整块 Y %.2f~%.2f  vs  分块 Y %.2f~%.2f   →  Y 偏差 %.2f / %.2f m"
      % (full[2], full[3], both[2], both[3], abs(full[2] - both[2]), abs(full[3] - both[3])))
print("建筑数：整块 %d，分块合并 %d，丢失 %d（跨中线的楼会被裁掉）"
      % (full[6], both[6], full[6] - both[6]))
