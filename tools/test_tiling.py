# -*- coding: utf-8 -*-
"""分块 → 拼接 实验：把两块相邻的 .osm 导入同一个场景，验证接缝能不能对齐。

核心机制（读 blosm 源码 __init__.py:324-334 得到）：
    if "lat" in scene and "lon" in scene and a.relativeToInitialImport:
        osm.setProjection(scene["lat"], scene["lon"])
    ...
    if setLatLon and osm.projection:
        self.setCenterLatLon(context, osm.lat, osm.lon)   # 把本块中心写进 scene["lat"]/["lon"]

    也就是说：
      第一块  →  scene 里没有 lat/lon，于是用自己 bbox 的中心做投影，并把它写进 scene
      第二块起 →  只要 relativeToInitialImport = True，就复用 scene 里那个中心
                  → 所有块落在同一个横轴墨卡托坐标系里 → 接缝天然对齐

本脚本跑两种模式做对照：
    模式 A：relativeToInitialImport = True   （预期：对齐）
    模式 B：relativeToInitialImport = False  （预期：各自以自己中心为原点，错开）
"""
import bpy
import addon_utils
import xml.etree.ElementTree as ET
from mathutils import Vector

WEST = r"D:\Users\asus\Desktop\项目\data\osm\_tile_west.osm"
EAST = r"D:\Users\asus\Desktop\项目\data\osm\_tile_east.osm"


def reset_scene():
    bpy.ops.wm.read_homefile(use_empty=True)


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


def import_file(a, path):
    a.osmFilepath = path
    bpy.ops.blosm.import_data()


def bbox_of_osm(path):
    root = ET.parse(path).getroot()
    lats = [float(n.get("lat")) for n in root if n.tag == "node"]
    lons = [float(n.get("lon")) for n in root if n.tag == "node"]
    return min(lats), min(lons), max(lats), max(lons)


def mesh_extent(tag):
    """返回某个集合里所有 mesh 的世界坐标包围盒。"""
    objs = [o for o in bpy.data.objects if o.type == "MESH" and tag in o.name]
    if not objs:
        return None
    xs, ys = [], []
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            xs.append(w.x)
            ys.append(w.y)
    return min(xs), min(ys), max(xs), max(ys), len(objs)


def run(relative, label):
    print("=" * 92)
    print("模式 %s：relativeToInitialImport = %s" % (label, relative))
    reset_scene()
    a = setup()
    a.relativeToInitialImport = relative

    import_file(a, WEST)
    print("  导入西块后 scene lat/lon = %s / %s" % (
        round(bpy.context.scene.get("lat", float("nan")), 6),
        round(bpy.context.scene.get("lon", float("nan")), 6)))
    west_names = {o.name for o in bpy.data.objects if o.type == "MESH"}

    import_file(a, EAST)
    print("  导入东块后 scene lat/lon = %s / %s" % (
        round(bpy.context.scene.get("lat", float("nan")), 6),
        round(bpy.context.scene.get("lon", float("nan")), 6)))

    all_mesh = [o for o in bpy.data.objects if o.type == "MESH"]
    east_names = [o.name for o in all_mesh if o.name not in west_names]

    # 用"只出现在西块 / 只出现在东块"的物体算各自范围
    def extent_of(names):
        xs, ys = [], []
        for n in names:
            o = bpy.data.objects.get(n)
            if not o:
                continue
            for c in o.bound_box:
                w = o.matrix_world @ Vector(c)
                xs.append(w.x)
                ys.append(w.y)
        return (min(xs), min(ys), max(xs), max(ys)) if xs else None

    w = extent_of(list(west_names))
    e = extent_of(east_names)
    print("  西块 mesh 范围: X %8.2f ~ %8.2f   Y %8.2f ~ %8.2f   (%d 个)" % (w[0], w[2], w[1], w[3], len(west_names)))
    print("  东块 mesh 范围: X %8.2f ~ %8.2f   Y %8.2f ~ %8.2f   (%d 个)" % (e[0], e[2], e[1], e[3], len(east_names)))
    print("  → 两块的 X 接缝间距 = %.2f m  （西块 maxX %.2f，东块 minX %.2f）" % (e[0] - w[2], w[2], e[0]))
    print("  → 两块的 Y 重叠 = 西 %.2f~%.2f，东 %.2f~%.2f" % (w[1], w[3], e[1], e[3]))
    return w, e


bw = bbox_of_osm(WEST)
print("西块经纬度范围: 南%.5f 西%.5f 北%.5f 东%.5f" % bw)
be_ = bbox_of_osm(EAST)
print("东块经纬度范围: 南%.5f 西%.5f 北%.5f 东%.5f" % be_)
print("西块宽度 %.0f m / 东块宽度 %.0f m" % (
    (bw[3] - bw[1]) * 111000 * 0.756, (be_[3] - be_[1]) * 111000 * 0.756))

run(True, "A")
run(False, "B")
