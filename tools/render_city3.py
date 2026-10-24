# -*- coding: utf-8 -*-
"""城市级渲染 v3：蓝天空 + 几何专属雾 + 门窗格 + 逐栋材质变化。

相比 v1 (render_city.py) 的改进：
  1. ★ 逐栋材质变化 —— blosm 的 3D simple 路径让 21,995 栋楼共用同一个
     `wall` 材质（defaultColors wall=(1.0,0.5,0.2) 强烈橙色）和同一个 `roof`
     材质，整城一色。这里复制成调色板变体，按物体名稳定哈希逐栋分配。
  2. ★ 立面窗格 —— 用 Brick Texture 在墙面上生成规则的窗洞（深色玻璃），
     这是"看着像楼"和"看着像塑料块"之间最大的差别。
  3. ★ 蓝色天空 —— Sky Texture (Hosek-Wilkie/Nishita) 真实大气渐变。
  4. ★ 大气透视用**合成器 Mist 通道**做，只作用于几何、不影响天空
     （v2 用 world 节点混合反而把天空也搅成了灰的，见下）。
  5. 太阳 + 天光补光 + 地面反弹，避免背阴面死黑。

v2 踩的坑:
  * world 节点里用 Light Path → Mix Shader 做雾，会把**天空本身**也混进雾色，
    结果整个天空变成灰褐色。→ 改用 Mist 通道 + 合成器。
  * `scene_bbox()` 返回的是 tuple，不能写 `b.z.y` → 必须 `lo, hi = scene_bbox(...)`。
  * 近景相机放在离地标 260 m 处会插进楼里 → 近景要沿空旷轴（国家广场）放。

用法:
    blender.exe --background --python render_city3.py -- <in.blend> <out_prefix> [视图...]
视图: aerial / aerial2 / mall / capitol / capitol2 / monument / whitehouse / closeup
"""
import hashlib
import math
import os
import sys

import bpy
from mathutils import Vector


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- 工具

def scene_bbox(objs):
    xs, ys, zs = [], [], []
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            xs.append(w.x); ys.append(w.y); zs.append(w.z)
    if not xs:
        return Vector((0, 0, 0)), Vector((1, 1, 1))
    return Vector((min(xs), min(ys), min(zs))), Vector((max(xs), max(ys), max(zs)))


def find_objects(*keys):
    out = []
    for o in bpy.data.objects:
        if o.type not in ("MESH", "CURVE"):
            continue
        n = o.name.lower()
        for k in keys:
            if k.lower() in n:
                out.append(o)
                break
    return out


def stable01(s):
    return int(hashlib.md5(str(s).encode()).hexdigest()[:8], 16) / float(0xFFFFFFFF)


# ---------------------------------------------------------------- 材质

# 真实城市立面色板（DC 联邦建筑以石灰岩米白为主，夹杂砖红/混凝土灰/玻璃幕墙）
WALL_PALETTE = [
    (0.74, 0.71, 0.63),   # 石灰岩米白 ★ DC 主色
    (0.68, 0.65, 0.58),   # 浅灰石材
    (0.60, 0.54, 0.46),   # 暖灰
    (0.62, 0.43, 0.35),   # 砖红
    (0.52, 0.49, 0.45),   # 混凝土灰
    (0.46, 0.50, 0.55),   # 灰蓝玻璃
    (0.71, 0.67, 0.55),   # 浅米黄
    (0.54, 0.52, 0.49),   # 深灰
    (0.63, 0.60, 0.53),   # 中性米灰
    (0.49, 0.44, 0.39),   # 深褐
]
ROOF_PALETTE = [
    (0.30, 0.28, 0.26),   # 深灰沥青
    (0.40, 0.26, 0.20),   # 陶瓦红褐
    (0.35, 0.33, 0.31),   # 灰褐
    (0.25, 0.24, 0.23),   # 近黑
    (0.44, 0.39, 0.32),   # 浅褐
    (0.37, 0.36, 0.34),   # 中性灰
]


