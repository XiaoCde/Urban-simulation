# -*- coding: utf-8 -*-
r"""按真实经纬度架多个机位，给城市基座「拍一组照片」。

复用 tools\restyle_city.py 里的 setup_world / add_sun / place_camera / render，
不重复实现渲染逻辑。

场景坐标换算（实测 bbox）：
    西 -77.059998  东 -77.000000   南 38.885003  北 38.924999
    场景 X: -887 .. 4310 (5,197 m)   Y: -597 .. 3854 (4,451 m)

用法（必须由 blender 执行）:
    blender --background --python tools\render_gallery.py -- <输入.blend> <输出前缀>
"""
import importlib.util
import os
import sys

import bpy
from mathutils import Vector

DEFAULT_SRC = r"D:\Users\asus\Desktop\项目\out\dc_real3.blend"
DEFAULT_OUT = r"D:\Users\asus\Desktop\项目\out\gallery"

W, E, S, N = -77.059998, -77.000000, 38.885003, 38.924999
X0, XW, Y0, YH = -887.0, 5197.0, -597.0, 4451.0

HERE = os.path.dirname(os.path.abspath(__file__))
ns = {"__name__": "not_main"}
exec(compile(open(os.path.join(HERE, "restyle_city.py"), encoding="utf-8").read(),
             "restyle_city", "exec"), ns)


def xy(lon, lat):
    return X0 + (lon - W) / (E - W) * XW, Y0 + (lat - S) / (N - S) * YH


def bounds():
    lo = [1e9, 1e9, 1e9]
    hi = [-1e9, -1e9, -1e9]
    for o in bpy.data.objects:
        if o.type != "MESH" or not o.data.vertices or o.name == "ground":
            continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])
    return lo, hi


def shot(name, lon, lat, span, direction, margin, lens, z=18.0, samples=48):
    x, y = xy(lon, lat)
    lo = [x - span, y - span, 0.0]
    hi = [x + span, y + span, max(80.0, z * 4)]
    ns["place_camera"](lo, hi, target=(x, y, z), direction=direction,
                       margin=margin, lens=lens)
    ns["render"](OUT + "_%s.png" % name, samples=samples)
    print("[shot] %-22s 经纬度 (%.4f, %.4f) → 场景 (%.0f, %.0f)" % (name, lon, lat, x, y))


def main():
    global SRC, OUT
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    SRC = argv[0] if len(argv) > 0 else DEFAULT_SRC
    OUT = argv[1] if len(argv) > 1 else DEFAULT_OUT

    bpy.ops.wm.open_mainfile(filepath=SRC)
    print("[open] %s" % SRC)
    ns["setup_world"]()
    ns["add_sun"]()

    # 1) 全城鸟瞰，从西南往东北
    lo, hi = bounds()
    print("[bounds] (%.0f, %.0f, %.0f) -> (%.0f, %.0f, %.0f)" % (lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]))
    ns["place_camera"](lo, hi, direction=(0.55, -1.0, 0.50), margin=1.06, lens=50.0)
    ns["render"](OUT + "_01_全城鸟瞰_从南向北.png", samples=48)
    print("[shot] 01_全城鸟瞰")

    # 2) 国会大厦（能带进穹顶）
    shot("02_国会大厦", -77.0091, 38.8899, 320.0, (-0.75, 1.0, 0.26), 1.15, 52.0, z=22.0)

    # 3) 国家广场 + 华盛顿纪念碑
    shot("03_国家广场与纪念碑", -77.0330, 38.8895, 520.0, (0.95, 0.75, 0.26), 1.02, 48.0, z=25.0)

    # 4) 杜邦圆环的连排屋
    shot("04_杜邦圆环连排屋", -77.0434, 38.9096, 220.0, (1.0, -0.85, 0.22), 1.05, 62.0, z=16.0)

    # 5) 低角度街景（洛根圆环一带，相机压到接近街面）
    shot("05_低角度街景", -77.0360, 38.9100, 130.0, (1.0, -0.55, 0.11), 1.25, 72.0, z=11.0)

    # 6) 白宫一带（这一片官方删除了激光雷达数据，用来看缺口）
    shot("06_白宫一带", -77.0365, 38.8977, 300.0, (0.9, -0.9, 0.30), 1.10, 55.0, z=20.0)

    # 7) 宾夕法尼亚大道一带（联邦办公楼群）
    shot("07_宾大道办公区", -77.0230, 38.8970, 330.0, (-0.85, -0.95, 0.24), 1.08, 54.0, z=20.0)

    # 8) 国会山连排屋
    shot("08_国会山连排屋", -77.0060, 38.8890, 210.0, (0.95, 0.9, 0.20), 1.05, 62.0, z=15.0)

    # 9) 正俯视总平面（正交相机）
    x, y = xy(-77.0300, 38.9050)
    ns["place_camera"]([x - 2600, y - 2600, 0.0], [x + 2600, y + 2600, 300.0],
                       target=(x, y, 0.0), direction=(0.01, -0.01, 1.0), margin=1.0, lens=50.0)
    cam = bpy.context.scene.camera
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 5900.0
    ns["render"](OUT + "_09_正俯视总平面.png", samples=48)
    print("[shot] 09_正俯视总平面")

    print("[done] %s" % OUT)


main()
