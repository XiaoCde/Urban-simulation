#!/usr/bin/env bash
# 跟拍近景看步态（1 人 / 32 帧 ≈ 1.33 s ≈ 一个走路循环 + 一点）。
# 为什么不用上一版那个固定机位：人在画面里只有 60 px 高，判不了步态。
# --cam track 是 Day 1 的跟拍机位（右后侧 3.8/4.2 m、2.05 m 高），能看清迈步。
set -u
cd "D:/Users/asus/Desktop/项目" || exit 1
PYTHONUTF8=1 /d/blender/blender.exe --background --python tools/ped_demo.py -- \
  out/pedestrian/_gait \
  --city out/dc_real3_clean.blend --cell 27,22 --z-floor 0.3 \
  --model "data/characters/Body Block.fbx" \
  --clips "data/characters/Breathing Idle.fbx,data/characters/Walking.fbx,data/characters/Running.fbx" \
  --people 1 --seconds 1.34 --mode png --frames 32 --samples 8 \
  --cam track --seed 20261020 --allow-placeholder \
  > out/gait.log 2>&1
echo "exit=$?"
grep -E "行走速度|占位|第1帧 相机" out/gait.log | sed 's/[^ -~]//g'
ls out/pedestrian/_gait/frames/ 2>/dev/null | wc -l
