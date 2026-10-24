# -*- coding: utf-8 -*-
"""方案 4：完全模拟 Blender 正常启用插件时的 import 环境。

Blender 启用插件时，插件目录被当成顶层包（包名 = 目录名 "blosm"），
它的 __init__.py 被执行，里面所有 `from ..parse...` / `from .setup...`
都相对于包 "blosm"。

关键点：包名必须是 "blosm"，且 ADDON 是它的 __path__。
试 loader.exec_module(__init__.py) 的方式注册，而不是 spec_from_file_location(包)。
"""
import os
import sys

import bpy

ADDON = r"C:\Users\asus\AppData\Roaming\Blender Foundation\Blender\5.2\scripts\addons\blosm"


def register_blosm_package():
    """把 ADDON 注册为顶层包 'blosm'（不执行 __init__，只建包壳）。"""
    import types
    if "blosm" in sys.modules:
        return sys.modules["blosm"]
    pkg = types.ModuleType("blosm")
    pkg.__path__ = [ADDON]
    pkg.__package__ = "blosm"
    sys.modules["blosm"] = pkg
    return pkg


register_blosm_package()

import importlib

targets = [
    ("blosm.setup.premium", None),
    ("blosm.setup.uv_only", None),
    ("blosm.setup.neoclassical", None),
    ("blosm.setup.premium_default", None),
    ("blosm.setup.example_custom_textures", None),
    ("blosm.setup.realistic_dev", None),
]

for name, _ in targets:
    try:
        mod = importlib.import_module(name)
        print("[OK]   %-42s setup=%r" % (name, getattr(mod, "setup", "<无 setup>")))
    except Exception as e:
        print("[FAIL] %-42s %s: %s" % (name, type(e).__name__, e))

print()
print("== 我们的 setup 脚本在同样环境下能否加载 ==")
try:
    sys.path.insert(0, r"D:\Users\asus\Desktop\项目\setup")
    import ny_office_mix  # noqa: F401
    print("[OK]   ny_office_mix setup=%r" % ny_office_mix.setup)
except Exception as e:
    print("[FAIL] ny_office_mix %s: %s" % (type(e).__name__, e))
    import traceback
    traceback.print_exc()
