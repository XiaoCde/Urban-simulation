# -*- coding: utf-8 -*-
r"""行人世界的仿真核心 —— **纯 python**，不 import bpy。

分工（这是计划表里定死的）：
    ped_fsm.py    只回答「下一个状态是什么」（纯函数）
    ped_sim.py    只回答「大家在哪儿、谁挡着谁、谁该去哪儿」（纯 python，本文件）
    ped_demo.py   只回答「把状态画出来」（Blender 那边）

    这么分的好处：
      1. 仿真可以脱离 Blender 跑、可以单元测试、可以几秒钟跑完一小时的剧情；
      2. 渲染慢的时候不用重跑仿真 —— 但更重要的反过来：仿真是确定性的，
         固定种子跑两次结果必须逐位相同，「一条命令 + 固定种子 -> 同一段视频」
         这条验收标准才成立（blender 那层完全不碰随机数）；
      3. 以后要评估「视觉感知泛化」，把人群密度/状态比例/相遇率当自变量，
         只需要改这里的参数，不用动渲染管线。

    「观察」怎么来的也在这一层：正前方锥形内最近的那个人的距离 = gap_ahead，
    状态机就是根据它决定让不让路。距离算错 -> 让路行为算错，所以这里是重点。
"""
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ped_fsm as F

INF = F.INF

# 行人平均步速（m/s）。1.35 是通行值（成年人平地常速 1.2~1.5）。
WALK_SPEED = 1.35


class Agent(object):
    """一个人。位置是平面坐标（x, y），高度交给 Blender 那边贴地。"""

    __slots__ = ("aid", "aid_i", "x", "y", "speed", "heading", "goal", "state", "t",
                 "landmark", "patrol", "patrol_i", "rest_s", "rest_t",
                 "log", "dist_walked", "state_hist",
                 "ox", "oy", "base_goal", "dodge_sgn", "dodge_done", "yield_t",
                 "route", "route_i")

    def __init__(self, aid, x, y, speed=WALK_SPEED, heading=0.0, patrol=None):
        self.aid = aid
        self.aid_i = 0            # add() 里按加入顺序赋值，用来做确定性的对称打破
        self.x = float(x)
        self.y = float(y)
        self.speed = float(speed)
        self.heading = float(heading)
        self.goal = None
        self.state = F.ST_IDLE
        self.t = 0.0              # 进入当前状态多久了
        self.landmark = False
        self.patrol = list(patrol) if patrol else []
        self.patrol_i = 0
        self.rest_s = 1.5         # 到站后站多久再走向下一个点
        self.rest_t = 0.0
        self.log = []             # [(时刻, 新状态, 原因)]
        self.dist_walked = 0.0
        self.state_hist = {}      # 状态 -> 累计秒数
        self.ox = self.x          # 设置当前目标时的出发点（用于算侧向绕行方向）
        self.oy = self.y
        self.base_goal = None
        self.dodge_sgn = 0        # 侧向绕行方向：0 = 没在绕，+1 / -1 = 往哪边绕
        self.dodge_done = 0.0     # 已经横着挪了多少米
        self.yield_t = 0.0        # 已经僵持让路多久
        self.route = []           # 导航航点 [(x, y), ...]（由 ped_nav 排出来）
        self.route_i = 0          # 当前走向第几个航点

    def pos(self):
        return (self.x, self.y)

    def next_patrol(self, min_dist=0.0):
        """取下一个巡查点。

        min_dist 这一步不能省：巡逻点若落在 arrive_m 半径内，拿到目标的下一帧就
        判"到达"，状态机会在 Walk / Idle 之间反复抖。实测半径 2 m 的 8 点巡逻圆
        相邻弦长只有 1.53 m，正好卡在 arrive_m=1.5 上，于是出现"起步 0.12 秒就
        又站住"的抖动。
        """
        if not self.patrol:
            return None
        n = len(self.patrol)
        for _ in range(n):
            p = self.patrol[self.patrol_i % n]
            self.patrol_i += 1
            if math.hypot(p[0] - self.x, p[1] - self.y) >= min_dist:
                return p
        # 全都在 min_dist 以内：退而求其次，返回离当前位置最远的那个
        best, best_d = None, -1.0
        for p in self.patrol:
            d = math.hypot(p[0] - self.x, p[1] - self.y)
            if d > best_d:
                best_d, best = d, p
        return best

    def __repr__(self):
        return ("Agent(%s @ %.2f,%.2f  %s  goal=%s)"
                % (self.aid, self.x, self.y, self.state, self.goal))


