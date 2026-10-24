# -*- coding: utf-8 -*-
r"""逐个网格打印「世界坐标」包围盒 —— 用来找混进模型里的多余物体。

踩过的坑（这个脚本就是为了不再踩）：
  o.dimensions / o.bound_box 是**物体局部**坐标。blosm 那种给物体挂了旋转的模型，
  局部 z 和世界 z 不是一回事（华盛顿纪念碑局部 +Y 才是世界 +Z，直接读 dimensions.z
  会得到 17.1 m 而不是 169.3 m）。所以必须把 8 个 bound_box 角点乘 o.matrix_world。

用法:
    blender --background --python tools\probe_meshes.py -- <a.glb> [b.blend ...]
"""
import os
import sys

import bpy
from mathutils import Vector


def world_bbox(o):
    lo = Vector((1e18, 1e18, 1e18))
    hi = Vector((-1e18, -1e18, -1e18))
    for c in o.bound_box:
        p = o.matrix_world @ Vector(c)
        for i in range(3):
            lo[i] = min(lo[i], p[i])
            hi[i] = max(hi[i], p[i])
    return lo, hi


def report(label):
    print("### %s" % label)
    tlo = Vector((1e18, 1e18, 1e18))
    thi = Vector((-1e18, -1e18, -1e18))
    for o in sorted(bpy.context.scene.objects, key=lambda x: x.name):
        if o.type != "MESH":
            continue
        lo, hi = world_bbox(o)
        d = hi - lo
        print("  MESH %-26s 世界尺寸 %6.2f x %6.2f x %6.2f   z %7.2f ~ %-7.2f 顶点 %6d 材质 %d 修改器 %s"
              % (o.name[:26], d.x, d.y, d.z, lo.z, hi.z,
                 len(o.data.vertices), len(o.data.materials),
                 [m.type for m in o.modifiers] or "无"))
        for i in range(3):
            tlo[i] = min(tlo[i], lo[i])
            thi[i] = max(thi[i], hi[i])
    print("  合计 世界尺寸 %6.2f x %6.2f x %6.2f  ->  高 %.2f m"
          % ((thi - tlo).x, (thi - tlo).y, (thi - tlo).z, (thi - tlo).z))
    for o in bpy.context.scene.objects:
        if o.type == "ARMATURE":
            print("  ARMATURE %-22s 世界缩放 %s  本机缩放 %s  骨头 %d"
                  % (o.name[:22], tuple(round(v, 4) for v in o.matrix_world.to_scale()),
                     tuple(round(v, 4) for v in o.scale), len(o.data.bones)))
    for o in bpy.context.scene.objects:
        if o.type not in ("MESH", "ARMATURE"):
            print("  其他 %-8s %-24s 世界位置 %s"
                  % (o.type, o.name[:24], tuple(round(v, 2) for v in o.matrix_world.translation)))
    print("")


def main():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    if not argv:
        print(__doc__)
        sys.exit(1)
    for p in argv:
        if p.lower().endswith(".blend"):
            bpy.ops.wm.open_mainfile(filepath=os.path.abspath(p))
            report(os.path.basename(p))
        else:
            bpy.ops.wm.read_factory_settings(use_empty=True)
            # Mixamo 只给 FBX；按扩展名分派，别再拿 glTF 去读 .fbx
            # （会报 `Error: Bad glTF: json error: utf-8`）。
            if os.path.splitext(p)[1].lower() == ".fbx":
                bpy.ops.import_scene.fbx(filepath=os.path.abspath(p))
            else:
                bpy.ops.import_scene.gltf(filepath=os.path.abspath(p))
            report(os.path.basename(p))


if __name__ == "__main__":
    main()
