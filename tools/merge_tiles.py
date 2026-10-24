# -*- coding: utf-8 -*-
"""把一批 .osm 块**拼成一座城市**（同一坐标系），保存 .blend / .glb 并渲染预览。

这是"城市级"的端到端验证：逐块导入，靠 `Relative to initial import`
让所有块共用同一个横轴墨卡托原点，最后检查合并后的包围盒是否等于
地理尺寸（若不等 → 说明有块被放错了位置）。

用法（必须由 blender 执行）:
    blender.exe --background --python merge_tiles.py -- <块目录> <输出前缀> [南北米] [东西米]
    blender.exe --background --python merge_tiles.py -- <块目录> <输出前缀> --render-only

坑记录:
  * render.filepath 若为相对路径，Blender 按**进程当前目录**解析，
    实测被解析成 C:\\out\\... 导致 "No such file or directory" 渲染失败
    → 所有输出路径必须先 os.path.abspath()。
"""
import glob
import math
import os
import sys
import time

import addon_utils
import bpy
from mathutils import Vector

CACHE = r"D:\Users\asus\Desktop\项目\data\blosm_cache"


def scene_stats():
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    curves = [o for o in bpy.data.objects if o.type == "CURVE"]
    faces = sum(len(o.data.polygons) for o in meshes)
    buildings = [o for o in meshes if o.dimensions.z > 2]
    xs, ys, zs = [], [], []
    for o in meshes:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            xs.append(w.x); ys.append(w.y); zs.append(w.z)
    return dict(mesh=len(meshes), buildings=len(buildings), curve=len(curves),
                faces=faces, xs=xs, ys=ys, zs=zs,
                sx=max(xs) - min(xs), sy=max(ys) - min(ys), sz=max(zs) - min(zs))


def render_and_report(prefix, exp_ns=None, exp_ew=None, stats=None):
    st = stats or scene_stats()
    print("=" * 90)
    print("合并完成: mesh=%d（其中建筑 %d）  curve=%d  面=%d"
          % (st["mesh"], st["buildings"], st["curve"], st["faces"]))
    print("合并包围盒: X(东西)=%.0f m  Y(南北)=%.0f m  Z=%.0f m" % (st["sx"], st["sy"], st["sz"]))
    if exp_ns and exp_ew:
        dx, dy = abs(st["sx"] - exp_ew), abs(st["sy"] - exp_ns)
        print("地理尺寸:   南北=%.0f m  东西=%.0f m" % (exp_ns, exp_ew))
        print("偏差:       东西 %+.0f m (%.2f%%)  南北 %+.0f m (%.2f%%)  → %s"
              % (st["sx"] - exp_ew, dx / exp_ew * 100, st["sy"] - exp_ns, dy / exp_ns * 100,
                 "对齐 ✓" if dx < 30 and dy < 30 else "!! 有块位置不对 !!"))

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x, scene.render.resolution_y = 1920, 1200
    scene.render.resolution_percentage = 100
    sh = scene.display.shading
    sh.light = "STUDIO"; sh.color_type = "MATERIAL"
    sh.show_shadows = True; sh.show_cavity = True

    cam = bpy.data.objects.get("MergeCam")
    if not cam:
        cam_data = bpy.data.cameras.new("MergeCam")
        cam = bpy.data.objects.new("MergeCam", cam_data)
        scene.collection.objects.link(cam)
    cam_data = cam.data
    # ★ 必须放大裁剪距离：Blender 相机默认 clip_end = 100 m，
    # 而俯视相机架在 max(z)+1000 处 → 整个场景都在裁剪面之外，渲染出来是全灰。
    cam_data.clip_start = 1.0
    cam_data.clip_end = 100000.0
    scene.camera = cam
    xs, ys, zs = st["xs"], st["ys"], st["zs"]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2

    # ① 俯视（正交，看整体布局和接缝）
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = max(st["sx"], st["sy"]) * 1.06
    cam.location = (cx, cy, max(zs) + 1000)
    cam.rotation_euler = (0, 0, 0)
    scene.render.filepath = prefix + "_俯视图.png"
    bpy.ops.render.render(write_still=True)
    print("俯视图:", scene.render.filepath, os.path.getsize(scene.render.filepath), "字节")

    # ② 斜视（看三维效果）
    cam_data.type = "PERSP"
    cam_data.lens = 40
    cam.location = (cx - st["sx"] * 0.55, cy - st["sy"] * 0.75, min(zs) + max(st["sx"], st["sy"]) * 0.55)
    cam.rotation_euler = (math.radians(52), 0, math.radians(-36))
    scene.render.filepath = prefix + "_预览.png"
    bpy.ops.render.render(write_still=True)
    print("预览图:", scene.render.filepath, os.path.getsize(scene.render.filepath), "字节")


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    tiles_dir, prefix = os.path.abspath(argv[0]), os.path.abspath(argv[1])
    nums = [a for a in argv[2:] if not a.startswith("--")]
    exp_ns = float(nums[0]) if len(nums) > 0 else None
    exp_ew = float(nums[1]) if len(nums) > 1 else None

    if "--render-only" in argv:
        blend = prefix + ".blend"
        print("render-only 模式，打开已有:", blend)
        bpy.ops.wm.open_mainfile(filepath=blend)
        render_and_report(prefix, exp_ns, exp_ew)
        return

    tiles = sorted(glob.glob(os.path.join(tiles_dir, "*.osm")))
    print("待合并 %d 块: %s" % (len(tiles), os.path.basename(tiles_dir)))

    for o in list(bpy.data.objects):
        if o.type == "MESH" and o.name == "Cube":
            bpy.data.objects.remove(o, do_unlink=True)

    addon_utils.enable("blosm")
    prefs = bpy.context.preferences.addons["blosm"].preferences
    prefs.dataDir = CACHE
    prefs.assetsDir = ""

    a = bpy.context.scene.blosm
    a.dataType = "osm"
    a.osmSource = "file"
    a.mode = "3Dsimple"
    a.buildings = True
    a.singleObject = False
    a.relativeToInitialImport = True      # ★ 所有块共用一个原点
    a.importForExport = False
    a.loadMissingMembers = False

    t_all = time.time()
    for i, t in enumerate(tiles, 1):
        a.osmFilepath = t
        t0 = time.time()
        bpy.ops.blosm.import_data()
        n_mesh = len([o for o in bpy.data.objects if o.type == "MESH"])
        print("  [%2d/%d] %-18s %5.2f s  累计 mesh=%d"
              % (i, len(tiles), os.path.basename(t), time.time() - t0, n_mesh))
    t_import = time.time() - t_all

    st = scene_stats()
    print("导入 %d 块总用时 %.1f s" % (len(tiles), t_import))

    blend = prefix + ".blend"
    bpy.ops.wm.save_as_mainfile(filepath=blend)
    print("已保存: %s  (%.1f MB)" % (blend, os.path.getsize(blend) / 1048576))

    glb = prefix + ".glb"
    try:
        bpy.ops.preferences.addon_enable(module="io_scene_gltf2")
    except Exception as e:
        print("addon_enable:", e)
    bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=False,
                              export_apply=True, export_yup=True,
                              export_cameras=False, export_lights=False)
    print("GLB: %s (%.1f MB)" % (glb, os.path.getsize(glb) / 1048576))

    render_and_report(prefix, exp_ns, exp_ew, st)


main()