def principled(mat):
    if not mat.use_nodes:
        mat.use_nodes = True
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(b.outputs["BSDF"], out.inputs["Surface"])
    return b


def set_in(node, name, val):
    if name in node.inputs:
        try:
            node.inputs[name].default_value = val
            return True
        except Exception:
            pass
    return False


def make_wall_mat(src, name, color, rough, windows=True,
                  win=(2.6, 2.4, 0.9), glass=(0.055, 0.075, 0.105)):
    """墙面材质：底色 + 程序化窗格 + 轻微凹凸。

    ★ 投影的坑（第一版踩过）：
      直接用 Object 坐标喂 Brick Texture，它默认读向量的 X 和 **Y**。
      竖直墙面的 Y 是"进深"方向、几乎不变 → 渲染出来是**一条条通高的竖条纹**，
      而不是窗户。
      修法：把坐标重组成 U = x + y（水平方向），V = z（竖直方向）。
      这样无论墙面朝哪个方向，U 都沿水平走、V 都沿高度走，窗格比例才正确。
    win = (窗宽 m, 层高 m, 窗间距 m)
    """
    m = src.copy()
    m.name = name
    m.use_nodes = True
    nt = m.node_tree
    b = principled(m)
    set_in(b, "Base Color", (*color, 1.0))
    set_in(b, "Roughness", rough)
    set_in(b, "Metallic", 0.0)
    m.diffuse_color = (*color, 1.0)

    if not windows:
        return m
    try:
        ww, wh, gap = win
        tc = nt.nodes.new("ShaderNodeTexCoord")
        sep = nt.nodes.new("ShaderNodeSeparateXYZ")
        nt.links.new(tc.outputs["Object"], sep.inputs["Vector"])
        # U = x + y  → 水平方向（对朝 ±Y 和朝 ±X 的墙都成立）
        addxy = nt.nodes.new("ShaderNodeMath")
        addxy.operation = "ADD"
        nt.links.new(sep.outputs["X"], addxy.inputs[0])
        nt.links.new(sep.outputs["Y"], addxy.inputs[1])
        comb = nt.nodes.new("ShaderNodeCombineXYZ")
        nt.links.new(addxy.outputs["Value"], comb.inputs["X"])
        nt.links.new(sep.outputs["Z"], comb.inputs["Y"])   # V = z（高度）

        br = nt.nodes.new("ShaderNodeTexBrick")
        br.offset = 0.0
        br.offset_frequency = 1
        br.squash_frequency = 1
        set_in(br, "Color1", (*glass, 1.0))                 # 玻璃
        set_in(br, "Color2", (*[c * 1.25 for c in glass], 1.0))
        set_in(br, "Mortar", (*color, 1.0))                  # 砖缝 = 墙色（窗框）
        set_in(br, "Scale", 1.0)
        set_in(br, "Mortar Size", gap)
        set_in(br, "Mortar Smooth", 0.05)
        set_in(br, "Bias", 0.0)
        set_in(br, "Brick Width", ww)
        set_in(br, "Row Height", wh)
        nt.links.new(comb.outputs["Vector"], br.inputs["Vector"])
        nt.links.new(br.outputs["Color"], b.inputs["Base Color"])

        # 凹凸：窗框略有起伏
        bump = nt.nodes.new("ShaderNodeBump")
        set_in(bump, "Strength", 0.10)
        nt.links.new(br.outputs["Color"], bump.inputs["Height"])
        if "Normal" in b.inputs:
            nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    except Exception as e:
        log("  ⚠ 窗格材质失败（退回纯色）%s: %s" % (name, e))
    return m


def make_roof_mat(src, name, color, rough):
    m = src.copy()
    m.name = name
    m.use_nodes = True
    b = principled(m)
    set_in(b, "Base Color", (*color, 1.0))
    set_in(b, "Roughness", rough)
    set_in(b, "Metallic", 0.0)
    m.diffuse_color = (*color, 1.0)
    return m


