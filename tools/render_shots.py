# -*- coding: utf-8 -*-
r"""对已贴好材质的城市 blend，按 export_conditions.py 里定义的机位出基座渲染图。

为什么单独拆出来：贴材质那一步要跑 4 分钟（载入 48,381 个物体 + 分配 4.3 万个材质槽），
调机位/调光照时不想每次都重跑一遍，所以先存成 .blend，之后只渲图。

用法:
    D:\blender\blender.exe --background --python tools\render_shots.py -- ^
        out\dc_real3_tex.blend out\tex street,mall2
"""
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import export_conditions as ec  # noqa: E402


def main():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    if len(argv) < 3:
        print(__doc__)
        return 1
    blend, outdir, shots = argv[0], argv[1], argv[2].split(",")
    if not os.path.isdir(outdir):
        os.makedirs(outdir)

    bpy.ops.wm.open_mainfile(filepath=os.path.abspath(blend))
    scene = bpy.context.scene
    ec.setup_render(scene, 1600, 1000)

    for name in shots:
        cfg = ec.SHOTS[name]
        lon, lat, z = cfg["loc_geo"]
        x, y = ec.geo_to_scene(lon, lat)
        tlon, tlat, tz = cfg["tgt_geo"]
        tx, ty = ec.geo_to_scene(tlon, tlat)
        ec.make_camera(scene, (x, y, z), (tx, ty, tz), cfg["lens"])
        out = os.path.abspath(os.path.join(outdir, "tex_%s.png" % name))
        ec.render_beauty(scene, out, darken_roofs=False)
        print("[tex] %s -> %s" % (cfg["title"], out), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
