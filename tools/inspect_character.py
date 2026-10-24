# -*- coding: utf-8 -*-
r"""Day 1.1 验收 —— 检查角色模型能不能在 Blender 里用。

要回答的问题（对应计划表 Day 1.1 的验收标准）：
    1. 能不能 import？
    2. 有没有骨骼（armature + bones + 蒙皮）？
    3. 有没有 Idle / Walk / Run 三段动画？各多长？
    4. 长什么样？（渲一张正面图）

用法:
    blender --background --python tools\inspect_character.py -- <模型1.glb> [模型2.glb ...] [--out <输出目录>]
"""
import math
import os
import sys

import bpy
from mathutils import Vector

OUT = r"D:\Users\asus\Desktop\项目\out\chars"


def fresh_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE" if "BLENDER_EEVEE" in \
        [i.identifier for i in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items] else "BLENDER_EEVEE_NEXT"
    sc.render.resolution_x, sc.render.resolution_y = 640, 900
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.view_settings.view_transform = "Standard"
    sc.render.film_transparent = False
    return sc


def add_light_and_world(sc):
    w = bpy.data.worlds.new("W")
    sc.world = w
    w.use_nodes = True
    for n in w.node_tree.nodes:
        if n.type == "BACKGROUND":
            n.inputs[0].default_value = (0.42, 0.50, 0.60, 1.0)
            n.inputs[1].default_value = 0.6
    ld = bpy.data.lights.new("Sun", type="SUN")
    ld.energy = 3.0
    ld.angle = math.radians(2.0)
    sun = bpy.data.objects.new("Sun", ld)
    sc.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(55), 0.0, math.radians(35))


def mesh_bbox(sc):
    lo = Vector((1e18, 1e18, 1e18))
    hi = Vector((-1e18, -1e18, -1e18))
    found = False
    for o in sc.objects:
        if o.type != "MESH":
            continue
        found = True
        for c in o.bound_box:
            p = o.matrix_world @ Vector(c)
            for i in range(3):
                lo[i] = min(lo[i], p[i])
                hi[i] = max(hi[i], p[i])
    return (lo, hi) if found else (None, None)


def shoot(sc, path, prefix):
    lo, hi = mesh_bbox(sc)
    if lo is None:
        print("        !! 没有网格，跳过渲染")
        return
    ctr = (lo + hi) * 0.5
    size = max((hi - lo).x, (hi - lo).y, (hi - lo).z)
    d = size * 2.4
    cd = bpy.data.cameras.new("C")
    cam = bpy.data.objects.new("C", cd)
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.location = ctr + Vector((0.0, -d, size * 0.18))
    cam.rotation_euler = (Vector(ctr + Vector((0, 0, size * 0.06))) - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = 55.0
    cam.data.clip_start = 0.01
    cam.data.clip_end = 10000.0
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sc.render.filepath = os.path.abspath(path)
    bpy.ops.render.render(write_still=True)
    print("        渲染 -> %s" % path)


def inspect(path, outdir):
    print("=" * 84)
    print("模型 %s（%.2f MB）" % (os.path.basename(path), os.path.getsize(path) / 1048576.0))
    sc = fresh_scene()
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == ".fbx":
            # Mixamo 只给 FBX。用默认参数即可：Mixamo 的角色和动画共用同一套
            # mixamorig 骨架，和免登录下的 Soldier/Xbot 那套命名一致，
            # 所以导进来之后动作能直接互相套。
            bpy.ops.import_scene.fbx(filepath=path)
        else:
            bpy.ops.import_scene.gltf(filepath=path)
    except Exception as e:
        print("  !! 导入失败 %s: %s" % (type(e).__name__, e))
        return None
    add_light_and_world(sc)

    meshes = [o for o in sc.objects if o.type == "MESH"]
    arms = [o for o in sc.objects if o.type == "ARMATURE"]
    print("  物体 %d 个：网格 %d / 骨骼 %d / 其他 %d"
          % (len(sc.objects), len(meshes), len(arms), len(sc.objects) - len(meshes) - len(arms)))

    # --- 骨骼 ---
    nb = 0
    for a in arms:
        nb += len(a.data.bones)
        print("  骨骼 %-22s 骨头 %3d 根，缩放 %s"
              % (a.name, len(a.data.bones), tuple(round(v, 3) for v in a.scale)))
    if not arms:
        print("  !! 没有骨骼 —— 这个模型只能当静态道具，不能做动作")

    # --- 蒙皮 ---
    for m in meshes:
        mods = [md.type for md in m.modifiers]
        print("  网格 %-22s 顶点组 %4d  修改器 %s"
              % (m.name[:22], len(m.vertex_groups), mods if mods else "无"))
    if meshes and nb and not any("ARMATURE" in [md.type for md in m.modifiers] for m in meshes):
        print("  !! 有骨骼但网格没挂 Armature 修改器 —— 蒙皮可能丢了")

    # --- 动画 ---
    acts = list(bpy.data.actions)
    print("  动画 %d 条：" % len(acts))
    names = []
    for a in acts:
        f0, f1 = a.frame_range
        names.append(a.name)
        print("        %-34s 帧 %7.1f ~ %-7.1f  (%.2f 秒 @24fps)"
              % (a.name, f0, f1, (f1 - f0) / 24.0))
    if not acts:
        print("        !! 一条动画都没有")

    # --- 尺寸 ---
    lo, hi = mesh_bbox(sc)
    if lo is not None:
        print("  包围盒 %.2f x %.2f x %.2f m（高 %.2f m）"
              % ((hi - lo).x, (hi - lo).y, (hi - lo).z, (hi - lo).z))

    base = os.path.splitext(os.path.basename(path))[0]
    shoot(sc, os.path.join(outdir, "%s.png" % base), base)
    return dict(name=base, meshes=len(meshes), arms=len(arms), bones=nb,
                actions=names, height=((hi - lo).z if lo is not None else 0.0))


def main():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    outdir = OUT
    if "--out" in argv:
        i = argv.index("--out")
        outdir = argv[i + 1]
        del argv[i:i + 2]
    if not argv:
        print(__doc__)
        sys.exit(1)

    print("[insp] Blender %s" % bpy.app.version_string)
    enabled = [a for a in bpy.context.preferences.addons.keys() if "gltf" in a or "fbx" in a]
    print("[insp] glTF / FBX 导入插件：%s" % (enabled if enabled else "（用内置操作符）"))

    rows = []
    for p in argv:
        r = inspect(p, outdir)
        if r:
            rows.append(r)

    print("=" * 84)
    print("汇总")
    for r in rows:
        print("  %-14s 网格 %-3d 骨骼 %-3d 骨头 %-4d 高 %5.2f m 动画 %s"
              % (r["name"], r["meshes"], r["arms"], r["bones"], r["height"], r["actions"]))
    print("[insp] 图片在 %s" % outdir)


if __name__ == "__main__":
    main()
