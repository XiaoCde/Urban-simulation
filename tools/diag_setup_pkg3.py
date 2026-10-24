# -*- coding: utf-8 -*-
"""诊断：blosm 自己是怎么让 `from setup.premium import ...` 成立的。

结论来源：blosm/setup/premium.py:20 用的是 `from ..parse...`（相对 import），
所以 setup 包必须挂在某个有父包的包下面；
而 blosm/setup/uv_only.py:20 用的是 `from setup.premium import ...`（绝对 import），
说明 Blender 运行时 sys.path 里一定有 ADDON 目录本身，且 ADDON 是顶层包。
两者只有在"ADDON 作为包 blosm 被 import，同时 ADDON 也在 sys.path"时才同时成立。
本脚本枚举几种组合，找出可行解。
"""
import importlib
import os
import sys
import types
import traceback

import bpy

ADDON = r"C:\Users\asus\AppData\Roaming\Blender Foundation\Blender\5.2\scripts\addons\blosm"


def reset():
    for name in [n for n in sys.modules if n == "blosm" or n.startswith("blosm.")]:
        del sys.modules[name]
    sys.path[:] = [p for p in sys.path if os.path.realpath(p) != ADDON]


def attempt(label):
    print("\n" + "-" * 78)
    print(label)
    print("-" * 78)
    ok = True
    # 官方 uv_only 的写法：from setup.premium import setup_base
    try:
        m = importlib.import_module("uv_only")
        print("[OK]   import uv_only -> setup=%r" % getattr(m, "setup", None))
    except Exception as e:
        ok = False
        print("[FAIL] import uv_only -> %s: %s" % (type(e).__name__, e))
    # 我们的脚本
    sys.path.insert(0, r"D:\Users\asus\Desktop\项目\setup")
    try:
        m2 = importlib.import_module("ny_office_mix")
        print("[OK]   import ny_office_mix -> setup=%r" % getattr(m2, "setup", None))
    except Exception as e:
        ok = False
        print("[FAIL] import ny_office_mix -> %s: %s" % (type(e).__name__, e))
        traceback.print_exc()
    print("=> %s" % ("可行" if ok else "不可行"))
    return ok


# A: ADDON 在 sys.path（官方 uv_only 的绝对 import 期望如此）
reset()
sys.path.insert(0, ADDON)
attempt("A: sys.path += ADDON（无包注册）")

# B: ADDON 在 sys.path + 顶层包壳 blosm（带 __path__）
reset()
sys.path.insert(0, ADDON)
pkg = types.ModuleType("blosm")
pkg.__path__ = [ADDON]
pkg.__package__ = "blosm"
sys.modules["blosm"] = pkg
attempt("B: sys.path += ADDON + 包壳 blosm")

# C: 只注册包壳，不加 sys.path
reset()
pkg = types.ModuleType("blosm")
pkg.__path__ = [ADDON]
pkg.__package__ = "blosm"
sys.modules["blosm"] = pkg
attempt("C: 只注册包壳 blosm")
