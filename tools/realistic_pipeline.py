# -*- coding: utf-8 -*-
"""一键跑通 blosm 真实感管线：自建 assets + setup 脚本，不需要买 Pro。

用法（在 Blender 外，用命令行）:
    D:\blender\blender.exe --background --python tools\realistic_pipeline.py

它做四件事：
  1) 生成 assets 目录下的 building_materials.blend（含 office / plaster / glass /
     concrete / roof_tiles / metal 六组，每组若干变体，纯 Principled BSDF）
  2) 生成 version.txt（blosm 要求 >= 2021.05.07）
  3) 生成 setup/washington_neoclassical.py（抄官方 neoclassical.py 的配方，
     华盛顿白宫/国会大厦一片用石灰岩墙面 + 红瓦屋顶）
  4) 用 blosm 的 realistic 模式导入 OSM 文件，导出 glTF 供 UE/Unity/three.js 用

可以只生成素材不导入：给环境变量 BUILD_ASSETS_ONLY=1
"""
import bpy
import os
import sys

PROJECT = r"D:\Users\asus\Desktop\项目"
ADDON = r"C:\Users\asus\AppData\Roaming\Blender Foundation\Blender\5.2\scripts\addons\blosm"
ASSETS = os.path.join(PROJECT, "data", "assets")
MODE = os.environ.get("BLOSM_MODE", "realistic")

sys.path.insert(0, ADDON)
sys.path.insert(0, os.path.join(PROJECT, "setup"))
sys.path.insert(0, os.path.join(PROJECT, "tools"))

import addon_utils

# ---------------------------------------------------------------- assets


def build_assets():
    os.makedirs(ASSETS, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)

    groups = {
        # 组名: [(基色 rgba, 粗糙度, 金属度)]
        "office": [
            ((0.30, 0.32, 0.35, 1), 0.75, 0.05),   # 玻璃幕墙灰蓝
            ((0.42, 0.44, 0.47, 1), 0.80, 0.05),
            ((0.20, 0.22, 0.26, 1), 0.70, 0.10),
        ],
        "plaster": [
            ((0.74, 0.76, 0.78, 1), 0.85, 0.00),   # 石灰岩（华盛顿主色）
            ((0.83, 0.80, 0.72, 1), 0.90, 0.00),   # 米砂石
            ((0.68, 0.66, 0.62, 1), 0.85, 0.00),
        ],
        "glass": [
            ((0.10, 0.14, 0.18, 1), 0.12, 0.00),
            ((0.06, 0.09, 0.13, 1), 0.08, 0.00),
        ],
        "concrete": [
            ((0.62, 0.62, 0.60, 1), 0.92, 0.00),
            ((0.78, 0.76, 0.71, 1), 0.92, 0.00),
            ((0.44, 0.44, 0.43, 1), 0.92, 0.00),
        ],
        "roof_tiles": [
            ((0.42, 0.17, 0.12, 1), 0.80, 0.00),   # 红陶瓦
            ((0.30, 0.28, 0.26, 1), 0.85, 0.00),
            ((0.20, 0.18, 0.17, 1), 0.85, 0.00),
        ],
        "metal": [
            ((0.55, 0.56, 0.58, 1), 0.40, 0.85),
            ((0.40, 0.41, 0.43, 1), 0.35, 0.90),
        ],
        "brick": [
            ((0.45, 0.20, 0.14, 1), 0.90, 0.00),
            ((0.55, 0.28, 0.20, 1), 0.90, 0.00),
        ],
        "gravel": [
            ((0.38, 0.37, 0.35, 1), 0.95, 0.00),
        ],
    }

    for groupName, variants in groups.items():
        for i, (color, rough, metal) in enumerate(variants, start=1):
            name = "%s.%d" % (groupName, i)
            if name in bpy.data.materials:
                m = bpy.data.materials[name]
            else:
                m = bpy.data.materials.new(name)
            m.use_nodes = True
            m.diffuse_color = (color[0], color[1], color[2], 1.0)
            tree = m.node_tree
            bsdf = tree.nodes.get("Principled BSDF")
            if not bsdf:
                bsdf = tree.nodes.new("ShaderNodeBsdfPrincipled")
            bsdf.inputs["Base Color"].default_value = color
            bsdf.inputs["Roughness"].default_value = rough
            bsdf.inputs["Metallic"].default_value = metal

        # 每种材质组建一个带 _ground_level 后缀的版本，blosm 底层立面会用它
        for suffix, factor in (("_ground_level", 0.85), ("_color", 1.0)):
            for i, (color, rough, metal) in enumerate(variants, start=1):
                name = "%s%s.%d" % (groupName, suffix, i)
                m = bpy.data.materials.new(name)
                m.use_nodes = True
                c = (color[0] * factor, color[1] * factor, color[2] * factor, 1.0)
                m.diffuse_color = c
                bsdf = m.node_tree.nodes.get("Principled BSDF")
                bsdf.inputs["Base Color"].default_value = c
                bsdf.inputs["Roughness"].default_value = min(rough + 0.05, 1.0)
                bsdf.inputs["Metallic"].default_value = metal

    out = os.path.join(ASSETS, "building_materials.blend")
    bpy.ops.wm.save_as_mainfile(filepath=out)

    with open(os.path.join(ASSETS, "version.txt"), "w") as f:
        f.write("2026.10.16\n")
    print("[assets] 已生成 %s，共 %d 个材质" % (out, len(bpy.data.materials)))
    print("[assets] version.txt 已写入")
    return out


# ---------------------------------------------------------------- import


def import_osm(osm_path, setup_script):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    addon_utils.enable("blosm", default_set=True, persistent=True)
    prefs = bpy.context.preferences.addons["blosm"].preferences
    prefs.dataDir = os.path.join(PROJECT, "data", "blosm_cache")
    prefs.assetsDir = ASSETS

    addon = bpy.context.scene.blosm
    addon.dataType = "osm"
    addon.osmSource = "file"
    addon.osmFilepath = osm_path
    addon.mode = "3Drealistic"
    addon.buildings = True
    addon.water = True
    addon.vegetation = True
    addon.highways = True
    addon.forests = False
    addon.setupScript = setup_script
    # 关键：把 assets 目录也设置到 GUI 属性上，app.setAttributes() 会拷贝它
    addon.assetsDir = ASSETS

    res = bpy.ops.blosm.import_data()
    print("[import] bpy.ops.blosm.import_data() ->", res)


if __name__ == "__main__":
    if MODE == "assets-only":
        build_assets()
    else:
        osm_path = os.environ.get(
            "OSM_PATH",
            os.path.join(PROJECT, "data", "osm", "manhattan_times-square_556x435m.osm"),
        )
        setup_script = os.path.join(PROJECT, "setup", "ny_office_mix.py")
        import_osm(osm_path, setup_script)