class World(object):
    def __init__(self, cfg=None, seed=20261020, gap_radius=6.0,
                 gap_half_angle=45.0, walk_speed=WALK_SPEED,
                 yield_max_s=4.0, dodge_m=0.9, dodge_speed=0.8,
                 waypoint_eps=0.05):
        self.cfg = cfg or F.Config()
        self.seed = seed
        self.rng = random.Random(seed)
        self.agents = []
        self.gap_radius = gap_radius
        self.gap_half_angle = gap_half_angle     # 只看正前方 ±45° 的锥形
        self.walk_speed = walk_speed
        self.yield_max_s = yield_max_s   # 互相让路僵持超过这么久就侧身绕行
        self.dodge_m = dodge_m           # 侧身绕行的横向偏移（米）
        self.dodge_speed = dodge_speed   # 侧身的横向速度（m/s）
        self.waypoint_eps = waypoint_eps # 到航点多近算"走过这一点"（米）
        self.on_arrive = None            # 到达终点后的回调，由 ped_nav 提供新路线
        self.now = 0.0

    # ---------------------------------------------------------------- 建人
    def add(self, aid, x, y, speed=None, heading=0.0, patrol=None):
        a = Agent(aid, x, y, self.walk_speed if speed is None else speed,
                  heading, patrol)
        a.aid_i = len(self.agents)
        self.agents.append(a)
        return a

    def set_goal(self, a, gx, gy):
        a.base_goal = (float(gx), float(gy))
        a.goal = a.base_goal
        a.ox, a.oy = a.x, a.y
        a.dodge_sgn = 0
        a.dodge_done = 0.0
        a.yield_t = 0.0

    def set_route(self, a, points):
        """给一个人一条**航点序列**（由 ped_nav 在图的最短路上算出来）。

        为什么要航点而不是一个终点：
            终点 + 直线插值 = 人横穿街区（计划表风险表点名的"一眼假"）。
            航点序列保证每一步都落在可见的人行道带里。

        为什么状态机一行都不用改：
            「到目的地还有多远」这个观察由本层算 —— 有路线时报告的是
            **剩余路线总长**，不是到当前航点的直线距离。所以中间航点不会被
            状态机当成"到达"，只有走完整条路线才会切 Idle。
            这正是 ped_fsm 里"观察是一层抽象"那句注释的用处。
        """
        pts = [(float(p[0]), float(p[1])) for p in points] if points else []
        a.route = pts
        a.route_i = 0
        if not pts:
            a.goal = None
            a.base_goal = None
            return
        a.base_goal = pts[0]
        a.goal = pts[0]
        a.ox, a.oy = a.x, a.y
        a.dodge_sgn = 0
        a.dodge_done = 0.0
        a.yield_t = 0.0

    def remaining(self, a):
        """剩余路线长度（米）。没有路线时退化成到单点的直线距离。

        这是状态机看到的 dist_goal —— 也就是"到达"的唯一判据。
        """
        if a.goal is None:
            return INF
        d = math.hypot(a.goal[0] - a.x, a.goal[1] - a.y)
        if a.route:
            for k in range(a.route_i + 1, len(a.route)):
                d += math.hypot(a.route[k][0] - a.route[k - 1][0],
                                a.route[k][1] - a.route[k - 1][1])
        return d

    # ------------------------------------------------------------ 观察生成
    def gap_ahead(self, a):
        """正前方锥形范围内最近那个人的距离；没人就是 INF。

        这是状态机「让路」的唯一依据。为什么是"正前方锥形"而不是"最近的人"：
        背后的人不该让你停 —— 真人不会因为后面有人就站住。
        """
        import math as _m
        if a.goal is not None:
            # 「正前方」= 我打算去的方向（哪怕正在让路，意图仍是那个目标）。
            # 这里若只看 a.heading，侧身绕行改掉的目标就不会反映进来。
            dx = a.goal[0] - a.x
            dy = a.goal[1] - a.y
            L = _m.hypot(dx, dy)
            hx, hy = (dx / L, dy / L) if L > 1e-9 else (_m.cos(a.heading), _m.sin(a.heading))
        else:
            hx, hy = _m.cos(a.heading), _m.sin(a.heading)
        cos_lim = _m.cos(_m.radians(self.gap_half_angle))
        best = INF
        for b in self.agents:
            if b is a:
                continue
            vx, vy = b.x - a.x, b.y - a.y
            d = _m.hypot(vx, vy)
            if d < 1e-9 or d > self.gap_radius:
                continue
            if (vx * hx + vy * hy) / d < cos_lim:    # 不在正前方锥形里
                continue
            if d < best:
                best = d
        return best

    def _perp(self, a):
        """行进方向的**右手边**单位向量 —— "靠右让行"。

        为什么是每人各自的右手边，而不是某个全局方向：
        两个人相向而行时，用各自的右手边才会往相反的两侧让开；
        取同一个全局方向会让两个人挪到同一边，还是正面对上。
        """
        if a.goal is None:
            return None
        dx, dy = a.goal[0] - a.x, a.goal[1] - a.y
        L = math.hypot(dx, dy)
        if L < 1e-9:
            return None
        hx, hy = dx / L, dy / L
        return (hy, -hx)

    def _apply_dodge(self, a):
        """侧身开始：目标也一起横移过去，绕开之后就是朝新目标继续走。"""
        pv = self._perp(a)
        if pv is None:
            return
        px, py = pv
        gx, gy = a.base_goal
        a.goal = (gx + px * self.dodge_m, gy + py * self.dodge_m)

    def observe(self, a):
        return F.Obs(t=a.t, dist_goal=self.remaining(a), gap_ahead=self.gap_ahead(a),
                     near_landmark=a.landmark, rand=self.rng.random())

    # ---------------------------------------------------------------- 步进
    def step(self, dt):
        """推进 dt 秒。顺序很重要：**先所有人观测决策，再统一移动**，
        否则同一帧里先移动的人会影响后移动的人的判断，结果依赖遍历顺序。"""
        decisions = []
        for a in self.agents:
            obs = self.observe(a)
            ns, why = F.next_state(a.state, obs, self.cfg)
            decisions.append((a, ns, why))

        for a, ns, why in decisions:
            if ns != a.state:
                a.state_hist[a.state] = a.state_hist.get(a.state, 0.0) + a.t
                a.log.append((round(self.now, 3), ns, why))
                a.state = ns
                a.t = 0.0
                if ns == F.ST_IDLE:
                    a.dodge_sgn, a.dodge_done = 0, 0.0   # 到站了就把绕行状态清掉
            else:
                a.t += dt

        for a in self.agents:
            if a.state == F.ST_WALK and a.goal is not None:
                dx = a.goal[0] - a.x
                dy = a.goal[1] - a.y
                L = math.hypot(dx, dy)
                if L > 1e-9:
                    step = min(a.speed * dt, L)
                    a.x += dx / L * step
                    a.y += dy / L * step
                    a.heading = math.atan2(dy, dx)
                    a.dist_walked += step

        # 走到当前航点了就顺延到下一个航点（多人各自的路线互不影响）。
        # 这里推进的阈值故意远小于 arrive_m：用 arrive_m 当阈值会在路口提前
        # 拐弯，把路线切角，人就走到人行道带外面去了。
        for a in self.agents:
            if not a.route:
                continue
            guard = 0
            while a.goal is not None and guard < len(a.route) + 2:
                guard += 1
                d = math.hypot(a.goal[0] - a.x, a.goal[1] - a.y)
                if d > self.waypoint_eps or a.route_i + 1 >= len(a.route):
                    break
                a.route_i += 1
                a.goal = a.route[a.route_i]
                a.base_goal = a.goal
                a.ox, a.oy = a.x, a.y

        # 死锁破解：两个人正面对上会互相让路 -> 谁都不走，僵在这里。
        # 真人靠侧身绕过对方，这里照做：僵持超过 yield_max_s 秒就横着挪 dodge_m 米。
        # 注意**必须真的挪身体**：只把目标挪开是不够的 —— "正前方"是 ±45° 的锥形，
        # 目标偏 0.9 m 在 5 m 外只相当于 9°，对方仍然在锥形里，让路规则不解除。
        # 身体横挪开之后对方就出了锥形，gap_ahead 回到 INF，两边自然起步。
        # 方向按加入顺序取奇偶，不用随机数（随机就复现不了了）。
        for a in self.agents:
            if a.state == F.ST_YIELD:
                a.yield_t += dt
                if a.dodge_sgn == 0 and a.yield_t >= self.yield_max_s and a.base_goal:
                    a.dodge_sgn = 1          # 一律靠右让行
                    self._apply_dodge(a)
            else:
                a.yield_t = 0.0
            # 侧身一旦开始就走完这 dodge_m 米：中途停下会在 1.5 m 阈值附近来回抖
            if a.dodge_sgn != 0 and a.dodge_done < self.dodge_m:
                pv = self._perp(a)
                if pv is not None:
                    step = min(self.dodge_speed * dt, self.dodge_m - a.dodge_done)
                    a.x += pv[0] * step
                    a.y += pv[1] * step
                    a.dodge_done += step
                    a.dist_walked += step

        # 到站休息够了就去下一个目标（"目的地从哪来"是世界的责任，不是状态机的）。
        # 两种来源：① 老的巡查点；② ped_nav 挂上来的 on_arrive 回调（真路网重规划）。
        for a in self.agents:
            if a.state != F.ST_IDLE:
                continue
            if not a.patrol and self.on_arrive is None:
                continue
            a.rest_t += dt
            if a.rest_t < a.rest_s:
                continue
            a.rest_t = 0.0
            if a.patrol:
                p = a.next_patrol(max(self.cfg.arrive_m * 1.4, self.cfg.walk_min_m))
                if p is not None:
                    self.set_goal(a, p[0], p[1])
            elif self.on_arrive is not None:
                self.on_arrive(self, a)

        self.now += dt

    def run(self, seconds, dt, on_frame=None):
        """跑 seconds 秒，每 dt 秒调一次 on_frame(世界, 帧序号, 时刻)。"""
        n = int(round(seconds / dt))
        for i in range(n):
            self.step(dt)
            if on_frame is not None:
                on_frame(self, i, self.now)
        return n

    # ---------------------------------------------------------------- 统计
    def stats(self):
        out = {"agents": len(self.agents), "now": self.now}
        for a in self.agents:
            out["agent_%s" % a.aid] = {
                "pos": (round(a.x, 3), round(a.y, 3)),
                "dist_walked": round(a.dist_walked, 3),
                "state_hist": {k: round(v, 2) for k, v in a.state_hist.items()},
                "state_now": a.state,
                "events": len(a.log),
            }
        return out


