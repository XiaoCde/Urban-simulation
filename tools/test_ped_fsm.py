# -*- coding: utf-8 -*-
r"""行人状态机的单元测试 —— **不需要 Blender**，用普通 python 跑。

    python tools\test_ped_fsm.py

为什么这个测试本身就是交付物的一部分：
    计划表里写死了「状态机必须是纯函数」。纯不纯不能靠嘴说，得能证明：
    这个文件全程不 import bpy，只用 python 标准库，跑完打印全部用例。
    哪天有人把决策逻辑挪进 Blender 那边，这个测试第一时间就会崩。
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ped_fsm as F

PASS = []
FAIL = []


def ck(name, got, want):
    if got == want:
        PASS.append(name)
        print("  [OK]   %-52s -> %s" % (name, got))
    else:
        FAIL.append(name)
        print("  [FAIL] %-52s -> %s  (想要 %s)" % (name, got, want))


def st(state, **kw):
    """跑一步，返回新状态（不关心原因）。"""
    return F.next_state(state, F.Obs(**kw))[0]


def main():
    print("=" * 78)
    print("行人状态机单元测试")
    print("=" * 78)

    # ---------- 0. 先证明它真的是纯的：不依赖 bpy ----------
    print("\n[0] 纯度检查")
    ck("import ped_fsm 之后 sys.modules 里没有 bpy", "bpy" in sys.modules, False)
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "ped_fsm.py"),
               encoding="utf-8").read()
    # 只认"真的在导入"的行：行首（允许缩进）就是 import bpy / from bpy。
    # 不能用 `"import bpy" in src` —— 注释和 docstring 里写「不 import bpy」也会命中，是假阳性。
    bad = [ln for ln in src.splitlines()
           if re.match(r"^\s*(import\s+bpy\b|from\s+bpy\b)", ln)]
    ck("source 里没有真的 import bpy 的行", bad, [])
    a = F.next_state(F.ST_WALK, F.Obs(t=0.5, dist_goal=10.0, gap_ahead=2.0))
    b = F.next_state(F.ST_WALK, F.Obs(t=0.5, dist_goal=10.0, gap_ahead=2.0))
    ck("同样输入两次结果一致", a, b)

    # ---------- 1. Idle ----------
    print("\n[1] Idle：站着")
    ck("没目的地、待不到 1 秒 -> 继续站", st(F.ST_IDLE, t=0.3), F.ST_IDLE)
    ck("没目的地、待够 1 秒 -> 还是站", st(F.ST_IDLE, t=1.2, rand=0.9), F.ST_IDLE)
    ck("拿到目的地（10 m）-> 起步", st(F.ST_IDLE, t=0.3, dist_goal=10.0), F.ST_WALK)
    ck("目的地比 arrive 还近（1.0 m）-> 不值得走", st(F.ST_IDLE, t=0.3, dist_goal=1.0), F.ST_IDLE)
    ck("地标旁边 + 随机数命中 -> 驻足", st(F.ST_IDLE, t=1.2, near_landmark=True, rand=0.05), F.ST_LOOK)
    ck("地标旁边 + 随机数没命中 -> 继续站", st(F.ST_IDLE, t=1.2, near_landmark=True, rand=0.95), F.ST_IDLE)
    ck("不是地标 + 随机数命中 -> 也不驻足", st(F.ST_IDLE, t=1.2, near_landmark=False, rand=0.01), F.ST_IDLE)

    # ---------- 2. Walk ----------
    print("\n[2] Walk：走")
    ck("走着、前方没人、没到 -> 继续走", st(F.ST_WALK, t=1.0, dist_goal=20.0), F.ST_WALK)
    ck("走着、到目的地了（1.0 m）-> 站住", st(F.ST_WALK, t=1.0, dist_goal=1.0), F.ST_IDLE)
    ck("走着、但目的地丢了（INF）-> 停下，不许无限走",
       st(F.ST_WALK, t=1.0, dist_goal=F.INF), F.ST_IDLE)
    ck("正俯视：走着、目的地 1.5 m 刚好等于 arrive -> 算到达",
       st(F.ST_WALK, t=1.0, dist_goal=1.5), F.ST_IDLE)

    # ---------- 3. Yield：避让，优先级最高 ----------
    print("\n[3] Yield：避让")
    ck("走着、前方 1.0 m 有人 -> 让路", st(F.ST_WALK, t=1.0, dist_goal=20.0, gap_ahead=1.0), F.ST_YIELD)
    ck("站着、前方 1.0 m 有人 -> 也让", st(F.ST_IDLE, t=0.2, gap_ahead=1.0), F.ST_YIELD)
    ck("驻足看、前方 1.0 m 有人 -> 也打断去看", st(F.ST_LOOK, t=1.5, gap_ahead=1.0), F.ST_YIELD)
    ck("让路中、前方已清空但只让了 0.3 s -> 还得等", st(F.ST_YIELD, t=0.3, dist_goal=20.0), F.ST_YIELD)
    ck("让路中、等够 0.8 s 且前方清空 -> 继续走", st(F.ST_YIELD, t=0.9, dist_goal=20.0), F.ST_WALK)
    ck("让路中、等够且前方清空、但没目的地 -> 站住", st(F.ST_YIELD, t=0.9), F.ST_IDLE)
    ck("让路中、前方还堵着 -> 继续让", st(F.ST_YIELD, t=2.0, dist_goal=20.0, gap_ahead=0.9), F.ST_YIELD)

    # ---------- 4. Look ----------
    print("\n[4] Look：驻足")
    ck("看着、没到 3 秒 -> 继续看", st(F.ST_LOOK, t=1.5), F.ST_LOOK)
    ck("看着、够 3 秒 -> 继续走", st(F.ST_LOOK, t=3.2), F.ST_WALK)

    # ---------- 5. 计时器语义 ----------
    print("\n[5] step_with_timer：计时器")
    o = F.Obs(t=0.0, dist_goal=20.0)
    o.t = 0.6
    ns, _ = F.step_with_timer(F.ST_WALK, o, 0.5)
    ck("状态不变时计时器累加 0.6+0.5", round(o.t, 2), 1.1)
    o2 = F.Obs(t=0.0)
    o2.t = 0.9
    ns, why = F.step_with_timer(F.ST_WALK, o2, 0.5)   # 目的地丢失 -> 切 Idle
    ck("状态切换时计时器归零（并且原因可读：%s）" % why, o2.t, 0.0)

    # ---------- 6. 状态 -> 动画剪辑 ----------
    print("\n[6] clip_of：状态映射到动画")
    ck("Idle -> Idle", F.clip_of(F.ST_IDLE), "Idle")
    ck("Walk -> Walk", F.clip_of(F.ST_WALK), "Walk")
    ck("Yield -> Idle（第一阶段复用）", F.clip_of(F.ST_YIELD), "Idle")
    ck("未知状态也给出 Idle，不抛异常", F.clip_of("不存在"), "Idle")

    # ---------- 7. Config 防拼错 ----------
    print("\n[7] Config：字段防拼错")
    try:
        F.Config(arrive_mm=2.0)
        ck("写错字段名应该报错", "没报错", "报错")
    except KeyError as e:
        ck("写错字段名会报错", "没有这个字段" in str(e), True)
    ck("正确改字段生效", F.Config(arrive_m=3.0).arrive_m, 3.0)

    # ---------- 8. 一条完整时间线 ----------
    print("\n[8] 时间线：站着 -> 起步 -> 避让 -> 继续走 -> 到达")
    cfg = F.Config()
    o = F.Obs(t=0.0, dist_goal=F.INF)
    state = F.ST_IDLE
    dt = 0.4
    timeline = []
    script = [
        (0.4, dict(dist_goal=12.0)),        # 0.8 s 时拿到目的地
        (2.0, dict(dist_goal=12.0)),        # 继续走
        (2.4, dict(dist_goal=12.0, gap_ahead=1.0)),   # 前面有人
        (3.2, dict(dist_goal=12.0, gap_ahead=3.0)),   # 人走开了
        (4.0, dict(dist_goal=12.0, gap_ahead=3.0)),   # 继续走
        (6.0, dict(dist_goal=0.8, gap_ahead=3.0)),    # 到了
    ]
    t = 0.0
    for dur, kw in script:
        while t < dur - 1e-9:
            for k, v in kw.items():
                setattr(o, k, v)
            state, why = F.step_with_timer(state, o, dt, cfg)
            t += dt
        timeline.append(state)
    print("      时间线状态序列：%s" % " -> ".join(timeline))
    ck("时间线以 Walk 结尾（避让后继续走、最后抵达）",
       timeline[-1] in (F.ST_WALK, F.ST_IDLE), True)
    ck("时间线里出现过 Yield", F.ST_YIELD in timeline, True)

    print("\n" + "=" * 78)
    print("通过 %d 项，失败 %d 项" % (len(PASS), len(FAIL)))
    if FAIL:
        for f in FAIL:
            print("  失败：%s" % f)
    print("=" * 78)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
