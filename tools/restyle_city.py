# -*- coding: utf-8 -*-
r"""给 DC 那版城市重新上色 + 补地面 + 补天空阴影，出一张"像真的"的图。

诊断依据（tools\inspect_dc_materials.py 实测 out\dc_downtown_v2.blend）：
    材质总数 39，其中
        wall        被 21995 个物体用   diffuse=(1.000,0.500,0.200)  ← 通用橙色
        roof        被 21994 个物体用   diffuse=(0.290,0.250,0.210)  ← 通用深棕
        vegetation  被  1205 个物体用   diffuse=(0.007,0.558,0.005)  ← 纯绿标记色
        water       被   109 个物体用   diffuse=(0.009,0.002,0.800)  ← 纯蓝标记色
        道路类（roads_* / paths_* / areas_*）全是 (0.086,0.091,0.089)
    也就是说：**22004 栋楼里 21995 栋穿的是同一个"橙色默认材质"**，
    只有十几个从 OSM 的 building:colour=#xxxxxx 标签来的十六进制材质
    （a2abb2 / c3bbae / cb9c92 / 43b3ae / 947f7a / 875a5d / 5e818b / 40484a / a5a492）
    是真数据。再加上场景里**完全没有地面物体**，所以整个画面就是
    "橙房子 + 深棕屋顶 + 荧光绿草地 + 纯蓝水面 + 近黑路面 + 灰底背景"。

    → 这就是"不像华盛顿"的全部技术原因，而且全都不用花钱、不用大模型就能改。

本脚本做四件事：
    1) 把 wall 换成 10 种华盛顿常见的石材色（花岗岩/石灰岩：暖灰、米白、浅褐），
       按物体名做确定性哈希分配，让 2 万栋楼有自然色差而不是一片橙。
    2) 把 roof 换成 6 种深灰/灰褐色（真实 DC 屋顶多为深灰卷材或铜锈）。
    3) 把 vegetation / water / 道路换成收敛过的自然色（不再用荧光标记色）。
    4) 补一块地面（z=-0.25，比所有物体低），再加天空 + 太阳 + 阴影，
       渲染"全景"和"国家广场近景"两张图。

用法：
    D:\blender\blender.exe --background --python tools\restyle_city.py -- <输入blend> <输出前缀>
"""
import math
import os
import sys
import zlib

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
SRC = argv[0] if len(argv) > 0 else r"D:\Users\asus\Desktop\项目\out\dc_downtown_v2.blend"
OUT = argv[1] if len(argv) > 1 else r"D:\Users\asus\Desktop\项目\out\dc_styled"

# ── 华盛顿常见石材色（线性空间的近似值，参考花岗岩/石灰岩/砂石） ─────────────
STONE = [
    (0.62, 0.60, 0.56),   # 灰花岗岩
    (0.72, 0.70, 0.65),   # 浅石灰岩
    (0.55, 0.53, 0.50),   # 深花岗岩
    (0.78, 0.74, 0.66),   # 米白砂岩
    (0.66, 0.62, 0.55),   # 暖灰
    (0.50, 0.48, 0.46),   # 深灰石材
    (0.70, 0.66, 0.60),   # 象牙
    (0.58, 0.55, 0.52),   # 中性灰
    (0.74, 0.71, 0.67),   # 浅暖灰
    (0.46, 0.44, 0.42),   # 炭灰石材
]
ROOF_TONES = [
    (0.22, 0.22, 0.22),   # 深灰卷材
    (0.28, 0.27, 0.25),   # 灰褐
    (0.19, 0.20, 0.21),   # 近黑沥青
    (0.33, 0.30, 0.27),   # 风化铜锈
    (0.25, 0.24, 0.23),   # 中性深灰
    (0.38, 0.36, 0.33),   # 浅灰砾石
]
VEGETATION = (0.16, 0.26, 0.10)      # 收敛的橄榄绿，不是荧光绿
WATER = (0.11, 0.19, 0.25)           # 深蓝绿
ROADS = (0.13, 0.13, 0.13)           # 沥青
GROUND = (0.19, 0.19, 0.18)