def vary_materials(windows=True):
    wall0 = bpy.data.materials.get("wall")
    if wall0 is None:
        log("  ⚠ 找不到 wall 材质，跳过材质变化")
        return
    walls = [make_wall_mat(wall0, "wall_v%d" % i, c, 0.72, windows)
             for i, c in enumerate(WALL_PALETTE)]
    roof0 = bpy.data.materials.get("roof")
    roofs = ([make_roof_mat(roof0, "roof_v%d" % i, c, 0.80)
              for i, c in enumerate(ROOF_PALETTE)] if roof0 else [])

    n_wall = n_roof = 0
    for o in bpy.data.objects:
        if o.type != "MESH" or not o.data.polygons or not o.material_slots:
            continue
        lo, hi = scene_bbox([o])
        if (hi.z - lo.z) < 1.0:            # 高度 < 1 m 的多半是道路
            continue
        for slot in o.material_slots:
            mn = slot.material.name if slot.material else ""
            if mn == "wall" or mn.startswith("wall_v"):
                r = stable01(o.name)
                slot.material = walls[int(r * len(walls)) % len(walls)]
                n_wall += 1
            elif roofs and (mn == "roof" or mn.startswith("roof_v")):
                r = stable01(o.name + "_roof")
                slot.material = roofs[int(r * len(roofs)) % len(roofs)]
                n_roof += 1
    log("  材质变化: wall %d 槽 → %d 种(带窗格), roof %d 槽 → %d 种"
        % (n_wall, len(walls), n_roof, len(roofs)))


# ---------------------------------------------------------------- 渲染

def setup_render(engine_pref=None):
    scene = bpy.context.scene
    for e in ([engine_pref] if engine_pref else []) + [
            "BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"]:
        try:
            scene.render.engine = e
            log("渲染引擎:", e)
            break
        except Exception:
            continue
    scene.render.resolution_x, scene.render.resolution_y = 2560, 1440
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = False

    ee = getattr(scene, "eevee", None)
    if ee:
        for attr, val in (("taa_render_samples", 64), ("use_shadows", True),
                          ("use_raytracing", True), ("use_gtao", True),
                          ("use_soft_shadows", True), ("shadow_ray_count", 4),
                          ("shadow_step_count", 8)):
            if hasattr(ee, attr):
                try:
                    setattr(ee, attr, val)
                except Exception:
                    pass
    vs = scene.view_settings
    for vt in ("AgX", "Filmic", "Standard"):
        try:
            vs.view_transform = vt
            log("色彩变换:", vt)
            break
        except Exception:
            continue
    # AgX 默认偏灰，用 Punchy look 找回一点饱和度
    for lk in ("AgX - Punchy", "Punchy", "None"):
        try:
            vs.look = lk
            log("look:", lk)
            break
        except Exception:
            continue
    log("分辨率: %dx%d" % (scene.render.resolution_x, scene.render.resolution_y))


def setup_sky(sun_elev=36.0, sun_rot=205.0):
    scene = bpy.context.scene
    w = bpy.data.worlds.get("RC_World") or bpy.data.worlds.new("RC_World")
    scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    set_in(bg, "Strength", 1.0)
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])

    sky = nt.nodes.new("ShaderNodeTexSky")
    for st in ("NISHITA", "HOSEK_WILKIE", "PREETHAM"):
        try:
            sky.sky_type = st
            log("天空模型:", st)
            break
        except Exception:
            continue
    if hasattr(sky, "sun_elevation"):
        sky.sun_elevation = math.radians(sun_elev)
    if hasattr(sky, "sun_rotation"):
        sky.sun_rotation = math.radians(sun_rot)
    for attr, val in (("altitude", 40.0), ("sun_intensity", 1.0), ("sun_disc", True)):
        if hasattr(sky, attr):
            try:
                setattr(sky, attr, val)
            except Exception:
                pass
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    log("天空: 太阳高度 %.0f° 方位 %.0f°" % (sun_elev, sun_rot))
    return sun_elev, sun_rot


