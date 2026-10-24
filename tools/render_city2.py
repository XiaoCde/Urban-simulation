# -*- coding: utf-8 -*-
"""城市级高质量渲染 v2：EEVEE + 天空渐变 + 逐栋材质变化 + 光照 + 雾。

相比 v1 (render_city.py) 的改进：
  1. ★ 逐栋材质变化 —— blosm 3D simple 路径给所有建筑只发一个 wall 材质
     (defaultColors wall=(1.0,0.5,0.2) 强烈橙色) 和一个 roof 材质，所以整城是
     同一个橙色。这里把 wall/roof 复制成 N 个色相/明度微变的变体，按物体
     稳定哈希逐栋分配 → 一眼看过去有"楼与楼不一样"的真实感。
  2. 天空：用 Sky Texture 节点做真实大气渐变（v1 是纯色背景）。
  3. 光照：太阳 + 天光补光 + 地面反弹光，避免背阴面死黑。
  4. 雾：远景物衰减，给出城市尺度的大气纵深。
  5. EEVEE 光线追踪 / AO / 软阴影参数显式打开。

用法:
    blender.exe --background --python render_city2.py -- <in.blend> <out_prefix> [视图...]
视图: aerial / mall / capitol / monument / whitehouse / closeup
"""
import hashlib
import math
import os
import sys

import bpy
from mathutils import Vector


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- 基础工具

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


# ---------------------------------------------------------------- 材质变化

