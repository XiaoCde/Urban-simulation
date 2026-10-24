# -*- coding: utf-8 -*-
r"""导出"大模型渲染"所需的四种图：基座渲染 / 深度 / 法线 / 语义分割。

为什么是这四种：
    ControlNet 这类可控生成模型靠"条件图"锁死几何。
      深度图  → 锁位置和前后关系（最要命的一路）
      法线图  → 锁朝向
      语义分割 → 锁"这块像素是什么东西"（还能顺带控制材质）
    三者都从同一机位、同一分辨率渲出，喂给生成模型后它只能在"长什么样"上
    自由发挥，不能把墙挪走。基座渲染图是给人看的对照底图。

四种图分别怎么渲（全部用 Blender 自带能力，不装任何东西）：
    语义分割 = Workbench 引擎 + shading.light='FLAT' + color_type='OBJECT'，
               逐物体把 obj.color 设成类别色，无光照渲染 → 纯色块、边缘干净。
    深度     = Cycles + view_layer.material_override 换成自发光材质，
               颜色取自 ShaderNodeCameraData 的 'View Z Depth'，
               用 ShaderNodeMapRange 归一化到 0~1（近处白、远处黑）。
    法线     = 同上，颜色取自 ShaderNodeNewGeometry 的 Normal，
               经 ShaderNodeVectorTransform(WORLD→CAMERA) 再 n*0.5+0.5。
    基座渲染 = EEVEE + 一盏太阳 + 世界天光。屋顶材质临时压暗（顶面和立面分得开）。

两个必须记住的坑：
   1. scene.view_settings.view_transform 必须是 'Standard'。默认的 AgX 会整体
      去饱和+提亮，把条件图的像素值改掉，等于条件图不准。
   2. 深度/法线走 material_override，渲完必须清掉，否则基座渲染也变成自发光。

用法：
    blender --background --python tools\export_conditions.py -- <输入.blend> <输出目录> [street|mall]
    不写 shot 则两个机位都渲。
"""

import math
import os
import sys

import bpy
from mathutils import Vector

# ----------------------------------------------------------------- 类别
CAT_OTHER, CAT_BUILDING, CAT_ROAD, CAT_VEG, CAT_WATER, CAT_GROUND = 0, 1, 2, 3, 4, 5
CAT_NAMES = {
    CAT_OTHER: "other",
    CAT_BUILDING: "building",
    CAT_ROAD: "road",
    CAT_VEG: "vegetation",
    CAT_WATER: "water",
    CAT_GROUND: "ground",
}
# 语义分割用的调色板：越饱和越好，生成模型对纯色块最敏感
CAT_COLORS = {
    CAT_OTHER: (0.02, 0.02, 0.02, 1.0),
    CAT_BUILDING: (0.85, 0.18, 0.16, 1.0),
    CAT_ROAD: (0.22, 0.22, 0.24, 1.0),
    CAT_VEG: (0.13, 0.60, 0.16, 1.0),
    CAT_WATER: (0.12, 0.36, 0.80, 1.0),
    CAT_GROUND: (0.62, 0.56, 0.42, 1.0),
}

# ----------------------------------------------------------------- 坐标换算
# 这套常数是从 tools/render_gallery2.py 沿用下来的：
# 场景原点 (0,0) 对应 lon -77.059998 / lat 38.885003，整个框 5197 x 4451 m
G_LON0, G_LON_KM = -77.059998, 0.059998
G_LAT0, G_LAT_KM = 38.885003, 0.039996
S_X0, S_X_SPAN = -887.0, 5197.0
S_Y0, S_Y_SPAN = -597.0, 4451.0


def geo_to_scene(lon, lat):
    x = S_X0 + (lon - G_LON0) / G_LON_KM * S_X_SPAN
    y = S_Y0 + (lat - G_LAT0) / G_LAT_KM * S_Y_SPAN
    return x, y


def scene_to_geo(x, y):
    lon = G_LON0 + (x - S_X0) / S_X_SPAN * G_LON_KM
    lat = G_LAT0 + (y - S_Y0) / S_Y_SPAN * G_LAT_KM
    return lon, lat


# ----------------------------------------------------------------- 基础
def log(msg):
    print("[cond] %s" % msg, flush=True)


def open_blend(path):
    bpy.ops.wm.open_mainfile(filepath=os.path.abspath(path))
    return bpy.context.scene


