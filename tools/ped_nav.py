# -*- coding: utf-8 -*-
r"""行人导航层（**纯 python，不 import bpy**）：把 road_graph 的图变成"每个人的路线"。

分层：
    road_graph.py  路网拓扑/最短路径（谁连着谁）
    ped_nav.py     路线规划（谁从哪儿走到哪儿）        <- 本文件
    ped_sim.py     世界模型（谁在哪儿、谁挡谁）
    ped_demo.py    Blender 渲染

为什么"不穿墙"不需要碰撞检测（这是本文件最重要的一个设计判断）：
    渲染出来的人行道**就是** road_graph 里那些顶点连成的带（blender 里
    bevel_object 沿同一条 POLY 扫出来的）。所以只要人沿图的边走，
    他脚下的那一条带必然存在 —— 穿墙在几何上不可能发生。
    反过来，如果做直线插值（A 直达 B），人就会横穿街区，那才是一眼假的根源
    （计划表风险表原文："导航必须在图上跑，不能直线插值"）。

两种路线：
    corridor  主街对穿 —— 沿一条长人行道，一半人朝东一半人朝西。
              这是**唯一能保证"相遇会避让"的排法**：随机撒点可能一下午都不碰面，
              那样 Yield 状态根本不会被触发，验收标准就无法证伪。
    wander    普通随机路线 —— 从当前点走到区域内另一个点，用于"到达后继续走"。

用法:
    python tools\ped_nav.py            # 打印一份 10 人路线计划（Day 2.3 验收证据）
"""
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import road_graph as RG

WALK_KINDS = ("sidewalk", "footway", "crossing", "pedestrian")

# 机动车道类别：只用来回答一个问题 —— "我这条人行道的哪一侧是马路"。
# 有了它才能把机位放到**确定是空地**的位置：人行道保证没楼但会让人重叠，
# 马路同样保证没楼且能把 10 个人在画面里横向拆开。
ROAD_KLASSES = ("motorway", "trunk", "primary", "secondary", "tertiary",
                "residential", "service", "unclassified", "living_street",
                "motorway_link", "trunk_link", "primary_link",
                "secondary_link", "tertiary_link")

# ---- 「驻足观望」的人（这是让 4 段动作全部出镜的必要安排，不是装饰）----
# 走廊模式下 10 个人从起点一路走到头，`on_arrive` 一到站就重规划，
# 全程没有一个 Idle 帧 —— 实测 8 秒片 1920 个「人·帧」里 Idle=0、Look=0，
# 计划表 §二 要求的 4 段动作只有 2 段出镜（走 + 让）。所以让其中几个人
# 中途走到人行道**靠外一侧**站住：状态机自己在 Idle 里做决策、按
# look_chance 切进 Look（ped_fsm 第 3 步），"主动在动作之间切换"才看得见。
DWELL_AGENTS = (1, 4, 6, 9)   # 谁的路线终点改在路边（0~9，出片/验收同一份）
DWELL_LEN_M = 4.0             # 走多远站住：剩余路线 4 m，走 2.5 m 就进 arrive_m
DWELL_LAT_M = 0.80            # 站到人行道外侧（半宽 1.0 m，仍在带内、不挡人）

# ---- 路口模式的三个距离（10 个人撒在路口的 2~3 条臂上）----
# 为什么改用路口（用户看片后的反馈）：走廊模式无论怎么抖，10 个人都排在
# **同一条人行道**上，画面里还是一列人。改成路口之后，人会从 2~3 个方向过来。
CROSS_NEAR_M = 2.6            # 观望点离路口多远站住（走 1 m 左右就进 arrive_m）
CROSS_FAR_M = 9.0             # 路过的人从离路口多远处起步（约 4~6 秒走到路口）
CROSS_JITTER_M = 1.5          # 起步距离的抖动，免得同一条臂上的人并排
CROSS_ARMS = 3                # 最多用几条臂（度≥3 的真路口）