def setup_sun(elev=36.0, azim=205.0):
    scene = bpy.context.scene
    for o in list(bpy.data.objects):
        if o.type == "LIGHT" and o.name.startswith("RC_"):
            bpy.data.objects.remove(o, do_unlink=True)
    ld = bpy.data.lights.new("RC_Sun", type="SUN")
    ld.energy = 3.6
    ld.angle = math.radians(1.0)
    try:
        ld.color = (1.0, 0.96, 0.90)
    except Exception:
        pass
    sun = bpy.data.objects.new("RC_Sun", ld)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(90.0 - elev), 0.0, math.radians(azim))
    log("太阳: 高度 %.0f° 方位 %.0f°" % (elev, azim))


def setup_fill(lo, hi):
    """天光补光：大面积 AREA 灯，压掉背阴面死黑。"""
    scene = bpy.context.scene
    c = (lo + hi) / 2
    span = max(hi.x - lo.x, hi.y - lo.y)
    ld = bpy.data.lights.new("RC_Fill", type="AREA")
    ld.energy = 2.2e7
    ld.size = span * 1.8
    try:
        ld.color = (0.70, 0.79, 0.95)
    except Exception:
        pass
    o = bpy.data.objects.new("RC_Fill", ld)
    scene.collection.objects.link(o)
    o.location = (c.x, c.y, hi.z + span * 0.9)
    return o


def setup_atmosphere(lo, hi, fog=(0.74, 0.82, 0.93), start=1200.0, depth=8000.0,
                     strength=1.0, sky_cut=14000.0):
    """大气透视：用 Mist 通道 + 合成器混合，并用 Depth 把天空排除掉。

    ★ 两个必须解决的坑:
      1. v2 在 world 节点里用 Light Path 混合 → 天空本身也被搅成灰褐色。
      2. 光用 Mist 通道也不行：EEVEE 里天空像素的 Mist 恒为 1.0，
         所以天空同样会被刷上雾色（v3 实测：顶部天空发灰）。
    解法：用 **Depth 通道** 造一个"这是几何不是天空"的遮罩 —— 天空的 depth
    是个极大值（≈1e10），几何的 depth 在几公里内。超过 sky_cut 就判为天空，
    雾强度归零 → 天空保持蓝，只有远处的楼有纵深衰减。
    """
    scene = bpy.context.scene
    try:
        scene.world.mist_settings.start = start
        scene.world.mist_settings.depth = depth
        scene.world.mist_settings.falloff = "LINEAR"
        for vl in scene.view_layers:
            vl.use_pass_mist = True
            vl.use_pass_z = True
    except Exception as e:
        log("  ⚠ mist 设置失败: %s" % e)
    try:
        scene.use_nodes = True
        nt = scene.node_tree
        nt.nodes.clear()
        rl = nt.nodes.new("CompositorNodeRLayers")

        # 1) 天空遮罩: depth 超过 sky_cut → 0
        #    mask = 1 - clamp((depth - sky_cut) / sky_cut, 0, 1)
        sub = nt.nodes.new("CompositorNodeMath")
        sub.operation = "SUBTRACT"
        div = nt.nodes.new("CompositorNodeMath")
        div.operation = "DIVIDE"
        div.inputs[1].default_value = sky_cut
        one_minus = nt.nodes.new("CompositorNodeMath")
        one_minus.operation = "SUBTRACT"
        one_minus.inputs[0].default_value = 1.0
        nt.links.new(rl.outputs["Depth"], sub.inputs[0])
        sub.inputs[1].default_value = sky_cut
        nt.links.new(sub.outputs["Value"], div.inputs[0])
        nt.links.new(div.outputs["Value"], one_minus.inputs[1])

        # 2) 雾量 = mist * mask * strength
        mulm = nt.nodes.new("CompositorNodeMath")
        mulm.operation = "MULTIPLY"
        nt.links.new(rl.outputs["Mist"], mulm.inputs[0])
        nt.links.new(one_minus.outputs["Value"], mulm.inputs[1])
        muls = nt.nodes.new("CompositorNodeMath")
        muls.operation = "MULTIPLY"
        muls.inputs[1].default_value = strength
        muls.use_clamp = True
        nt.links.new(mulm.outputs["Value"], muls.inputs[0])

        mix = nt.nodes.new("CompositorNodeMixRGB")
        mix.blend_type = "MIX"
        mix.use_clamp = True
        set_in(mix, "Color2", (*fog, 1.0))
        comp = nt.nodes.new("CompositorNodeComposite")
        nt.links.new(rl.outputs["Image"], mix.inputs[1])
        nt.links.new(muls.outputs["Value"], mix.inputs[0])
        nt.links.new(mix.outputs["Image"], comp.inputs["Image"])
        log("大气透视: mist %.0f→%.0f m, 天空遮罩 %.0f m, 强度 %.2f"
            % (start, start + depth, sky_cut, strength))
    except Exception as e:
        log("  ⚠ 合成器失败: %s" % e)


