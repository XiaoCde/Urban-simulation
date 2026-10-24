# -*- coding: utf-8 -*-
r"""只读：查清 dc_real3_tex.blend 里的材质到底是什么。

背景：fix_plain_mats 报告「替换了 43894 个槽」其中有 21929 个叫 wall、21928 个叫 roof
—— 这两个数字跟 apply_textures.assign() 的 tag 统计一模一样，可疑。必须查清楚
到底是"槽真的是 blosm 的默认材质"还是"我的判定写错了"。

**只读，不保存。**

用法: D:\blender\blender.exe --background --python tools\probe_mats.py -- <blend>
"""
import os
import sys
from collections import Counter

import bpy


def log(m):
    print("[pm] %s" % m, flush=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    bpy.ops.wm.open_mainfile(filepath=os.path.abspath(argv[0]))

    allm = list(bpy.data.materials)
    names = Counter(m.name for m in allm)
    log("材质总数 %d 个" % len(allm))
    for want in ("wall", "roof", "white", "brown"):
        got = [m for m in allm if m.name == want]
        log("  名叫 %-8s 的材质：%d 个，用户数 %s"
            % (want, len(got), [m.users for m in got][:3]))
    tex = [m for m in allm if m.name.startswith("tex_")]
    log("  tex_* 材质：%d 个" % len(tex))

    # 槽状态普查
    slot_state = Counter()
    for o in bpy.data.objects:
        if o.type not in ("MESH", "CURVE", "SURFACE"):
            continue
        for s in o.material_slots:
            nm = s.material.name if s.material else "(None)"
            slot_state["tex_*" if nm.startswith("tex_") else nm] += 1
    log("全部槽位状态（前 12）：")
    for k, v in slot_state.most_common(12):
        log("   %-34s %6d" % (k, v))

    # 抽几个对象，把槽 + 每个槽被多少面引用 都列出来
    log("抽样对象：")
    shown = 0
    for o in bpy.data.objects:
        if o.type != "MESH" or not o.material_slots or shown >= 5:
            continue
        h = o.dimensions.z
        if not (6.0 <= h <= 15.0):
            continue
        used = Counter(p.material_index for p in o.data.polygons)
        log("   %-32s 高 %.1f 面 %d" % (o.name[:32], h, len(o.data.polygons)))
        log("      data.materials = %s" % [m.name if m else None for m in o.data.materials])
        for i, s in enumerate(o.material_slots):
            log("      slot %d link=%-6s mat=%-34s 被 %d 个面用"
                % (i, s.link, (s.material.name if s.material else "(None)"), used.get(i, 0)))
        shown += 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
