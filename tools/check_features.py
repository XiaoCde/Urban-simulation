# -*- coding: utf-8 -*-
r"""核对 ① 是否真的把几何加进去了，并打一张近距离特写。

两张街面渲染图看起来一样，不等于几何没加 —— 也可能是那个机位全是高层
（高层不在连排屋候选里）。所以这里用**逐物体包围盒对比**来判定：
    同名物体在 after 里的水平外扩 > 0.05 m  => 这个物体被加了东西。
凸窗悬挑 0.61 m、檐口出挑 0.45 m，所以外扩量应该落在 0.45~0.65 m。

用法:
    D:\blender\blender.exe --background --python tools\check_features.py -- ^
        <before.blend> <after.blend> <输出.png> [经度] [纬度]
"""
import math
import os
import sys

import bpy
from mathutils import Vector

G_LON0, G_LON_KM = -77.059998, 0.059998
G_LAT0, G_LAT_KM = 38.885003, 0.039996
S_X0, S_X_SPAN = -887.0, 5197.0
S_Y0, S_Y_SPAN = -597.0, 4451.0


def geo_to_scene(lon, lat):
    return (S_X0 + (lon - G_LON0) / G_LON_KM * S_X_SPAN,
            S_Y0 + (lat - G_LAT0) / G_LAT_KM * S_Y_SPAN)


def log(m):
    print("[chk] %s" % m, flush=True)