def setup_ground(lo, hi, color=(0.28, 0.27, 0.24)):
    scene = bpy.context.scene
    old = bpy.data.objects.get("RC_Ground")
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    cx, cy = (lo.x + hi.x) / 2, (lo.y + hi.y) / 2
    span = max(hi.x - lo.x, hi.y - lo.y) * 1.06
    bpy.ops.mesh.primitive_plane_add(size=span, location=(cx, cy, lo.z - 0.05))
    g = bpy.context.active_object
    g.name = "RC_Ground"
    m = bpy.data.materials.get("RC_GroundMat") or bpy.data.materials.new("RC_GroundMat")
    m.use_nodes = True
    b = principled(m)
    set_in(b, "Base Color", (*color, 1.0))
    set_in(b, "Roughness", 0.95)
    g.data.materials.append(m)
    return g


def make_camera():
    scene = bpy.context.scene
    cam = bpy.data.objects.get("RC_Cam")
    if not cam:
        cd = bpy.data.cameras.new("RC_Cam")
        cam = bpy.data.objects.new("RC_Cam", cd)
        scene.collection.objects.link(cam)
    cd = cam.data
    cd.clip_start = 1.0
    cd.clip_end = 200000.0
    scene.camera = cam
    return cam


def aim(cam, eye, target, lens):
    cam.data.type = "PERSP"
    cam.data.lens = lens
    cam.location = Vector(eye)
    cam.rotation_euler = (Vector(target) - Vector(eye)).to_track_quat("-Z", "Y").to_euler()


def shoot(prefix, tag):
    scene = bpy.context.scene
    scene.render.filepath = os.path.abspath("%s_%s.png" % (prefix, tag))
    bpy.ops.render.render(write_still=True)
    log("  → %s  %d 字节" % (scene.render.filepath, os.path.getsize(scene.render.filepath)))


# ---------------------------------------------------------------- 主流程