def _set_base(m, color, rough=0.9, metal=0.0):
    r"""把颜色写进渲染**真正会读**的地方。

    ★ 关键坑（已用 tools/probe_material_nodes.py 实证；本机界面语言 = zh_HANS）：

      Blender 会按界面语言给"自动生成的默认节点"命名 —— 中文界面下那个节点叫
      「原理化 BSDF」，不叫 "Principled BSDF"。于是：

          m.node_tree.nodes.get("Principled BSDF")   # → None，改了等于没改
          m.node_tree.nodes.get("原理化 BSDF")        # → 只在中文界面成立，换个语言又废

      而 blosm 自带的 `blosm\util\blender.py:85-88 createDiffuseMaterial()` 只写
      legacy 的 `m.diffuse_color`，**根本不碰节点树** → 节点里的 Base Color 一直停在
      默认的 (0.8, 0.8, 0.8) 灰白。后果：

          Workbench + `shading.color_type = "MATERIAL"` → 读 diffuse_color，颜色正常
          EEVEE / Cycles                              → 读节点树，整城一片惨白

      这正是「之前 Workbench 出的 DC 图是橙色、一换 EEVEE 就全白」的完整解释。

      → 唯一稳的做法：**按节点类型 `BSDF_PRINCIPLED` 去找**，绝不按名字找。
        socket 名（"Base Color" / "Roughness" / "Metallic"）不受本地化影响，可以直接用。
        （另：`m.use_nodes = False` 在 Blender 5.2 实测**不生效**，赋值后仍为 True，
          所以不能靠关节点树绕开这个问题。）
    """
    rgb = (color[0], color[1], color[2], 1.0)
    m.diffuse_color = rgb                      # Workbench 读这里
    m.roughness = rough
    m.metallic = metal
    if m.use_nodes and m.node_tree:
        bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf:
            bsdf.inputs["Base Color"].default_value = rgb   # EEVEE / Cycles 读这里
            bsdf.inputs["Roughness"].default_value = rough
            bsdf.inputs["Metallic"].default_value = metal
    return m


def recolor(name, color, rough=0.9, metal=0.0):
    m = bpy.data.materials.get(name)
    return _set_base(m, color, rough, metal) if m else None


def make_material(name, color, rough=0.9, metal=0.0):
    m = bpy.data.materials.get(name)
    if m:
        bpy.data.materials.remove(m)
    m = bpy.data.materials.new(name)
    _set_base(m, color, rough, metal)
    m.use_fake_user = True
    return m


def pick(seq, key):
    return seq[zlib.crc32(key.encode("utf-8")) % len(seq)]


def restyle():
    # 1) 建色板
    stones = [make_material("dc_stone_%02d" % (i + 1), c, 0.85) for i, c in enumerate(STONE)]
    roofs = [make_material("dc_roof_%02d" % (i + 1), c, 0.80) for i, c in enumerate(ROOF_TONES)]
    print("[restyle] 石材 %d 种 / 屋顶 %d 种" % (len(stones), len(roofs)))

    # 2) 旧材质改色
    for n in ("vegetation",):
        recolor(n, VEGETATION, 0.95)
    recolor("water", WATER, 0.25)
    for m in bpy.data.materials:
        if m.name.startswith(("roads_", "paths_", "areas_")):
            recolor(m.name, ROADS, 0.92)
    recolor("white", (0.80, 0.79, 0.76), 0.85)

    # 3) 逐物体换 wall / roof
    n_wall = n_roof = 0
    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        for slot in o.material_slots:
            m = slot.material
            if not m:
                continue
            if m.name == "wall":
                slot.link = "OBJECT"
                slot.material = pick(stones, o.name + "w")
                n_wall += 1
            elif m.name == "roof":
                slot.link = "OBJECT"
                slot.material = pick(roofs, o.name + "r")
                n_roof += 1
    print("[restyle] 换掉的墙材质槽 %d 个 / 屋顶材质槽 %d 个" % (n_wall, n_roof))

    # 4) 地面
    lo = [1e18] * 3
    hi = [-1e18] * 3
    for o in bpy.data.objects:
        if o.type != "MESH" or not o.data.vertices:
            continue
        for c in o.bound_box:
            w = o.matrix_world @ __import__("mathutils").Vector(c)
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])
    cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
    sx, sy = (hi[0] - lo[0]) * 1.15, (hi[1] - lo[1]) * 1.15
    bpy.ops.mesh.primitive_plane_add(size=1.0, location=(cx, cy, -0.25))
    ground = bpy.context.active_object
    ground.name = "ground"
    ground.scale = (sx, sy, 1.0)
    gm = make_material("dc_ground", GROUND, 0.95)
    ground.data.materials.clear()
    ground.data.materials.append(gm)
    print("[restyle] 地面: 中心 (%.1f, %.1f, -0.25)  尺寸 %.0f x %.0f m" % (cx, cy, sx, sy))
    return lo, hi