def snapshot():
    """{name: (poly, (minx,miny,minz,maxx,maxy,maxz))}，只取 MESH。"""
    d = {}
    for o in bpy.data.objects:
        if o.type != "MESH" or o.data is None:
            continue
        mw = o.matrix_world
        cs = [mw @ Vector(c) for c in o.bound_box]
        xs = [c.x for c in cs]
        ys = [c.y for c in cs]
        zs = [c.z for c in cs]
        d[o.name] = (len(o.data.polygons),
                     (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs)))
    return d


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) < 3:
        print(__doc__)
        return 1
    before, after, out = (os.path.abspath(a) for a in argv[:3])
    lon = float(argv[3]) if len(argv) > 3 else -77.0337
    lat = float(argv[4]) if len(argv) > 4 else 38.9103

    bpy.ops.wm.open_mainfile(filepath=before)
    b = snapshot()
    log("before: %d 个 MESH，面 %d" % (len(b), sum(v[0] for v in b.values())))

    bpy.ops.wm.open_mainfile(filepath=after)
    a = snapshot()
    log("after : %d 个 MESH，面 %d" % (len(a), sum(v[0] for v in a.values())))

    grown, faces_added, samples = 0, 0, []
    for name, (pa, ba) in a.items():
        if name not in b:
            continue
        pb, bb = b[name]
        ex_b = max(ba[3] - ba[0], ba[4] - ba[1]) - max(bb[3] - bb[0], bb[4] - bb[1])
        if ex_b > 0.05:
            grown += 1
            faces_added += (pa - pb)
            if len(samples) < 8:
                samples.append((name, ex_b, pa - pb))
    log("水平外扩的物体 = %d 个；这些物体共新增面 %d" % (grown, faces_added))
    for n, e, f in samples:
        log("   %-28s 外扩 %.3f m  新增面 %d" % (n[:28], e, f))

    # ---- 近距离特写：瞄准"外扩最大、而且真的临街"的一栋 ----
    # 先把路网索引建起来：判断一栋楼是不是"临街连排屋"，唯一可靠的依据是
    # "它的中心离最近的道路采样点有多近"。**之前只按包围盒外扩量选目标**，
    # 选出来的常常是离路 40 m 的大体量建筑，站在街上根本拍不到 —— 这是
    # "加了特征却看不见"的一半原因（另一半是相机放错了地方，见下）。
    adf = grid = None
    try:
        import importlib.util
        here = os.path.dirname(os.path.abspath(__file__))
        spec = importlib.util.spec_from_file_location(
            "adf", os.path.join(here, "add_dc_features.py"))
        adf = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(adf)
        grid = adf.build_road_index()
    except Exception as e:
        log("路网索引建不起来（%s）" % e)

    px, py = geo_to_scene(lon, lat)
    best = None
    for name, (pa, ba) in a.items():
        if name not in b:
            continue
        pb, bb = b[name]
        h = ba[5] - ba[2]
        if not (6.0 <= h <= 15.0):
            continue
        ex_b = max(ba[3] - ba[0], ba[4] - ba[1]) - max(bb[3] - bb[0], bb[4] - bb[1])
        if ex_b <= 0.05:
            continue
        cx, cy = (ba[0] + ba[3]) / 2, (ba[1] + ba[4]) / 2
        dist = math.hypot(cx - px, cy - py)
        if dist > 400:
            continue
        if (ba[3] - ba[0]) * (ba[4] - ba[1]) > 420.0:        # 连排屋没这么大
            continue
        rd = 0.0
        if grid is not None:
            nr0 = adf.nearest_road(grid, cx, cy)
            if nr0 is None:
                continue
            rd = nr0[2]
            if rd > 22.0:                                    # 不临街，排除
                continue
        score = ex_b - dist * 1e-4 - rd * 0.03
        if best is None or score > best[0]:
            best = (score, name, ba, ex_b)
    forced = argv[5] if len(argv) > 5 else None
    if forced and forced in a:
        name = forced
        ba = a[forced][1]
        bb0 = b[forced][1] if forced in b else ba
        ex_b = (max(ba[3] - ba[0], ba[4] - ba[1])
                - max(bb0[3] - bb0[0], bb0[4] - bb0[1]))
        log("强制指定目标 %s" % forced)
    elif best is None:
        log("框内 400 m 没找到带特征的连排屋，特写跳过")
        return 0
    else:
        _, name, ba, ex_b = best
    cx, cy, cz = (ba[0] + ba[3]) / 2, (ba[1] + ba[4]) / 2, (ba[2] + ba[5]) / 2
    hx, hy, hz = ba[3] - ba[0], ba[4] - ba[1], ba[5] - ba[2]
    log("特写目标 %s  尺寸 %.1f x %.1f x %.1f m  外扩 %.3f m" % (name[:28], hx, hy, hz, ex_b))

    # 连排屋是"窄面朝街"，而且左右都贴着邻居 —— 从侧面 15 m 打必然撞进邻居楼里
    # （实测拍出来就是两片砖墙）。唯一正确的机位是**站在街上**看正面立面。
    views = []
    nr = adf.nearest_road(grid, cx, cy) if (adf is not None and grid is not None) else None
    if nr is not None:
        dx, dy, rd = nr
        # 【坑】nearest_road() 返回的是 (dx, dy, dist) —— **相对偏移量**，
        # 不是绝对坐标。当成绝对坐标用会把相机放到场景原点（华盛顿是潮汐湖公园），
        # 于是"特写"实际是站在 4 km 外的公园里回望城市：满屏绿地、楼小得像牙签。
        rx, ry = cx + dx, cy + dy
        log("最近路点 (%.0f,%.0f) 距楼心 %.1f m —— 这就是临街一侧" % (rx, ry, rd))
        L = max(math.hypot(dx, dy), 1e-6)
        ux, uy = dx / L, dy / L                              # 楼 -> 街道 的单位向量
        # 站街上正对立面。连排屋面宽只有 5 m 出头，必须退到路对面才看得全，
        # 所以机位离楼心取 max(1.6*rd, 15 m)。
        cd = max(rd * 1.6, 15.0)
        views.append(("street", Vector((cx + ux * cd, cy + uy * cd, 1.85))))
        # 沿街各退 22 m 斜看 —— 连排屋真正好认的是"一整排连续的檐口线脚
        # + 一排重复的凸窗"，正对着只能看到一户，必须斜看。
        for sgn, tag in ((1.0, "rowL"), (-1.0, "rowR")):
            views.append((tag, Vector((cx + ux * cd * 0.9 + (-uy) * 22.0 * sgn,
                                       cy + uy * cd * 0.9 + (ux) * 22.0 * sgn, 2.0))))
    if not views:
        views.append(("front", Vector((cx + 30.0, cy, 6.0))))

    scene = bpy.context.scene
    cam = bpy.data.objects.get("__closecam")
    if cam is None:
        cd = bpy.data.cameras.new("__closecam")
        cam = bpy.data.objects.new("__closecam", cd)
        scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.lens = 40.0
    cam.data.sensor_width = 36.0
    cam.data.clip_start = 0.2
    cam.data.clip_end = 60000.0

    for o in list(bpy.data.objects):
        if o.type == "LIGHT":
            bpy.data.objects.remove(o, do_unlink=True)
    ld = bpy.data.lights.new("CitySun", type="SUN")
    ld.energy = 3.0
    ld.angle = math.radians(1.2)
    sun = bpy.data.objects.new("CitySun", ld)
    scene.collection.objects.link(sun)
    w = scene.world or bpy.data.worlds.new("CityWorld")
    scene.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes.get("Background") or w.node_tree.nodes.new("ShaderNodeBackground")
    bg.inputs[0].default_value = (0.44, 0.58, 0.82, 1.0)
    bg.inputs[1].default_value = 0.5

    r = scene.render
    r.engine = "BLENDER_EEVEE"
    r.resolution_x, r.resolution_y = 1200, 900
    r.resolution_percentage = 100
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGB"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"

    base, ext = os.path.splitext(out)
    aim = Vector((cx, cy, (ba[2] + ba[5]) / 2))
    for tag, loc in views:
        cam.location = loc
        cam.rotation_euler = (aim - loc).to_track_quat("-Z", "Y").to_euler()
        # 太阳从相机侧后方打，保证正面受光而不是逆光剪影
        sun.rotation_euler = (math.radians(52), 0.0,
                              math.atan2(loc.y - cy, loc.x - cx) + math.radians(200))
        p = "%s_%s%s" % (base, tag, ext)
        r.filepath = p
        bpy.ops.render.render(write_still=True)
        log("写出 %s（%.1f MB）" % (os.path.basename(p), os.path.getsize(p) / 1048576))
    return 0


if __name__ == "__main__":
    sys.exit(main())
