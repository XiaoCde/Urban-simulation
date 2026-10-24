# -*- coding: utf-8 -*-
r"""从已有的 .blend 导出 glTF 二进制（.glb）。

导出参数沿用 tools\merge_tiles.py 里实测可用的那一组：
    export_format="GLB"、export_apply=True、export_yup=True、
    export_cameras=False、export_lights=False
道路是 CURVE 类型，glTF 导出器会自动求值成网格，不需要先 Convert to Mesh。

用法（必须由 blender 执行）:
    blender --background --python tools\export_glb.py -- <输入.blend> [输出.glb]
"""
import os
import sys

import bpy

DEFAULT_SRC = r"D:\Users\asus\Desktop\项目\out\dc_real3.blend"
DEFAULT_GLB = r"D:\Users\asus\Desktop\项目\out\dc_real3.glb"


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    src = argv[0] if len(argv) > 0 else DEFAULT_SRC
    glb = argv[1] if len(argv) > 1 else (os.path.splitext(src)[0] + ".glb")

    bpy.ops.wm.open_mainfile(filepath=src)
    print("[open] %s" % src)

    kinds = {}
    for o in bpy.data.objects:
        kinds[o.type] = kinds.get(o.type, 0) + 1
    tris = 0
    for o in bpy.data.objects:
        if o.type == "MESH" and o.data.polygons:
            tris += sum(len(p.vertices) - 2 for p in o.data.polygons)
    print("[场景] %s   三角面约 %d" % (kinds, tris))

    try:
        bpy.ops.preferences.addon_enable(module="io_scene_gltf2")
    except Exception as e:
        print("[addon_enable]", e)

    bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=False,
                              export_apply=True, export_yup=True,
                              export_cameras=False, export_lights=False)
    print("[done] %s  (%.1f MB)" % (glb, os.path.getsize(glb) / 1048576))


main()
