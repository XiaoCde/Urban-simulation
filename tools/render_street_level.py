# -*- coding: utf-8 -*-
r"""街面视角渲染 —— 专门用来验证 ① 加的特征（凸窗/檐口/台阶/窗洞）。

为什么必须有这一张：
    之前实测过，**1.75 m 人眼高度渲出来是四堵没窗户的白墙** —— 这是"必须先补
    几何特征"的直接证据。所以验证 ① 有没有用，唯一的办法就是站到街上再看一次。
    （70 m 低空斜视看不出 0.6 m 的凸窗，那个机位不适合做验证。）

做法：给一个经纬度，找它附近最近的路点，用道路切向定相机朝向，
      相机放在路面上方 1.70 m（人眼高），lens 35（接近人眼视角）。

用法:
    D:\blender\blender.exe --background --python tools\render_street_level.py -- ^
        <输入.blend> <输出.png> [经度] [纬度] [朝向] [侧]

    朝向 = along（默认，沿街纵深看，看连排屋的连续性）
         | front（垂直于街，正对临街立面，看凸窗/檐口/台阶）
    侧   = 1（默认，切向左侧）/ -1（右侧）—— front 模式下用来选看哪一边的楼
"""
import math
import os
import sys

import bpy
from mathutils import Vector

# 与 export_conditions.py 同一套常数
G_LON0, G_LON_KM = -77.059998, 0.059998
G_LAT0, G_LAT_KM = 38.885003, 0.039996
S_X0, S_X_SPAN = -887.0, 5197.0
S_Y0, S_Y_SPAN = -597.0, 4451.0
EYE = 1.70          # 人眼高度
LENS = 35.0


def geo_to_scene(lon, lat):
    return (S_X0 + (lon - G_LON0) / G_LON_KM * S_X_SPAN,
            S_Y0 + (lat - G_LAT0) / G_LAT_KM * S_Y_SPAN)


def log(m):
    print("[street] %s" % m, flush=True)


def road_samples():
    """把道路曲线采样成 (x, y, tangent_x, tangent_y) 列表。"""
    out = []
    for o in bpy.data.objects:
        if o.type != "CURVE":
            continue
        mw = o.matrix_world
        for sp in o.data.splines:
            if sp.type == "BEZIER":
                raw = [bp.co for bp in sp.bezier_points]
            else:
                raw = [p.co for p in sp.points]
            pts = [mw @ Vector((p[0], p[1], p[2])) for p in raw]
            for i in range(1, len(pts) - 1):
                a, b = pts[i - 1], pts[i + 1]
                d = b - a
                L = d.length
                if L < 0.5:
                    continue
                out.append((pts[i].x, pts[i].y, pts[i].z, d.x / L, d.y / L))
    return out


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) < 2:
        print(__doc__)
        return 1
    src = os.path.abspath(argv[0])
    dst = os.path.abspath(argv[1])
    lon = float(argv[2]) if len(argv) > 2 else -77.0337
    lat = float(argv[3]) if len(argv) > 3 else 38.9103
    mode = argv[4] if len(argv) > 4 else "along"
    side = float(argv[5]) if len(argv) > 5 else 1.0

    bpy.ops.wm.open_mainfile(filepath=src)
    scene = bpy.context.scene
    log("载入 %s" % os.path.basename(src))

    s = road_samples()
    log("道路采样 %d 个点" % len(s))
    px, py = geo_to_scene(lon, lat)
    best = min(s, key=lambda t: (t[0] - px) ** 2 + (t[1] - py) ** 2)
    dist = math.hypot(best[0] - px, best[1] - py)
    log("最近路点距 (%.5f,%.5f) %.1f m，切向 (%.2f, %.2f)"
        % (lon, lat, dist, best[3], best[4]))

    # 相机
    cam = bpy.data.objects.get("__streetcam")
    if cam is None:
        cd = bpy.data.cameras.new("__streetcam")
        cam = bpy.data.objects.new("__streetcam", cd)
        scene.collection.objects.link(cam)
    scene.camera = cam
    tx, ty = best[3], best[4]
    if mode == "front":
        lx, ly = -ty * side, tx * side      # 垂直于街，正对 side 那一侧的立面
        back, fwd, drop = 6.0, 22.0, 0.9
    else:
        lx, ly = tx, ty                     # 沿街纵深
        back, fwd, drop = 3.0, 45.0, 0.3
    loc = Vector((best[0] - lx * back, best[1] - ly * back, best[2] + EYE))
    tgt = Vector((best[0] + lx * fwd, best[1] + ly * fwd, best[2] + EYE - drop))
    cam.location = loc
    cam.rotation_euler = (tgt - loc).to_track_quat("-Z", "Y").to_euler()
    log("机位 %s/%+.0f：loc=(%.1f,%.1f,%.2f) -> tgt=(%.1f,%.1f,%.2f)"
        % (mode, side, loc.x, loc.y, loc.z, tgt.x, tgt.y, tgt.z))
    cam.data.lens = LENS
    cam.data.sensor_width = 36.0
    cam.data.clip_start = 0.2
    cam.data.clip_end = 60000.0

    # 光照（与 render_shots.py 一致）
    for o in list(bpy.data.objects):
        if o.type == "LIGHT":
            bpy.data.objects.remove(o, do_unlink=True)
    ld = bpy.data.lights.new("CitySun", type="SUN")
    ld.energy = 2.9
    ld.angle = math.radians(1.5)
    sun = bpy.data.objects.new("CitySun", ld)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(48), 0.0, math.radians(-35))
    w = scene.world or bpy.data.worlds.new("CityWorld")
    scene.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes.get("Background") or w.node_tree.nodes.new("ShaderNodeBackground")
    bg.inputs[0].default_value = (0.44, 0.58, 0.82, 1.0)
    bg.inputs[1].default_value = 0.55

    r = scene.render
    try:
        r.engine = "BLENDER_EEVEE"
    except Exception:
        r.engine = "BLENDER_EEVEE_NEXT"
    r.resolution_x, r.resolution_y = 1600, 1000
    r.resolution_percentage = 100
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGB"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    r.filepath = dst
    bpy.ops.render.render(write_still=True)
    log("写出 %s（%.1f MB）" % (dst, os.path.getsize(dst) / 1048576))
    return 0


if __name__ == "__main__":
    sys.exit(main())
