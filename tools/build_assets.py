# -*- coding: utf-8 -*-
r"""生成 assets\building_materials.blend + version.txt（零成本替代 Pro 素材包）。

在 Blender 里跑：
    D:\blender\blender.exe --background --python tools\build_assets.py

【为什么需要这个文件】
    blosm 的 3D realistic 模式要求偏好设置里指定一个 assets 目录，且目录里必须有
    building_materials.blend（见 blosm\app\blender.py:247-268 validateAssetsDirContent）。
    官方那个是付费 Pro 素材包，这里我们用程序生成一个功能等价的。

【材质命名规则（必须严格照抄）】
    来自 blosm\realistic\material\renderer.py:138-187 setupMaterials()：
        for name in ("%s.%s" % (groupName, i) for i in range(1, numMaterials+1))
    numMaterials 默认 20。所以每个"材质组"要有 组名.1 ... 组名.20，共 20 个。
    另外两类是"单体材质"（不带序号），由 setupMaterial(name) 直接按名加载
    （renderer.py:128-136）：
        brick_color / plaster_color  —— FacadeWithOverlay.__init__ 里
            self.wallMaterial = "%s_color" % args[0]（renderer.py:414），
            给"窄墙或无窗的墙"当纯色兜底。
        metal_without_uv            —— MaterialWithColor 用（premium_default.py:52）。
    还有 _ground_level 后缀组：底层（街面层）用，见 FacadeWithColor
        materialName2 = "%s_ground_level" % baseMaterialName（renderer.py:267-269）。

【踩过的坑】
    1) 材质必须 m.use_fake_user = True。否则没有任何物体使用它们时，
       Blender 保存 .blend 会把它们当 0 用户数据丢弃，之后
       loadMaterialsFromFile() 报一堆
         UserWarning: load: '...building_materials.blend' does not contain materials["office.1"]
    2) 组里的 20 个变体不能只给 3~4 个，否则 blosm 会对缺的名字刷屏 warning
       （虽然不致命，但说明变体不足，同一栋楼反复用同几张贴图，观感单调）。
"""
import math
import os

import bpy

ASSETS = r"D:\Users\asus\Desktop\项目\data\assets"

# 组名 -> [(基色 RGB, 粗糙度, 金属度), ...]  会循环补齐到 NUM_VARIANTS 个
GROUPS = {
    "office": [
        ((0.30, 0.32, 0.35, 1), 0.75, 0.05),
        ((0.42, 0.44, 0.47, 1), 0.80, 0.05),
        ((0.20, 0.22, 0.26, 1), 0.70, 0.10),
        ((0.50, 0.52, 0.55, 1), 0.78, 0.05),
        ((0.36, 0.38, 0.42, 1), 0.72, 0.08),
    ],
    "plaster": [
        ((0.74, 0.76, 0.78, 1), 0.85, 0.00),
        ((0.83, 0.80, 0.72, 1), 0.90, 0.00),
        ((0.68, 0.66, 0.62, 1), 0.85, 0.00),
        ((0.80, 0.72, 0.62, 1), 0.88, 0.00),
        ((0.60, 0.66, 0.60, 1), 0.88, 0.00),
    ],
    "glass": [
        ((0.10, 0.14, 0.18, 1), 0.12, 0.00),
        ((0.06, 0.09, 0.13, 1), 0.08, 0.00),
        ((0.14, 0.20, 0.26, 1), 0.15, 0.00),
        ((0.08, 0.16, 0.18, 1), 0.10, 0.00),
        ((0.18, 0.24, 0.28, 1), 0.18, 0.00),
    ],
    "concrete": [
        ((0.62, 0.62, 0.60, 1), 0.92, 0.00),
        ((0.78, 0.76, 0.71, 1), 0.92, 0.00),
        ((0.44, 0.44, 0.43, 1), 0.92, 0.00),
        ((0.70, 0.70, 0.68, 1), 0.90, 0.00),
        ((0.55, 0.55, 0.54, 1), 0.93, 0.00),
    ],
    "roof_tiles": [
        ((0.42, 0.17, 0.12, 1), 0.80, 0.00),
        ((0.30, 0.28, 0.26, 1), 0.85, 0.00),
        ((0.20, 0.18, 0.17, 1), 0.85, 0.00),
        ((0.52, 0.24, 0.16, 1), 0.82, 0.00),
        ((0.36, 0.20, 0.14, 1), 0.84, 0.00),
    ],
    "metal": [
        ((0.55, 0.56, 0.58, 1), 0.40, 0.85),
        ((0.40, 0.41, 0.43, 1), 0.35, 0.90),
        ((0.65, 0.66, 0.68, 1), 0.45, 0.80),
        ((0.48, 0.49, 0.51, 1), 0.38, 0.88),
        ((0.58, 0.57, 0.55, 1), 0.42, 0.82),
    ],
    "brick": [
        ((0.45, 0.20, 0.14, 1), 0.90, 0.00),
        ((0.55, 0.28, 0.20, 1), 0.90, 0.00),
        ((0.38, 0.18, 0.13, 1), 0.92, 0.00),
        ((0.50, 0.24, 0.18, 1), 0.91, 0.00),
        ((0.42, 0.22, 0.16, 1), 0.90, 0.00),
    ],
    "gravel": [
        ((0.38, 0.37, 0.35, 1), 0.95, 0.00),
        ((0.32, 0.31, 0.30, 1), 0.96, 0.00),
        ((0.44, 0.43, 0.41, 1), 0.94, 0.00),
    ],
}

