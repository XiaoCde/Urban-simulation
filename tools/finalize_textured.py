# -*- coding: utf-8 -*-
r"""把贴图版收尾成"打开就能看"的状态，并导出一份贴图真的能显示的 glb。

这一步是为了修三个实测出来的问题（都不是猜的，是查出来的）：

1. **存的 .blend 里没有光照。**
   apply_textures.py 是在"加太阳、配世界背景"之前就把文件存下来的 ——
   那套光照只活在渲染时的内存里。实测打开的 .blend 只有 1 盏灯、世界背景
   强度 0.26，所以看着灰蒙蒙。这里把太阳和世界背景真正写进文件。

2. **视口默认是 Solid（实体）模式，根本不显示材质。**
   这里顺手把文件里所有 3D 视口的着色方式设成 Material Preview，打开就能看到贴图。

3. **导出的 .glb 里贴图是坏的。**
   我们用的是 Box（三平面）投影，而 glTF 格式不支持它。实测：
   70,031 个图元里有 **45,354 个丢了 UV 坐标**（就是全部 23,486 栋建筑），
   建筑在 glb 里只剩一块平均色、没有纹理图案。
   解决办法：把 Box 投影**烘成真正的 UV** ——
       UV = 世界坐标 / tile_m，按面法线选主轴。
   这**正是** Box 投影的定义，所以看起来一模一样，而且砖缝仍然全城对齐、
   水平砖缝仍然对齐地面（z=0）。烘完把材质的投影改成 FLAT（走 UV），再导出 glb。

   注意顺序：先存 .blend（保留更好的 Box 投影），再烘 UV、导出 glb，
   烘完不再存 —— 这样 .blend 和 .glb 各自拿到最适合自己的那套坐标。

用法:
    D:\blender\blender.exe --background --python tools\finalize_textured.py -- ^
        out\dc_real3_tex.blend out\dc_real3_tex.glb
"""
import json
import math
import os
import sys
import time

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "textures.json")


def log(m):
    print("[fin] %s" % m, flush=True)


def load_tiles():
    with open(MANIFEST, "r", encoding="utf-8") as f:
        man = json.load(f)
    return {c: float(v["tile_m"]) for c, v in man["lib"].items()}


def class_of(mat):
    """材质名形如 tex_wall_brick__Bricks051 -> wall_brick"""
    if not mat or not mat.name.startswith("tex_"):
        return None
    body = mat.name[4:]
    return body.split("__", 1)[0] if "__" in body else None


def setup_light(scene):
    for o in list(bpy.data.objects):
        if o.type == "LIGHT":
            bpy.data.objects.remove(o, do_unlink=True)
    ld = bpy.data.lights.new("CitySun", type="SUN")
    ld.energy = 2.9
    ld.angle = math.radians(1.5)
    sun = bpy.data.objects.new("CitySun", ld)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(45), 0.0, math.radians(55))

    w = scene.world or bpy.data.worlds.new("CityWorld")
    scene.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.44, 0.58, 0.82, 1.0)
        bg.inputs[1].default_value = 0.45
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    log("已写入太阳 CitySun（强度 2.9，45/0/55 度）+ 世界背景 (0.44,0.58,0.82)@0.45")


def setup_viewport():
    n = 0
    for scr in bpy.data.screens:
        for area in scr.areas:
            if area.type != "VIEW_3D":
                continue
            for sp in area.spaces:
                if sp.type == "VIEW_3D":
                    try:
                        sp.shading.type = "MATERIAL"
                        n += 1
                    except Exception:
                        pass
    log("已把 %d 个 3D 视口切成 Material Preview（打开即见贴图）" % n)


def convert_curves():
    """道路是 CURVE，它的 UV 是 curve 自带的，和我们按世界坐标烘的对不上，
    所以先转成网格，统一烘。"""
    curves = [o for o in bpy.data.objects if o.type == "CURVE"]
    if not curves:
        return 0
    bpy.ops.object.select_all(action="DESELECT")
    for o in curves:
        o.select_set(True)
    bpy.context.view_layer.objects.active = curves[0]
    bpy.ops.object.convert(target="MESH")
    log("把 %d 个 CURVE（道路）转成网格" % len(curves))
    return len(curves)


AXIS_UV = {0: (1, 2), 1: (0, 2), 2: (0, 1)}


def bake_uvs(tiles):
    """UV = 世界坐标 / tile_m，按世界法线选主轴 —— 这就是 Box 投影的定义。"""
    done = skipped = 0
    loops_total = 0
    t0 = time.time()
    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        cls = None
        for slot in o.material_slots:
            cls = class_of(slot.material)
            if cls:
                break
        t = tiles.get(cls)
        if not t:
            skipped += 1
            continue
        me = o.data
        uvl = me.uv_layers.get("UVMap")
        if uvl is None:
            uvl = me.uv_layers.new(name="UVMap")
        uvd = uvl.data
        mw = o.matrix_world
        m3 = mw.to_3x3()
        inv = 1.0 / t
        verts = me.vertices
        for poly in me.polygons:
            n = m3 @ poly.normal
            a0, a1 = AXIS_UV[max(range(3), key=lambda i: abs(n[i]))]
            for li in poly.loop_indices:
                co = mw @ verts[me.loops[li].vertex_index].co
                uvd[li].uv = (co[a0] * inv, co[a1] * inv)
        loops_total += len(me.loops)
        done += 1
        if done % 4000 == 0:
            log("  烘 UV 进度 %d 个物体（%.0f 秒）" % (done, time.time() - t0))
    log("烘 UV 完成：%d 个物体，%d 个 loop，跳过 %d，用时 %.0f 秒"
        % (done, loops_total, skipped, time.time() - t0))


def switch_to_uv():
    """把 tex_* 材质的图像纹理从 BOX 投影改成走 UV（删掉 Mapping->Vector 连线）。"""
    n = 0
    for m in bpy.data.materials:
        if not m.name.startswith("tex_") or not m.use_nodes:
            continue
        nt = m.node_tree
        for node in list(nt.nodes):
            if node.type != "TEX_IMAGE":
                continue
            node.projection = "FLAT"
            for lk in list(nt.links):
                if lk.to_node == node and lk.to_socket.name == "Vector":
                    nt.links.remove(lk)
            n += 1
    log("已把 %d 个图像纹理节点改成走 UV（FLAT）" % n)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not argv:
        print(__doc__)
        sys.exit(1)
    blend = os.path.abspath(argv[0])
    glb = os.path.abspath(argv[1]) if len(argv) > 1 else os.path.splitext(blend)[0] + ".glb"
    tiles = load_tiles()

    bpy.ops.wm.open_mainfile(filepath=blend)
    scene = bpy.context.scene
    log("载入 %s：物体 %d 个" % (blend, len(bpy.data.objects)))

    setup_light(scene)
    setup_viewport()
    bpy.ops.wm.save_as_mainfile(filepath=blend)
    log("已保存 %s（%.1f MB）—— .blend 保留 Box 投影" % (blend, os.path.getsize(blend) / 1048576))

    log("--- 下面是只为了 glb 的那一遍，不会再存 .blend ---")
    convert_curves()
    bake_uvs(tiles)
    switch_to_uv()

    bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=False,
                              export_apply=True, export_yup=True,
                              export_cameras=False, export_lights=False)
    log("已导出 %s（%.1f MB）" % (glb, os.path.getsize(glb) / 1048576))
    return 0


if __name__ == "__main__":
    sys.exit(main())
