# -*- coding: utf-8 -*-
r"""补渲染：把镜头架在华盛顿的连排屋（rowhouse）街区上，让真实坡屋顶看得见。

现状问题：restyle_city.py 的"近景"取景在场景东南角（lon 0.72 / lat 0.22 位置），
那里是海军船厂/联邦中心一带的**大体量平顶办公楼**，所以看着还是"盒子"。
真实的坡屋顶集中在 Dupont/Logan Circle/Shaw/Capitol Hill 这些连排屋街区。

场景坐标换算（实测 bbox）：
    西 -77.059998  东 -77.000000   南 38.885003  北 38.924999
    场景 X: -887 .. 4310 (5,197 m)   Y: -597 .. 3854 (4,451 m)
    X = -887 + (lon - W)/(E - W) * 5197
    Y = -597 + (lat - S)/(N - S) * 4451

用法（必须由 blender 执行）:
    blender --background --python tools\render_rowhouses.py -- <输入.blend> <输出前缀>
"""
import importlib.util
import os
import sys

import bpy

DEFAULT_SRC = r"D:\Users\asus\Desktop\项目\out\dc_real3.blend"
DEFAULT_OUT = r"D:\Users\asus\Desktop\项目\out\dc_real3_连排屋"

W, E, S, N = -77.059998, -77.000000, 38.885003, 38.924999
X0, XW, Y0, YH = -887.0, 5197.0, -597.0, 4451.0


def xy(lon, lat):
    return X0 + (lon - W) / (E - W) * XW, Y0 + (lat - S) / (N - S) * YH


HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("rc", os.path.join(HERE, "restyle_city.py"))
ns = {"__name__": "not_main"}
exec(compile(open(os.path.join(HERE, "restyle_city.py"), encoding="utf-8").read(),
             "restyle_city", "exec"), ns)


def shot(name, lon, lat, span, direction, margin, lens, z=18.0):
    x, y = xy(lon, lat)
    print("[shot] %s  经纬度 (%.6f, %.6f) → 场景 (%.0f, %.0f)" % (name, lon, lat, x, y))
    ns["place_camera"]([x - span, y - span, 0.0], [x + span, y + span, 60.0],
                       target=(x, y, z), direction=direction, margin=margin, lens=lens)
    ns["render"](OUT + "_%s.png" % name, samples=48)


def main():
    global SRC, OUT
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    SRC = argv[0] if len(argv) > 0 else DEFAULT_SRC
    OUT = argv[1] if len(argv) > 1 else DEFAULT_OUT
    bpy.ops.wm.open_mainfile(filepath=SRC)
    print("[open] %s" % SRC)
    ns["setup_world"]()
    ns["add_sun"]()
    # 1) Shaw / Logan Circle 一带 —— 典型连排屋，坡屋顶最密
    shot("shaw", -77.0315, 38.9120, 420.0, (1.0, -1.0, 0.40), 1.05, 58.0)
    # 2) Capitol Hill —— 连排屋 + 国会穹顶可入画
    shot("capitolhill", -77.0035, 38.8895, 460.0, (-1.0, 1.0, 0.38), 1.05, 58.0)
    print("[done] %s" % OUT)


main()