# 真实城市立面色板（米白石材 / 浅灰混凝土 / 砖红 / 灰蓝玻璃 / 深褐）
WALL_PALETTE = [
    (0.72, 0.69, 0.62),   # 石灰岩米白（DC 联邦建筑主色）
    (0.66, 0.63, 0.57),   # 浅灰石材
    (0.58, 0.52, 0.45),   # 暖灰
    (0.63, 0.44, 0.36),   # 砖红
    (0.50, 0.47, 0.44),   # 混凝土灰
    (0.44, 0.48, 0.52),   # 灰蓝（玻璃幕墙）
    (0.70, 0.66, 0.55),   # 浅米黄
    (0.52, 0.50, 0.48),   # 深灰
    (0.61, 0.58, 0.52),   # 中性米灰
    (0.47, 0.42, 0.38),   # 深褐
]
ROOF_PALETTE = [
    (0.30, 0.28, 0.26),   # 深灰沥青
    (0.38, 0.25, 0.20),   # 陶瓦红褐
    (0.34, 0.32, 0.30),   # 灰褐
    (0.25, 0.24, 0.23),   # 近黑
    (0.42, 0.37, 0.31),   # 浅褐
    (0.36, 0.35, 0.33),   # 中性灰
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
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return bsdf


def clone_mat(src, name, color, rough):
    m = src.copy()
    m.name = name
    b = principled(m)
    if "Base Color" in b.inputs:
        b.inputs["Base Color"].default_value = (*color, 1.0)
    for k, v in (("Roughness", rough), ("Metallic", 0.0)):
        if k in b.inputs:
            b.inputs[k].default_value = v
    m.diffuse_color = (*color, 1.0)
    m.use_nodes = True
    return m


def vary_materials():
    """把 wall / roof 材质展开成调色板变体，按物体稳定分配（逐栋不同色）。

    blosm 的 3D simple 路径让 21,995 栋建筑共用同一个 `wall` 材质、
    21,994 栋共用 `roof` 材质，所以整城只有一种颜色。这里给每栋楼
    替换成调色板里的一个变体。
    """
    wall0 = bpy.data.materials.get("wall")
    roof0 = bpy.data.materials.get("roof")
    if wall0 is None:
        log("  ⚠ 找不到 wall 材质，跳过材质变化")
        return 0

    wall_vars = [clone_mat(wall0, "wall_v%d" % i, c, 0.72)
                 for i, c in enumerate(WALL_PALETTE)]
    roof_vars = ([clone_mat(roof0, "roof_v%d" % i, c, 0.80)
                  for i, c in enumerate(ROOF_PALETTE)] if roof0 else [])

    n_wall = n_roof = 0
    for o in bpy.data.objects:
        if o.type != "MESH" or not o.data.polygons:
            continue
        # 只处理建筑（面积/高度上都像建筑）；道路曲线不碰
        blo, bhi = scene_bbox([o])
        if (bhi.z - blo.z) < 1.0:          # 高度 < 1 m 的多半是道路/地面
            continue
        if not o.material_slots:
            continue
        r = stable01(o.name)
        for slot in o.material_slots:
            mn = slot.material.name if slot.material else ""
            if mn == "wall" or mn.startswith("wall_v"):
                slot.material = wall_vars[int(r * len(wall_vars)) % len(wall_vars)]
                n_wall += 1
            elif roof_vars and (mn == "roof" or mn.startswith("roof_v")):
                r2 = stable01(o.name + "_roof")
                slot.material = roof_vars[int(r2 * len(roof_vars)) % len(roof_vars)]
                n_roof += 1
    log("  材质变化: wall 槽 %d 个 → %d 种, roof 槽 %d 个 → %d 种"
        % (n_wall, len(wall_vars), n_roof, len(roof_vars) if roof_vars else 0))
    return n_wall


# ---------------------------------------------------------------- 渲染设置

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
    scene.render.film_transparent = False

    ee = getattr(scene, "eevee", None)
    if ee:
        for attr, val in (
            ("taa_render_samples", 64),
            ("use_shadows", True),
            ("use_raytracing", True),
            ("use_gtao", True),            # 环境光遮蔽 → 楼与楼之间有阴影感
            ("use_soft_shadows", True),
            ("shadow_ray_count", 4),
            ("shadow_step_count", 8),
            ("use_volumetric_lights", True),
            ("volumetric_samples", 48),
            ("use_shadow_jitter_viewport", True),
        ):
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
    try:
        vs.look = "None"
    except Exception:
        pass
    log("分辨率: %dx%d" % (scene.render.resolution_x, scene.render.resolution_y))


def setup_sky(sun_elev=34.0, sun_rot=200.0):
    """真实大气渐变天空（Nishita）。太阳位置同时决定天空色温与主光方向。"""
    scene = bpy.context.scene
    w = bpy.data.worlds.get("RC_World") or bpy.data.worlds.new("RC_World")
    scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = 1.0
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])

    sky = nt.nodes.new("ShaderNodeTexSky")
    # Blender 各版本可选的 sky_type 不同，挑第一个能用的
    for st in ("NISHITA", "HOSEK_WILKIE", "PREETHAM"):
        try:
            sky.sky_type = st
            log("天空模型:", st)
            break
        except Exception:
            continue
    for attr, val in (("sun_elevation", math.radians(sun_elev)),
                      ("sun_rotation", math.radians(sun_rot)),
                      ("altitude", 30.0),
                      ("sun_intensity", 1.0)):
        if hasattr(sky, attr):
            try:
                setattr(sky, attr, val)
            except Exception:
                pass
    try:
        sky.sun_disc = True
    except Exception:
        pass
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    log("天空: 太阳高度 %.0f° 方位 %.0f°" % (sun_elev, sun_rot))
    return sun_elev, sun_rot


def setup_sun(elev=34.0, azim=200.0):
    """主太阳光。azimuth 从正北顺时针算，Blender 的 rotation_euler.z 需相应换算。"""
    scene = bpy.context.scene
    for o in list(bpy.data.objects):
        if o.type == "LIGHT" and o.name.startswith("RC_"):
            bpy.data.objects.remove(o, do_unlink=True)

    ld = bpy.data.lights.new("RC_Sun", type="SUN")
    ld.energy = 4.0
    ld.angle = math.radians(1.2)
    try:
        ld.color = (1.0, 0.95, 0.88)
    except Exception:
        pass
    sun = bpy.data.objects.new("RC_Sun", ld)
    scene.collection.objects.link(sun)
    # 太阳方向：先绕 X 抬起高度角，再绕 Z 转到方位角
    sun.rotation_euler = (math.radians(90.0 - elev), 0.0, math.radians(azim))
    log("太阳: 高度 %.0f° 方位 %.0f°" % (elev, azim))


