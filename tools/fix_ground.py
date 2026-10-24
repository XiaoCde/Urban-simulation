# -*- coding: utf-8 -*-
r"""修地面：把"整城一块草地"换成"城市硬质铺装基底"。

**先量出来的事实**（tools\probe_ground.py 实测 dc_real3_dc.blend）：
    tex_grass__Grass005         物体    1 个   面积 30.602 km^2  ← 占全部网格面积 67.5%
    tex_vegetation              物体 1205 个   面积  3.190 km^2  ← 这才是 OSM 真实的公园/草地
    tex_pavement__Concrete047A  物体  162 个   面积  2.619 km^2  ← 这是人行道/铺装
    MESH 材质占用面积合计 45.4 km^2

问题一眼就清楚了：**整个城市的地面是 1 个平面、1 个面、铺了一张草地贴图**，
而真实的公园草地 OSM 本来就给了（1,205 个独立多边形，3.19 km²）。
所以正确做法不是"给地面调个色"，而是：
    基底 -> 灰色硬质铺装（街道/人行道/空地）
    公园 -> 保留 OSM 的 vegetation 多边形（本来就绿）

**z-fighting 处理**：地面是单面平面，公园/水体多边形本来和它同高。同色时看不出来，
换成灰色之后就会闪。所以把 vegetation / water 的多边形抬 LIFT 米（5 cm，肉眼不可见）。

用法:
    D:\\blender\\blender.exe --background --python tools\\fix_ground.py -- <输入.blend> [输出.blend]
    不写输出就原地覆盖（源文件 dc_real3_tex.blend 不受影响，随时可重跑）
"""
import os
import sys

import bpy
from mathutils import Vector

NEW_MAT = "tex_pavement__GroundCity"      # 名字必须形如 tex_<类>__<资产>：
                                          # tools\finalize_textured.py 的 class_of() 靠 __ 前面那段
                                          # 去 tools\textures.json 查 tile_m，并据此烘 glb 的 UV。
                                          # 叫 tex_ground_city 会被判定为"认不出"而跳过烘 UV。
TILE_M = 3.0                              # 必须与 textures.json 里 "pavement".tile_m 一致，
                                          # 否则 .blend（Box 投影按这里的值）和 .glb（按 manifest 烘的 UV）尺度会不一样。
                                          # 贴图内 4x4 块板 -> 每块 0.75 m。
LIFT = 0.06                               # 抬升量（米），给公园/水体让出渲染优先级
# 中性灰路面贴图，由 tools\make_ground_tex.py 生成（平均 RGB 116,116,116，R==G==B）
GROUND_TEX = r"D:\citysim\textures\_generated\pavement_gray_1k.jpg"


def log(m):
    print("[gnd] %s" % m, flush=True)


def xy_area(o):
    cs = [o.matrix_world @ Vector(c) for c in o.bound_box]
    xs = [c.x for c in cs]
    ys = [c.y for c in cs]
    return max(0.0, max(xs) - min(xs)) * max(0.0, max(ys) - min(ys))


def z_range(o):
    cs = [o.matrix_world @ Vector(c) for c in o.bound_box]
    return min(c.z for c in cs), max(c.z for c in cs)