# ── 渲染（沿用 render_scene.py 的实测可用参数） ─────────────────────────────
def setup_world():
    w = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    bpy.context.scene.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0.32, 0.46, 0.72, 1.0)
        bg.inputs["Strength"].default_value = 0.26   # 降环境光：DC 是浅色石材，靠直射光+阴影拉开对比才不糊成一片白


def add_sun():
    """
    曝光账（Standard 视图变换没有高光滚降，1.0 以上就是死白，所以必须算）：
        漫反射面的出射辐射 = albedo * (E_sun * cosθ / π + L_world)
        E_sun = 2.2, 太阳高度 35° → cosθ ≈ 0.57 → 直射项 ≈ 0.40 * albedo
        L_world = 0.55 * ~0.5 = 0.28            → 天光项 ≈ 0.28 * albedo
        石材 albedo 0.62 → 0.42（sRGB ≈ 0.67，浅灰不爆）
        地面 albedo 0.19 → 0.13（sRGB ≈ 0.39，深灰）
    """
    for o in list(bpy.data.objects):
        if o.type == "LIGHT":
            bpy.data.objects.remove(o, do_unlink=True)
    d = bpy.data.lights.new("Sun", type="SUN")
    d.energy = 3.4
    d.angle = math.radians(2.0)
    o = bpy.data.objects.new("Sun", d)
    bpy.context.scene.collection.objects.link(o)
    o.rotation_euler = (math.radians(58), 0.0, math.radians(38))
    return o


def place_camera(lo, hi, target=None, direction=(1.0, -1.0, 0.55), margin=1.25, lens=50.0):
    from mathutils import Vector
    for o in list(bpy.data.objects):
        if o.type == "CAMERA":
            bpy.data.objects.remove(o, do_unlink=True)
    cam = bpy.data.cameras.new("Camera")
    cam.clip_start = 1.0
    cam.clip_end = 200000.0
    cam.lens = lens
    obj = bpy.data.objects.new("Camera", cam)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.scene.camera = obj

    if target is None:
        target = Vector(((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2))
    else:
        target = Vector(target)

    span = max(hi[0] - lo[0], hi[1] - lo[1])
    dist = span * margin
    d = Vector(direction).normalized()
    obj.location = target + d * dist
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()
    return obj


def render(path, res=(1920, 1200), samples=48):
    sc = bpy.context.scene
    for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"):
        try:
            sc.render.engine = engine
            break
        except Exception:
            continue
    print("[render] 引擎 %s" % sc.render.engine)
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.render.filepath = os.path.abspath(path)
    sc.view_settings.view_transform = "Standard"
    ee = getattr(sc, "eevee", None)
    if ee:
        for attr, val in (("taa_render_samples", samples), ("use_shadows", True),
                          ("use_gtao", True), ("use_raytracing", True)):
            if hasattr(ee, attr):
                try:
                    setattr(ee, attr, val)
                except Exception:
                    pass
    bpy.ops.render.render(write_still=True)
    print("[render] 写出 %s" % sc.render.filepath)


if __name__ == "__main__":
    QUICK = os.environ.get("QUICK") == "1"
    bpy.ops.wm.open_mainfile(filepath=SRC)
    print("[open] %s" % SRC)
    lo, hi = restyle()
    setup_world()
    add_sun()
    bpy.context.scene.render.film_transparent = False

    # 全景
    place_camera(lo, hi, direction=(1.0, -1.05, 0.50), margin=1.45, lens=42.0)
    render(OUT + "_全景.png",
           res=(960, 600) if QUICK else (1920, 1200),
           samples=8 if QUICK else 48)

    if not QUICK:
        # 国家广场 / 国会近景（场景坐标里 DC 的东南象限，实测国会大道一带）
        tx = lo[0] + (hi[0] - lo[0]) * 0.72
        ty = lo[1] + (hi[1] - lo[1]) * 0.22
        place_camera(
            [tx - 400, ty - 400, 0], [tx + 400, ty + 400, 60],
            target=(tx, ty, 25.0), direction=(1.0, -1.0, 0.42), margin=1.0, lens=55.0,
        )
        render(OUT + "_近景.png")

    bpy.ops.wm.save_as_mainfile(filepath=OUT + ".blend")
    print("[save] %s" % (OUT + ".blend"))