def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    inp = os.path.abspath(argv[0])
    prefix = os.path.abspath(argv[1])
    views = argv[2:] or ["aerial"]
    no_windows = "--no-windows" in views
    no_fog = "--no-fog" in views
    views = [v for v in views if not v.startswith("--")]

    bpy.ops.wm.open_mainfile(filepath=inp)
    log("=" * 84)
    log("打开:", inp)

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    lo, hi = scene_bbox(meshes)
    center = (lo + hi) / 2
    span = max(hi.x - lo.x, hi.y - lo.y)
    log("包围盒 X=%.0f Y=%.0f Z=%.0f  跨度=%.0f m"
        % (hi.x - lo.x, hi.y - lo.y, hi.z - lo.z, span))

    cap = scene_bbox(find_objects("united states capitol", "us capitol", "capitol building"))
    mon = scene_bbox(find_objects("washington monument", "monument"))
    wh = scene_bbox(find_objects("white house", "the white house"))
    lin = scene_bbox(find_objects("lincoln memorial"))
    marks = {"capitol": cap, "monument": mon, "whitehouse": wh, "lincoln": lin}
    for k, (a, b) in marks.items():
        if (b.x - a.x) > 0 or (b.y - a.y) > 0:
            log("地标 %-10s 中心=(%.0f,%.0f) 高=%.1f m"
                % (k, (a.x + b.x) / 2, (a.y + b.y) / 2, b.z - a.z))
        else:
            log("地标 %-10s 未找到" % k)

    setup_render()
    elev, azim = setup_sky()
    setup_sun(elev, azim)
    setup_ground(lo, hi)
    vary_materials(windows=not no_windows)
    setup_fill(lo, hi)
    if not no_fog:
        setup_atmosphere(lo, hi)
    cam = make_camera()

    def mid(a, b, z=0.0):
        return Vector(((a.x + b.x) / 2, (a.y + b.y) / 2, z))

    def found(a):
        return (a[1].x - a[0].x) > 0 or (a[1].y - a[0].y) > 0

    C = mid(*cap, z=45) if found(cap) else Vector((center.x, center.y, 45))
    M = mid(*mon, z=55) if found(mon) else C
    W = mid(*wh, z=16) if found(wh) else C
    L = mid(*lin, z=25) if found(lin) else C

    for v in views:
        log("-" * 84)
        log("视图:", v)
        if v == "aerial":
            # 高角度俯视：xy 偏移要小于高度，否则会看到地面网格的边缘（地平线）
            t = Vector((center.x, center.y, 0))
            eye = (center.x - span * 0.34, center.y - span * 0.52, span * 0.78)
            aim(cam, eye, t, 34)
        elif v == "aerial2":
            t = Vector((center.x, center.y, 0))
            eye = (center.x + span * 0.30, center.y + span * 0.58, span * 0.36)
            aim(cam, eye, t, 42)
        elif v == "mall":
            eye = (L.x - 380, L.y - 60, 42)
            aim(cam, eye, (C.x, C.y, 55), 52)
        elif v == "capitol":
            d = (C - M)
            d = d.normalized() if d.length > 1 else Vector((0, -1, 0))
            eye = C + d * 800
            eye.z = 70
            aim(cam, eye, (C.x, C.y, 48), 62)
        elif v == "capitol2":
            aim(cam, (C.x - 620, C.y - 700, 420), (C.x, C.y, 40), 80)
        elif v == "monument":
            d = (M - C)
            d = d.normalized() if d.length > 1 else Vector((0, -1, 0))
            eye = M + d * 700
            eye.z = 60
            aim(cam, eye, (M.x, M.y, 90), 58)
        elif v == "whitehouse":
            # ★ 白宫南面朝椭圆草坪(Elipse)与国家广场，是开阔的；
            #   朝北是拉法耶特广场和密集街区。所以相机要放在**南侧**。
            d = (W - M)
            d = d.normalized() if d.length > 1 else Vector((0, -1, 0))
            eye = W + d * 420
            eye.z = 55
            aim(cam, eye, (W.x, W.y, 16), 55)
        elif v == "capitolwest":
            # 从国家广场正面看国会（西立面）
            d = (M - C)
            d = d.normalized() if d.length > 1 else Vector((0, -1, 0))
            eye = C + d * 1100
            eye.z = 90
            aim(cam, eye, (C.x, C.y, 45), 70)
        elif v == "closeup":
            d = (C - M)
            d = d.normalized() if d.length > 1 else Vector((0, -1, 0))
            eye = C + d * 1500
            eye.z = 130
            aim(cam, eye, (C.x, C.y, 60), 85)
        else:
            log("  未知视图，跳过")
            continue
        shoot(prefix, v)

    log("=" * 84)
    log("全部完成")


main()
