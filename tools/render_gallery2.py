# -*- coding: utf-8 -*-
r"""给城市基座拍一组「远中景」照片。

第一轮（tools\render_gallery.py）的教训：
    近景（span 130~330 m）拍出来的全是没窗户的大白墙，画面并不好看。
    真正能看的是中远景（span 600~1500 m）—— 这时体量、街道网格、屋顶起伏才是主角。
    所以这一轮全部用中远景，并把太阳调成暖光 + 斜射，让阴影把体量拉开。

用法（必须由 blender 执行）:
    blender --background --python tools\render_gallery2.py -- <输入.blend> <输出前缀>
"""
import math
import os
import sys

import bpy
from mathutils import Vector

DEFAULT_SRC = r"D:\Users\asus\Desktop\项目\out\dc_real3.blend"
DEFAULT_OUT = r"D:\Users\asus\Desktop\项目\out\pic"

W, E, S, N = -77.059998, -77.000000, 38.885003, 38.924999
X0, XW, Y0, YH = -887.0, 5197.0, -597.0, 4451.0

HERE = os.path.dirname(os.path.abspath(__file__))
ns = {"__name__": "not_main"}
exec(compile(open(os.path.join(HERE, "restyle_city.py"), encoding="utf-8").read(),
             "restyle_city", "exec"), ns)


def xy(lon, lat):
    return X0 + (lon - W) / (E - W) * XW, Y0 + (lat - S) / (N - S) * YH


def lighting(warm=1.0):
    """白天蓝天 + 暖色斜射阳光。

    第一轮的通病是画面发灰、天空发暗（世界强度 0.30 同时管着天光和天空颜色，
    天空就跟着变暗了）。这里把天光调亮到像白天，太阳略降一点补偿。
    """
    ns["setup_world"]()
    w = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    bg = w.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0.44, 0.58, 0.82, 1.0)
        bg.inputs["Strength"].default_value = 0.45
    # 地面压暗，城市才从底板上"跳"出来
    gm = bpy.data.materials.get("dc_ground")
    if gm:
        ns["_set_base"](gm, (0.11, 0.11, 0.105), 0.96)
    # 屋顶压暗：DC 的平屋顶本来就是深色沥青/金属，压暗之后屋顶和墙面对比出来，
    # 一栋楼才有"顶面 + 立面"的读数，不然整片糊成一片白。只改本次渲染，不动 .blend。
    for m in bpy.data.materials:
        if m.name.startswith("dc_roof") or m.name == "roof":
            c = m.diffuse_color
            ns["_set_base"](m, (c[0] * 0.42, c[1] * 0.42, c[2] * 0.44), 0.88)
    for o in list(bpy.data.objects):
        if o.type == "LIGHT":
            bpy.data.objects.remove(o, do_unlink=True)
    d = bpy.data.lights.new("Sun", type="SUN")
    d.energy = 2.9
    d.angle = math.radians(1.5)
    d.color = (1.0, 1.0 - 0.09 * warm, 1.0 - 0.24 * warm)
    o = bpy.data.objects.new("Sun", d)
    bpy.context.scene.collection.objects.link(o)
    # 高度 45° + 方位 55°：影子够长，又不至于把街道全糊掉
    o.rotation_euler = (math.radians(45), 0.0, math.radians(55))


def want(idx):
    """只渲指定编号（环境变量 ONLY=1,3,5），便于先花 25 秒试一张。"""
    only = os.environ.get("ONLY", "").strip()
    return (not only) or (str(idx) in {s.strip() for s in only.split(",") if s.strip()})


def shot(idx, name, lon, lat, span, direction, margin=1.10, lens=48.0, z=20.0, samples=48):
    if not want(idx):
        print("[skip] %02d %s" % (idx, name))
        return
    x, y = xy(lon, lat)
    lo = [x - span, y - span, 0.0]
    hi = [x + span, y + span, max(90.0, z * 5)]
    ns["place_camera"](lo, hi, target=(x, y, z), direction=direction, margin=margin, lens=lens)
    ns["render"](OUT + "_%02d_%s.png" % (idx, name), samples=samples)
    print("[shot] %02d %-16s (%.4f, %.4f) → 场景 (%.0f, %.0f)" % (idx, name, lon, lat, x, y))


def main():
    global OUT
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    src = argv[0] if len(argv) > 0 else DEFAULT_SRC
    OUT = argv[1] if len(argv) > 1 else DEFAULT_OUT

    bpy.ops.wm.open_mainfile(filepath=src)
    print("[open] %s" % src)

    lighting()
    # 1) 全城：从南边国家广场中轴向北看
    if want(1):
        ns["place_camera"]([-887, -597, 0], [4310, 3854, 169],
                           direction=(0.30, -1.0, 0.62), margin=1.05, lens=46.0)
        ns["render"](OUT + "_01_全城鸟瞰_自南向北.png", samples=48)
        print("[shot] 01 全城鸟瞰")

    # 2) 全城：从西南往里看，逆着晨光
    if want(2):
        ns["place_camera"]([-887, -597, 0], [4310, 3854, 169],
                           direction=(0.95, 0.30, 0.58), margin=1.05, lens=46.0)
        ns["render"](OUT + "_02_全城鸟瞰_自西南.png", samples=48)
        print("[shot] 02 全城鸟瞰（另一侧）")

    # 3~8) 各处中景
    shot(3, "国会大厦", -77.0075, 38.8885, 620.0, (-0.55, 1.0, 0.44), 1.06, 46.0, z=22.0)
    shot(4, "国家广场", -77.0320, 38.8892, 900.0, (0.90, 0.80, 0.42), 1.04, 46.0, z=25.0)
    shot(5, "白宫与宾大道", -77.0362, 38.8975, 620.0, (0.85, -0.90, 0.42), 1.08, 48.0, z=20.0)
    shot(6, "杜邦圆环街区", -77.0432, 38.9098, 620.0, (1.0, -0.80, 0.40), 1.06, 48.0, z=18.0)
    shot(7, "联合车站一带", -77.0062, 38.8978, 620.0, (-0.80, -1.0, 0.42), 1.06, 48.0, z=20.0)
    shot(8, "会议中心街区", -77.0228, 38.9028, 700.0, (1.0, 0.85, 0.40), 1.06, 48.0, z=18.0)

    # 9) 正俯视总平面（正交，画地图用）
    if want(9):
        x, y = xy(-77.0300, 38.9050)
        ns["place_camera"]([x - 2600, y - 2600, 0.0], [x + 2600, y + 2600, 300.0],
                           target=(x, y, 0.0), direction=(0.01, -0.01, 1.0), margin=1.0, lens=50.0)
        bpy.context.scene.camera.data.type = "ORTHO"
        bpy.context.scene.camera.data.ortho_scale = 5900.0
        ns["render"](OUT + "_09_正俯视总平面.png", samples=48)
        print("[shot] 09 正俯视总平面")

    print("[done] %s" % OUT)


main()
