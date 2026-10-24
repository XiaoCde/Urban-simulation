# -*- coding: utf-8 -*-
"""给当前场景加相机 + 太阳光 + 世界环境，渲染一张预览图。

被 full_pipeline.py 调用（同一进程内，导入完接着渲染）。
也可以单独跑：D:\blender\blender.exe --background <某个.blend> --python tools\render_scene.py
"""
import math
import os

import bpy
from mathutils import Vector

PROJECT = r"D:\Users\asus\Desktop\项目"


def set_engine():
    """Blender 5.x 的引擎标识是 BLENDER_EEVEE_NEXT，兼容旧名。"""
    for name in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"):
        try:
            bpy.context.scene.render.engine = name
            print("[render] 引擎 = %s" % name)
            return name
        except TypeError:
            continue
    raise RuntimeError("找不到可用的渲染引擎")


def scene_bounds():
    lo = Vector((1e18, 1e18, 1e18))
    hi = Vector((-1e18, -1e18, -1e18))
    for o in bpy.context.scene.objects:
        if o.type != "MESH":
            continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])
    return lo, hi


def setup_world():
    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.55, 0.68, 0.85, 1.0)   # 天空蓝
        bg.inputs[1].default_value = 1.2


def add_sun():
    light = bpy.data.lights.new("Sun", type="SUN")
    light.energy = 4.0
    light.angle = math.radians(3.0)
    obj = bpy.data.objects.new("Sun", light)
    bpy.context.scene.collection.objects.link(obj)
    obj.rotation_euler = (math.radians(52), 0.0, math.radians(40))
    return obj


def place_camera(lo, hi, direction=(1.0, -1.0, 0.62), margin=1.45):
    center = (lo + hi) * 0.5
    size = hi - lo
    max_dim = max(size.x, size.y, size.z)
    d = Vector(direction).normalized()
    cam_data = bpy.data.cameras.new("PreviewCam")
    cam_data.clip_start = 1.0
    cam_data.clip_end = 100000.0
    cam_data.lens = 40.0
    cam = bpy.data.objects.new("PreviewCam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = center + d * (max_dim * margin)
    # 让相机看向场景中心
    look = (center - cam.location).normalized()
    cam.rotation_euler = look.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam
    return cam, center, max_dim


def render(out_path, res=(1600, 1000)):
    sc = bpy.context.scene
    set_engine()
    # 坑：Blender 4.x+ 默认视图变换是 AgX，会明显去饱和 + 提亮，
    # 材质基色（office 深灰 0.30/0.32/0.35、brick 砖红 0.45/0.20/0.14）
    # 会被压成一模一样的浅灰。要看真实基色必须切回 Standard。
    try:
        sc.view_settings.view_transform = "Standard"
        sc.view_settings.look = "None"
        print("[render] 视图变换 = Standard")
    except Exception as e:
        print("[render] 切视图变换失败: %s" % e)
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    # 已实测的坑：filepath 是相对路径时 Blender 按"进程当前目录"解析，
    # 会写出到 C:\out\... 然后报 "Couldn't create directory for file"。
    sc.render.filepath = os.path.abspath(out_path)
    try:
        sc.eevee.taa_render_samples = 32
    except Exception:
        pass
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    bpy.ops.render.render(write_still=True)
    print("[render] 写出 %s" % sc.render.filepath)
    return sc.render.filepath


def main(out_name="out/preview.png", direction=(1.0, -1.0, 0.62), res=(1600, 1000)):
    lo, hi = scene_bounds()
    print("[render] 场景包围盒 %s -> %s" % (tuple(round(v, 1) for v in lo),
                                           tuple(round(v, 1) for v in hi)))
    setup_world()
    add_sun()
    place_camera(lo, hi, direction=direction)
    return render(os.path.join(PROJECT, out_name), res=res)


if __name__ == "__main__":
    main()
