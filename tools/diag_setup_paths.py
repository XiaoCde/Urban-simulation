# -*- coding: utf-8 -*-
"""诊断：官方示例 setup/example_custom_textures.py 自身在 --background 下能否加载。

目的：判断 `from setup.premium import setup_base` 这种顶层包名 import
在什么 sys.path 组合下才成立。blosm 的官方脚本就是这么写的，说明
一定有一条可行路径。
"""
import os
import sys

import bpy

ADDON = r"C:\Users\asus\AppData\Roaming\Blender Foundation\Blender\5.2\scripts\addons\blosm"
PARENT = os.path.dirname(ADDON)          # ...\addons
BLOSM_NAME = "blosm"

import importlib.util


def try_load(path, label):
    path = os.path.realpath(path)
    moduleName = os.path.splitext(os.path.basename(path))[0]
    try:
        spec = importlib.util.spec_from_file_location(moduleName, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[moduleName] = module
        spec.loader.exec_module(module)
        print("[OK]   %s -> setup=%r" % (label, module.setup))
        return True
    except Exception as e:
        print("[FAIL] %s -> %s: %s" % (label, type(e).__name__, e))
        return False


def banner(msg):
    print("\n" + "=" * 78)
    print(msg)
    print("=" * 78)


candidates = [
    ("官方 example_custom_textures.py", os.path.join(ADDON, "setup", "example_custom_textures.py")),
    ("官方 uv_only.py", os.path.join(ADDON, "setup", "uv_only.py")),
    ("官方 neoclassical.py", os.path.join(ADDON, "setup", "neoclassical.py")),
    ("官方 premium_default.py", os.path.join(ADDON, "setup", "premium_default.py")),
]

# ---- 方案 1：ADDON 在 sys.path（模块名 setup/premium 都是顶层）----
banner("方案 1: sys.path 里放 ADDON（插件根目录）")
sys.path.insert(0, ADDON)
for label, p in candidates:
    try_load(p, label)

# ---- 方案 2：把插件目录本身当作包 "blosm"，PARENT 在 sys.path ----
banner("方案 2: sys.path 里放 PARENT（addons 目录），插件包名 = blosm")
for p in list(sys.path):
    if os.path.realpath(p) == ADDON:
        sys.path.remove(p)
sys.path.insert(0, PARENT)
for label, p in candidates:
    try_load(p, label)

# ---- 方案 3：显式把插件注册成包 blosm ----
banner("方案 3: 手动注册包 'blosm' -> ADDON")
if BLOSM_NAME not in sys.modules:
    pkg_spec = importlib.util.spec_from_file_location(
        BLOSM_NAME, os.path.join(ADDON, "__init__.py"),
        submodule_search_locations=[ADDON]
    )
    pkg = importlib.util.module_from_spec(pkg_spec)
    sys.modules[BLOSM_NAME] = pkg
for label, p in candidates:
    # 用包内相对路径加载，模块名带 blosm. 前缀
    rel = os.path.relpath(p, ADDON).replace("\\", ".")
    full = "%s.%s" % (BLOSM_NAME, rel[:-3])
    try:
        __import__(full)
        print("[OK]   %s -> %r" % (label, getattr(sys.modules[full], "setup", None)))
    except Exception as e:
        print("[FAIL] %s -> %s: %s" % (label, type(e).__name__, e))
