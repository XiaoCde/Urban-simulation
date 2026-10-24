# -*- coding: utf-8 -*-
r"""干净的 A/B：让 Blender 自己把 Mixamo 动画文件里的 action 挂到角色骨骼上
（完全不经过 tools\ped_demo.py 的 apply_pose），看角色会不会照样塌成 0.53 m。

判据：
  rest 高度正常、套动作后也正常 -> 问题在我的 apply_pose
  rest 正常、套动作后塌        -> 问题在 action 与骨骼的配对（Blender 原生行为）

用法:
    blender --background --python tools\probe_pose.py -- [角色.fbx] [动画.fbx]
"""
import os
import sys

import bpy
from mathutils import Vector

DEF_CHAR = r"data\characters\Body Block.fbx"
DEF_CLIP = r"data\characters\Walking.fbx"
BONES = ("Hips", "Spine", "Head", "LeftFoot", "RightFoot", "LeftHand")


def mods(tag, meshes):
    """网格到底有没有挂上骨骼形变？—— 这是「套了动作但形状不变」的第一嫌疑人。"""
    for m in meshes:
        print("[pose] %s 网格 %-9s parent=%-9s(%s) 修改器=%s" % (
            tag, m.name,
            m.parent.name if m.parent else "-", m.parent_type,
            [(md.type, getattr(md, "object", None).name if getattr(md, "object", None) else "-")
             for md in m.modifiers]))


def bbox(objs):
    """必须读**求值后**的网格。o.bound_box 是未变形的物体局部包围盒，
    套上骨骼动作之后它一个数字都不会变 —— 用它做 A/B 会得出假结论。"""
    dg = bpy.context.evaluated_depsgraph_get()
    lo = Vector((1e18, 1e18, 1e18))
    hi = Vector((-1e18, -1e18, -1e18))
    for o in objs:
        if o.type != "MESH":
            continue
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        mw = ev.matrix_world
        for v in me.vertices:
            w = mw @ v.co
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])
        ev.to_mesh_clear()
    return lo, hi


def report(tag, arm, meshes):
    dg = bpy.context.evaluated_depsgraph_get()
    lo, hi = bbox(meshes)
    print("[pose] %-10s 世界包围盒 x %7.2f~%7.2f  y %7.2f~%7.2f  z %7.2f~%7.2f  高 %.2f"
          % (tag, lo.x, hi.x, lo.y, hi.y, lo.z, hi.z, hi.z - lo.z))
    ev = arm.evaluated_get(dg)
    for nm in BONES:
        pb = ev.pose.bones.get("mixamorig:" + nm)
        if pb is None:
            continue
        w = ev.matrix_world @ pb.head
        print("             %-16s 世界头=(%8.3f,%8.3f,%8.3f)  basis平移=%s"
              % (nm, w.x, w.y, w.z,
                 tuple(round(v, 3) for v in pb.matrix_basis.translation)))


def main():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    char = argv[0] if len(argv) > 0 else DEF_CHAR
    clip = argv[1] if len(argv) > 1 else DEF_CLIP

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=os.path.abspath(char))
    arm = [o for o in bpy.data.objects if o.type == "ARMATURE"][0]
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    print("[pose] 角色 %s：骨头 %d，网格 %d（%s）"
          % (arm.name, len(arm.data.bones), len(meshes),
             ",".join(o.name for o in meshes)))
    print("[pose] 骨骼数据 pose_position = %s   （REST 会让所有姿势变换失效）"
          % arm.data.pose_position)
    bpy.context.view_layer.update()
    report("rest", arm, meshes)
    mods("rest", meshes)

    nb = len(bpy.data.actions)
    bpy.ops.import_scene.fbx(filepath=os.path.abspath(clip))
    acts = [a for a in list(bpy.data.actions)[nb:]]
    act = max(acts, key=lambda a: a.frame_range[1] - a.frame_range[0])
    print("[pose] 新动作：%s  帧 %s"
          % ([a.name for a in acts], tuple(round(v, 1) for v in act.frame_range)))

    if arm.animation_data is None:
        arm.animation_data_create()
    arm.animation_data.action = act
    try:
        if hasattr(arm.animation_data, "action_slot"):          # Blender 4.4+
            slots = getattr(act, "slots", [])
            if len(slots):
                arm.animation_data.action_slot = slots[0]
                print("[pose] action_slot <- %s" % slots[0].name_display)
            else:
                print("[pose] 这个 action 没有 slots（老式 action）")
    except Exception as e:
        print("[pose] 设 slot 失败：%s: %s" % (type(e).__name__, e))

    f0 = int(act.frame_range[0])
    bpy.context.scene.frame_set(f0)
    bpy.context.view_layer.update()
    print("[pose] frame_set(%d) 之后" % f0)
    for nm in ("Hips", "Spine", "Head", "LeftFoot"):
        pb = arm.pose.bones.get("mixamorig:" + nm)
        if pb is None:
            continue
        print("             %-16s loc=%s quat=%s scale=%s"
              % (nm,
                 tuple(round(v, 3) for v in pb.location),
                 tuple(round(v, 3) for v in pb.rotation_quaternion),
                 tuple(round(v, 3) for v in pb.scale)))
    report("套动作后", arm, meshes)
    mods("套动作后", meshes)
    dg = bpy.context.evaluated_depsgraph_get()
    print("[pose] depsgraph 是否更新过：%s（强制 update 后重测）"
          % str(hasattr(dg, "update")))
    try:
        dg.update()
    except Exception as e:
        print("[pose] dg.update 失败：%s" % e)
    report("强制更新后", arm, meshes)


if __name__ == "__main__":
    main()
