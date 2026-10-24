# -*- coding: utf-8 -*-
"""最小复现：alias 之后官方 uv_only.py 到底卡在哪一句。

打印完整 traceback，并逐行检查 `from gui import addDefaultLevels`
在 sys.modules['gui'] = blosm.gui 之后是否可用。
"""
import importlib.util
import os
import sys
import traceback

import addon_utils
import bpy

ADDON = r"C:\Users\asus\AppData\Roaming\Blender Foundation\Blender\5.2\scripts\addons\blosm"
addon_utils.enable("blosm", default_set=True, persistent=True)

# 只别名 gui（uv_only.py 链条上真正需要的）
sys.modules["gui"] = sys.modules["blosm.gui"]
print("sys.modules['gui'] =", sys.modules["gui"])

try:
    from gui import addDefaultLevels
    print("[OK] from gui import addDefaultLevels ->", addDefaultLevels)
except Exception:
    print("[FAIL] from gui import addDefaultLevels")
    traceback.print_exc()

print()
print("== 加载官方 uv_only.py ==")
p = os.path.join(ADDON, "setup", "uv_only.py")
spec = importlib.util.spec_from_file_location("uv_only", p)
m = importlib.util.module_from_spec(spec)
sys.modules["uv_only"] = m
try:
    spec.loader.exec_module(m)
    print("[OK] setup =", m.setup)
except Exception:
    print("[FAIL]")
    traceback.print_exc()

print()
print("== 我们的脚本（blosm. 前缀版）==")
sys.path.insert(0, r"D:\Users\asus\Desktop\项目\setup")
try:
    import ny_office_mix
    print("[OK] setup =", ny_office_mix.setup)
except Exception:
    print("[FAIL]")
    traceback.print_exc()
