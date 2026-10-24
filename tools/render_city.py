# -*- coding: utf-8 -*-
"""城市级高质量渲染：EEVEE + 太阳光 + 天空 + 地面。

用法:
    blender.exe --background --python render_city.py -- <in.blend> <out_prefix> [视图...]

视图:
    aerial    高空斜视，看整城
    mall      低空斜视，对准国家广场
    capitol   近景，对准国会大厦
    monument  近景，对准华盛顿纪念碑
    whitehouse 近景，对准白宫

坑记录:
  * 相机默认 clip_end = 100 m，而城市尺度是几公里 → 必须放大到 100000。
  * render.filepath 用相对路径时按**进程当前目录**解析 → 一律 os.path.abspath()。
"""
import math
import os
import sys

import bpy
from mathutils import Vector


def log(*a):
    print(*a, flush=True)


def scene_bbox(objs):
    xs, ys, zs = [], [], []
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            xs.append(w.x); ys.append(w.y); zs.append(w.z)
    if not xs:
        return Vector((0, 0, 0)), Vector((1, 1, 1))
    return Vector((min(xs), min(ys), min(zs))), Vector((max(xs), max(ys), max(zs)))


def find_objects(*keys):
    out = []
    for o in bpy.data.objects:
        if o.type not in ("MESH", "CURVE"):
            continue
        n = o.name.lower()
        for k in keys:
            if k.lower() in n:
                out.append(o)
                break
    return out


def setup_render(engine_pref=None):
    scene = bpy.context.scene
    cands = ([engine_pref] if engine_pref else []) + [
        "BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"]
    for e in cands:
        try:
            scene.render.engine = e
            log("渲染引擎:", e)
            break
        except Exception:
            continue
    scene.render.resolution_x, scene.render.resolution_y = 2560, 1440
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    ee = getattr(scene, "eevee", None)
    if ee:
        for attr, val in (("taa_render_samples", 48), ("use_shadows", True),
                          ("use_raytracing", True), ("use_gtao", True)):
            if hasattr(ee, attr):
                try:
                    setattr(ee, attr, val)
                except Exception:
                    pass
    # 色彩管理：AgX 更有电影感，没有就退回 Filmic
    vs = scene.view_settings
    for vt in ("AgX", "Filmic", "Standard"):
        try:
            vs.view_transform = vt
            log("色彩变换:", vt)
            break
        except Exception:
            continue
    vs.look = "None" if hasattr(vs, "look") else vs.look
    log("分辨率: %dx%d" % (scene.render.resolution_x, scene.render.resolution_y))


def setup_world(color=(0.32, 0.46, 0.68)):
    scene = bpy.context.scene
    w = bpy.data.worlds.get("RC_World") or bpy.data.worlds.new("RC_World")
    scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Color"].default_value = (*color, 1.0)
    bg.inputs["Strength"].default_value = 0.55
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])


def setup_sun():
    scene = bpy.context.scene
    for o in list(bpy.data.objects):
        if o.type == "LIGHT" and o.name.startswith("RC_"):
            bpy.data.objects.remove(o, do_unlink=True)
    ld = bpy.data.lights.new("RC_Sun", type="SUN")
    ld.energy = 3.2
    ld.angle = math.radians(2.0)          # 略微柔和的影子边缘
    try:
        ld.color = (1.0, 0.96, 0.90)
    except Exception:
        pass
    sun = bpy.data.objects.new("RC_Sun", ld)
    scene.collection.objects.link(sun)
    # ≈ 下午 4 点的太阳：东南高、光线斜
    sun.rotation_euler = (math.radians(48), 0, math.radians(135))


def setup_ground(lo, hi, color=(0.20, 0.20, 0.19)):
    """给城市垫一块地面 —— 没有地面时背景一片黑，看起来很远、很假。"""
    scene = bpy.context.scene
    old = bpy.data.objects.get("RC_Ground")
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    cx, cy = (lo.x + hi.x) / 2, (lo.y + hi.y) / 2
    span = max(hi.x - lo.x, hi.y - lo.y) * 3.0
    bpy.ops.mesh.primitive_plane_add(size=span, location=(cx, cy, lo.z - 0.05))
    g = bpy.context.active_object
    g.name = "RC_Ground"
    m = bpy.data.materials.get("RC_GroundMat") or bpy.data.materials.new("RC_GroundMat")
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = 0.95
    g.data.materials.append(m)
    return g


