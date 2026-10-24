# -*- coding: utf-8 -*-
"""最小复现：在 blosm 已启用的前提下，用不同方式加载官方 uv_only.py。

结论要回答的问题：为什么 `from setup.premium import setup_base`
在 Blosm 的 loadSetupScript() 里能成功，而我们自己加载就报
"attempted relative import beyond top-level package"？

关键差别怀疑点：loadSetupScript 用 spec_from_file_location(moduleName, path)
（moduleName 不带点），此时模块的 __package__ = ""，
于是 `from setup.premium import ...` 中的 "setup" 走 sys.path 找到
ADDON/setup/__init__.py，被当成顶层包 "setup"，其内部 `from ..parse` 就越界。
→ 说明官方这条路只有在 sys.path 里 ADDON 不在首位、而是 addons 目录在首位时才成立。
"""
import importlib
import importlib.util
import os
import sys

import addon_utils
import bpy

ADDON = r"C:\Users\asus\AppData\Roaming\Blender Foundation\Blender\5.2\scripts\addons\blosm"
addon_utils.enable("blosm", default_set=True, persistent=True)

print("== 加载后 sys.modules 的 setup 相关项 ==")
for n in sorted(sys.modules):
    if "setup" in n or n == "premium":
        print("   %-30s file=%s" % (n, getattr(sys.modules[n], "__file__", None)))

print()
print("== 方式 1：spec_from_file_location('uv_only', 官方脚本)（= blosm 的做法）==")
p = os.path.join(ADDON, "setup", "uv_only.py")
spec = importlib.util.spec_from_file_location("uv_only", p)
m = importlib.util.module_from_spec(spec)
sys.modules["uv_only"] = m
try:
    spec.loader.exec_module(m)
    print("[OK] setup =", m.setup)
except Exception as e:
    print("[FAIL] %s: %s" % (type(e).__name__, e))

print()
print("== 方式 2：importlib.import_module('blosm.setup.uv_only') ==")
try:
    m2 = importlib.import_module("blosm.setup.uv_only")
    print("[OK] setup =", m2.setup)
except Exception as e:
    print("[FAIL] %s: %s" % (type(e).__name__, e))

print()
print("== 方式 3：把 ADDON/setup 加 sys.path，再 import uv_only ==")
sys.path.insert(0, os.path.join(ADDON, "setup"))
try:
    m3 = importlib.import_module("uv_only")
    print("[OK] setup =", m3.setup)
except Exception as e:
    print("[FAIL] %s: %s" % (type(e).__name__, e))

print()
print("== 方式 4：注册顶层包壳 'setup' -> ADDON/setup，再 import uv_only ==")
import types
if "setup" not in sys.modules:
    sh = types.ModuleType("setup")
    sh.__path__ = [os.path.join(ADDON, "setup")]
    sh.__package__ = "setup"
    sys.modules["setup"] = sh
try:
    m4 = importlib.import_module("uv_only")
    print("[OK] setup =", m4.setup)
except Exception as e:
    print("[FAIL] %s: %s" % (type(e).__name__, e))