def setup_fill(lo, hi):
    """天光补光：一个大面积 AREA 灯挂在城市上方，压掉背阴面的死黑。"""
    scene = bpy.context.scene
    c = (lo + hi) / 2
    span = max(hi.x - lo.x, hi.y - lo.y)
    ld = bpy.data.lights.new("RC_Fill", type="AREA")
    ld.energy = 3.0e7
    ld.size = span * 1.6
    try:
        ld.color = (0.72, 0.80, 0.95)      # 冷色天光
    except Exception:
        pass
    o = bpy.data.objects.new("RC_Fill", ld)
    scene.collection.objects.link(o)
    o.location = (c.x, c.y, hi.z + span * 0.8)
    o.rotation_euler = (0, 0, 0)
    return o


def setup_mist(fog_color=(0.66, 0.75, 0.86), start=900.0, end=9000.0):
    """大气纵深：把原来的天空输出与一个雾色混合，越远越混入雾。

    用 Light Path 的 Ray Length 经 Map Range 归一到 0~1 作为混合因子。
    这段在 EEVEE 里偶有兼容问题，所以整体 try/except —— 失败就纯天空，不影响出图。
    """
    scene = bpy.context.scene
    w = scene.world
    if not (w and w.node_tree):
        return
    nt = w.node_tree
    try:
        bg = next(n for n in nt.nodes if n.type == "BACKGROUND")
        out = next(n for n in nt.nodes if n.type == "OUTPUT_WORLD")

        mix = nt.nodes.new("ShaderNodeMixShader")
        mix.name = "RC_Mist_Mix"
        mist = nt.nodes.new("ShaderNodeBackground")
        mist.name = "RC_Mist_BG"
        mist.inputs["Color"].default_value = (*fog_color, 1.0)
        mist.inputs["Strength"].default_value = 1.0

        lp = nt.nodes.new("ShaderNodeMapRange")
        lp.name = "RC_Mist_Range"
        lp.interpolation_type = "LINEAR"
        lp.clamp = True
        lp.inputs["From Min"].default_value = start
        lp.inputs["From Max"].default_value = end

        path = nt.nodes.new("ShaderNodeLightPath")
        path.name = "RC_Mist_LP"
        nt.links.new(path.outputs["Ray Length"], lp.inputs["Value"])

        # 重新连线：bg -> mix[1], mist -> mix[2], factor -> mix[0], mix -> out
        for l in list(nt.links):
            if l.to_node is out:
                nt.links.remove(l)
        nt.links.new(bg.outputs["Background"], mix.inputs[1])
        nt.links.new(mist.outputs["Background"], mix.inputs[2])
        nt.links.new(lp.outputs["Result"], mix.inputs[0])
        nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
        log("雾: %.0f m 起, %.0f m 饱和" % (start, end))
    except Exception as e:
        log("  ⚠ 雾设置失败（忽略，继续用纯天空）: %s" % e)


def setup_ground(lo, hi, color=(0.26, 0.25, 0.23)):
    scene = bpy.context.scene
    old = bpy.data.objects.get("RC_Ground")
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    cx, cy = (lo.x + hi.x) / 2, (lo.y + hi.y) / 2
    span = max(hi.x - lo.x, hi.y - lo.y) * 3.0
    bpy.ops.mesh.primitive_plane_add(size=span, location=(cx, cy, lo.z - 0.05))
    g = bpy.context.active_object
    g.name = "RC_Ground"
    m = bpy.data.materials.get("RC_GroundMat") or bpy.data.materials.new("RC_GroundMat")
    m.use_nodes = True
    b = principled(m)
    if "Base Color" in b.inputs:
        b.inputs["Base Color"].default_value = (*color, 1.0)
    if "Roughness" in b.inputs:
        b.inputs["Roughness"].default_value = 0.95
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
    log("  → %s  %d 字节" % (scene.render.filepath,
                            os.path.getsize(scene.render.filepath)))


