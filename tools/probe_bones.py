# -*- coding: utf-8 -*-
r"""对骨骼 + 动作通道做体检：查清「Mixamo 的角色文件」和「Mixamo 的动画文件」
两边的骨骼是不是同一套。

为什么需要它：把动画文件里的 action 套到角色文件的骨骼上之后，角色塌成 0.53 m
并沉到地面以下（z -0.23 ~ 0.30），而角色自己的 rest 高度是正常的 1.80 m。
要么两边的 rest 骨骼不一样，要么动作里有非 1.0 的 scale 通道。
这个脚本把两边的 rest 变换和动作通道的数值范围都打出来，一次看清。

用法:
    blender --background --python tools\probe_bones.py -- <甲.fbx> [乙.fbx]
"""
import importlib.util
import os
import sys

import bpy

TOOLS = os.path.dirname(os.path.abspath(__file__))


def load_mod(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(TOOLS, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


PD = load_mod("pd", "ped_demo.py")
KEY = ("Hips", "Spine", "LeftUpLeg", "LeftFoot", "Head")


def load(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if path.lower().endswith(".fbx"):
        bpy.ops.import_scene.fbx(filepath=os.path.abspath(path))
    else:
        bpy.ops.import_scene.gltf(filepath=os.path.abspath(path))


def dump(tag, path):
    print("")
    print("=" * 90)
    print("[%s] %s" % (tag, os.path.basename(path)))
    for o in bpy.data.objects:
        if o.type != "ARMATURE":
            continue
        ws = o.matrix_world.to_scale()
        print("  骨骼物体 %-14s 世界缩放=%s 本机缩放=%s 骨头 %d 根"
              % (o.name, tuple(round(v, 6) for v in ws),
                 tuple(round(v, 6) for v in o.scale), len(o.data.bones)))
        hits = [n for n in o.data.bones.keys() if any(k in n for k in KEY)]
        for nm in hits:
            b = o.data.bones[nm]
            h = b.head_local
            print("      %-30s rest头=(%9.4f,%9.4f,%9.4f) 长=%9.4f rest缩放=%s"
                  % (nm, h.x, h.y, h.z, b.length,
                     tuple(round(v, 4) for v in b.matrix_local.to_scale())))
    for a in bpy.data.actions:
        rows = {}
        for fc in PD.iter_fcurves(a):
            if "Hips" not in fc.data_path and "Spine" not in fc.data_path:
                continue
            prop = fc.data_path.rsplit(".", 1)[-1]
            bone = fc.data_path.split('"')[1] if '"' in fc.data_path else "?"
            vs = [kp.co[1] for kp in fc.keyframe_points]
            if not vs:
                continue
            rows["%s.%s[%d]" % (bone, prop, fc.array_index)] = (min(vs), max(vs))
        if rows:
            print("  动作 %-38s 帧 %s" % (a.name, tuple(round(v, 1) for v in a.frame_range)))
            for k in sorted(rows):
                lo, hi = rows[k]
                print("      %-42s %9.3f ~ %9.3f" % (k, lo, hi))


def main():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    if not argv:
        print(__doc__)
        sys.exit(1)
    for i, p in enumerate(argv):
        load(p)
        dump("文件%d" % (i + 1), p)


if __name__ == "__main__":
    main()
