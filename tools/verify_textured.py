# -*- coding: utf-8 -*-
r"""验收贴图版：检查 .blend 的设置，并把导出的 .glb 重新导进来渲一张。

为什么要"把 glb 导回来再渲"：
    光看导出日志里的 UV 数量不够 —— 只有把 glb 重新读进一个**干净**的场景、
    用自己的相机和太阳渲出来，才能证明"别人拿到这个 glb 打开，看到的是有贴图的"。
    之前那版就是这么发现问题的：图元 70,031 个里只有 24,677 个带 TEXCOORD_0，
    45,354 个（全部 23,486 栋建筑）丢了 UV，建筑在 glb 里只剩一块平均色。

用法:
    D:\blender\blender.exe --background --python tools\verify_textured.py -- ^
        out\dc_real3_tex.blend out\dc_real3_tex.glb out\verify_glb.png
"""
import math
import os
import sys

import bpy
from mathutils import Vector

# 和 export_conditions.py 里 mall2 机位一致（场景坐标）
CAM_LOC = (698.0, -798.0, 380.0)
CAM_TGT = (2196.0, -97.0, 0.0)
LENS = 45.0


def log(m):
    print("[ver] %s" % m, flush=True)


def check_blend(path):
    bpy.ops.wm.open_mainfile(filepath=path)
    sc = bpy.context.scene
    log("=== 检查 %s ===" % path)
    lights = [o for o in bpy.data.objects if o.type == "LIGHT"]
    log("  灯光 %d 个：%s" % (len(lights), ", ".join(
        "%s(强度%.1f)" % (o.name, o.data.energy) for o in lights[:4])))
    w = sc.world
    bg = w.node_tree.nodes.get("Background") if (w and w.use_nodes) else None
    if bg:
        log("  世界背景 颜色=%s 强度=%.2f" % (
            tuple(round(v, 2) for v in bg.inputs[0].default_value[:3]), bg.inputs[1].default_value))
    log("  色彩管理 view_transform=%s look=%s exposure=%.2f" % (
        sc.view_settings.view_transform, sc.view_settings.look, sc.view_settings.exposure))
    log("  渲染引擎 %s" % sc.render.engine)

    modes = {}
    for scr in bpy.data.screens:
        for area in scr.areas:
            if area.type != "VIEW_3D":
                continue
            for sp in area.spaces:
                if sp.type == "VIEW_3D":
                    modes[sp.shading.type] = modes.get(sp.shading.type, 0) + 1
    log("  3D 视口着色方式：%s  <- 应为 MATERIAL" % modes)

    n_uv = n_mesh = 0
    for o in bpy.data.objects:
        if o.type == "MESH":
            n_mesh += 1
            if o.data.uv_layers:
                n_uv += 1
    log("  网格 %d 个，其中有 UV 层的 %d 个（.blend 走 Box 投影，不需要 UV）" % (n_mesh, n_uv))

    for m in bpy.data.materials:
        if not m.name.startswith("tex_wall_brick"):
            continue
        ik = [n for n in m.node_tree.nodes if n.type == "TEX_IMAGE"]
        if ik:
            log("  抽样材质 %s：%d 张图，投影=%s（应为 BOX）"
                % (m.name, len(ik), ik[0].projection))
            break


def render_glb(glb, out):
    log("=== 把 %s 导回干净场景再渲一张 ===" % glb)
    bpy.ops.wm.read_homefile(use_empty=True)
    sc = bpy.context.scene
    bpy.ops.import_scene.gltf(filepath=glb)
    log("  导入完成：物体 %d 个，材质 %d 个" % (len(bpy.data.objects), len(bpy.data.materials)))

    nmesh = sum(1 for o in bpy.data.objects if o.type == "MESH")
    nuv = sum(1 for o in bpy.data.objects if o.type == "MESH" and o.data.uv_layers)
    log("  导回来后有 UV 的网格：%d / %d" % (nuv, nmesh))

    ld = bpy.data.lights.new("s", type="SUN")
    ld.energy = 3.0
    ld.angle = math.radians(1.5)
    sun = bpy.data.objects.new("s", ld)
    sc.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(45), 0.0, math.radians(55))

    # 新建的 world 不一定自带名为 Background 的节点，自己找/自己建，别直接取名字
    w = bpy.data.worlds.new("w")
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    bg = next((n for n in nt.nodes if n.type == "BACKGROUND"), None)
    if bg is None:
        bg = nt.nodes.new("ShaderNodeBackground")
        wout = next((n for n in nt.nodes if n.type == "OUTPUT_WORLD"), None)
        if wout is None:
            wout = nt.nodes.new("ShaderNodeOutputWorld")
        nt.links.new(bg.outputs[0], wout.inputs[0])
        log("  新建了 Background 节点（新建 world 不自带）")
    bg.inputs[0].default_value = (0.44, 0.58, 0.82, 1.0)
    bg.inputs[1].default_value = 0.45

    cd = bpy.data.cameras.new("c")
    cam = bpy.data.objects.new("c", cd)
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam.location = Vector(CAM_LOC)
    cam.rotation_euler = (Vector(CAM_TGT) - Vector(CAM_LOC)).to_track_quat("-Z", "Y").to_euler()
    cd.lens = LENS
    cd.sensor_width = 36.0
    cd.clip_start = 0.5
    cd.clip_end = 60000.0

    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = 1280, 800
    sc.render.image_settings.file_format = "PNG"
    sc.view_settings.view_transform = "Standard"
    sc.render.filepath = os.path.abspath(out)
    bpy.ops.render.render(write_still=True)
    log("  写出 %s（%.0f KB）" % (out, os.path.getsize(out) / 1024))


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) < 2:
        print(__doc__)
        sys.exit(1)
    check_blend(os.path.abspath(argv[0]))
    render_glb(os.path.abspath(argv[1]), os.path.abspath(argv[2] if len(argv) > 2 else "out/verify_glb.png"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
