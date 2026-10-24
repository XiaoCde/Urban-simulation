#!/usr/bin/env bash
# Day 3 正式片（交导师的成品）：10 人 / 8 秒 / 1280x720 / 24 fps。
#
# 用法：bash tools/render_day3.sh [输出目录] [日志路径]
#   —— 3.3 复现性验收要把同一条命令再跑一遍，靠这个参数把产物分开；
#      参数化是为了"第二遍和第一遍的命令一定是同一条"，不靠手抄。
#
# 为什么只传 6 段动作（用户一共下了 9 段新的）：
#   接线是"一个状态一段专属动作，状态内再按子相位分段"，只有位移性质对得上的
#   动作才会真的被播到。这 6 段各有明确去处：
#     Breathing Idle    -> Idle，以及 Yield 的僵持段（实测 0.00 m/s，站着才对）
#     Walking           -> Walk 主循环（素材里唯一一段持续向前走的循环）
#     Start Walking     -> Walk 头 0.62 s（站立 -> 迈步的过渡）
#     Stop Walking      -> Yield 头 0.55 s（迈步 -> 站定的过渡）
#     Walk Strafe Right -> Yield 真在横移的那 3.04 s（ped_sim 一律靠右让行）
#     Looking Around    -> Look
#   故意没传、也说明理由的：Walking Backwards / Walking Turn 180 / Run To Stop /
#   Walk Strafe Left / Crouching Idle / Running —— 见交接单 §2.5（有实测依据）。
#
# 为什么片子里会有 4 个人中途站住（P01/P04/P06/P09）：那是我在 ped_nav 里安排的
# 「原地观望点」（`DWELL_AGENTS`，走 4 m 后站到路边）。走廊模式下所有人从起点
# 一路走到走廊尽头、`on_arrive` 一到站就重规划，**全程没有一个 Idle 帧** ——
# 实测 1920 个「人·帧」里 Idle=0 / Look=0，4 段动作只有 2 段出镜。让这 4 个人
# 站住，"主动在动作之间切换"里那段"站着环顾"才出得来。不是摆拍，见 §2.5。
#
# 为什么 --no-rt：见 repro_full.sh 顶部 —— 开光追时两次出片的解码帧会差到
# 25~36/255，"逐帧一致"这条验收就不成立。
#
# 注意：机位视线用的是**整段 trace 的质心**，所以帧数一变机位就变。
# 想省时间"只重渲前几帧"来验复现性是**无效**的 —— 见 tools/repro_day3.sh 顶部。
#
# 让行参数为什么和 Day-2 不同（2026-10-21 傍晚按路口重扫出来的）：
#   Day-2 那组（1.2 m / 0.8 s / 0.4 s / 30°）是在**走廊**上调的；换到路口构图后
#   人多方向杂，同一组阈值让人频繁互相挡住 —— 实测走路只占 34.2%、Yield 29.1%。
#   重扫（tools\verify_ped_nav.py --sweep --outdir out\pedestrian\day3_10人）：
#     1.0m/0.6s/30° -> 37.3%   0.9m/0.5s -> 38.5%   0.8m/0.4s -> 39.2%
#     **0.8m/0.4s/25° -> 51.7%**（擦身 1 对、偏离 0.645 m ≤ 半宽 1.0、侧移仍有 0.71 s）
#   所以取 0.8 m / 0.4 s / 0.25 s / 25°：走路 34.2% -> 51.7%，四个状态一个没掉。
set -u
cd "D:/Users/asus/Desktop/项目" || exit 1

OUT="${1:-out/pedestrian/day3_10人}"
LOG="${2:-out/render_day3.log}"
PYTHONUTF8=1 /d/blender/blender.exe --background --python tools/ped_demo.py -- "$OUT" \
  --city out/dc_real3_clean.blend --cell 27,22 --z-floor 0.3 --window 18 \
  --model "data/characters/Body Block.fbx" \
  --clips "data/characters/Breathing Idle.fbx,\
data/characters/Walking.fbx,\
data/characters/Start Walking.fbx,\
data/characters/Stop Walking.fbx,\
data/characters/Walk Strafe Right.fbx,\
data/characters/Looking Around.fbx" \
  --people 10 --seconds 8 --size 1280x720 --mode video --samples 32 --no-rt \
  --seed 20261020 \
  --yield-max 0.4 --dodge 0.45 --dodge-spd 1.0 \
  --yield-gap 0.8 --yield-hold 0.25 --cone 25 \
  > "$LOG" 2>&1
echo "exit=$?"
