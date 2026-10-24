# -*- coding: utf-8 -*-
r"""专门给「城市仿真基座」出展示图的脚本（多机位、每个机位只出一张 beauty）。

为什么不往 export_conditions.py 的 SHOTS 里加机位：
    SHOTS 是给「条件图导出」用的，每个机位要出 beauty / semantic / depth / normal
    四张图；展示照只要一张好看的 beauty，而且机位多得多。两件事分开写互不干扰。

    export_conditions.py 里有 __main__ 守卫，importlib 载入不会触发它的 main。

用法:
    blender --background --python tools\render_showcase.py -- <输入.blend> <输出目录> [机位名逗号分隔]
例:
    blender --background --python tools\render_showcase.py -- out\dc_real3_clean.blend out\showcase
"""
import importlib.util
import os
import sys

import bpy

TOOLS = os.path.dirname(os.path.abspath(__file__))


def load_mod(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(TOOLS, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ec = load_mod("ec", "export_conditions.py")

# ------------------------------------------------------------------ 展示机位
# 全部是固定机位。字段与 export_conditions.SHOTS 一致，只是去掉了 kind/near/far
# 这些条件图专用的东西（渲染用不到）。经纬度是 WGS84，z 是场景里的真实米数。
#
# 选角度的三条原则（这一轮反复试出来的）：
#   1. 俯下 > 平视。低空平视看到的多半是没窗户的墙；抬高到 250~400 m 斜看，
#      画面里以屋面为主，连排屋的锯齿状坡屋面（我们 DCGIS 补出来的部分）才看得见。
#   2. 画面里要有地标。穹顶/方尖碑给观众一个「这是华盛顿」的锚点。
#   3. 全城鸟瞰 near 必须放到 800 m，否则机身正下方的楼会被近裁剪面切掉。
SHOW = [
    ("01_全城鸟瞰", "全城鸟瞰（西南 1800 m 高空斜看）", dict(
        lens=50.0, near=800.0, far=14000.0,
        loc_geo=(-77.0700, 38.8800, 1800.0),
        tgt_geo=(-77.0250, 38.9020, 0.0))),

    ("02_国家广场", "国家广场高斜视（西南 380 m，纪念碑近、国会山远）", dict(
        lens=45.0, near=600.0, far=3200.0,
        loc_geo=(-77.0417, 38.8832, 380.0),
        tgt_geo=(-77.0244, 38.8895, 0.0))),

    ("03_国会山", "国会山斜视（330 m，以国会大厦为主的密集城区）", dict(
        lens=45.0, near=450.0, far=3600.0,
        loc_geo=(-77.0180, 38.8853, 330.0),
        tgt_geo=(-77.0094, 38.8896, 20.0))),

    ("04_正俯视总平面", "正俯视总平面（市中心 900 m 高空垂直向下）", dict(
        lens=50.0, near=600.0, far=2200.0,
        loc_geo=(-77.0330, 38.8990, 900.0),
        tgt_geo=(-77.0330, 38.8995, 0.0))),

    ("05_连排屋街区", "连排屋街区（邵区，70 m 低空斜视）", dict(
        lens=45.0, near=120.0, far=1000.0,
        loc_geo=(-77.0337, 38.9103, 70.0),
        tgt_geo=(-77.0315, 38.9120, 5.0))),
]


def main(blend, outdir, only=None):
    outdir = os.path.abspath(outdir)
    os.makedirs(outdir, exist_ok=True)

    scene = ec.open_blend(blend)
    ec.setup_render(scene)
    print("[show] 场景载入完成：物体 %d 个" % len(bpy.data.objects))

    names = [n for n, _t, _c in SHOW if (only is None or n in only)]
    for name, title, cfg in SHOW:
        if name not in names:
            continue
        full = dict(cfg)
        full["kind"] = "fixed"
        print("[show] === %s : %s ===" % (name, title))
        ec.place(scene, name, full)
        ec.render_beauty(scene, os.path.join(outdir, "%s.png" % name))
    print("[show] 全部完成 -> %s" % outdir)


if __name__ == "__main__":
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    if len(argv) < 2:
        print(__doc__)
        sys.exit(1)
    main(argv[0], argv[1], argv[2].split(",") if len(argv) > 2 else None)
