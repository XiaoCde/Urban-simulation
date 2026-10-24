# -*- coding: utf-8 -*-
r"""量一批动作文件的：时长 / action 结构 / 根位移漂移 / 循环缝宽。

用法:
    blender --background --python tools\probe_clips.py -- "Walk Strafe Right.fbx" "Looking Around.fbx"
    不给参数就量 data\characters 下所有 .fbx（含 Day 1 三个，做对照）。

为什么单独做这个：
    check_root_motion.py 只为 Day 1 的三个动作写死了清单。新下的动作必须先量一遍，
    否则"接线成功"只证明名字匹配上了 —— 动作本身带不带根位移、循环首尾缝多宽，
    一概不知。而这两个量正是"闪回"和"脚在地上打滑"的唯一来源。
"""
import importlib.util
import math
import os
import sys

import bpy

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS)
CHARS = os.path.join(ROOT, "data", "characters")
MODEL = os.path.join(CHARS, "Body Block.fbx")
FPS = 24


def load_mod(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


PD = load_mod("ped_demo", os.path.join(TOOLS, "ped_demo.py"))


def centroid(arm, meshes):
    """变形后角色网格的质心（世界坐标）。角色钉在原点，位移只可能来自姿势。"""
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    sx = sy = sz = 0.0
    n = 0
    for m in meshes:
        ev = m.evaluated_get(dg)
        try:
            me = ev.to_mesh()
        except Exception:
            continue
        mw = ev.matrix_world
        for v in me.vertices:
            w = mw @ v.co
            sx += w.x
            sy += w.y
            sz += w.z
            n += 1
        ev.to_mesh_clear()
    return (sx / n, sy / n, sz / n) if n else (0.0, 0.0, 0.0)


def d3(a, b):
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))


def sample_ends(arm, meshes, act, tbl, rootfix, n=16):
    t0, t1 = act.frame_range
    pts = []
    for k in range(n + 1):
        t = t0 + (t1 - t0) * (k / float(n))
        PD.apply_pose(arm, tbl, t, FPS, rootfix)
        pts.append(centroid(arm, meshes))
    return pts


def main():
    argv = sys.argv
    args = argv[argv.index("--") + 1:] if "--" in argv else []
    model_base = os.path.basename(MODEL).lower()
    if args:
        clips = [p if os.path.isabs(p) else os.path.join(CHARS, p) for p in args]
    else:
        clips = sorted(os.path.join(CHARS, f) for f in os.listdir(CHARS)
                       if f.lower().endswith(".fbx") and f.lower() != model_base)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    arm, _body, meshes = PD.import_character(MODEL)
    acts = PD.load_clip_files(clips, FPS)

    print("=" * 104)
    print("动作清单体检（角色钉在原点，质心位移只可能来自姿势）")
    print("=" * 104)
    print("%-24s %7s %6s %5s %6s %7s %9s %10s" %
          ("键(小写文件名)", "时长s", "曲线", "层", "条", "重复键", "漂移m", "缝宽削后m"))
    fixed_max = 0.0
    for key in sorted(acts):
        act = acts[key]
        tbl = PD.pose_table(act)
        fix, info = PD.strip_root_drift(arm, act, tbl)
        sc = arm.scale[0]
        drift = math.sqrt(sum((v * sc) ** 2 for _b, _i, v in info))
        desc = PD.describe_action(act)
        raw = sample_ends(arm, meshes, act, tbl, [], 16)
        fx = sample_ends(arm, meshes, act, tbl, fix, 16)
        seam_raw = d3(raw[0], raw[-1])
        seam_fix = d3(fx[0], fx[-1])
        secs = PD.clip_seconds(act, FPS)
        print("%-24s %7.2f %6d %5d %6d %7d %9.3f %10.4f" %
              (key[:24], secs, desc["curves"], desc["layers"], desc["strips"],
               desc["dupes"], drift, seam_fix))
        print("%-24s   action.name = %s" % ("", act.name))
        print("%-24s   未削缝宽 %.4f m（水平分量 %.4f m）| channelbag %d" %
              ("", seam_raw,
               math.hypot(raw[-1][0] - raw[0][0], raw[-1][1] - raw[0][1]),
               desc["channelbags"]))
        if key in ("walking", "running"):
            fixed_max = max(fixed_max, seam_fix)

    print("\n判据：")
    print("  · 重复键 > 0        → 同格曲线互相覆盖，姿态会串相位，接线前必须查")
    print("  · 缝宽削后 < 0.02 m → 循环首尾严丝合缝，可以接进循环状态（Idle/Walk）")
    print("  · 缝宽削后 > 0.05 m → 一次性动作，只能进 RESET_ON_ENTER 那种从头播的状态")
    return 0


if __name__ == "__main__":
    sys.exit(main())