# 由 setupMaterial() 按单名加载的兜底材质：(名字, 基色, 粗糙度, 金属度)
SINGLES = [
    ("brick_color", (0.46, 0.24, 0.18, 1), 0.90, 0.0),
    ("plaster_color", (0.76, 0.75, 0.72, 1), 0.88, 0.0),
    ("metal_without_uv", (0.55, 0.56, 0.58, 1), 0.40, 0.85),
]

NUM_VARIANTS = 20


def make_material(name, color, rough, metal):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.use_fake_user = True          # 见文件头"踩过的坑"第 1 条
    m.diffuse_color = (color[0], color[1], color[2], 1.0)
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if not bsdf:
        bsdf = m.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
        m.node_tree.links.new(
            bsdf.outputs["BSDF"],
            m.node_tree.nodes["Material Output"].inputs["Surface"],
        )
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    return m


def jitter(color, k):
    """第 k 轮循环时给基色一点明度/色相扰动，让 20 个变体不重样。"""
    if k == 0:
        return color
    f = 1.0 + 0.06 * k * (1 if k % 2 else -1)
    r = min(max(color[0] * f, 0.0), 1.0)
    g = min(max(color[1] * f, 0.0), 1.0)
    b = min(max(color[2] * f, 0.0), 1.0)
    return (r, g, b, color[3])


def variants_of(baseList):
    """把 baseList 循环补齐到 NUM_VARIANTS 个（带轻微扰动）。"""
    out = []
    for i in range(NUM_VARIANTS):
        color, rough, metal = baseList[i % len(baseList)]
        k = i // len(baseList)
        out.append((jitter(color, k), min(rough + 0.01 * k, 1.0), metal))
    return out


def main():
    os.makedirs(ASSETS, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)

    count = 0
    for groupName, baseList in GROUPS.items():
        pad = variants_of(baseList)
        # 标准层：组名.1 ... 组名.20
        for i, (color, rough, metal) in enumerate(pad, start=1):
            make_material("%s.%d" % (groupName, i), color, rough, metal)
            count += 1
        # 底层（街面层）：组名_ground_level.1 ... .20
        for i, (color, rough, metal) in enumerate(pad, start=1):
            c = (color[0] * 0.80, color[1] * 0.80, color[2] * 0.80, 1.0)
            make_material("%s_ground_level.%d" % (groupName, i), c, min(rough + 0.05, 1.0), metal)
            count += 1
        # 纯色版（无窗/窄墙）：组名_color.1 ... .20
        for i, (color, rough, metal) in enumerate(pad, start=1):
            make_material("%s_color.%d" % (groupName, i), color, rough, metal)
            count += 1

    for name, color, rough, metal in SINGLES:
        make_material(name, color, rough, metal)
        count += 1

    out = os.path.join(ASSETS, "building_materials.blend")
    bpy.ops.wm.save_as_mainfile(filepath=out)
    with open(os.path.join(ASSETS, "version.txt"), "w") as f:
        f.write("2026.10.16\n")

    print("[build_assets] 写出 %s" % out)
    print("[build_assets] 共 %d 个材质（%d 组 x 3 类 x %d 变体 + %d 个单体）"
          % (count, len(GROUPS), NUM_VARIANTS, len(SINGLES)))
    print("[build_assets] 写出 %s" % os.path.join(ASSETS, "version.txt"))
    return out


main()
