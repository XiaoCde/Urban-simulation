# -*- coding: utf-8 -*-
r"""直接从已保存的 .blend 渲一张，**不额外加灯、不改世界背景**。

用途很具体：回答"我打开这个文件到底该看到什么"。
    它和 apply_textures.py 的 render_beauty 是两回事 —— 那个会在内存里
    加太阳、换世界背景再渲，所以渲出来好看**不代表打开文件好看**。
    这个脚本什么都不加，文件里存的是什么样就渲成什么样。

用法:
    D:\blender\blender.exe --background --python tools\preview_saved_blend.py -- ^
        out\dc_real3_tex.blend out\saved_preview_1.png [street|mall2|mall3]
"""
import os
import sys

import bpy
from mathutils import Vector

# 和 export_conditions.py 里 SHOTS 一致：格式 (lon, lat, z_m)
SHOTS = {
    "street": dict(lens=45.0, loc=(-77.0337, 38.9103, 70.0), tgt=(-77.0315, 38.9120, 5.0)),
    "mall2": dict(lens=45.0, loc=(-77.0417, 38.8832, 380.0), tgt=(-77.0244, 38.8895, 0.0)),
    "mall3": dict(lens=45.0, loc=(-77.0180, 38.8853, 330.0), tgt=(-77.0094, 38.8896, 20.0)),
}

G_LON0, G_LON_KM = -77.059998, 0.059998
G_LAT0, G_LAT_KM = 38.885003, 0.039996
S_X0, S_X_SPAN = -887.0, 5197.0
S_Y0, S_Y_SPAN = -597.0, 4451.0


def geo_to_scene(lon, lat):
    return (S_X0 + (lon - G_LON0) / G_LON_KM * S_X_SPAN,
            S_Y0 + (lat - G_LAT0) / G_LAT_KM * S_Y_SPAN)


def log(m):
    print("[prev] %s" % m, flush=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) < 2:
        print(__doc__)
        sys.exit(1)
    blend, out = os.path.abspath(argv[0]), os.path.abspath(argv[1])
    which = argv[2] if len(argv) > 2 else "mall2"
    cfg = SHOTS[which]

    bpy.ops.wm.open_mainfile(filepath=blend)
    sc = bpy.context.scene
    w = sc.world
    bg = w.node_tree.nodes.get("Background") if (w and w.use_nodes) else None
    log("文件里现有的：引擎=%s  灯光=%d 个  世界强度=%s  view_transform=%s" % (
        sc.render.engine, sum(1 for o in bpy.data.objects if o.type == "LIGHT"),
        ("%.2f" % bg.inputs[1].default_value) if bg else "无", sc.view_settings.view_transform))

    x, y = geo_to_scene(cfg["loc"][0], cfg["loc"][1])
    tx, ty = geo_to_scene(cfg["tgt"][0], cfg["tgt"][1])
    cd = bpy.data.cameras.new("__preview")
    cam = bpy.data.objects.new("__preview", cd)
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.location = Vector((x, y, cfg["loc"][2]))
    cam.rotation_euler = (Vector((tx, ty, cfg["tgt"][2])) - cam.location).to_track_quat("-Z", "Y").to_euler()
    cd.lens = cfg["lens"]
    cd.sensor_width = 36.0
    cd.clip_start = 0.5
    cd.clip_end = 60000.0

    sc.render.resolution_x, sc.render.resolution_y = 1600, 1000
    sc.render.image_settings.file_format = "PNG"
    sc.render.filepath = out
    bpy.ops.render.render(write_still=True)
    log("写出 %s（%.0f KB）—— 这张就是「打开文件应看到的样子」" % (out, os.path.getsize(out) / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
