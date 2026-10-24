# -*- coding: utf-8 -*-
"""打印一个 .blend 的规模指标（物体数 / 顶点 / 面 / 材质 / 贴图），用来量化改动。

用法:
    D:\\blender\\blender.exe --background --python tools\\count_scene.py -- <a.blend> [b.blend ...]
"""
import os
import sys

import bpy


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not argv:
        print(__doc__)
        return 1
    for p in argv:
        p = os.path.abspath(p)
        bpy.ops.wm.open_mainfile(filepath=p)
        obj = len(bpy.data.objects)
        me = [o for o in bpy.data.objects if o.type == "MESH" and o.data]
        cur = [o for o in bpy.data.objects if o.type == "CURVE"]
        v = sum(len(o.data.vertices) for o in me)
        f = sum(len(o.data.polygons) for o in me)
        imgs = len(bpy.data.images)
        print("[cnt] %-26s 物体 %6d (MESH %5d / CURVE %5d)  顶点 %8d  面 %8d  "
              "材质 %4d  贴图 %4d  文件 %5.1f MB"
              % (os.path.basename(p), obj, len(me), len(cur), v, f,
                 len(bpy.data.materials), imgs,
                 os.path.getsize(p) / 1048576), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
