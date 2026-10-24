# -*- coding: utf-8 -*-
"""修正版：把 setup 脚本也注册进 'blosm' 包内，这样 `from setup.premium import ...`
就能解析成 blosm.setup.premium。

做法：给 blosm 包额外加一个 search location = 我们项目的 setup 目录，
再注册一个子模块 blosm.setup_ny（实际文件在项目 setup\ny_office_mix.py）。
更简单的做法：直接把我们的脚本注册成 blosm.setup.<name>。
"""
import importlib.util
import os
import sys
import types

import bpy

ADDON = r"C:\Users\asus\AppData\Roaming\Blender Foundation\Blender\5.2\scripts\addons\blosm"


def make_pkg(name, path=None):
    if name in sys.modules:
        m = sys.modules[name]
    else:
        m = types.ModuleType(name)
        m.__package__ = name
        sys.modules[name] = m
    if path:
        m.__path__ = [path]
    return m


# 1) 顶层包 blosm
make_pkg("blosm", ADDON)
# 2) 子包 blosm.setup（指向插件里的 setup 目录）
make_pkg("blosm.setup", os.path.join(ADDON, "setup"))
# 3) 把项目的 setup 目录也挂到 blosm.setup 的搜索路径上，这样
#    "from setup.premium import setup_base" 会先找到 blosm/setup/premium.py
#    而我们的脚本可以用 blosm.setup.ny_office_mix 这种名字导入
OUR_SETUP = r"D:\Users\asus\Desktop\项目\setup"
make_pkg("blosm.setup").__path__.append(OUR_SETUP)

print("blosm.setup.__path__ =", sys.modules["blosm.setup"].__path__)

# 4) 用包内名字加载我们的脚本
spec = importlib.util.spec_from_file_location(
    "blosm.setup.ny_office_mix",
    os.path.join(OUR_SETUP, "ny_office_mix.py"),
)
mod = importlib.util.module_from_spec(spec)
sys.modules["blosm.setup.ny_office_mix"] = mod
try:
    spec.loader.exec_module(mod)
    print("[OK] ny_office_mix 加载成功, setup =", mod.setup)
except Exception:
    import traceback
    traceback.print_exc()

# 5) 顺便验证官方脚本用同样方式能否加载
for n in ("uv_only", "neoclassical", "premium_default", "realistic_dev"):
    try:
        m = importlib.import_module("blosm.setup." + n)
        print("[OK]   blosm.setup.%-20s setup=%r" % (n, getattr(m, "setup", None)))
    except Exception as e:
        print("[FAIL] blosm.setup.%-20s %s: %s" % (n, type(e).__name__, e))
