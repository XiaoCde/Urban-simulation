# -*- coding: utf-8 -*-
r"""帧时间探针（只在需要时用）：把相机架到真实人行道上，渲 1 帧 720p，量耗时。

为什么必须先量：
    计划表 §五 写死了"渲染是过夜跑的事"，风险表里也写了"先渲一帧看帧时间"。
    48,381 个物体 + 96 张贴图，如果一帧 3 分钟，Day 3 的 192 帧就是 10 小时，
    方案得当场改（降分辨率/降采样/只留相机范围内的物体）。这个数字不能猜。

相机怎么架：
    从 road_graph 里取指定格内**最长的一条 sidewalk 边**，相机放在这条边中点
    往右偏 1.0 m、高 1.65 m，沿边方向看过去、俯角 4° —— 这是"站在人行道上看街"
    的真实机位，也是 Day 2 街面视频要用的机位，一次架好两处复用。

用法:
    blender --background --python tools\probe_city_render.py -- <i,j> <出图.png> [--samples 32]
"""
import importlib.util
import math
import os
import sys
import time

import bpy
from mathutils import Vector

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS)
CITY = os.path.join(ROOT, "out", "dc_real3_clean.blend")


def load_mod(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


RC = load_mod("road_graph", os.path.join(TOOLS, "road_graph.py"))


def pick_edge(cell_key, kinds=("sidewalk", "footway", "crossing", "pedestrian")):
    """在指定格里挑最长的一条人行道边，返回 (中点, 方向单位向量, 长度, 类别)。"""
    ci, cj = (int(v) for v in cell_key.split(","))
    g = RC.build(snap_m=0.0)
    sizes = g.component_sizes()
    g._sizes = sizes
    giant = sizes.index(max(sizes))
    cell = 150.0
    best = None
    for e in g.edges:
        if g.comp[e.u] != giant or e.kind not in kinds:
            continue
        pa, pb = RC.dkey(g.pos[e.u]), RC.dkey(g.pos[e.v])
        mx, my = (pa[0] + pb[0]) * 0.5, (pa[1] + pb[1]) * 0.5
        if int(mx // cell) != ci or int(my // cell) != cj:
            continue
        if best is None or e.length > best[0]:
            best = (e.length, mx, my, pa, pb, e.kind, e.width)
    if best is None:
        raise SystemExit("格里没有符合条件的边：%s" % cell_key)
    ln, mx, my, pa, pb, kind, width = best
    dx, dy = pb[0] - pa[0], pb[1] - pa[1]
    L = math.hypot(dx, dy) or 1.0
    return (mx, my), (dx / L, dy / L), ln, kind, width, (pa, pb)


def setup_render(scene, width, height, samples):
    r = scene.render
    r.resolution_x = width
    r.resolution_y = height
    r.resolution_percentage = 100
    r.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    try:
        r.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        r.engine = "BLENDER_EEVEE"
    ee = getattr(scene, "eevee", None)
    if ee is not None and hasattr(ee, "taa_render_samples"):
        ee.taa_render_samples = samples
    if hasattr(r, "image_settings"):
        if hasattr(r.image_settings, "media_type"):
            r.image_settings.media_type = "IMAGE"
        r.image_settings.file_format = "PNG"
        r.image_settings.color_mode = "RGB"
    return r.engine


def main(argv):
    cell = argv[0] if argv else "27,22"
    out = argv[1] if len(argv) > 1 else os.path.join(ROOT, "out", "probe", "probe.png")
    samples = 32
    if "--samples" in argv:
        samples = int(argv[argv.index("--samples") + 1])
    width, height = 1280, 720
    if "--size" in argv:
        w, h = argv[argv.index("--size") + 1].lower().split("x")
        width, height = int(w), int(h)

    # ---- 先在纯 python 里定机位（不依赖 blend） ----
    mid, d, ln, kind, width_m, ends = pick_edge(cell)
    px, py = d[1], -d[0]          # 右手法向
    cam_x = mid[0] + px * 1.0
    cam_y = mid[1] + py * 1.0
    print("[probe] 格 %s 最长人行道边：长 %.1f m  类别 %s  宽 %.1f m" % (cell, ln, kind, width_m))
    print("[probe] 边端点 %s -> %s" % (tuple(round(v, 1) for v in ends[0]),
                                       tuple(round(v, 1) for v in ends[1])))
    print("[probe] 机位 (%.1f, %.1f, 1.65)  朝向 (%.3f, %.3f)" % (cam_x, cam_y, d[0], d[1]))

    # ---- 打开城市 ----
    t0 = time.time()
    bpy.ops.wm.open_mainfile(filepath=CITY)
    scene = bpy.context.scene
    n_obj = len(bpy.data.objects)
    n_mat = len(bpy.data.materials)
    n_img = len(bpy.data.images)
    print("[probe] 打开城市 %.1f s：物体 %d 材质 %d 图像 %d"
          % (time.time() - t0, n_obj, n_mat, n_img))

    engine = setup_render(scene, width, height, samples)
    print("[probe] 引擎 %s  采样 %d  分辨率 %dx%d  色彩 %s"
          % (engine, samples, width, height,
             scene.view_settings.view_transform))

    cd = bpy.data.cameras.new("probe_cam")
    cam = bpy.data.objects.new("probe_cam", cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    loc = Vector((cam_x, cam_y, 1.65))
    look = Vector((cam_x + d[0] * 20.0, cam_y + d[1] * 20.0, 1.65 - 20.0 * math.tan(math.radians(4.0))))
    cam.location = loc
    cam.rotation_euler = (look - loc).to_track_quat("-Z", "Y").to_euler()
    cd.lens = 42.0
    cd.sensor_width = 36.0
    cd.clip_start = 0.05
    cd.clip_end = 8000.0

    # 【铁律】Blender 把相对路径的 render.filepath 解析到 **blend 所在盘**，
    # 实测传 "out/probe/x.png" 会被解析成 C:\out\probe\x.png 然后保存失败。
    # 一律用绝对路径。
    out = os.path.abspath(out)
    os.makedirs(os.path.dirname(out), exist_ok=True)

    # 连渲 n 帧，逐帧计时。第一帧要把 EEVEE 的 shader 全部编译完，慢得多；
    # 用第一帧的数字推 192 帧会得出错误结论（实测差好几倍）。
    n_frames = 4
    times = []
    for i in range(n_frames):
        # 每帧把相机往前挪一点，模拟动画：视角变了但 shader 缓存还在
        cam.location = Vector((cam_x + d[0] * i * 0.05, cam_y + d[1] * i * 0.05, 1.65))
        scene.render.filepath = out if i == 0 else out.replace(".png", "_f%d.png" % i)
        t1 = time.time()
        bpy.ops.render.render(write_still=True)
        dt = time.time() - t1
        times.append(dt)
        print("[probe] 第 %d 帧耗时 %.2f s" % (i + 1, dt))
    warm = times[1:]
    avg = sum(warm) / len(warm)
    print("[probe] 首帧 %.2f s（含 shader 编译）；稳态平均 %.2f s/帧" % (times[0], avg))
    print("[probe] 据此推算：120 帧（5 s）%.1f min；192 帧（8 s）%.1f min"
          % (avg * 120 / 60.0, avg * 192 / 60.0))
    print("[probe] 出图 %s  %s" % (out, "存在" if os.path.exists(out) else "!! 不存在"))
    print("[probe] 完成")


if __name__ == "__main__":
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    main(argv)
