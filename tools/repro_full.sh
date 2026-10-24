#!/usr/bin/env bash
# Day 3.3 验收提前做掉：同一条命令渲两遍，比**解码帧像素**（不是 md5）。
#
# 为什么不能用 md5：
#   ① Blender 会往 PNG 里写墙钟时间（tEXt 块），文件 md5 必然不同而像素可能相同；
#   ② mp4 容器里也有时间元数据，两次出片大小相同、md5 不同、解码帧却逐像素相同。
#   ③ 反过来，md5 相同也只能说明字节一样，说明不了"差在哪儿"。
# 所以指标只能是：解码帧逐像素比较。
#
# 为什么要 --no-rt：
#   EEVEE 的硬件光追在这台机器上每次渲染有 ±1 LSB 抖动（samples=32 时
#   最大差 1/255、0 个像素差>2）。这点抖动本身可以忽略，但它会**扰动 H.264
#   的码率决策**，实测让两次出片的解码帧差到 25~36/255、36% 像素不同 ——
#   这就不是"逐帧一致"了。关掉光追后渲染逐位确定，整条链才可复现。
set -u
cd "D:/Users/asus/Desktop/项目" || exit 1

run() {
  local outdir="$1"; shift
  PYTHONUTF8=1 /d/blender/blender.exe --background --python tools/ped_demo.py -- "$outdir" \
    --city out/dc_real3_clean.blend --cell 27,22 --z-floor 0.3 \
    --model "data/characters/Body Block.fbx" \
    --clips "data/characters/Breathing Idle.fbx,data/characters/Walking.fbx,data/characters/Running.fbx" \
    --people 10 --seconds 5 --size 1280x720 --mode video --samples 32 --no-rt \
    --seed 20261020 --yield-max 0.8 --dodge 0.45 --dodge-spd 1.0 \
    --yield-gap 1.2 --yield-hold 0.4 --cone 30 "$@" \
    > "out/repro_$(basename "$outdir").log" 2>&1
  echo "  $outdir  exit=$?"
}

echo "### 第一遍 -> out/pedestrian/day2_10人（交付物）"
run out/pedestrian/day2_10人
echo "### 第二遍 -> out/pedestrian/_repro（复现性对照）"
run out/pedestrian/_repro

A=out/pedestrian/day2_10人
B=out/pedestrian/_repro
echo ""
echo "### 仿真层：states.csv / params.json"
md5sum "$A/states.csv" "$B/states.csv" "$A/params.json" "$B/params.json"

echo ""
echo "### 视频文件"
ls -l "$A/demo0001-0120.mp4" "$B/demo0001-0120.mp4"
md5sum "$A/demo0001-0120.mp4" "$B/demo0001-0120.mp4"

echo ""
echo "### 解码帧逐像素对比（这才是 3.3 的验收指标）"
PYTHONUTF8=1 /d/blender/blender.exe --background --python tools/grab_video_frames.py -- \
  "$A/demo0001-0120.mp4" "out/pedestrian/_reproA" 1 24 48 72 96 120 > /dev/null 2>&1
PYTHONUTF8=1 /d/blender/blender.exe --background --python tools/grab_video_frames.py -- \
  "$B/demo0001-0120.mp4" "out/pedestrian/_reproB" 1 24 48 72 96 120 > /dev/null 2>&1
PY=/c/Users/asus/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe
for f in 0001 0024 0048 0072 0096 0120; do
  $PY tools/diff_frames.py "out/pedestrian/_reproA/v$f.png" "out/pedestrian/_reproB/v$f.png" \
    | sed 's/[^ -~]//g'
done
echo "### 完成"
