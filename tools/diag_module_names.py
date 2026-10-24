# -*- coding: utf-8 -*-
"""关键诊断：blosm 启用后，sys.modules 里的真实包名到底是什么。

做法：启用插件，打印所有名字含 "setup" / "premium" / "blosm" 的模块及其 __path__。
"""
import os
import sys

import addon_utils
import bpy

addon_utils.enable("blosm", default_set=True, persistent=True)

print("== sys.modules 中与 blosm/setup 相关的项 ==")
for name, mod in sorted(sys.modules.items()):
    if name == "blosm" or name.startswith("blosm.") or name in ("setup", "premium"):
        print("  %-45s file=%s" % (name, getattr(mod, "__file__", None)))
        p = getattr(mod, "__path__", None)
        if p:
            print("        __path__ = %s" % (p,))
        print("        __package__ = %r" % getattr(mod, "__package__", None))

print()
print("== sys.path 里与 blosm 相关的项 ==")
for p in sys.path:
    if "blosm" in p or "addons" in p:
        print("  ", p)
