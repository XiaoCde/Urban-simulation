#!/usr/bin/env bash
# 两件事：
#  ① 查清"PNG 文件 md5 不同但解码像素完全相同"到底差在哪（决定验收指标）
#  ② 隔离视频编码器：输入已确定（--no-rt）时，H.264 编码是否逐位确定
set -u
cd "D:/Users/asus/Desktop/项目" || exit 1
PY=/c/Users/asus/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe
CLIPS="data/characters/Breathing Idle.fbx,data/characters/Walking.fbx,data/characters/Running.fbx"
MODEL="data/characters/Body Block.fbx"

echo "=== ① PNG 字节差异定位 ==="
$PY - <<'EOF'
import sys
def probe(p1, p2, tag):
    a = open(p1, 'rb').read()
    b = open(p2, 'rb').read()
    n = min(len(a), len(b))
    d = [i for i in range(n) if a[i] != b[i]]
    print("%-22s 大小 %d / %d  不同字节 %d" % (tag, len(a), len(b), len(d)))
    if d:
        print("    首个不同位置 %d，附近 a=%r b=%r" % (d[0], a[d[0]:d[0]+24], b[d[0]:d[0]+24]))
    for chunk in (b'tIME', b'tEXt', b'zTXt', b'iTXt', b'Date', b'Software'):
        print("    %-9s 在 A 中出现 %d 次，B 中 %d 次" % (chunk.decode(), a.count(chunk), b.count(chunk)))
probe('out/pedestrian/_det_RTa/frames/f0001.png',
      'out/pedestrian/_det_RTb/frames/f0001.png', 'RTa vs RTb(像素同)')
probe('out/pedestrian/_det_A/frames/f0001.png',
      'out/pedestrian/_det_B/frames/f0001.png', 'A vs B(像素差1)')
EOF

echo ""
echo "=== ② 编码器隔离：--no-rt 下出 1 帧视频两次 ==="
runvid() {
  local tag="$1"
  PYTHONUTF8=1 /d/blender/blender.exe --background --python tools/ped_demo.py -- \
    "out/pedestrian/_vd_$tag" --city out/dc_real3_clean.blend --cell 27,22 --z-floor 0.3 \
    --model "$MODEL" --clips "$CLIPS" --people 10 --seconds 5 --size 1280x720 \
    --mode video --frames 1 --samples 32 --no-rt --seed 20261020 \
    --yield-max 0.8 --dodge 0.45 --dodge-spd 1.0 --yield-gap 1.2 --yield-hold 0.4 --cone 30 \
    > "out/vd_$tag.log" 2>&1
  echo "  $tag exit=$?"
}
runvid X
runvid Y
echo "--- mp4 文件与 md5 ---"
ls -l out/pedestrian/_vd_X/demo0001-0001.mp4 out/pedestrian/_vd_Y/demo0001-0001.mp4 2>&1
md5sum out/pedestrian/_vd_X/demo0001-0001.mp4 out/pedestrian/_vd_Y/demo0001-0001.mp4 2>&1
echo "--- 解码帧像素对比 ---"
PYTHONUTF8=1 /d/blender/blender.exe --background --python tools/grab_video_frames.py -- \
  "out/pedestrian/_vd_X/demo0001-0001.mp4" "out/pedestrian/_vd_X/png" 1 > /dev/null 2>&1
PYTHONUTF8=1 /d/blender/blender.exe --background --python tools/grab_video_frames.py -- \
  "out/pedestrian/_vd_Y/demo0001-0001.mp4" "out/pedestrian/_vd_Y/png" 1 > /dev/null 2>&1
$PY tools/diff_frames.py out/pedestrian/_vd_X/png/v0001.png out/pedestrian/_vd_Y/png/v0001.png
