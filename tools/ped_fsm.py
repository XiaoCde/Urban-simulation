# -*- coding: utf-8 -*-
r"""行人有限状态机 —— **纯函数**，不 import bpy，可以脱离 Blender 单独跑。

为什么要写成纯函数（这是计划表里定死的技术决定）：
    导师要的是「像游戏一样，让他能主动地在一些动作之间切换」。
    那么「用什么来驱动决策」就是一个随时可能换的插头 —— 今天是沿路网走，
    明天可能要接感知真值、接事件注入（封路/疏散）。如果把决策和 Blender 的
    场景对象、骨骼、action 揉在一起写，换插头就得重写。
    写成 next_state(状态, 观察) -> 新状态 之后：
      - 决策逻辑可以脱离 Blender 跑单元测试（见 tools\test_ped_fsm.py）
      - 「观察」是一层抽象：现在只有"到目的地多远/前面有没有人"，
        以后加"路口灯是什么颜色/有没有事件"不用动状态机
      - 能固定随机数种子复现

观察里为什么带 rand：
    要"概率性驻足"就必须有随机数；但纯函数不能自己去调 random（那样跑两次结果不同）。
    所以随机数作为观察的一个字段传进来，由调用方控制种子 —— 这样"同一个种子跑出同一段视频"
    这条验收标准才成立。
"""

# ----------------------------------------------------------------- 状态名
ST_IDLE = "Idle"    # 站着不动
ST_WALK = "Walk"    # 走
ST_YIELD = "Yield"  # 避让（前方有人）
ST_LOOK = "Look"    # 驻足看（靠近地标时概率触发）

ALL_STATES = (ST_IDLE, ST_WALK, ST_YIELD, ST_LOOK)

# 状态 -> 播哪段动画（骨骼模型里的剪辑名，见 tools\inspect_character.py 的输出）
# 这里放的是"逻辑名"，真正映射到 Soldier 的 Idle/Walk/Run 还是 Xbot 的 idle/walk/run
# 由 Blender 那边按模型填，状态机不管模型。
CLIP_FOR_STATE = {
    ST_IDLE: "Idle",
    ST_WALK: "Walk",
    ST_YIELD: "Idle",   # 第一阶段先复用站立，后面换成 sidestep
    ST_LOOK: "Idle",
}

INF = float("inf")


class Config(object):
    """所有阈值集中在这里，方便调参时只改一处。单位：米 / 秒。"""

    def __init__(self, **kw):
        self.arrive_m = 1.5        # 距目的地小于这个值就算到达
        self.walk_min_m = 1.5      # 目的地比这个还近就不值得走
        self.yield_gap_m = 1.5     # 正前方这个距离内有人就让
        self.yield_hold_s = 0.8    # 让路至少保持这么久，避免"让-走-让"抖动
        self.idle_decide_s = 1.0   # 站着时每隔这么久重新决策一次
        self.look_time_s = 3.0     # 驻足看多久
        self.look_chance = 0.15    # 靠近地标时每次决策的驻足概率
        for k, v in kw.items():
            if not hasattr(self, k):
                raise KeyError("Config 没有这个字段：%s" % k)
            setattr(self, k, v)


DEFAULT = Config()


class Obs(object):
    """一次决策要用到的全部信息（纯数据，没有任何 Blender 对象）。

    字段说明：
        t            进入当前状态后经过了多少秒
        dist_goal    到目的地的直线距离；INF 表示当前没有目的地
        gap_ahead    正前方锥形范围内最近一个人的距离；INF 表示没人
        near_landmark 是否处在"值得驻足"的位置（地标附近）
        rand         [0,1) 的随机数，由调用方按种子产生
    """

    __slots__ = ("t", "dist_goal", "gap_ahead", "near_landmark", "rand")

    def __init__(self, t=0.0, dist_goal=INF, gap_ahead=INF,
                 near_landmark=False, rand=0.5):
        self.t = t
        self.dist_goal = dist_goal
        self.gap_ahead = gap_ahead
        self.near_landmark = near_landmark
        self.rand = rand

    def __repr__(self):
        return ("Obs(t=%.2f, dist_goal=%.2f, gap_ahead=%.2f, landmark=%s, rand=%.3f)"
                % (self.t, self.dist_goal, self.gap_ahead, self.near_landmark, self.rand))


def next_state(state, o, cfg=DEFAULT):
    """状态机的**全部**逻辑。返回 (新状态, 原因或 None)。

    优先级（从高到低，顺序就是这段代码的顺序）：
        1. 避让   —— 安全第一，任何状态下前方有人都能打断
        2. 到达   —— 走完了就站住
        3. 决策   —— 站着的时候决定"继续站着 / 起步 / 驻足看"
        4. 计时   —— 驻足看够了就继续走

    "原因"是给人看的：调 bug 时一眼就知道为什么切了状态。
    """
    # ---- 1. 避让：优先级最高，可以打断 Walk / Look / Idle ----
    if o.gap_ahead < cfg.yield_gap_m:
        if state != ST_YIELD:
            return ST_YIELD, "前方 %.2f m 有人，让路" % o.gap_ahead
        return ST_YIELD, None

    # 已经在避让：要"前方清空"且"让够时间"才走，否则会一步一停
    if state == ST_YIELD:
        if o.t < cfg.yield_hold_s:
            return ST_YIELD, None
        if o.dist_goal > cfg.arrive_m and o.dist_goal < INF:
            return ST_WALK, "前方清空，继续走"
        return ST_IDLE, "前方清空，没有目的地"

    # ---- 2. 到达 / 目的地丢失 ----
    if state == ST_WALK:
        if o.dist_goal <= cfg.arrive_m:
            return ST_IDLE, "到达目的地"
        # 目的地为 INF 表示"没有目的地"。这种情况正常不该发生在 Walk 里，
        # 但一旦发生（比如目标点被判定为非法而清空），必须能停下来 ——
        # 否则这个行人会永远沿着当前方向走下去，是这类状态机最典型的死循环。
        if o.dist_goal >= INF:
            return ST_IDLE, "目的地丢失，停下"
        return ST_WALK, None

    # ---- 3. 站着时的决策 ----
    if state == ST_IDLE:
        if o.dist_goal > cfg.arrive_m and o.dist_goal < INF:
            return ST_WALK, "拿到目的地，起步"
        if o.t >= cfg.idle_decide_s:
            if o.near_landmark and o.rand < cfg.look_chance:
                return ST_LOOK, "靠近地标，驻足看一会儿"
            return ST_IDLE, "继续待着"
        return ST_IDLE, None

    # ---- 4. 驻足计时 ----
    if state == ST_LOOK and o.t >= cfg.look_time_s:
        return ST_WALK, "看够了，继续走"

    # 其余情况：维持原状态
    return state, None


def step_with_timer(state, o, dt, cfg=DEFAULT):
    """便利函数：走一步并维护「进入当前状态多久了」这个计时器。

    真实循环里计时器由调用方维护（因为还要处理目的地重设等），
    但单元测试和简单驱动都可以直接用这个。
    """
    ns, why = next_state(state, o, cfg)
    if ns == state:
        nt = o.t + dt
    else:
        nt = 0.0
    o.t = nt
    return ns, why


def is_walking(state):
    return state == ST_WALK


def clip_of(state):
    return CLIP_FOR_STATE.get(state, "Idle")