def setup_render(scene, w=1920, h=1200):
    r = scene.render
    r.resolution_x, r.resolution_y = w, h
    r.resolution_percentage = 100
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGB"
    r.image_settings.color_depth = "8"
    r.film_transparent = False
    r.use_compositing = False
    r.use_sequencer = False
    v = scene.view_settings
    v.view_transform = "Standard"
    v.look = "None"
    v.exposure = 0.0
    v.gamma = 1.0


def ensure_world(scene, color, strength):
    w = scene.world
    if w is None:
        w = bpy.data.worlds.new("__condworld")
        scene.world = w
    w.use_nodes = True
    bg = None
    for n in w.node_tree.nodes:
        if n.type == "BACKGROUND":
            bg = n
            break
    if bg is None:
        bg = w.node_tree.nodes.new("ShaderNodeBackground")
        out = None
        for n in w.node_tree.nodes:
            if n.type == "OUTPUT_WORLD":
                out = n
                break
        if out is None:
            out = w.node_tree.nodes.new("ShaderNodeOutputWorld")
        w.node_tree.links.new(bg.outputs["Background"], out.inputs["Surface"])
    bg.inputs[0].default_value = (color[0], color[1], color[2], 1.0)
    bg.inputs[1].default_value = strength
    return w


def make_camera(scene, loc, target, lens):
    cam = bpy.data.objects.get("__condcam")
    if cam is None:
        cd = bpy.data.cameras.new("__condcam")
        cam = bpy.data.objects.new("__condcam", cd)
        scene.collection.objects.link(cam)
    scene.camera = cam
    cam.location = Vector(loc)
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = lens
    cam.data.sensor_width = 36.0
    cam.data.sensor_fit = "AUTO"
    cam.data.clip_start = 0.5
    cam.data.clip_end = 60000.0
    return cam


def do_render(scene, path):
    path = os.path.abspath(path)
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    size = os.path.getsize(path) if os.path.isfile(path) else -1
    log("写出 %s  (%d 字节)" % (path, size))


# ----------------------------------------------------------------- 类别着色
def mats_of(o):
    return [s.material.name.lower() for s in o.material_slots if s.material]


def classify(o):
    """按材质名判类别。

    材质名是确定的——blosm 和 tools/restyle_city.py 都按前缀命名
    （roads_* / paths_* / areas_* / dc_stone_* / dc_roof_* / vegetation /
    water / dc_ground）。**不能用物体名**：blosm 的道路物体用的是街道名
    （'10th Street Northwest'、'7th Avenue'），按名字判会把路判错。
    """
    m = " ".join(mats_of(o))
    if "dc_ground" in m or o.name == "ground":
        return CAT_GROUND
    if "water" in m:
        return CAT_WATER
    if "vegetation" in m or "forest" in m:
        return CAT_VEG
    if "roads_" in m or "paths_" in m or "areas_" in m or "railway" in m or "rail" in m:
        return CAT_ROAD
    if "dc_stone" in m or "dc_roof" in m or "roof" in m or "wall" in m:
        return CAT_BUILDING
    # 兜底：按物体类型
    if o.type == "CURVE":
        return CAT_ROAD
    if o.type == "MESH":
        return CAT_BUILDING
    return CAT_OTHER


def classify_all():
    counts = {}
    samples = {}
    for o in bpy.data.objects:
        if o.type not in ("MESH", "CURVE", "SURFACE", "FONT"):
            continue
        c = classify(o)
        o.color = CAT_COLORS[c]
        counts[c] = counts.get(c, 0) + 1
        if len(samples.get(c, [])) < 3:
            samples.setdefault(c, []).append("%s <-- 材质[%s]" % (o.name, ",".join(mats_of(o))))
    log("类别统计：")
    for c in sorted(counts, key=lambda k: -counts[k]):
        log("  %-11s %6d 个" % (CAT_NAMES[c], counts[c]))
        for s in samples.get(c, []):
            log("      例: %s" % s)
    return counts


# ----------------------------------------------------------------- 条件图材质
def new_mat(name):
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Strength"].default_value = 1.0
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return m, nt, em


