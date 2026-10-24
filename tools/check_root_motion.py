# -*- coding: utf-8 -*-
r"""量动作自带的**根位移漂移**，并验证"削掉之后循环首尾严丝合缝"。

为什么不能靠眼睛验收：
    上一版片子里的症状是"走一段就闪回一次"。肉眼看只能看出"在抽"，
    看不出到底抽了多少、周期对不对、修完是不是真的没了。
    这里是纯几何量：把每个动作按循环播一遍，量**角色网格质心**的位移。

    角色物体本身钉在原点不动（arm.location 固定），所以质心的任何移动
    都只能来自姿势 —— 也就是动画自带的根位移。

输出三个数：
    漂移   一个循环内根骨骼位移曲线的首尾差（米）
    缝宽   循环末帧姿势 与 首帧姿势 的质心距离（米）—— 这就是"闪回"的幅度
    跨度   一个循环内质心水平方向的 max-min（米）= 摆动 + 漂移

用法:
    blender --background --python tools\check_root_motion.py
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
CLIPS = [os.path.join(CHARS, n) for n in
         ("Breathing Idle.fbx", "Walking.fbx", "Running.fbx")]
FPS = 24


def load_mod(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


PD = load_mod("ped_demo", os.path.join(TOOLS, "ped_demo.py"))


def centroid(arm, meshes):
    """变形后角色网格的质心（世界坐标）。"""
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


def sample(arm, meshes, act, tbl, rootfix, n=16, end=False):
    """按循环播一遍，采 n 个点（end=True 时取末帧，用来量缝宽）。"""
    t0, t1 = act.frame_range
    pts = []
    for k in range(n + 1):
        if end and k < n:
            continue
        t = t0 + (t1 - t0) * (k / float(n))
        PD.apply_pose(arm, tbl, t, FPS, rootfix)
        pts.append(centroid(arm, meshes))
    return pts


def d3(a, b):
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))


def d_h(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


FOOT_PAIRS = (("mixamorig:LeftFoot", "mixamorig:RightFoot"),
              ("mixamorig:LeftToeBase", "mixamorig:RightToeBase"))


def pick_feet(arm):
    for pair in FOOT_PAIRS:
        if arm.pose.bones.get(pair[0]) and arm.pose.bones.get(pair[1]):
            return pair
    return None


def implied_speed(arm, act, tbl, rootfix, n=48):
    """从"支撑脚相对髋部的后移速度"**独立**反推动画隐含的地面速度（m/s）。

    为什么需要这条独立测量：
        速度直接决定脚打不打滑。根位移曲线给出的 3.98 m/循环 推出 3.09 m/s，
        而代码里的 walk_speed 是查表猜的 1.16 m/s —— 差 2.7 倍。
        只信一条曲线不够，得从运动学另测一遍：真人走路时支撑脚相对地面不动，
        所以**脚相对身体的后移速度 = 前进速度**。原地循环化后这个量依然在。
    """
    feet = pick_feet(arm)
    if not feet:
        return None, None
    t0, t1 = act.frame_range
    cyc = (t1 - t0) / FPS
    frames = []
    for k in range(n):
        t = t0 + (t1 - t0) * k / float(n)
        PD.apply_pose(arm, tbl, t, FPS, rootfix)
        bpy.context.view_layer.update()
        mw = arm.matrix_world
        hips = mw @ arm.pose.bones["mixamorig:Hips"].head
        frames.append((hips, [mw @ arm.pose.bones[nm].head for nm in feet]))
    dt = cyc / n
    speeds = []
    for fi in range(2):
        zs = [f[1][fi].z for f in frames]
        zmin, zmax = min(zs), max(zs)
        thr = zmin + 0.15 * (zmax - zmin)
        k0 = zs.index(zmin)
        order = [(k0 + i) % n for i in range(n)]      # 从最低点开始绕，处理跨端点
        best, cur = [], []
        for k in order:
            if zs[k] <= thr:
                cur.append(k)
            else:
                if len(cur) > len(best):
                    best = cur
                cur = []
        if len(cur) > len(best):
            best = cur
        if len(best) < 3:
            continue
        a, b = best[0], best[-1]
        pa = frames[a][1][fi] - frames[a][0]
        pb = frames[b][1][fi] - frames[b][0]
        d = math.hypot(pb.x - pa.x, pb.y - pa.y)
        spans = len(best) - 1
        if spans > 0:
            speeds.append(d / (spans * dt))
    if not speeds:
        return None, feet
    speeds.sort()
    return speeds[len(speeds) // 2], feet


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    arm, _body, meshes = PD.import_character(MODEL)
    acts = PD.load_clip_files(CLIPS, FPS)

    print("=" * 78)
    print("根位移漂移检查（角色钉在原点，质心位移只可能来自姿势）")
    print("=" * 78)
    print("%-14s %8s %8s %8s %8s %8s" %
          ("动作(键)", "漂移X", "漂移Y", "漂移Z", "缝宽-未削", "缝宽-削后"))
    worst_fixed = 0.0
    for key in sorted(acts):
        act = acts[key]
        tbl = PD.pose_table(act)
        fix, info = PD.strip_root_drift(arm, act, tbl)
        sc = arm.scale[0]                       # 本地单位 -> 世界米
        per = {0: 0.0, 1: 0.0, 2: 0.0}
        for _b, i, v in info:
            per[i] = abs(v) * sc

        raw = sample(arm, meshes, act, tbl, [], 16)
        fx = sample(arm, meshes, act, tbl, fix, 16)
        seam_raw = d3(raw[0], raw[-1])
        seam_fix = d3(fx[0], fx[-1])
        xs = [p[0] for p in fx]
        span = max(xs) - min(xs)

        # 【铁律】行标必须用**字典键**，不能用 act.name —— 三个动作的 name 都长成
        # "Armature.001|mixamo.com|Layer0.00x"，印出来前三行一模一样，
        # 我自己就因此把 running 的数字当成 walking 的读，推出了"差 2.7 倍"的错误结论。
        print("%-14s %8.3f %8.3f %8.3f %8.3f %8.3f"
              % (key[:14], per[0], per[1], per[2], seam_raw, seam_fix))
        if key in ("walking", "running"):
            worst_fixed = max(worst_fixed, seam_fix)
            # 往哪个方向闪？把未削的缝拆成 XYZ 分量，才谈得上"验清"
            print("%-14s   未削缝分量 dx=%+.3f dy=%+.3f dz=%+.3f"
                  % ("", raw[-1][0] - raw[0][0], raw[-1][1] - raw[0][1],
                     raw[-1][2] - raw[0][2]))
            print("%-14s   削后水平跨度 %.3f m（摆动）" % ("", span))

    print("\n判据：")
    print("  · 「缝宽-未削」> 0.5 m  → 该动作**自带根位移**，正是闪回的来源")
    print("  · 「缝宽-削后」< 0.02 m → 循环首尾严丝合缝，闪回在几何上不可能再发生")

    # ---- 独立测速：根位移推出的速度 vs 支撑脚推出的速度 ----
    print("\n" + "=" * 78)
    print("速度独立互检（决定脚会不会打滑）")
    print("=" * 78)
    print("%-14s %12s %12s %10s" % ("动作(键)", "根位移推速", "支撑脚推速", "差异"))
    for key in ("walking", "running"):
        if key not in acts:
            continue
        act = acts[key]
        tbl = PD.pose_table(act)
        fix, info = PD.strip_root_drift(arm, act, tbl)
        sc = arm.scale[0]
        dm = math.sqrt(sum((v * sc) ** 2 for _b, _i, v in info))
        cyc = PD.clip_seconds(act, FPS)
        v_root = dm / cyc
        v_foot, feet = implied_speed(arm, act, tbl, fix)
        if v_foot is None:
            print("%-14s %12.3f %12s" % (key, v_root, "测不出（没找到脚骨）"))
            continue
        print("%-14s %12.3f %12.3f %9.0f%%"
              % (key, v_root, v_foot,
                 100.0 * abs(v_root - v_foot) / max(1e-9, v_root)))
        print("%-14s   脚骨用 %s；每循环根位移 %.3f m / %.2f s"
              % ("", feet, dm, cyc))
        print("%-14s   含意：削掉根运动后，仿真推进取 %.2f m/s 脚才不打滑"
              % ("", v_root))

    ok = worst_fixed < 0.02
    print("\n结论：%s（走路/跑步削完后最大缝宽 %.4f m）"
          % ("通过" if ok else "没通过，回去查 strip_root_drift", worst_fixed))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
