# -*- coding: utf-8 -*-
"""关键补丁：让 blosm 内部的顶层 import（`from gui import ...`）也能解析。

问题链（已实测）：
    blosm/building/renderer.py:80  写的是 `from gui import addDefaultLevels`
    这是顶层 import。blosm/__init__.py:46-54 的 _checkPath() 虽然把插件根目录
    插到 sys.path[0]，但 gui/__init__.py:23 又用了相对 import
    `from ..app.blender import app`，于是把 ADDON/gui 当成顶层包 "gui" 时越界：
        ImportError: attempted relative import beyond top-level package

解法：预加载 "gui" 这个顶层名字，让它指向 blosm.gui 模块
    （等价于把 blosm.gui 注册成别名 "gui"）。
    这样 building/renderer.py:80 的 `from gui import addDefaultLevels`
    拿到的是已经加载好的 blosm.gui，不会触发新的顶层包加载。
同理给 blosm 源码里其他顶层 import 的名字都建别名：
    gui / setup / app / parse / building / realistic / manager / renderer /
    util / style / grammar / item / item_renderer / action / defs / terrain
（完整名单见 blosm/__init__.py:38-44 的清理列表）
"""
import sys
import types


def alias_blosm_submodules():
    """把 blosm.* 的主要子模块在 sys.modules 里登记顶层别名。返回别名列表。"""
    import importlib

    if "blosm" not in sys.modules:
        raise RuntimeError("先启用 blosm，再调用 alias_blosm_submodules()")

    # blosm/__init__.py:38-44 的清理名单，这些名字在 blosm 内部以顶层方式 import
    names = [
        "action", "ape", "app", "building", "building2", "defs", "gpx", "grammar",
        "gui", "item", "item_renderer", "lib", "manager", "material", "mpl",
        "overlay", "parse", "pml", "realistic", "renderer", "script", "setup",
        "style", "terrain", "threed_tiles", "util", "way",
    ]
    aliased = []
    for n in names:
        full = "blosm." + n
        if full in sys.modules:
            sys.modules[n] = sys.modules[full]
            aliased.append(n)
            continue
        try:
            mod = importlib.import_module(full)
            sys.modules[n] = mod
            aliased.append(n)
        except Exception as e:
            print("[alias] 跳过 %s: %s: %s" % (full, type(e).__name__, e))
    print("[alias] 已建顶层别名: %s" % ", ".join(aliased))
    return aliased


if __name__ == "__main__":
    import addon_utils
    import bpy
    addon_utils.enable("blosm", default_set=True, persistent=True)
    alias_blosm_submodules()
    # 验证官方 uv_only.py 的写法现在能否加载
    import importlib.util, os
    ADDON = r"C:\Users\asus\AppData\Roaming\Blender Foundation\Blender\5.2\scripts\addons\blosm"
    p = os.path.join(ADDON, "setup", "uv_only.py")
    spec = importlib.util.spec_from_file_location("uv_only", p)
    m = importlib.util.module_from_spec(spec)
    sys.modules["uv_only"] = m
    try:
        spec.loader.exec_module(m)
        print("[OK] 官方 uv_only.py 现在能加载, setup =", m.setup)
    except Exception as e:
        print("[FAIL] %s: %s" % (type(e).__name__, e))