# ------------------------------------------------------------------ 自测
def _selftest():
    """两件事：① 剧情是不是"人话"（会走会停会让路）；② 固定种子能不能复现。"""
    print("=" * 78)
    print("ped_sim 自测")
    print("=" * 78)

    def build():
        w = World(seed=20261020)
        # 甲乙相向而行：会在 3 m 左右相遇，考验让路
        w.add("A", 0.0, 0.0, patrol=[(10.0, 0.0)])
        w.add("B", 10.0, 0.0, patrol=[(0.0, 0.0)])
        w.set_goal(w.agents[0], 10.0, 0.0)
        w.set_goal(w.agents[1], 0.0, 0.0)
        return w

    RUN_S = 20.0
    w1 = build()
    w1.run(RUN_S, 1.0 / 24.0)
    s1 = w1.stats()

    print("\n[A] 甲 事件序列")
    for t, st, why in w1.agents[0].log[:12]:
        print("    t=%6.2f  -> %-6s  %s" % (t, st, why))
    print("[B] 乙 事件序列")
    for t, st, why in w1.agents[1].log[:12]:
        print("    t=%6.2f  -> %-6s  %s" % (t, st, why))

    seen = set()
    for a in w1.agents:
        for _t, st, _why in a.log:
            seen.add(st)
    print("\n出现过的状态：%s" % sorted(seen))

    ok = True
    if F.ST_YIELD not in seen:
        print("  !! %.0f 秒里两个人相向而行居然没有让路，gap_ahead 算错了" % RUN_S)
        ok = False
    for a in w1.agents:
        if a.dist_walked < 5.0:
            print("  !! %s 只走了 %.3f m，多半是卡死在互相让路上了" % (a.aid, a.dist_walked))
            ok = False

    # 死锁破解的关键证据：两个人都越过了中点 = 真的擦身而过，而不是一起站住
    ax, bx = w1.agents[0].x, w1.agents[1].x
    print("\n终点：甲 x=%.2f   乙 x=%.2f   （应该 甲>5、乙<5）" % (ax, bx))
    if not (ax > 5.0 and bx < 5.0):
        print("  !! 两个人没有擦身而过 —— 死锁没解开")
        ok = False

    # 复现性：同一个种子重建一次世界，逐位对比
    w2 = build()
    w2.run(RUN_S, 1.0 / 24.0)
    s2 = w2.stats()
    same = (s1 == s2)
    print("\n复现性（同种子跑两次 stats 完全相同）：%s" % same)
    if not same:
        ok = False
        for k in s1:
            if s1[k] != s2.get(k):
                print("    不一致：%s\n      一次 %s\n      二次 %s" % (k, s1[k], s2.get(k)))

    print("\n" + "=" * 78)
    print("自测结果：%s" % ("通过" if ok else "失败"))
    print("=" * 78)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(_selftest())
