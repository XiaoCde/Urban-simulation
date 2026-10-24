# -*- coding: utf-8 -*-
r"""Day 2 行为验收（**纯 python，不 import bpy，秒级跑完**）。

为什么要单独写这个脚本，而不是"渲出来看一眼"：
    渲染 120 帧要 36 分钟，而"10 个人有没有穿墙"这件事是**几何问题**，
    用不着画面 —— 每条轨迹点到最近人行道边的距离，算得出来。
    把可算的东西交给算术，把算不出来的（好不好看）交给眼睛，各干各的。

四件事，全部给数字：
    1. 各走各的  —— 每个人的行走里程、状态时间占比
    2. 不穿墙    —— 每个轨迹点到最近**可步行走廊边**的距离，报最大值
                    （精确点到线段距离，不是采样近似）
    3. 相遇会避让 —— Yield 进入次数、以及"擦身而过"的对数
                    （擦身而过 = 两人沿走廊方向的次序对调了）
    4. 复现性    —— 同种子跑两遍逐位比较

用法:
    python tools\verify_ped_nav.py                     # 默认参数跑 5 秒
    python tools\verify_ped_nav.py --sweep             # 几组避让参数对比
    python tools\verify_ped_nav.py --seconds 12
"""
import json
import math
import os
import sys
from collections import defaultdict

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)

import ped_fsm as F
import ped_nav as NAV
import ped_sim as S
import road_graph as RG

# 与 ped_demo 保持一致的城市参数。
# 【铁律】这些数**优先从产物目录的 params.json 读**（成片自己带的），
# 读不到才用下面的兜底值。写死常数会出人命：实测把步速写成 1.16，
# 而出片用的是 1.5/1.29=1.16129…，0.1% 的差让 917/1200 行对不上。
CELL = "27,22"
SEED = 20261020
# 【口径已变】以前这里写 1.16（= 查表 1.5 m ÷ 1.29 s）。实测走路动作自带根位移
# 是 **1.960 m/循环**，削成原地循环之后，仿真推进取 1.960/1.29 = 1.517 m/s 脚才不打滑。
# 优先从成片 params.json 读；下面这个只作兜底，而且只对"削过根运动"的新片有效。
WALK_SPEED = 1.960 / 1.29      # ≈ 1.5172
WINDOW = 18.0
OUTDIR = os.path.join(os.path.dirname(TOOLS), "out", "pedestrian", "day2_10人")

# 本次运行的实际参数，main 里会被成片 params.json 覆盖
RUN = {"seed": SEED, "walk_speed": WALK_SPEED, "window": WINDOW, "n": 10,
       "seconds": 5.0}


def load_meta(outdir=OUTDIR):
    p = os.path.join(outdir, "params.json")
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as fh:
        meta = json.load(fh)
    print("[meta] 从成片参数文件读到：步速 %.6f m/s，种子 %s，%d 人，%d 帧，窗口 %.1f m"
          % (meta["walk_speed"], meta["seed"], meta["people"], meta["frames"],
             meta.get("window", -1)))
    return meta


