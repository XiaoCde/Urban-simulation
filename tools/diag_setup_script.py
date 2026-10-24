# -*- coding: utf-8 -*-
"""诊断 setup 脚本为什么加载失败：手动模拟 blosm 的 loadSetupScript()。"""
import os
import sys
import traceback

import bpy

ADDON = r"C:\Users\asus\AppData\Roaming\Blender Foundation\Blender\5.2\scripts\addons\blosm"
sys.path.insert(0, ADDON)

setupScript = r"D:\Users\asus\Desktop\项目\setup\ny_office_mix.py"
setupScript = os.path.realpath(setupScript)
print("脚本路径:", setupScript, "存在:", os.path.isfile(setupScript))

import importlib.util
moduleName = os.path.splitext(os.path.basename(setupScript))[0]
print("模块名:", moduleName)

try:
    spec = importlib.util.spec_from_file_location(moduleName, setupScript)
    module = importlib.util.module_from_spec(spec)
    sys.modules[moduleName] = module
    spec.loader.exec_module(module)
    print("exec_module 成功，setup =", module.setup)
except Exception:
    print("---- exec_module 失败，完整 traceback ----")
    traceback.print_exc()
    print("---- sys.path 里和 blosm 相关的前几项 ----")
    for p in sys.path:
        if "blosm" in p or "Desktop" in p or "5.2" in p:
            print("   ", p)