def depth_material(near, far, inverse=True):
    """近处白、远处黑。

    inverse=True 用"倒数深度"归一化：
        value = (1/z - 1/far) / (1/near - 1/far)
    为什么不用线性：线性映射下 3 m 和 30 m 都挤在 0.9 以上，近景全糊成白的；
    倒数深度把近处的层次拉开，也更接近 ControlNet 训练时用的 MiDaS 相对深度。
    """
    m, nt, em = new_mat("__cond_depth")
    cd = nt.nodes.new("ShaderNodeCameraData")
    z = cd.outputs["View Z Depth"]
    if inverse:
        inv = nt.nodes.new("ShaderNodeMath")
        inv.operation = "DIVIDE"
        inv.inputs[0].default_value = 1.0
        nt.links.new(z, inv.inputs[1])
        src = inv.outputs["Value"]
        lo, hi = 1.0 / float(far), 1.0 / float(near)
    else:
        src = z
        lo, hi = float(near), float(far)
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.clamp = True
    mr.inputs["From Min"].default_value = lo
    mr.inputs["From Max"].default_value = hi
    mr.inputs["To Min"].default_value = 1.0
    mr.inputs["To Max"].default_value = 0.0
    nt.links.new(src, mr.inputs["Value"])
    nt.links.new(mr.outputs["Result"], em.inputs["Color"])
    return m


def normal_material():
    m, nt, em = new_mat("__cond_normal")
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    vt = nt.nodes.new("ShaderNodeVectorTransform")
    vt.vector_type = "NORMAL"
    vt.convert_from = "WORLD"
    vt.convert_to = "CAMERA"
    vm = nt.nodes.new("ShaderNodeVectorMath")
    vm.operation = "MULTIPLY_ADD"
    vm.inputs[1].default_value = (0.5, 0.5, 0.5)
    vm.inputs[2].default_value = (0.5, 0.5, 0.5)
    nt.links.new(geo.outputs["Normal"], vt.inputs["Vector"])
    nt.links.new(vt.outputs["Vector"], vm.inputs[0])
    nt.links.new(vm.outputs["Vector"], em.inputs["Color"])
    return m


def set_override(mat):
    try:
        bpy.context.view_layer.material_override = mat
        return True
    except Exception as e:
        log("material_override 不可用：%s" % e)
        return False


# ----------------------------------------------------------------- 三种条件图
def render_semantic(scene, path):
    scene.render.engine = "BLENDER_WORKBENCH"
    sh = scene.display.shading
    sh.light = "FLAT"
    sh.color_type = "OBJECT"
    sh.show_shadows = False
    sh.show_cavity = False
    sh.show_object_outline = False
    sh.show_specular_highlight = False
    sh.background_type = "VIEWPORT"
    sh.background_color = (0.0, 0.0, 0.0)
    try:
        scene.display.render_aa = "OFF"
    except Exception:
        pass
    set_override(None)
    do_render(scene, path)


def render_pass(scene, path, mat):
    scene.render.engine = "CYCLES"
    try:
        scene.cycles.device = "CPU"
        scene.cycles.samples = 1
        scene.cycles.use_denoising = False
        scene.cycles.max_bounces = 0
        scene.cycles.diffuse_bounces = 0
        scene.cycles.glossy_bounces = 0
        scene.cycles.transmission_bounces = 0
        scene.cycles.transparent_max_bounces = 0
        scene.cycles.caustics_reflective = False
        scene.cycles.caustics_refractive = False
    except Exception as e:
        log("cycles 设置部分失败：%s" % e)
    # 世界全黑，保证背景不污染条件图
    ensure_world(scene, (0.0, 0.0, 0.0), 0.0)
    set_override(mat)
    do_render(scene, path)
    set_override(None)


def render_depth(scene, path, near, far, inverse=False):
    render_pass(scene, path, depth_material(near, far, inverse))


def render_normal(scene, path):
    render_pass(scene, path, normal_material())


# ----------------------------------------------------------------- 基座渲染
def pick_eevee():
    try:
        items = [e.identifier for e in
                 bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    except Exception:
        items = []
    for cand in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        if cand in items:
            return cand
    return items[0] if items else "BLENDER_EEVEE"


def render_beauty(scene, path, darken_roofs=True):
    set_override(None)
    scene.render.engine = pick_eevee()
    log("基座渲染引擎 = %s" % scene.render.engine)

    for o in list(bpy.data.objects):
        if o.type == "LIGHT":
            bpy.data.objects.remove(o, do_unlink=True)
    ld = bpy.data.lights.new("__condsun", type="SUN")
    ld.energy = 2.2
    ld.angle = math.radians(1.5)
    ld.color = (1.0, 1.0 - 0.09, 1.0 - 0.24)
    sun = bpy.data.objects.new("__condsun", ld)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(45.0), 0.0, math.radians(55.0))
    ensure_world(scene, (0.44, 0.58, 0.82), 0.38)

    if darken_roofs:
        n = 0
        for m in bpy.data.materials:
            mn = m.name.lower()
            if "roof" not in mn:
                continue
            try:
                for nd in m.node_tree.nodes:
                    if nd.type != "BSDF_PRINCIPLED":
                        continue
                    c = nd.inputs["Base Color"].default_value
                    nd.inputs["Base Color"].default_value = (c[0] * 0.42, c[1] * 0.44, c[2] * 0.44, 1.0)
                    nd.inputs["Roughness"].default_value = 0.88
                    n += 1
                    break
            except Exception:
                pass
        log("屋顶材质压暗 %d 个" % n)

    try:
        scene.eevee.taa_render_samples = 48
    except Exception:
        pass
    do_render(scene, path)


