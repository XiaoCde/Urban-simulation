# -*- coding: utf-8 -*-
"""验证"按质心分块"：建筑总数是否与整块一致（不丢不重），且两块坐标系是否一致。"""
import bpy
import addon_utils
from mathutils import Vector

FULL = r"D:\Users\asus\Desktop\项目\data\osm\manhattan_250m_full.osm"
CW = r"D:\Users\asus\Desktop\项目\data\osm\_tilec_west.osm"
CE = r"D:\Users\asus\Desktop\项目\data\osm\_tilec_east.osm"


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


def centers():
    out = {}
    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        pts = [o.matrix_world @ Vector(c) for c in o.bound_box]
        cx = sum(p.x for p in pts) / 8.0
        cy = sum(p.y for p in pts) / 8.0
        out[o.name] = (cx, cy, max(p.z for p in pts), len(o.data.vertices))
    return out


def run(paths):
    bpy.ops.wm.read_homefile(use_empty=True)
    a = setup()
    a.relativeToInitialImport = True
    for p in paths:
        a.osmFilepath = p
        bpy.ops.blosm.import_data()
    return centers()


full = run([FULL])
print("整块：%d 栋" % len(full))

tiled = run([CW, CE])
print("质心分块合并：%d 栋" % len(tiled))

def fp(v):
    return (v[3], round(v[2], 2))

ff = {}
for n, v in full.items():
    ff.setdefault(fp(v), []).append(n)

dxs, dys, matched = [], [], 0
for n, v in tiled.items():
    k = fp(v)
    if k in ff and ff[k]:
        fn = ff[k].pop(0)
        dxs.append(v[0] - full[fn][0])
        dys.append(v[1] - full[fn][1])
        matched += 1

print("指纹可匹配：%d 栋" % matched)
print()
print("建筑总数：整块 %d，分块 %d  →  %s" % (
    len(full), len(tiled), "一致，不丢不重 ✓" if len(full) == len(tiled) else "不一致 ✗"))
if dxs:
    print("Δx 极差 %.4f m，Δy 极差 %.4f m  →  %s" % (
        max(dxs) - min(dxs), max(dys) - min(dys),
        "同一坐标系（只差固定平移）✓" if max(dxs) - min(dxs) < 0.01 and max(dys) - min(dys) < 0.01 else "坐标系不一致 ✗"))