class PtsIndex(object):
    """点集的空间哈希，用来快速问"离这个位置最近的路中心线有多远"。"""

    def __init__(self, pts, cell=10.0):
        self.cell = cell
        self.b = {}
        for p in pts:
            k = (int(p[0] // cell), int(p[1] // cell))
            self.b.setdefault(k, []).append(p)
        self.maxr = 0.0

    def nearest(self, x, y, maxr=25.0):
        c = self.cell
        r = int(maxr // c) + 1
        ci, cj = int(x // c), int(y // c)
        best = None
        for i in range(ci - r, ci + r + 1):
            for j in range(cj - r, cj + r + 1):
                for p in self.b.get((i, j), ()):
                    d = math.hypot(p[0] - x, p[1] - y)
                    if best is None or d < best:
                        best = d
        return best if (best is not None and best <= maxr) else None


def _dir_of(g, e):
    pa, pb = RG.dkey(g.pos[e.u]), RG.dkey(g.pos[e.v])
    dx, dy = pb[0] - pa[0], pb[1] - pa[1]
    L = math.hypot(dx, dy) or 1.0
    return dx / L, dy / L


class Planner(object):
    """确定性路线规划器。

    每个 agent 用**自己的** random.Random("种子|aidN")，
    而不是共用一个 RNG —— 共用一个的话，路线结果依赖"谁先被处理"，
    以后加/减一个人，剩下所有人的路线全变，复现性验收就废了。
    """

    def __init__(self, graph, seed=20261020, area=None,
                 min_len=50.0, max_len=260.0):
        self.g = graph
        sizes = graph.component_sizes()
        self.g._sizes = sizes
        self.giant = sizes.index(max(sizes))
        self.seed = seed
        self.area = area                     # (x0, y0, x1, y1) 或 None = 全城
        self.min_len = min_len
        self.max_len = max_len
        self._rngs = {}
        self.corridor = None
        self.window = None

    # ---------------------------------------------------------------- 工具
    def _rng(self, a):
        k = getattr(a, "aid_i", 0)
        r = self._rngs.get(k)
        if r is None:
            # 【坑，实测撞到】种子不能用元组：Python 3.11 起 random.seed() 只收
            # None/int/float/str/bytes，传 (seed, k) 会直接 TypeError。
            # 这条路径只在"走到终点、replan 下一条路线"时才会走到，8 秒片里没人
            # 到终点，所以以前从没触发过 —— 长片/巡查一开就是崩溃。
            r = random.Random("%s|aid%d" % (self.seed, k))
            self._rngs[k] = r
        return r

    def in_area(self, i):
        if self.area is None:
            return True
        x, y = RG.dkey(self.g.pos[i])
        x0, y0, x1, y1 = self.area
        return x0 <= x <= x1 and y0 <= y <= y1

    def candidates(self):
        out = []
        for i in range(len(self.g.pos)):
            if self.g.comp[i] != self.giant:
                continue
            if not self.g.adj[i] or not self.in_area(i):
                continue
            out.append(i)
        return out

    def route_between(self, s, t):
        """最短路 -> 折线航点。返回 (waypoints, 总长)。"""
        path, d = self.g.shortest_path(s, t)
        if path is None:
            return None, float("inf")
        return self.g.polyline(path), d

    # ---------------------------------------------------------------- 主街
    def _walk(self, tail, curdir, used, max_steps=80):
        """从 tail 出发、沿 curdir 方向走"最直"的连续边。

        返回 [(edge_idx, to_node), ...]（顺序 = 行走顺序）。
        """
        g = self.g
        cos_lim = math.cos(math.radians(50))
        out = []
        cur, d = tail, curdir
        while len(out) < max_steps:
            best = None
            for ej in g.adj[cur]:
                if ej in used:
                    continue
                e2 = g.edges[ej]
                if e2.kind not in WALK_KINDS:
                    continue
                other = e2.v if e2.u == cur else e2.u
                po, pc = RG.dkey(g.pos[other]), RG.dkey(g.pos[cur])
                L = math.hypot(po[0] - pc[0], po[1] - pc[1]) or 1.0
                d2 = ((po[0] - pc[0]) / L, (po[1] - pc[1]) / L)
                dot = d[0] * d2[0] + d[1] * d2[1]
                if dot < cos_lim:
                    continue
                if best is None or dot > best[0]:
                    best = (dot, ej, other, d2)
            if best is None:
                break
            _dot, ej, other, d2 = best
            used.add(ej)
            out.append((ej, other))
            cur, d = other, d2
        return out

    def find_corridor(self, cell, min_len=90.0):
        """在指定格里找一条尽量直、尽量长的可步行走廊。

        返回 (总长, 有向节点序列, None)。最后一位保留是为了兼容旧调用签名。

        【踩过的坑】第一版把"向前延伸"和"向后延伸"的边**追加进同一个 list**，
        于是 chain 的顺序不是连通顺序；再由 chain 反推节点序列时必然连错。
        症状：主走廊报 124.9 m 完全笔直，但 10 条对穿路线里 5 条只有 2.5~14 m。
        修法：两个方向各自成序列，最后把反向那段倒过来拼在前面。
        """
        g = self.g
        ci, cj = (int(v) for v in cell.split(","))
        CELL = 150.0
        seeds = []
        for ei, e in enumerate(g.edges):
            if g.comp[e.u] != self.giant or e.kind not in WALK_KINDS:
                continue
            pa, pb = RG.dkey(g.pos[e.u]), RG.dkey(g.pos[e.v])
            mx, my = (pa[0] + pb[0]) * 0.5, (pa[1] + pb[1]) * 0.5
            if int(mx // CELL) != ci or int(my // CELL) != cj:
                continue
            seeds.append((e.length, ei))
        if not seeds:
            raise SystemExit("格 %s 里没有可步行的边" % cell)
        seeds.sort(reverse=True)

        best = None
        for _ln, ei in seeds[:8]:
            e0 = g.edges[ei]
            pa, pb = RG.dkey(g.pos[e0.u]), RG.dkey(g.pos[e0.v])
            L = math.hypot(pb[0] - pa[0], pb[1] - pa[1]) or 1.0
            d0 = ((pb[0] - pa[0]) / L, (pb[1] - pa[1]) / L)
            used = {ei}
            fwd = self._walk(e0.v, d0, used)
            bwd = self._walk(e0.u, (-d0[0], -d0[1]), used)
            seq = [e0.u, e0.v] + [o for _e, o in fwd]
            seq = [o for _e, o in reversed(bwd)] + seq
            total = e0.length + sum(g.edges[e].length for e, _o in fwd) \
                + sum(g.edges[e].length for e, _o in bwd)
            if best is None or total > best[0]:
                best = (total, seq)
        total, seq = best
        self.corridor = (total, seq)
        return total, seq, None

    @staticmethod
    def _arc(pts):
        cum = [0.0]
        for i in range(1, len(pts)):
            cum.append(cum[-1] + math.hypot(pts[i][0] - pts[i - 1][0],
                                            pts[i][1] - pts[i - 1][1]))
        return cum

    @staticmethod
    def _point_at(pts, cum, s):
        """沿折线取弧长 s 处的点（s 夹在 [0, 总长]）。"""
        s = max(0.0, min(s, cum[-1]))
        lo, hi = 0, len(cum) - 1
        while lo < hi - 1:
            mid = (lo + hi) // 2
            if cum[mid] <= s:
                lo = mid
            else:
                hi = mid
        seg = cum[hi] - cum[lo]
        if seg <= 1e-9:
            return pts[lo]
        t = (s - cum[lo]) / seg
        return (pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t,
                pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t)

    @staticmethod
    def _point_off(pts, cum, s, lat):
        """弧长 s 处的点，再沿**局部法线**横移 lat 米（lat > 0 = 行进方向右侧）。

        为什么要它：10 个人原来严格排在走廊中线上，出片像一列横队，一眼是摆出来的。
        横移量由调用方控制在人行道半宽（1.0 m）内，人就还在带子上，只是不再踩同一条线。
        法线取 (-dy, dx)/|d|，和 ped_sim._perp() 的"右侧"同向，符号不会反。
        """
        s = max(0.0, min(s, cum[-1]))
        lo, hi = 0, len(cum) - 1
        while lo < hi - 1:
            mid = (lo + hi) // 2
            if cum[mid] <= s:
                lo = mid
            else:
                hi = mid
        dx = pts[hi][0] - pts[lo][0]
        dy = pts[hi][1] - pts[lo][1]
        d = math.hypot(dx, dy)
        if d <= 1e-9:
            return pts[lo]
        t = (s - cum[lo]) / max(1e-9, cum[hi] - cum[lo])
        nx, ny = -dy / d, dx / d
        return (pts[lo][0] + dx * t + nx * lat,
                pts[lo][1] + dy * t + ny * lat)

    def _nearest_arc(self, pts, cum, xy, step=0.5):
        """折线上离 xy 最近的弧长位置 s。

        合并出来是因为两处都要用：① 把行动窗口对齐到选中的格；
        ② 把机位视线对准整段仿真的质心。以前第①处是一段内联循环，
        第②处再抄一遍就是同一条逻辑两个实现，改一处忘一处。
        """
        L = cum[-1]
        s, s_best, best = 0.0, 0.0, 1e18
        while s <= L:
            p = self._point_at(pts, cum, s)
            d = (p[0] - xy[0]) ** 2 + (p[1] - xy[1]) ** 2
            if d < best:
                best, s_best = d, s
            s += step
        return s_best

    def corridor_routes(self, n, window=36.0, near_xy=None,
                        dwell=(), dwell_len=DWELL_LEN_M, dwell_lat=DWELL_LAT_M):
        """沿走廊排 n 条对穿路线：起点在一段 **window 米**的行动窗口里错开，
        再各加一个确定性抖动，免得排成一条横队（见下面"站位分散"）。

        dwell：这些序号的路线**不走到走廊尽头**，只走到前面 dwell_len 米处的
        一个路边点（横向 dwell_lat）就停 —— 用来让人走完 Idle -> Look 这条
        别人永远走不到的支线（理由见文件头 DWELL_AGENTS 那段）。

        为什么必须有 window（这是实测推出来的，不是拍的）：
            走廊全长 774 m，10 个人摊上去平均间距 77 m；而步速 1.35 m/s 在
            5 秒里只能走 6.75 m —— 两个人永远碰不到面，Yield 一次都不会触发，
            "相遇会避让"这条验收标准就**无法证伪**（等于没验）。
            所以把行动窗口收到 36 m（间距 3.6 m，相遇时间约 1.33 s）。

        near_xy：把窗口挪到走廊上**离这个点最近**的位置。为什么必需：
            走廊 774 m 长，中点落在哪一格是随机的；实测中点落在 (3900, 3374)，
            而选中的"人行道密 + 建筑密"的格是 27,22（中心 4125, 3375），
            差了 200 m —— 机位架在好看的街上、人却在别处走，片子等于白拍。
            让它自动对齐到选中的格，人就在镜头里。

        为什么要按**弧长**而不是"取节点"插值：
            这条走廊几何被简化过，节点间距几十米；按节点取锚点排不出 10 个
            不同起点。人行道带是直的，段内任意点都在 2 m 宽的带上，站得住。
        """
        total, seq = self.corridor
        pts = [RG.dkey(self.g.pos[i]) for i in seq]
        cum = self._arc(pts)
        L = cum[-1]
        center = L * 0.5
        if near_xy is not None:
            center = self._nearest_arc(pts, cum, near_xy)
        c0 = max(0.0, center - window * 0.5)
        c1 = min(L, c0 + window)
        # ---- 站位分散（按实测反馈改的）----
        # 原来 10 个人沿走廊中线**严格等距**（窗口 18 m / 10 人 = 1.80 m）排开，
        # 出片像一列横队 —— 一眼就看出是"摆"的，不像街上的人。
        # 这里给每人加一个**确定性**抖动：
        #   沿路 ±0.55 m：步距不再整齐划一（0.7~2.9 m）
        #   横向 ±0.40 m：不再踩同一条线（人行道半宽 1.0 m，仍在带内）
        # 抖动只用本地 RNG、种子取自 self.seed，所以 ped_demo 出片与
        # verify_ped_nav 复算出来的起点**逐位相同** —— "出片/验收同源"这条口径不破。
        rng = random.Random("%s|spread" % self.seed)
        dwell_set = frozenset(dwell)
        out = []
        for i in range(n):
            s = c0 + (i + 0.5) / float(n) * (c1 - c0)
            s = min(max(s + rng.uniform(-0.55, 0.55), 0.0), L)
            lat = rng.uniform(-0.40, 0.40)
            start = self._point_off(pts, cum, s, lat)
            if i in dwell_set:
                # 观望点：路线只有两个点，终点在路边。剩余路线长度就是这个
                # 直线距离（≈4 m），走到离它 1.5 m（arrive_m）状态机自己切 Idle。
                fwd = (i % 2 == 0)
                sd = min(max(s + (dwell_len if fwd else -dwell_len), 0.0), L)
                stop = self._point_off(pts, cum, sd, dwell_lat)
                d = math.hypot(stop[0] - start[0], stop[1] - start[1])
                out.append(([start, stop],
                            "%s 观望点 起点弧长 %.1f m  走 %.1f m 后站住"
                            % ("正向" if fwd else "反向", s, d)))
                continue
            if i % 2 == 0:
                k = 0
                while k < len(cum) and cum[k] <= s:
                    k += 1
                wp = [start] + pts[k:]
                desc = "正向 起点弧长 %.1f m" % s
            else:
                k = len(cum) - 1
                while k >= 0 and cum[k] >= s:
                    k -= 1
                wp = [start] + list(reversed(pts[:k + 1]))
                desc = "反向 起点弧长 %.1f m" % s
            d = sum(math.hypot(wp[j + 1][0] - wp[j][0], wp[j + 1][1] - wp[j][1])
                    for j in range(len(wp) - 1))
            out.append((wp, "%s  路线 %.1f m" % (desc, d)))
        self.window = (c0, c1, center, pts, cum)
        self.dwell = tuple(dwell)
        return out

    # ---------------------------------------------------------------- 路口
    def _arms_of(self, ni, min_arm):
        """路口节点 ni 的每条相邻边 → 一条"从路口向外"的折线 (pts, cum, 长度)。

        用 _walk() 沿最直的方向往外延伸，所以一条臂是一条接近直的连续带，
        人走在上面不会拐来拐去。
        """
        g = self.g
        arms = []
        for ei in g.adj[ni]:
            e = g.edges[ei]
            if e.kind not in WALK_KINDS:
                continue
            far = e.v if e.u == ni else e.u
            p0, p1 = RG.dkey(g.pos[ni]), RG.dkey(g.pos[far])
            L = math.hypot(p1[0] - p0[0], p1[1] - p0[1]) or 1.0
            d0 = ((p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L)
            used = {ei}
            chain = self._walk(far, d0, used)
            seq = [ni, far] + [o for _e, o in chain]
            pts = [RG.dkey(g.pos[j]) for j in seq]
            cum = self._arc(pts)
            if cum[-1] >= min_arm:
                arms.append((pts, cum, cum[-1]))
        arms.sort(key=lambda a: -a[2])
        return arms

    def find_intersection(self, near_xy=None, min_arm=8.0, k=CROSS_ARMS, span=60.0):
        """找一个真路口（度 ≥ 3 的节点），返回 (节点序号, 臂列表)。

        为什么必须"度 ≥ 3"：度 2 的节点是路上的一点，人在那儿只能一进一出，
        画面里还是"迎面来一队"。度 ≥ 3 才有"从 2~3 个方向过来"这回事。

        打分：先看能凑出几条够长的臂（越多越好），再比总臂长。
        只看离 near_xy 最近的 60 个候选，够用且快（这一步是纯 python，秒级）。
        """
        g = self.g
        if near_xy is None:
            near_xy = (0.0, 0.0)
        cands = []
        for i in range(len(g.pos)):
            if g.comp[i] != self.giant or len(g.adj[i]) < 3 or not self.in_area(i):
                continue
            p = RG.dkey(g.pos[i])
            d2 = (p[0] - near_xy[0]) ** 2 + (p[1] - near_xy[1]) ** 2
            if d2 <= span * span:
                cands.append((d2, i))
        if not cands:
            raise SystemExit("这一带找不到度≥3 的路口节点（near=%s span=%.0f）"
                             % (near_xy, span))
        cands.sort()
        best = None
        for _d2, ni in cands[:60]:
            arms = self._arms_of(ni, min_arm)
            if len(arms) < 2:            # 只有一条臂等于还是"一条街"
                continue
            score = (min(len(arms), k), sum(a[2] for a in arms))
            if best is None or score > best[0]:
                best = (score, ni, arms[:k])
        if best is None:
            raise SystemExit("这一带的度≥3 节点都没有够长的臂（min_arm=%.1f m）" % min_arm)
        _score, ni, arms = best
        self.cross_node = ni
        self.cross_arms = arms
        return ni, arms

    def intersection_routes(self, n, near_xy=None, dwell=(), k=CROSS_ARMS,
                            near_m=CROSS_NEAR_M, far_m=CROSS_FAR_M,
                            jitter=CROSS_JITTER_M, dwell_lat=DWELL_LAT_M):
        """在路口把 n 个人撒到 2~3 条臂上：一部分走进路口，一部分穿过去。

        人从哪来、到哪去（这是"不再是一列人"的关键之一）：
            第 i 个人沿**臂 i%k** 走进来，穿过路口，再沿**臂 (i+1)%k** 走出去。
            于是每条臂上同时有"往里走"和"往外走"的人 → 天然的正面对穿（会 Yield），
            路口上还有横穿 → 画面上人是从 2~3 个方向来的。
        dwell 里的人：走到路口外侧 near_m 米的路边（横向 dwell_lat）就站住，
            剩下交给状态机自己走 Idle → Look。

        顺带把 self.window 设成**最长的那条臂**（arc 0 = 路口、向外为正），
        这样 camera_hint(anchor_arc=...) 能站在臂上回看路口。
        """
        ni, arms = self.find_intersection(near_xy, k=k)
        k = min(k, len(arms))
        rng = random.Random("%s|cross" % self.seed)
        dwell_set = frozenset(dwell)
        dwell_seen = {}          # 每条臂上已有几个观望点（用来错开，别站成一个人）
        out = []
        for i in range(n):
            ia = i % k
            a_pts, a_cum, a_len = arms[ia]
            if i in dwell_set:
                # 观望点：走近一点就停（否则站住太晚，8 秒片里没时间环顾）；
                # 同一条臂上的多个观望点**沿臂错开 1.7 m、横向再让 0.15 m**，
                # 否则两个人会在同一个点上重叠（实测第一版就是这样，画面上贴成一个人）。
                j = dwell_seen.get(ia, 0)
                dwell_seen[ia] = j + 1
                stop_s = near_m + 1.7 * j
                d_in = min(a_len - 0.5, stop_s + 2.0 + rng.uniform(0.0, 0.5))
            else:
                d_in = min(a_len - 0.5, max(near_m + 3.0,
                                           far_m + rng.uniform(-jitter, jitter)))
            start = self._point_off(a_pts, a_cum, d_in, rng.uniform(-0.35, 0.35))
            if i in dwell_set:
                stop = self._point_off(a_pts, a_cum, stop_s, dwell_lat + 0.15 * j)
                d = math.hypot(stop[0] - start[0], stop[1] - start[1])
                out.append(([start, stop],
                            "路口观望 臂%d 走进 %.1f m 后站住（离路口 %.1f m）"
                            % (ia, d, stop_s)))
                continue
            oa = (ia + 1) % k
            b_pts, b_cum, b_len = arms[oa]
            d_out = min(b_len - 0.5, max(5.0, far_m + rng.uniform(-jitter, jitter)))
            goal = self._point_off(b_pts, b_cum, d_out, rng.uniform(-0.35, 0.35))
            kin = 0
            while kin < len(a_cum) and a_cum[kin] < d_in:
                kin += 1
            in_part = [start] + [a_pts[j] for j in range(kin - 1, -1, -1)]
            kout = 0
            while kout < len(b_cum) and b_cum[kout] <= d_out:
                kout += 1
            out_part = [b_pts[j] for j in range(1, kout)] + [goal]
            wp = in_part + out_part
            d = sum(math.hypot(wp[j + 1][0] - wp[j][0], wp[j + 1][1] - wp[j][1])
                    for j in range(len(wp) - 1))
            out.append((wp, "路口 臂%d 进来 -> 臂%d 出去（路线 %.1f m）" % (ia, oa, d)))
        # 给机位用：arc 0 = 路口、向外为正（camera_hint 的 anchor_arc 就按这个算）
        self.window = (0.0, arms[0][2], 0.0, arms[0][0], arms[0][1])
        self.dwell = tuple(dwell)
        return out

    def arrival_handler(self, dwell=()):
        """到终点之后怎么办。**出片（ped_demo）和验收（verify_ped_nav）必须共用
        这一个函数** —— 两边各抄一份的话，出片和复算就会走出两条不同的轨迹
        （"出片即验收"这条口径是我今天刚用 917/1200 行不一致换来的教训）。

        观望点的人（dwell 序号）到站后**不给新路线**：就站着，让状态机自己去
        Idle -> Look。其余人交给 replan 沿路网继续走。
        """
        d = frozenset(dwell)

        def _h(world, a):
            if a.aid_i in d:
                return
            self.replan(world, a)

        return _h

    def _road_index(self):
        """懒加载机动车道点集（只建一次）。"""
        if getattr(self, "_ridx", None) is None:
            rg = RG.build(klasses=ROAD_KLASSES, snap_m=0.0)
            pts = [RG.dkey(rg.pos[i]) for i in range(len(rg.pos))]
            self._ridx = PtsIndex(pts)
            self._road_n = len(pts)
        return self._ridx

    def street_side(self, center, perp, span=20.0):
        """量出 center 沿 ±perp 两个方向哪一侧是马路，返回 (符号, 到路中心线的距离)。

        实现方式就是沿着法线每 1 m 打一个点，问"这里离最近的路中心线多近"；
        第一个进入 1.2 m 以内的 t 就是路中心线的位置。两侧都没有就返回 (None, span)。
        """
        idx = self._road_index()
        best = None
        for sgn in (1, -1):
            for t in range(1, int(span) + 1):
                x = center[0] + perp[0] * sgn * t
                y = center[1] + perp[1] * sgn * t
                d = idx.nearest(x, y, maxr=1.2)
                if d is not None:
                    if best is None or t < best[1]:
                        best = (sgn, float(t))
                    break
        if best is None:
            return None, span
        return best

    def camera_hint(self, back=6.0, side=None, height=1.65, lens=35.0, aim_xy=None,
                    anchor_arc=None):
        """街面机位：站到**马路中心线**上，斜看这段人行道。

        为什么机位必须离开人行道（两轮试出来的，不是拍的）：
            第一轮把人行道中线上：10 个人在深度方向排成一条线，互相遮挡，
            画面里只看得到 2 个人 —— "10 个人各走各的"这条验收直接看不出。
            第二轮退到 30 m 外还是同一条线，遮挡照旧。
            只有**横向离开 4~5 m** 才能把 10 个人在画面里拆开。

        为什么选马路中心线：它是唯一既保证"没有楼挡着"又保证"离开人行道"
            的位置。人行道和马路都在"街道走廊"里，走廊之外就是建筑。
            具体往哪一侧走、走多远，由 street_side() 从真数据量出来。

        aim_xy：视线对准哪个点。默认用走廊行动窗口的中点 —— 但那是**排人的位置**，
            不是**人实际走到的位置**（实测人群会整体偏离画面中心到右侧）。
            传整段仿真的质心进来，人就在画面正中。
        """
        c0, c1, cs, pts, cum = self.window
        if anchor_arc is not None:
            # 路口模式：折线的 arc 0 就是路口，机位要挂在"路口外侧 back 米"，
            # 而 camera_hint 里 loc = anchor - d*back —— 所以挂靠点要取 2*back，
            # 算出来的落点才正好在路口外侧 back 米（见 ped_demo 的调用）。
            cs = max(0.0, min(anchor_arc, cum[-1]))
        elif aim_xy is not None:
            cs = self._nearest_arc(pts, cum, aim_xy)
        anchor = self._point_at(pts, cum, cs)        # 机位挂靠的走廊点
        center = aim_xy if aim_xy is not None else anchor
        a = self._point_at(pts, cum, max(0.0, cs - 8.0))
        b = self._point_at(pts, cum, min(cum[-1], cs + 8.0))
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy) or 1.0
        d = (dx / L, dy / L)
        px, py = d[1], -d[0]
        sgn, dist = self.street_side(anchor, (px, py))
        self.street_measured = (sgn, dist)
        if side is None:
            side = dist if sgn is not None else 0.0
        s = sgn if sgn is not None else 1
        # 机位挂在走廊上（保证在路面上、不进楼），视线落到 aim_xy（保证人在画面正中）
        loc = (anchor[0] - d[0] * back + px * side * s,
               anchor[1] - d[1] * back + py * side * s,
               height)
        # 视线目标高度：实测 1.05 m 会让画面下半幅全是空地面（三分之一的像素
        # 浪费在地上），抬到 1.45 m 后地面占比降到合理区间、建筑露出来更多。
        tgt = (center[0], center[1], 1.45)
        return loc, tgt, lens

    # ---------------------------------------------------------------- 排人
    def head_on_routes(self, n, window=36.0):
        """兼容旧名：走 corridor_routes。"""
        return self.corridor_routes(n, window=window)

    def random_route(self, from_node, rng):
        """从 from_node 出发走到区域里另一个点，路程在 [min_len, max_len] 内。"""
        g = self.g
        cands = self.candidates()
        if not cands:
            return None, "区域里没有候选节点"
        for _ in range(60):
            t = cands[rng.randrange(len(cands))]
            if t == from_node:
                continue
            wp, d = self.route_between(from_node, t)
            if wp is None:
                continue
            if d < self.min_len:
                continue
            if d > self.max_len:
                # 太长就只走到路径中途的一个节点，避免人跑出画面
                path, _dd = g.shortest_path(from_node, t)
                if path is None or len(path) < 4:
                    continue
                cut = max(2, int(len(path) * 0.25))
                wp, d = g.polyline(path[:cut]), None
            return wp, "wander 到节点 %d" % t
        return None, "60 次都没找到合适终点"

    # ---------------------------------------------------------------- 接 world
    def replan(self, world, a):
        """agent 到达终点后，ped_sim 会调它要一条新路线。

        这里是纯函数式的：只用 (seed, aid_i) 决定的 RNG，不读全局状态，
        所以"固定种子 -> 同一段视频"成立。
        """
        rng = self._rng(a)
        cur = self.g.nearest_node(a.x, a.y)[0]
        if cur is None or self.g.comp[cur] != self.giant:
            cur = self.candidates()[0]
        wp, why = self.random_route(cur, rng)
        if wp is None:
            return None
        world.set_route(a, wp)
        return why


def build_planner(cell="27,22", seed=20261020, margin=260.0):
    """按格中心建一个默认面积（格中心 ± margin）的规划器。"""
    g = RG.build(snap_m=0.0)
    ci, cj = (int(v) for v in cell.split(","))
    cx, cy = (ci + 0.5) * 150.0, (cj + 0.5) * 150.0
    area = (cx - margin, cy - margin, cx + margin, cy + margin)
    p = Planner(g, seed=seed, area=area)
    return p, (cx, cy)


def _report(cell="27,22", n=10, seed=20261020):
    print("=" * 78)
    print("ped_nav 路线计划：格 %s，%d 个人，种子 %d" % (cell, n, seed))
    print("=" * 78)
    p, center = build_planner(cell, seed)
    g = p.g
    print("图：节点 %d 边 %d 总长 %.1f km；规划区域 %.0f x %.0f m（中心 %.0f, %.0f）"
          % (len(g.pos), len(g.edges), sum(e.length for e in g.edges) / 1000.0,
             p.area[2] - p.area[0], p.area[3] - p.area[1], center[0], center[1]))
    total, seq, _chain = p.find_corridor(cell)
    print("\n主走廊：%.1f m，%d 个节点" % (total, len(seq)))
    pts = [RG.dkey(g.pos[i]) for i in seq]
    print("  首尾世界坐标 (%.1f, %.1f) -> (%.1f, %.1f)"
          % (pts[0][0], pts[0][1], pts[-1][0], pts[-1][1]))
    # 走廊直不直
    dx = pts[-1][0] - pts[0][0]
    dy = pts[-1][1] - pts[0][1]
    straight = math.hypot(dx, dy)
    print("  首尾直线距 %.1f m -> 曲折度 %.2f（1.00 = 完全笔直）"
          % (straight, total / max(1e-9, straight)))

    routes = p.corridor_routes(n, 36.0, near_xy=center)
    print("\n对穿路线 %d 条（窗口对齐到格中心 %.0f, %.0f）：" % (len(routes), center[0], center[1]))
    ok = True
    starts = []
    for i, (wp, why) in enumerate(routes):
        d = sum(math.hypot(wp[k + 1][0] - wp[k][0], wp[k + 1][1] - wp[k][1])
                for k in range(len(wp) - 1))
        starts.append(wp[0])
        print("  P%02d  %2d 个航点  路线 %7.1f m  起点 (%.1f, %.1f)  %s"
              % (i, len(wp), d, wp[0][0], wp[0][1], why))
        if len(wp) < 2:
            ok = False
            print("      !! 航点不足 2 个，走不动")

    # 关键验收：相邻起点间距 vs 5 秒能走的距离 —— 决定 Yield 到底会不会被触发
    sp = sorted(math.hypot(starts[i][0] - starts[j][0], starts[i][1] - starts[j][1])
                for i in range(len(starts)) for j in range(i + 1, len(starts)))
    if sp:
        walk5 = 1.35 * 5.0
        print("\n起点两两最近间距 %.2f m；5 秒能走 %.2f m（1.35 m/s）"
              % (sp[0], walk5))
        if sp[0] > walk5 * 2:
            ok = False
            print("  !! 间距比相遇所需距离还大：5 秒内不会相遇，Yield 无法被触发")
        else:
            print("  相遇必然发生：两人相向接近速度 2.70 m/s，%.1f m 只要 %.2f s"
                  % (sp[0], sp[0] / 2.70))
    print("\n结论：%s" % ("路线齐备、5 秒内必然相遇" if ok else "路线有问题，别急着渲"))
    loc, tgt, lens = p.camera_hint()
    print("机位建议：相机 (%.1f, %.1f, %.1f)  看向 (%.1f, %.1f, %.1f)  焦距 %.0f mm"
          % (loc[0], loc[1], loc[2], tgt[0], tgt[1], tgt[2], lens))
    return 0 if ok else 1


if __name__ == "__main__":
    cell = "27,22"
    if "--cell" in sys.argv:
        cell = sys.argv[sys.argv.index("--cell") + 1]
    sys.exit(_report(cell))