# ----------------------------------------------------------------- 机位
def curve_points(o):
    """取出曲线所有控制点的世界坐标（3 维）。

    坑：POLY/NURBS 的 SplinePoint.co 是 **4 维**（x, y, z, w，w 是权重），
    直接拿去做三维减法会报
    "Vector subtraction: vectors must have the same dimensions"。
    所以统一只取前三个分量。
    """
    mw = o.matrix_world
    out = []
    for sp in o.data.splines:
        if sp.type == "BEZIER":
            for bp in sp.bezier_points:
                out.append(mw @ Vector((bp.co[0], bp.co[1], bp.co[2])))
        else:
            for p in sp.points:
                out.append(mw @ Vector((p.co[0], p.co[1], p.co[2])))
    return out


def road_camera_near(scene, lon, lat, lens, max_dist=300.0):
    """在指定地点附近找一条路，把相机架在路面上、顺着路的方向看过去。

    为什么必须顺着路看：路两侧才是楼，顺着路看才有"街道峡谷"；
    横着看就只剩一堵墙，深度图也没信息量。

    为什么优先挑窄路：14th Street NW 这种主干道两侧是十几层的大楼，
    相机贴在路面上时最近的墙面只有四五米，会糊掉半张画面。
    连排屋住宅街（roads_residential / roads_service）宽约 15 m、楼高三四层，
    才是典型的街道峡谷，也是"以假乱真"最好出效果的场景。

    注意不能用物体名筛路——blosm 的道路物体叫街道名（'10th Street Northwest'），
    只能按材质名筛（roads_* / paths_*）。
    """
    tx, ty = geo_to_scene(lon, lat)
    target = Vector((tx, ty, 0.0))

    # 由窄到宽依次尝试
    tiers = [
        ("住宅/服务道路", ("roads_residential", "roads_service", "roads_living_street", "roads_unclassified")),
        ("次级道路", ("roads_tertiary", "roads_pedestrian", "paths_")),
        ("任意道路", ("roads_", "paths_")),
    ]
    for label, keys in tiers:
        best = None
        scanned = 0
        for o in bpy.data.objects:
            if o.type != "CURVE":
                continue
            mats = " ".join(mats_of(o))
            if not any(k in mats for k in keys):
                continue
            pts = curve_points(o)
            if len(pts) < 6:
                continue
            scanned += 1
            for i in range(2, len(pts) - 2):
                p = pts[i].copy()
                p.z = 0.0
                d = (p - target).length
                if d > max_dist:
                    continue
                a = pts[i - 2].copy()
                b = pts[i + 2].copy()
                a.z = 0.0
                b.z = 0.0
                seg = b - a
                if seg.length < 8.0:
                    continue
                if best is None or d < best[0]:
                    best = (d, p, seg.normalized(), o.name)
        if best is None:
            log("%s：扫了 %d 条曲线，附近没有命中，换下一档" % (label, scanned))
            continue
        d, mid, t, name = best
        loc = mid - t * 6.0
        loc.z = 1.75
        tgt = mid + t * 80.0
        tgt.z = 1.55
        glon, glat = scene_to_geo(mid.x, mid.y)
        log("%s：扫了 %d 条曲线，最近命中 %.0f m，路='%s'" % (label, scanned, d, name))
        log("街面机位：场景=(%.1f, %.1f) 经纬=(%.5f, %.5f)" % (mid.x, mid.y, glat, glon))
        make_camera(scene, loc, tgt, lens)
        return dict(kind="street", lon=glon, lat=glat, camera=(loc.x, loc.y, loc.z))
    return None


