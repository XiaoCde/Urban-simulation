# -*- coding: utf-8 -*-
r"""只读探针：看某个经纬度附近到底有哪些建筑、多高、多大。

用途：拍某个地标之前，先确认几何在不在、体量对不对，避免拍出来一片空地
却以为是相机放错了。

用法:
    blender --background --python tools\probe_here.py -- <blend> <lon> <lat> [半径米]
例:
    blender --background --python tools\probe_here.py -- out\dc_real3_clean.blend -77.0365 38.8977 160
"""
import math
import os
import sys

import bpy
from mathutils import Vector

# 与 export_conditions.py / apply_textures.py 同一套经纬 <-> 场景换算
G_LON0, G_LON_KM = -77.059998, 0.059998
G_LAT0, G_LAT_KM = 38.885003, 0.039996
S_X0, S_X_SPAN = -887.0, 5197.0
S_Y0, S_Y_SPAN = -597.0, 4451.0


def geo_to_scene(lon, lat):
    x = S_X0 + (lon - G_LON0) / G_LON_KM * S_X_SPAN
    y = S_Y0 + (lat - G_LAT0) / G_LAT_KM * S_Y_SPAN
    return x, y


def scene_to_geo(x, y):
    lon = G_LON0 + (x - S_X0) / S_X_SPAN * G_LON_KM
    lat = G_LAT0 + (y - S_Y0) / S_Y_SPAN * G_LAT_KM
    return lon, lat


def main(blend, lon, lat, radius):
    bpy.ops.wm.open_mainfile(filepath=blend)
    cx, cy = geo_to_scene(lon, lat)
    print("[here] 目标 经纬=(%.5f, %.5f) -> 场景=(%.1f, %.1f)  半径 %.0f m"
          % (lon, lat, cx, cy, radius))

    rows = []
    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        mw = o.matrix_world
        # 【重要】不能用 o.dimensions 当"高"。blosm 给物体挂了旋转矩阵
        # （例如华盛顿纪念碑的局部 +Y 就是世界的 +Z），dimensions 是**物体局部**的
        # 包围盒尺寸，直接取 dimensions.z 会得到 17.1 而不是 169.3。
        # 正确做法：把 8 个 bound_box 角点过一遍 matrix_world，取世界包围盒。
        xs, ys, zs = [], [], []
        for corner in o.bound_box:
            p = mw @ Vector((corner[0], corner[1], corner[2]))
            xs.append(p.x)
            ys.append(p.y)
            zs.append(p.z)
        w, dp, hgt = max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)
        c = mw.translation
        d = math.hypot(c.x - cx, c.y - cy)
        if d > radius:
            continue
        area = w * dp
        top = ""
        nslot = len(o.material_slots)
        if nslot:
            slots = [s.material.name for s in o.material_slots if s.material]
            top = slots[0] if slots else "(空)"
        rows.append((area, d, o.name, w, dp, hgt, nslot, top,
                     scene_to_geo(c.x, c.y)[0], scene_to_geo(c.x, c.y)[1]))

    rows.sort(reverse=True)
    print("[here] 半径内网格物体 %d 个（按占地面积从大到小）" % len(rows))
    for area, d, name, w, dp, hgt, nslot, mat, olon, olat in rows[:40]:
        print("[here]  %8.1f m2  距%5.0f m  %-26s 占地 %5.1f x %5.1f  高 %5.1f  %d槽  %s"
              % (area, d, name[:26], w, dp, hgt, nslot, mat))


if __name__ == "__main__":
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    if len(argv) < 3:
        print(__doc__)
        sys.exit(1)
    main(argv[0], float(argv[1]), float(argv[2]),
         float(argv[3]) if len(argv) > 3 else 150.0)
