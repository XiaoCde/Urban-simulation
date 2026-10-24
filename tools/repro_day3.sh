#!/usr/bin/env bash
# Day 3.3 复现性验收（正式片版，约 27 分钟）：把 tools/render_day3.sh 同一条命令
# 再跑一遍到另一个目录，然后比**解码帧像素**（不是 md5）。
#
# 为什么必须整片重跑、不能只重渲前几帧（踩过的坑，别重犯）：
#   机位视线是**整段 trace 的质心**（`aim=(mean x, mean y)`），帧数一变小质心就变，
#   机位跟着变。实测：只渲前 12 帧时 params.json 里
#     tgt = [4124.8943, 3436.8956]
#   而整片 192 帧是
#     tgt = [4125.2483, 3437.0228]
#   两者解码帧最大差 234/255、平均差异 11.36、67.9% 像素不同 —— 不是渲染不确定，
#   是"机位不同"，画面本来就不是同一个。所以"缩短帧数验复现性"是**无效实验**。
#   而仿真层是逐位确定的：只渲 12 帧的那次，states.csv 前 120 行与整片逐字节相同
#   （md5 a136c44c3e93a47cc3024b15a1d4d6e1）。
#
# 为什么不能用 md5：见 repro_full.sh 顶部（PNG 的 tEXt 墙钟时间、mp4 容器时间元数据）。
# 为什么必须 --no-rt：同上（开光追时解码帧会差 25~36/255）。
set -u
cd "D:/Users/asus/Desktop/项目" || exit 1

A=out/pedestrian/day3_10人
B=out/pedestrian/_repro_day3

echo "### 第二遍（第一遍是已交付的 $A，命令由 render_day3.sh 统一保证一致）"
bash tools/render_day3.sh "$B" out/repro_day3.log

echo ""
echo "### 仿真层：states.csv / params.json"
md5sum "$A/states.csv" "$B/states.csv" "$A/params.json" "$B/params.json"

echo ""
echo "### 视频文件（大小 + md5，仅供参考：md5 必然不同）"
ls -l "$A/demo0001-0192.mp4" "$B/demo0001-0192.mp4"
md5sum "$A/demo0001-0192.mp4" "$B/demo0001-0192.mp4"

echo ""
echo "### 解码帧逐像素对比（这才是 3.3 的验收指标）"
BL=/d/blender/blender.exe
PY=/c/Users/asus/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe
PYTHONUTF8=1 $BL --background --python tools/grab_video_frames.py -- \
  "$A/demo0001-0192.mp4" out/pedestrian/_r3A 1 32 64 96 128 160 192 > /dev/null 2>&1
PYTHONUTF8=1 $BL --background --python tools/grab_video_frames.py -- \
  "$B/demo0001-0192.mp4" out/pedestrian/_r3B 1 32 64 96 128 160 192 > /dev/null 2>&1
for f in 0001 0032 0064 0096 0128 0160 0192; do
  $PY tools/diff_frames.py "out/pedestrian/_r3A/v$f.png" "out/pedestrian/_r3B/v$f.png"
done
echo "### 完成"
