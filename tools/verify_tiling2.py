# -*- coding: utf-8 -*-
"""更严格的验证：分块导入和整块导入之间，是否只差一个**平移**。

如果每个"同时存在于两边"的建筑，其世界坐标差值都相同，
说明两块用的是同一个坐标系（只是原点不同）→ 拼接是正确的。
如果差值各不相同，说明投影不一致 → 拼接会错位。
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


def centers():
    """每个 mesh 的：名字、底面中心 x/y、最高 z、顶点数"""
    out = {}
    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        pts = [o.matrix_world @ Vector(c) for c in o.bound_box]
        cx = sum(p.x for p in pts) / 8.0
        cy = sum(p.y for p in pts) / 8.0
        out[o.name] = (cx, cy, max(p.z for p in pts), len(o.data.vertices))
    return out


def run(paths, relative):
    bpy.ops.wm.read_homefile(use_empty=True)
    a = setup()
    a.relativeToInitialImport = relative
    for p in paths:
        a.osmFilepath = p
        bpy.ops.blosm.import_data()
    return centers()


full = run([FULL], True)
tiled = run([WEST, EAST], True)

# 找两边都有的建筑：用 顶点数 + 最高Z 当指纹（名字会因为裁剪而不一致）
def fp(v):
    return (v[3], round(v[2], 2))


full_fp = {}
for n, v in full.items():
    full_fp.setdefault(fp(v), []).append(n)

pairs = []
for n, v in tiled.items():
    k = fp(v)
    if k in full_fp and full_fp[k]:
        fn = full_fp[k].pop(0)
        pairs.append((fn, n, full[fn], v))

print("两边都能匹配上的建筑：%d 个" % len(pairs))
print()
print("%-34s %-34s %10s %10s" % ("整块里的名字", "分块里的名字", "Δx", "Δy"))
dxs, dys = [], []
for fn, tn, fv, tv in pairs:
    dx, dy = tv[0] - fv[0], tv[1] - fv[1]
    dxs.append(dx)
    dys.append(dy)
    print("%-34s %-34s %10.3f %10.3f" % (fn[:34], tn[:34], dx, dy))

print()
print("Δx 范围 %.4f ~ %.4f   （极差 %.4f m）" % (min(dxs), max(dxs), max(dxs) - min(dxs)))
print("Δy 范围 %.4f ~ %.4f   （极差 %.4f m）" % (min(dys), max(dys), max(dys) - min(dys)))
print()
if max(dxs) - min(dxs) < 0.01 and max(dys) - min(dys) < 0.01:
    print("结论：所有建筑的位移差值完全一致 → 两块共用同一坐标系，**只差一个固定平移**。")
    print("      → 分块 → 拼接在几何上是正确的；只要统一投影原点（或事后整体平移），接缝严丝合缝。")
else:
    print("结论：位移差值不一致 → 投影不一致，拼接会错位。")