def make_base_material():
    """从零新建基地材质：中性灰路面贴图 + 世界坐标 Box 投影。

    为什么从零建而不是复制人行道材质：
        人行道那张贴图（Concrete047A）平均色是暖黄 (144,135,115)，铺满 30.6 km^2
        的整城地面就是一片沙漠。在 Blender 里插 HueSaturation 去饱和能救 .blend，
        但 **glTF 不支持这个节点**，导出的 .glb 又变回土黄（实测两版渲染对比确认）。
        所以直接换成一张自生成的中性灰贴图，颜色差异烘进文件本身，
        .blend 与 .glb 结果完全一致。
    """
    if not os.path.exists(GROUND_TEX):
        raise RuntimeError("找不到地面贴图 %s（先跑 tools\\make_ground_tex.py）" % GROUND_TEX)

    old = bpy.data.materials.get(NEW_MAT)
    if old is not None:
        bpy.data.materials.remove(old)

    mat = bpy.data.materials.new(NEW_MAT)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (420, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (120, 0)
    bsdf.inputs["Roughness"].default_value = 0.92
    bsdf.inputs["Metallic"].default_value = 0.0

    geo = nt.nodes.new("ShaderNodeNewGeometry")   # 世界坐标 -> 全城连续网格
    geo.location = (-620, -160)
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.location = (-400, -160)
    mp.vector_type = "POINT"
    s = 1.0 / TILE_M
    mp.inputs["Scale"].default_value = (s, s, s)
    log("  Mapping.Scale -> %.4f（一张铺 %.1f m，贴图内 4x4 块板 -> 每块 %.2f m）"
        % (s, TILE_M, TILE_M / 4.0))

    img = nt.nodes.new("ShaderNodeTexImage")
    img.location = (-160, -160)
    img.image = bpy.data.images.load(GROUND_TEX, check_existing=True)
    img.projection = "BOX"
    img.projection_blend = 0.15
    # 打包进 .blend：贴图原本在 D:\citysim\textures\_generated\ 下，不打包的话
    # 换台机器打开就丢图（glb 是自带的，不受影响）
    try:
        if not img.image.packed_file:
            img.image.pack()
            log("  已把地面贴图打包进 .blend")
    except Exception as e:                                  # noqa: BLE001
        log("  打包地面贴图失败（不影响渲染，只影响跨机器打开）：%s" % e)
    img.image.use_fake_user = True

    nt.links.new(geo.outputs["Position"], mp.inputs["Vector"])
    nt.links.new(mp.outputs["Vector"], img.inputs["Vector"])
    nt.links.new(img.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    log("  地面贴图 %s（%dx%d，中性灰，无 HueSaturation 节点 -> glTF 可还原）"
        % (os.path.basename(GROUND_TEX), img.image.size[0], img.image.size[1]))
    return mat


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not argv:
        print(__doc__)
        return 1
    src = os.path.abspath(argv[0])
    dst = os.path.abspath(argv[1]) if len(argv) > 1 else src
    bpy.ops.wm.open_mainfile(filepath=src)
    log("载入 %s（物体 %d）" % (os.path.basename(src), len(bpy.data.objects)))

    # ---- 1. 找地面：名字叫 ground，或面积最大的那个 MESH ----
    meshes = [o for o in bpy.data.objects if o.type == "MESH" and o.data]
    named = [o for o in meshes if o.name.lower() == "ground"]
    g = named[0] if named else max(meshes, key=xy_area)
    old_mats = [s.material.name if s.material else "-" for s in g.material_slots]
    gz0, gz1 = z_range(g)
    log("地面物体 = %s   面积 %.3f km^2   z %.3f ~ %.3f   原材质 %s"
        % (g.name, xy_area(g) / 1e6, gz0, gz1, old_mats))

    mat = make_base_material()
    if not g.material_slots:
        g.data.materials.append(mat)
    else:
        g.material_slots[0].material = mat
    log("地面材质 -> %s" % mat.name)

    # ---- 2. 公园 / 水体：保证它们盖在地面之上 ----
    lifted = 0
    for o in meshes:
        if o is g:
            continue
        names = [s.material.name if s.material else "" for s in o.material_slots]
        if not any(n.startswith("tex_vegetation") or n.startswith("tex_water")
                   for n in names):
            continue
        z0, z1 = z_range(o)
        if z0 < gz1 + LIFT:
            dz = (gz1 + LIFT) - z0
            o.location.z += dz
            lifted += 1
    log("抬升的公园/水体多边形 = %d 个（+%.2f m，避免与灰色基底 z-fighting）"
        % (lifted, LIFT))

    # ---- 3. 存盘 ----
    bpy.ops.wm.save_as_mainfile(filepath=dst)
    log("已保存 %s（%.1f MB）" % (os.path.basename(dst), os.path.getsize(dst) / 1048576))
    return 0


if __name__ == "__main__":
    sys.exit(main())