def make_camera():
    scene = bpy.context.scene
    cam = bpy.data.objects.get("RC_Cam")
    if not cam:
        cd = bpy.data.cameras.new("RC_Cam")
        cam = bpy.data.objects.new("RC_Cam", cd)
        scene.collection.objects.link(cam)
    cd = cam.data
    cd.clip_start = 1.0
    cd.clip_end = 200000.0
    scene.camera = cam
    return cam


def aim(cam, eye, target, lens):
    cam.data.type = "PERSP"
    cam.data.lens = lens
    cam.location = Vector(eye)
    cam.rotation_euler = (Vector(target) - Vector(eye)).to_track_quat("-Z", "Y").to_euler()


def shoot(prefix, tag):
    scene = bpy.context.scene
    scene.render.filepath = os.path.abspath("%s_%s.png" % (prefix, tag))
    bpy.ops.render.render(write_still=True)
    log("  → %s  %d 字节" % (scene.render.filepath, os.path.getsize(scene.render.filepath)))


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    inp = os.path.abspath(argv[0])
    prefix = os.path.abspath(argv[1])
    views = argv[2:] or ["aerial", "mall", "capitol"]

    bpy.ops.wm.open_mainfile(filepath=inp)
    log("=" * 84)
    log("打开:", inp)

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    lo, hi = scene_bbox(meshes)
    center = (lo + hi) / 2
    span = max(hi.x - lo.x, hi.y - lo.y)
    log("场景包围盒 X=%.0f Y=%.0f Z=%.0f  跨度=%.0f m" % (hi.x - lo.x, hi.y - lo.y, hi.z - lo.z, span))

    # 地标定位
    marks = {
        "capitol":    find_objects("united states capitol", "us capitol", "capitol building"),
        "monument":   find_objects("washington monument", "monument"),
        "whitehouse": find_objects("white house", "the white house"),
        "lincoln":    find_objects("lincoln memorial"),
        "mall":       find_objects("national mall", "the mall"),
    }
    for k, v in marks.items():
        if v:
            l, h = scene_bbox(v)
            log("地标 %-10s -> %d 个物体  中心=(%.0f, %.0f)  高=%.1f m" %
                (k, len(v), (l.x + h.x) / 2, (l.y + h.y) / 2, h.z - l.z))
        else:
            log("地标 %-10s -> 未找到" % k)

    setup_render()
    setup_world()
    setup_sun()
    setup_ground(lo, hi)
    cam = make_camera()

    def focus(*keys, fallback=None):
        objs = find_objects(*keys)
        if objs:
            l, h = scene_bbox(objs)
            return (l + h) / 2
        return Vector(fallback or (center.x, center.y, 0))

    for v in views:
        log("-" * 84)
        log("视图:", v)
        if v == "aerial":
            t = Vector((center.x, center.y, 0))
            eye = (center.x - span * 0.42, center.y - span * 0.58, span * 0.40)
            aim(cam, eye, t, 42)
        elif v == "mall":
            t = focus("capitol", fallback=(center.x, center.y, 0))
            t = Vector((t.x, t.y, 0))
            eye = (t.x - span * 0.30, t.y - span * 0.34, span * 0.16)
            aim(cam, eye, t, 50)
        elif v == "capitol":
            t = focus("united states capitol", "us capitol")
            aim(cam, (t.x - 900, t.y - 900, 420), (t.x, t.y, 40), 65)
        elif v == "monument":
            t = focus("washington monument")
            aim(cam, (t.x - 800, t.y - 800, 380), (t.x, t.y, 60), 60)
        elif v == "whitehouse":
            t = focus("white house")
            aim(cam, (t.x - 500, t.y - 500, 220), (t.x, t.y, 18), 55)
        else:
            log("  未知视图，跳过")
            continue
        shoot(prefix, v)

    log("=" * 84)
    log("全部完成")


main()
