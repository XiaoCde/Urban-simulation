#!/usr/bin/env bash
# 根运动修复后的可视化验证：1 个人、城市、2 秒。
# 为什么 1 个人：没有相遇就不会进 Yield/Look，整段都是走 —— 专门看步态
# （原地循环对不对、脚打不打滑、换速度后还自不自然）。
set -u
cd "D:/Users/asus/Desktop/项目" || exit 1
PYTHONUTF8=1 /d/blender/blender.exe --background --python tools/ped_demo.py -- \
  out/pedestrian/_fixcheck \
  --city out/dc_real3_clean.blend --cell 27,22 --z-floor 0.3 \
  --model "data/characters/Body Block.fbx" \
  --clips "data/characters/Breathing Idle.fbx,data/characters/Walking.fbx,data/characters/Running.fbx" \
  --people 1 --seconds 2 --size 1280x720 --mode both --samples 16 \
  --seed 20261020 --yield-max 0.8 --dodge 0.45 --dodge-spd 1.0 \
  --yield-gap 1.2 --yield-hold 0.4 --cone 30 --allow-placeholder \
  > out/fixcheck.log 2>&1
echo "exit=$?"
grep -E "动作覆盖|占位|根骨骼|行走速度|状态 |参数 ->" out/fixcheck.log | sed 's/[^ -~]//g'
echo "--- 产物 ---"
ls -la out/pedestrian/_fixcheck/ 2>&1 | head -8
ls out/pedestrian/_fixcheck/frames/ 2>/dev/null | wc -l