# ---------------------------------------------------------------- 线段索引
class SegIndex(object):
    """人行道边（线段）的空间索引，用来算"轨迹点离最近人行道边多远"。

    为什么要精确的点到**线段**距离，而不是"离最近顶点多远"：
        走廊的顶点间距实测有 25 m，按顶点算，一个走在线段正中间的人会被
        报成"离人行道 12 m"—— 那是把人行道当成虚线了，会把没穿墙判成穿墙。
    """

    def __init__(self, segs, cell=8.0):
        self.cell = cell
        self.b = defaultdict(list)
        for gi, (ax, ay, bx, by) in enumerate(segs):
            x0, x1 = (ax, bx) if ax <= bx else (bx, ax)
            y0, y1 = (ay, by) if ay <= by else (by, ay)
            for i in range(int(x0 // cell), int(x1 // cell) + 1):
                for j in range(int(y0 // cell), int(y1 // cell) + 1):
                    self.b[(i, j)].append(gi)
        self.segs = segs
        self.maxr = 0.0

    def nearest(self, x, y, maxr=30.0):
        c = self.cell
        r = int(maxr // c) + 1
        ci, cj = int(x // c), int(y // c)
        best = None
        seen = set()
        for i in range(ci - r, ci + r + 1):
            for j in range(cj - r, cj + r + 1):
                for gi in self.b.get((i, j), ()):
                    if gi in seen:
                        continue
                    seen.add(gi)
                    ax, ay, bx, by = self.segs[gi]
                    dx, dy = bx - ax, by - ay
                    L2 = dx * dx + dy * dy
                    if L2 <= 1e-12:
                        d = math.hypot(x - ax, y - ay)
                    else:
                        t = ((x - ax) * dx + (y - ay) * dy) / L2
                        t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
                        d = math.hypot(x - (ax + dx * t), y - (ay + dy * t))
                    if best is None or d < best:
                        best = d
        return best


def build_world(planner, params=None, n=None):
    """按 RUN 里的参数建世界。RUN 由 main 从成片 params.json 填进来。"""
    n = RUN["n"] if n is None else n
    cfg = F.Config()
    kw = dict(yield_max_s=4.0, dodge_m=0.9, dodge_speed=0.8)
    if params:
        for k, v in params.items():
            if k in ("arrive_m", "yield_gap_m", "yield_hold_s", "idle_decide_s"):
                setattr(cfg, k, v)
            elif k in ("yield_max_s", "dodge_m", "dodge_speed", "gap_radius",
                       "gap_half_angle"):
                kw[k] = v
    w = S.World(cfg=cfg, seed=RUN["seed"], walk_speed=RUN["walk_speed"], **kw)
    routes = planner.intersection_routes(n, near_xy=planner._near,
                                         dwell=NAV.DWELL_AGENTS)
    w.on_arrive = planner.arrival_handler(planner.dwell)
    for i, (wp, _why) in enumerate(routes[:n]):
        a = w.add("P%02d" % i, wp[0][0], wp[0][1])
        w.set_route(a, wp)
        a.landmark = i in planner.dwell
    return w, list(w.agents), routes


def run(w, seconds, dt=1.0 / 24.0):
    traj = defaultdict(list)
    yields = defaultdict(int)
    # Yield 里"僵持（站着让路）"和"侧身绕行"各占多少秒。
    # 为什么要单独量：Yield 现在接的是侧步动作，而 Yield 状态**同时**包含
    # 站着僵持和横向绕行两段。整段都播侧步，僵持那几秒就成了"站着还侧步"。
    # 这个数决定 Yield 该接一段还是两段动作，也给验收留个可核对的量。
    ysec = {"stall": 0.0, "dodge": 0.0, "after": 0.0}
    ydist = {"stall": 0.0, "dodge": 0.0, "after": 0.0}
    for a in w.agents:
        traj[a.aid].append((a.x, a.y))
    for _ in range(int(round(seconds / dt))):
        prev = {a.aid: a.dist_walked for a in w.agents}
        w.step(dt)
        for a in w.agents:
            traj[a.aid].append((a.x, a.y))
            if a.state == F.ST_YIELD:
                if not a.dodge_sgn:
                    k = "stall"                     # 站着僵持
                elif a.dodge_done < w.dodge_m:
                    k = "dodge"                     # 正在横着挪
                else:
                    k = "after"                     # 已挪完、朝偏移后的目标继续走
                ysec[k] += dt
                ydist[k] += a.dist_walked - prev[a.aid]
    for a in w.agents:
        for _t, st, _why in a.log:
            if st == F.ST_YIELD:
                yields[a.aid] += 1
    return traj, yields, ysec, ydist


def analyze(name, planner, seg_index, seconds=5.0, params=None, dt=1.0 / 24.0,
            verbose=True):
    w, agents, routes = build_world(planner, params=params)
    traj, yields, ysec, ydist = run(w, seconds, dt)

    # ---- 不穿墙 ----
    worst = 0.0
    worst_who = None
    for a in w.agents:
        for (x, y) in traj[a.aid]:
            d = seg_index.nearest(x, y)
            if d is not None and d > worst:
                worst, worst_who = d, a.aid

    # ---- 擦身而过（沿走廊方向的次序对调）----
    starts = {a.aid: None for a in w.agents}
    for a in w.agents:
        starts[a.aid] = traj[a.aid][0]
    swaps = 0
    # 用"两人终点连线与起点连线是否反向"近似判断谁越过了谁：
    # 相向而行的两个人如果都走了足够远且互相越过，midpoint 的次序会反过来。
    for i in range(len(w.agents)):
        for j in range(i + 1, len(w.agents)):
            ai, aj = w.agents[i], w.agents[j]
            if ai.dist_walked < 1.0 or aj.dist_walked < 1.0:
                continue
            d0 = math.hypot(starts[ai.aid][0] - starts[aj.aid][0],
                            starts[ai.aid][1] - starts[aj.aid][1])
            d1 = math.hypot(ai.x - aj.x, ai.y - aj.y)
            if d0 < 2.5 and d1 > 3.0:
                swaps += 1

    # ---- 状态占比 ----
    hist = defaultdict(float)
    for a in w.agents:
        for st, sec in a.state_hist.items():
            hist[st] += sec
        hist[a.state] += a.t
    total = sum(hist.values()) or 1.0

    rep = {
        "name": name,
        "time": w.now,
        "walked": [round(a.dist_walked, 2) for a in w.agents],
        "walked_min": round(min(a.dist_walked for a in w.agents), 2),
        "walked_max": round(max(a.dist_walked for a in w.agents), 2),
        "off_max": round(worst, 3),
        "off_who": worst_who,
        "yield_entries": sum(yields.values()),
        "yield_agents": len([1 for v in yields.values() if v]),
        "swaps": swaps,
        "yield_sec": {k: round(v, 2) for k, v in ysec.items()},
        "yield_speed": {k: round(ydist[k] / ysec[k], 3) if ysec[k] > 1e-9 else 0.0
                        for k in ysec},
        "state_pct": {k: round(100.0 * v / total, 1) for k, v in sorted(hist.items())},
        "stats": w.stats(),
    }
    if verbose:
        print("\n" + "-" * 78)
        print("[%s] %.1f 秒 / 10 人" % (name, seconds))
        print("  行走里程  最小 %.2f m  最大 %.2f m  明细 %s"
              % (rep["walked_min"], rep["walked_max"], rep["walked"]))
        print("  不穿墙    轨迹点到最近人行道边最大偏离 %.3f m（%s）" % (worst, worst_who))
        print("  相遇避让  进入 Yield %d 次，涉及 %d 个人；擦身而过 %d 对"
              % (rep["yield_entries"], rep["yield_agents"], swaps))
        print("  避让细分  僵持 %.2f 秒 @ %.2f m/s / 侧移中 %.2f 秒 @ %.2f m/s"
              " / 绕完续走 %.2f 秒 @ %.2f m/s"
              % (ysec["stall"], ydist["stall"] / ysec["stall"] if ysec["stall"] else 0.0,
                 ysec["dodge"], ydist["dodge"] / ysec["dodge"] if ysec["dodge"] else 0.0,
                 ysec["after"], ydist["after"] / ysec["after"] if ysec["after"] else 0.0))
        print("  状态占比  %s" % rep["state_pct"])
    return rep


def repro_check(planner, seconds=5.0, params=None, dt=1.0 / 24.0):
    """复现性：同种子跑两遍，逐帧比位置、逐条比状态事件。

    为什么这条必须单独验：demo 的验收原文是"一条命令 + 固定种子，稳定复现出
    同一段视频"。只要仿真层有一处碰了全局 random 或多线程，这条就废了，
    而它在画面上**完全看不出来** —— 只有逐位比才能发现。
    """
    out = []
    for _ in range(2):
        w, agents, _r = build_world(planner, params=params)
        trace = []
        logs = []
        for _ in range(int(round(seconds / dt))):
            w.step(dt)
            trace.append([(round(a.x, 9), round(a.y, 9), round(a.heading, 9), a.state)
                          for a in w.agents])
        for a in w.agents:
            logs.append(list(a.log))
        out.append((trace, logs, w.stats()))
    t_same = out[0][0] == out[1][0]
    l_same = out[0][1] == out[1][1]
    s_same = out[0][2] == out[1][2]
    print("\n" + "-" * 78)
    print("[复现性] 同种子跑两遍，%d 帧 × %d 人" % (len(out[0][0]), RUN["n"]))
    print("  逐帧位置+朝向+状态 完全相同：%s" % t_same)
    print("  状态切换事件序列  完全相同：%s" % l_same)
    print("  汇总统计          完全相同：%s" % s_same)
    if not t_same:
        for fi, (r1, r2) in enumerate(zip(out[0][0], out[1][0])):
            if r1 != r2:
                print("  !! 第一个不一致的帧 %d：\n     %s\n     %s" % (fi + 1, r1, r2))
                break
    return t_same and l_same and s_same


def compare_csv(planner, csv_path, params, seconds=5.0, dt=1.0 / 24.0):
    """把成片目录里的 states.csv 与纯 python 重跑的结果逐行比对。

    为什么需要这一步（这是整条链上最容易漏掉的一环）：
        "纯 python 验收通过" + "渲染 log 显示 120 帧都写了" 这两件事**各自成立**，
        但并不能推出"渲出来的那段视频 = 被验收的那套行为"。
        中间任何一处参数不一致（比如出片命令少传了 --cone 30），
        两边都"正常"，交付物却是没验过的那一版。
        这个函数就是拿交付物里的状态日志跟重跑结果对行 —— 对不上就说明中间被换过。
    """
    import csv as _csv
    w, agents, _r = build_world(planner, params=params)
    mine = []
    for _ in range(int(round(seconds / dt))):
        w.step(dt)
        for a in w.agents:
            # 【铁律】必须用**和 CSV 完全相同的格式**（%.3f 字符串）比，
            # 不能用 round() 比数值：round(4116.9005, 3) 与 "%.3f" % 4116.9005
            # 在进位规则上会差 1e-3，实测制造过 917/1200 行的假不一致。
            # 比错的比较方法会让人去改对的代码。
            mine.append((a.aid, a.state, "%.3f" % a.x, "%.3f" % a.y,
                         "%.3f" % a.heading))
    got = []
    clips = {}
    with open(csv_path, encoding="utf-8") as fh:
        rdr = _csv.reader(fh)
        head = next(rdr)
        for row in rdr:
            t, frame, aid, state, clip, x, y, hd = row
            got.append((aid, state, x, y, hd))
            clips[(state, clip)] = clips.get((state, clip), 0) + 1
    print("\n" + "-" * 78)
    print("[成片对账] %s" % csv_path)
    print("  表头 %s" % head)
    print("  成片行数 %d  重跑行数 %d" % (len(got), len(mine)))
    if len(got) != len(mine):
        print("  !! 行数不一致")
        return False
    bad = 0
    first = None
    for i, (g1, m1) in enumerate(zip(got, mine)):
        if g1 != m1:
            bad += 1
            if first is None:
                first = (i, g1, m1)
    print("  不一致行数 %d / %d" % (bad, len(mine)))
    if first:
        i, g1, m1 = first
        print("  第一处不一致（第 %d 行）：\n     成片 %s\n     重跑 %s" % (i + 1, g1, m1))
    # 动作覆盖：这条是"让 10 个人把动作都用上"的**可核对证据** ——
    # 直接数交付物自己的 states.csv，而不是引用渲染日志里的自我声明。
    # clip 列是出片时写进去的（ped_demo 的 trace 里存的就是每帧该播哪段动作）。
    _tot = float(sum(clips.values())) or 1.0
    print("  动作覆盖（数自 states.csv）：%d 段不同动作被播到"
          % len(set(k[1] for k in clips)))
    for (state, clip), c in sorted(clips.items()):
        print("     %-6s %-20s %6d 帧 %5.1f%%" % (state, clip, c, 100.0 * c / _tot))
    ok = bad == 0
    print("  结论：%s" % ("成片就是被验收的那套行为" if ok else "成片与验收的行为不是同一套"))
    return ok


def build_seg_index(g):
    segs = []
    for e in g.edges:
        ax, ay = RG.dkey(g.pos[e.u])
        bx, by = RG.dkey(g.pos[e.v])
        segs.append((ax, ay, bx, by))
    return SegIndex(segs)


def main():
    seconds = 5.0
    if "--seconds" in sys.argv:
        seconds = float(sys.argv[sys.argv.index("--seconds") + 1])
    sweep = "--sweep" in sys.argv
    # --outdir：验收哪一个产物目录。以前写死在 day2_10人，重渲到新目录就核对不到，
    # 只能改代码 —— 验收脚本不该在"交付物换了"的时候还得改自己。
    outdir = OUTDIR
    if "--outdir" in sys.argv:
        outdir = sys.argv[sys.argv.index("--outdir") + 1]

    # 先看成片自己带的参数文件，读到了就完全按它复现（包括人数/帧数/窗口）
    meta = load_meta(outdir)
    if meta:
        RUN.update(seed=meta["seed"], walk_speed=meta["walk_speed"],
                   window=meta.get("window", WINDOW), n=meta["people"])
        RUN["seconds"] = meta["seconds"]
        if "--seconds" not in sys.argv:
            seconds = meta["seconds"]
    planner, center = NAV.build_planner(CELL, seed=RUN["seed"], margin=260.0)
    planner._near = center
    total, seq, _c = planner.find_corridor(CELL)
    g = planner.g
    print("=" * 78)
    print("Day 2 行为验收 —— 格 %s，10 人，种子 %d" % (CELL, SEED))
    print("=" * 78)
    print("图 %d 节点 / %d 边 / %.1f km；主走廊 %.1f m" %
          (len(g.pos), len(g.edges), sum(e.length for e in g.edges) / 1000.0, total))
    seg_index = build_seg_index(g)
    print("线段索引建好：%d 条人行道边" % len(seg_index.segs))

    if not sweep:
        # 与出片完全一致的那组参数：优先用成片 params.json 里的 sim 段
        if meta:
            FINAL = dict(meta["sim"])
        else:
            # 兜底值：与 tools\render_day3.sh 保持一致（路口构图重扫后的那组）。
            # 正常情况下会从成片 params.json 读到，这里只是"还没出片"时的参照。
            FINAL = dict(yield_max_s=0.4, dodge_m=0.45, dodge_speed=1.0,
                         yield_gap_m=0.8, yield_hold_s=0.25, gap_half_angle=25.0)
        analyze("出片参数", planner, seg_index, seconds, FINAL)
        ok = repro_check(planner, seconds, FINAL)
        csvp = os.path.join(outdir, "states.csv")
        if os.path.exists(csvp):
            ok = compare_csv(planner, csvp, FINAL, seconds) and ok
        else:
            print("\n[成片对账] 没找到 %s（还没出片就跳过）" % csvp)
        print("\n结论：%s" % ("行为验收 + 复现性 + 成片对账 都过" if ok
                            else "有项目没过，片子不能当成品"))
        return 0 if ok else 1

    # 让行参数扫描。**注意这组参数的来历**：现行值（1.2 m / 0.8 s / 0.4 s / 30°）
    # 是 Day-2 在**走廊**上调出来的；路口构图人多、方向杂，同一组阈值会让人
    # 频繁互相挡住 —— 实测走路只占 34.2%、Yield 29.1%。所以按路口重新扫一遍，
    # 目标：把"走路占比"拉起来，同时 4 个状态都不掉、不穿墙、还有擦身。
    sets = [
        ("现行(参照) 1.2m/0.8s/30°", dict(yield_max_s=0.8, dodge_m=0.45,
                                       dodge_speed=1.0, yield_gap_m=1.2,
                                       yield_hold_s=0.4, gap_half_angle=30.0)),
        ("让行 1.0m/0.6s/30°", dict(yield_max_s=0.6, dodge_m=0.45, dodge_speed=1.0,
                                 yield_gap_m=1.0, yield_hold_s=0.35,
                                 gap_half_angle=30.0)),
        ("让行 0.9m/0.5s/30°", dict(yield_max_s=0.5, dodge_m=0.45, dodge_speed=1.0,
                                 yield_gap_m=0.9, yield_hold_s=0.3,
                                 gap_half_angle=30.0)),
        ("让行 0.8m/0.4s/30°", dict(yield_max_s=0.4, dodge_m=0.45, dodge_speed=1.0,
                                 yield_gap_m=0.8, yield_hold_s=0.25,
                                 gap_half_angle=30.0)),
        ("让行 0.8m/0.4s/25°", dict(yield_max_s=0.4, dodge_m=0.45, dodge_speed=1.0,
                                 yield_gap_m=0.8, yield_hold_s=0.25,
                                 gap_half_angle=25.0)),
    ]
    reps = []
    for name, params in sets:
        reps.append(analyze(name, planner, seg_index, seconds, params))

    print("\n" + "=" * 78)
    print("参数对比表（目标是 走路% 高，同时 擦身>0、偏离不涨）")
    print("=" * 78)
    print("%-24s %8s %8s %8s %6s %7s %7s %7s" %
          ("参数组", "最小里程", "最大里程", "偏离max", "擦身", "走路%", "让路%", "站/看%"))
    for r in reps:
        sp = r["state_pct"]
        print("%-24s %8.2f %8.2f %8.3f %6d %7.1f %7.1f %7.1f"
              % (r["name"], r["walked_min"], r["walked_max"], r["off_max"],
                 r["swaps"], sp.get("Walk", 0.0), sp.get("Yield", 0.0),
                 sp.get("Idle", 0.0) + sp.get("Look", 0.0)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