# ---------------------------------------------------------------- 主流程

def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    inp = os.path.abspath(argv[0])
    prefix = os.path.abspath(argv[1])
    views = argv[2:] or ["aerial"]

    bpy.ops.wm.open_mainfile(filepath=inp)
    log("=" * 84)
    log("打开:", inp)

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    lo, hi = scene_bbox(meshes)
    center = (lo + hi) / 2
    span = max(hi.x - lo.x, hi.y - lo.y)
    log("包围盒 X=%.0f Y=%.0f Z=%.0f  跨度=%.0f m"
        % (hi.x - lo.x, hi.y - lo.y, hi.z - lo.z, span))

    marks = {
        "capitol":    find_objects("united states capitol", "us capitol", "capitol building"),
        "monument":   find_objects("washington monument", "monument"),
        "whitehouse": find_objects("white house", "the white house"),
        "lincoln":    find_objects("lincoln memorial"),
        "mall":       find_objects("national mall", "the mall"),
    }
    for k, v in marks.items():
        if v:
            l, h = scene_bbox(v)
            log("地标 %-10s -> %d 个物体 中心=(%.0f,%.0f) 高=%.1f m"
                % (k, len(v), (l.x + h.x) / 2, (l.y + h.y) / 2, h.z - l.z))
        else:
            log("地标 %-10s -> 未找到" % k)

    setup_render()
    sun_elev, sun_azim = setup_sky()
    setup_sun(sun_elev, sun_azim)
    setup_ground(lo, hi)
    vary_materials()
    setup_fill(lo, hi)
    setup_mist()
    cam = make_camera()

    def focus(*keys, fallback=None):
        objs = find_objects(*keys)
        if objs:
            l, h = scene_bbox(objs)
            return (l + h) / 2
        return Vector(fallback or (center.x, center.y, 0))

    for v in views:
        log("-" * 84)
        log("视图:", v)
        if v == "aerial":
            # 高空斜视：从西南上方俯瞰整城
            t = Vector((center.x, center.y, 0))
            eye = (center.x - span * 0.40, center.y - span * 0.62, span * 0.42)
            aim(cam, eye, t, 40)
        elif v == "aerial2":
            # 换一个方位，看国会—纪念碑轴线
            t = focus("capitol", fallback=(center.x, center.y, 0))
            t = Vector((t.x, t.y, 0))
            eye = (t.x - span * 0.55, t.y - span * 0.45, span * 0.30)
            aim(cam, eye, t, 45)
        elif v == "mall":
            t = focus("capitol", fallback=(center.x, center.y, 0))
            t = Vector((t.x, t.y, 0))
            eye = (t.x - span * 0.28, t.y - span * 0.32, span * 0.13)
            aim(cam, eye, t, 50)
        elif v == "capitol":
            t = focus("united states capitol", "us capitol")
            aim(cam, (t.x - 950, t.y - 950, 380), (t.x, t.y, 45), 60)
        elif v == "monument":
            t = focus("washington monument")
            aim(cam, (t.x - 850, t.y - 850, 360), (t.x, t.y, 70), 58)
        elif v == "whitehouse":
            t = focus("white house")
            aim(cam, (t.x - 520, t.y - 520, 200), (t.x, t.y, 16), 50)
        elif v == "closeup":
            # 街景高度：站在街上往上看，最能体现坡顶与材质
            t = focus("white house", "capitol", fallback=(center.x, center.y, 0))
            aim(cam, (t.x - 260, t.y - 260, 55), (t.x, t.y, 45), 70)
        else:
            log("  未知视图，跳过")
            continue
        shoot(prefix, v)

    log("=" * 84)
    log("全部完成")


main()
