# -*- coding: utf-8 -*-
"""一键：自建 assets → blosm realistic 导入（用我们自己的 setup 脚本）。

在 Blender 外面跑（后台模式）：
    D:\blender\blender.exe --background --python tools\full_pipeline.py

setup 脚本加载方式（本项目最关键的技术点，别改）：
    blosm/__init__.py:38-44 在插件加载时把 "setup" 等顶层名从 sys.modules pop 掉，
    只保留 "blosm.setup"；setup/uv_only.py:20 那种 `from setup.premium import ...`
    会因此把 ADDON/setup 当成新顶层包，导致 premium.py 的相对 import 越界报错
    （已实测，见 tools/diag_load_official.py）。
    所以：
      1) 我们的脚本一律写 `from blosm.setup.premium import ...`
      2) 这里用 spec_from_file_location("blosm.setup.ny_office_mix", 脚本) 加载
"""
import os
import sys

import bpy

PROJECT = r"D:\Users\asus\Desktop\项目"
ASSETS = os.path.join(PROJECT, "data", "assets")
OUR_SETUP = os.path.join(PROJECT, "setup")
SETUP_MODULE_NAME = "ny_office_mix"

import addon_utils

sys.path.insert(0, os.path.join(PROJECT, "tools"))
from alias_blosm import alias_blosm_submodules  # noqa: E402


def ensure_assets():
    if not os.path.isfile(os.path.join(ASSETS, "building_materials.blend")):
        print("[pipeline] assets 缺失，调 build_assets 生成")
        sys.path.insert(0, os.path.join(PROJECT, "tools"))
        import build_assets  # noqa: F401  import 时即执行 main()
    else:
        print("[pipeline] assets 已存在: %s" % ASSETS)


def register_setup_module():
    """把我们的 setup 脚本注册成 blosm.setup.<module>，返回模块。"""
    import importlib
    import importlib.util

    if "blosm" not in sys.modules:
        raise RuntimeError("blosm 未启用")
    importlib.import_module("blosm.setup")

    full = "blosm.setup." + SETUP_MODULE_NAME
    path = os.path.join(OUR_SETUP, SETUP_MODULE_NAME + ".py")
    spec = importlib.util.spec_from_file_location(full, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[full] = mod
    spec.loader.exec_module(mod)
    print("[pipeline] 已加载 setup 模块: %s -> setup=%r" % (full, mod.setup))
    return mod


def import_osm(osm_path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    addon_utils.enable("blosm", default_set=True, persistent=True)

    prefs = bpy.context.preferences.addons["blosm"].preferences
    prefs.dataDir = os.path.join(PROJECT, "data", "blosm_cache")
    prefs.assetsDir = ASSETS
    prefs.enableExperimentalFeatures = False   # False 才走 premium_default / 自定义脚本

    # 关键补丁：blosm/building/renderer.py:80 用顶层 import `from gui import ...`，
    # 而 gui/__init__.py:23 用相对 import `from ..app.blender import app`，
    # 直接把 ADDON/gui 当顶层包会越界。先把 blosm.* 别名成顶层名。
    alias_blosm_submodules()

    register_setup_module()

    addon = bpy.context.scene.blosm
    addon.dataType = "osm"
    addon.osmSource = "file"
    addon.osmFilepath = osm_path
    addon.mode = "3Drealistic"
    addon.buildings = True
    addon.water = True
    addon.highways = True
    addon.railways = False
    addon.vegetation = True
    addon.forests = False          # True 会要求 assets/vegetation.blend
    addon.singleObject = False     # 每栋楼一个物体
    addon.relativeToInitialImport = False
    addon.setupScript = os.path.join(OUR_SETUP, SETUP_MODULE_NAME + ".py")
    addon.assetsDir = ASSETS       # app.setAttributes() 会拷贝到 app 上

    res = bpy.ops.blosm.import_data()
    print("[import] bpy.ops.blosm.import_data() -> %r" % (res,))
    if 'FINISHED' not in res:
        return False
    from stat_scene import stat
    stat("pipeline")
    return True


if __name__ == "__main__":
    ensure_assets()
    osm = os.environ.get(
        "OSM_PATH",
        os.path.join(PROJECT, "data", "osm", "manhattan_times-square_556x435m.osm"),
    )
    ok = import_osm(osm)

    if ok and os.environ.get("SAVE_BLEND", "1") == "1":
        out_blend = os.environ.get("OUT_BLEND", os.path.join(PROJECT, "out", "realistic_times-square.blend"))
        os.makedirs(os.path.dirname(out_blend), exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(out_blend))
        print("[pipeline] 已保存 %s" % out_blend)

    if ok and os.environ.get("RENDER", "1") == "1":
        sys.path.insert(0, os.path.join(PROJECT, "tools"))
        import render_scene
        out_png = os.environ.get("OUT_PNG", "out/realistic_times-square.png")
        render_scene.main(out_png)