SHOTS = {
    # 邵区（Shaw）一带是华盛顿连排屋最密集的街区之一，之前空中视角效果最好。
    # 机位定在街区西南 270 m 外、70 m 高处斜看下来：既能看清连排屋的锯齿状
    # 坡屋面（这是我们 DCGIS 补出来的、最有说服力的结构），又不会像街面
    # 视角那样只剩四堵没有窗户的白墙。
    "street": dict(kind="fixed", lens=45.0, near=120.0, far=1000.0, inverse=False,
                   loc_geo=(-77.0337, 38.9103, 70.0),
                   tgt_geo=(-77.0315, 38.9120, 5.0),
                   title="连排屋街区（低空斜视 70 m，邵区）"),
    "mall": dict(kind="fixed", lens=50.0, near=100.0, far=3000.0, inverse=False,
                 loc_geo=(-77.0480, 38.8870, 120.0),
                 tgt_geo=(-77.0200, 38.8890, 30.0),
                 title="国家广场中轴（低空 120 m，旧机位）"),
    # 旧机位的问题：120 m 低空顺着 3 km 长的草坪看过去，几乎整幅画面都在 500 m
    # 之外，深度图是一整片平滑渐变、没有任何结构 —— 实测 ControlNet 只能自己编，
    # 第一次编成水面，加了约束之后编成农田。
    # 下面两个新机位都是"抬高 + 俯下，让画面里以建筑为主"：
    #   mall2 从西南 380 m 高处斜看整条中轴，纪念碑在近处、国会山在远处，
    #         两侧联邦大楼成一排排横向条带 —— 这些条带就是深度图的结构。
    #   mall3 以国会大厦为主体，画面里全是密集城区，结构最丰富。
    #       这个机位必须用**倒数深度**：画面里近处地面都在 500~900 m，线性映射
    #       会把它们全挤到 0.85 以上、渲成一片白（实测就是这个结果）。倒数深度
    #       把近处拉开、远处压扁，900 m 落在 0.43 而不是 0.86。
    "mall2": dict(kind="fixed", lens=45.0, near=600.0, far=3200.0, inverse=False,
                  loc_geo=(-77.0417, 38.8832, 380.0),
                  tgt_geo=(-77.0244, 38.8895, 0.0),
                  title="国家广场高斜视（380 m，西南望东北）"),
    "mall3": dict(kind="fixed", lens=45.0, near=450.0, far=3600.0, inverse=True,
                  loc_geo=(-77.0180, 38.8853, 330.0),
                  tgt_geo=(-77.0094, 38.8896, 20.0),
                  title="国会山斜视（330 m，以国会大厦为主的密集城区）"),
}


def place(scene, name, cfg):
    if cfg["kind"] == "road":
        lon, lat = cfg["near_geo"]
        info = road_camera_near(scene, lon, lat, cfg["lens"])
        if info is not None:
            return info
        log("附近没找到路，退回固定机位")
    lon, lat, z = cfg["loc_geo"]
    x, y = geo_to_scene(lon, lat)
    tlon, tlat, tz = cfg["tgt_geo"]
    tx, ty = geo_to_scene(tlon, tlat)
    make_camera(scene, (x, y, z), (tx, ty, tz), cfg["lens"])
    log("固定机位：相机场景=(%.0f, %.0f, %.0f) 目标=(%.0f, %.0f, %.0f) 经纬=(%.5f, %.5f)"
        % (x, y, z, tx, ty, tz, lat, lon))
    return dict(kind=name, lon=lon, lat=lat, camera=(x, y, z))


def run(blend, outdir, only=None):
    scene = open_blend(blend)
    setup_render(scene)
    log("场景载入完成：物体 %d 个" % len(bpy.data.objects))
    classify_all()

    names = [n for n in SHOTS if (only is None or n in only)]
    for name in names:
        cfg = SHOTS[name]
        log("=== 机位 %s : %s ===" % (name, cfg["title"]))
        place(scene, name, cfg)
        prefix = os.path.join(outdir, "cond_%s" % name)
        render_beauty(scene, prefix + "_beauty.png")
        render_semantic(scene, prefix + "_semantic.png")
        render_depth(scene, prefix + "_depth.png", cfg["near"], cfg["far"], cfg.get("inverse", False))
        render_normal(scene, prefix + "_normal.png")
        log("=== 机位 %s 完成 ===" % name)
    log("全部完成")


if __name__ == "__main__":
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    if len(argv) < 2:
        print(__doc__)
        sys.exit(1)
    run(argv[0], argv[1], argv[2].split(",") if len(argv) > 2 else None)
