#!/usr/bin/env bash
# 渲染确定性实验：同一个单帧渲多次，看哪种配置能逐位一致。
# 为什么要写脚本文件而不是拼一行：上一次用 $CMD 变量展开，内层引号变成字面
# 字符，路径被切断（实测报 ["角色"] = "data/characters/Body），白跑 4 次。
set -u
cd "D:/Users/asus/Desktop/项目" || exit 1

CLIPS="data/characters/Breathing Idle.fbx,data/characters/Walking.fbx,data/characters/Running.fbx"
MODEL="data/characters/Body Block.fbx"

run() {
  local tag="$1"; shift
  PYTHONUTF8=1 /d/blender/blender.exe --background --python tools/ped_demo.py -- \
    "out/pedestrian/_det_$tag" --city out/dc_real3_clean.blend --cell 27,22 --z-floor 0.3 \
    --model "$MODEL" --clips "$CLIPS" --people 10 --seconds 5 --size 1280x720 \
    --mode png --frames 1 --warm 3.0 --seed 20261020 \
    --yield-max 0.8 --dodge 0.45 --dodge-spd 1.0 --yield-gap 1.2 --yield-hold 0.4 --cone 30 \
    "$@" > "out/det_$tag.log" 2>&1
  local rc=$?
  if [ -f "out/pedestrian/_det_$tag/frames/f0001.png" ]; then
    echo "$tag  exit=$rc  出图 OK"
  else
    echo "$tag  exit=$rc  !! 没有出图（看 out/det_$tag.log）"
  fi
}

run A   --samples 32
run B   --samples 32
run S1a --samples 1
run S1b --samples 1
run RTa --samples 32 --no-rt
run RTb --samples 32 --no-rt

echo "=== 对比（同 md5 = 逐位一致）==="
for pair in "A B" "S1a S1b" "RTa RTb"; do
  set -- $pair
  a="out/pedestrian/_det_$1/frames/f0001.png"
  b="out/pedestrian/_det_$2/frames/f0001.png"
  if [ -f "$a" ] && [ -f "$b" ]; then
    ma=$(md5sum "$a" | cut -d' ' -f1)
    mb=$(md5sum "$b" | cut -d' ' -f1)
    if [ "$ma" = "$mb" ]; then
      echo "$1 vs $2 : 逐位一致  $ma"
    else
      echo "$1 vs $2 : 不同  $ma  $mb"
    fi
  else
    echo "$1 vs $2 : 缺文件"
  fi
done
