# -*- coding: utf-8 -*-
"""修复 blosm 的材质 bug：颜色只写在 material.diffuse_color（视口色）里，
Principled BSDF 的 Base Color 一直是默认灰 (0.8,0.8,0.8)。

EEVEE / Cycles / glTF 导出都走 Principled BSDF → 渲出来和导出的 .glb 全灰。
根因见 blosm/util/blender.py:85-88 createDiffuseMaterial()。

本脚本把 diffuse_color 复制进 Principled 的 Base Color，并按材质类型给合理粗糙度。

用法:
  blender.exe --background --python fix_materials.py -- <输入.blend> [输出.blend] [--export-glb <out.glb>]
不给输出就用 -fixed 后缀另存，原文件不动。
"""
import os
import sys

import bpy

# 粗糙度：玻璃/水光滑一点，路面次之，墙和屋顶粗糙
ROUGHNESS = {
    "water": 0.12,
    "roads_motorway": 0.62, "roads_trunk": 0.62, "roads_primary": 0.62,
    "roads_secondary": 0.65, "roads_tertiary": 0.65, "roads_residential": 0.7,
    "roads_service": 0.7, "roads_unclassified": 0.7, "roads_pedestrian": 0.72,
    "roads_track": 0.8,
    "paths_footway": 0.85, "paths_steps": 0.8, "paths_cycleway": 0.8,
    "areas_pedestrian": 0.85, "areas_footway": 0.85, "areas_steps": 0.8,
    "vegetation": 0.95,
    "roof": 0.78,
    "wall": 0.72,
}
DEFAULT_ROUGHNESS = 0.75


def principled_of(mat):
    """返回材质的 Principled BSDF 节点，没有就建一个。"""
    if not mat.use_nodes:
        mat.use_nodes = True
    nt = mat.node_tree
    for n in nt.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    # 没有就清掉输出节点重建
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return bsdf


def set_input(node, name, value):
    """Blender 5.x 里部分输入改名/被移除，取不到就跳过。"""
    if name in node.inputs:
        node.inputs[name].default_value = value
        return True
    return False


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    src = os.path.abspath(argv[0])
    dst = None
    glb = None
    if "--export-glb" in argv:
        i = argv.index("--export-glb")
        glb = os.path.abspath(argv[i + 1])
        argv = argv[:i] + argv[i + 2:]
    if len(argv) > 1:
        dst = os.path.abspath(argv[1])
    if dst is None:
        base, ext = os.path.splitext(src)
        dst = base + "-fixed" + ext

    bpy.ops.wm.open_mainfile(filepath=src)
    print("=" * 80)
    print("打开:", src)

    fixed = 0
    for mat in bpy.data.materials:
        dc = mat.diffuse_color
        col = (dc[0], dc[1], dc[2], 1.0)
        bsdf = principled_of(mat)
        set_input(bsdf, "Base Color", col)
        # 金属度统一 0（OSM 数据没有金属信息）；水稍微留一点质感
        set_input(bsdf, "Metallic", 0.0)
        set_input(bsdf, "Roughness", ROUGHNESS.get(mat.name, DEFAULT_ROUGHNESS))
        # 视口色也同步，保证 Workbench 渲染一致
        mat.diffuse_color = col
        fixed += 1
        print("  %-24s base=%s rough=%.2f users=%d"
              % (mat.name, tuple(round(c, 3) for c in col),
                 ROUGHNESS.get(mat.name, DEFAULT_ROUGHNESS), mat.users))

    print("-" * 80)
    print("修复材质: %d 个" % fixed)
    bpy.ops.wm.save_as_mainfile(filepath=dst)
    print("已保存:", dst)

    if glb:
        bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB",
                                  use_selection=False)
        print("已导出 glb:", glb, os.path.getsize(glb), "字节")
    print("=" * 80)
    print("全部完成")


main()
