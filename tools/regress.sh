#!/usr/bin/env bash
# 改完根运动/时钟/接线表之后的回归。含一个负测试：闸门必须拦得住。
set -u
cd "D:/Users/asus/Desktop/项目" || exit 1
PY=/d/citysim/venv/Scripts/python.exe
BL=/d/blender/blender.exe

echo "### 1 语法"
$PY -c "import ast
for f in ('tools/ped_demo.py','tools/ped_fsm.py','tools/ped_sim.py','tools/check_root_motion.py'):
    ast.parse(open(f,encoding='utf-8').read())
print('OK')"

echo ""
echo "### 2 状态机单测（必须仍然 33/33 —— 我没动 ped_fsm.py）"
PYTHONUTF8=1 $PY tools/test_ped_fsm.py 2>&1 | tail -3

echo ""
echo "### 3 世界模型自测"
PYTHONUTF8=1 $PY tools/ped_sim.py 2>&1 | tail -3

echo ""
echo "### 4 根运动检查（行标用字典键，不再混淆 running/walking）"
PYTHONUTF8=1 $BL --background --python tools/check_root_motion.py > out/check_root.log 2>&1
grep -vE "^Blender|^$|WARNING|^FBX|User property|^\[demo\]" out/check_root.log \
  | sed 's/[^ -~]//g' | tail -16

echo ""
echo "### 5 闸门负测试：缺 Yield/Look 专属动作时必须拒绝出片"
PYTHONUTF8=1 $BL --background --python tools/ped_demo.py -- out/pedestrian/_gate \
  --city out/dc_real3_clean.blend --cell 27,22 --z-floor 0.3 \
  --model "data/characters/Body Block.fbx" \
  --clips "data/characters/Breathing Idle.fbx,data/characters/Walking.fbx,data/characters/Running.fbx" \
  --people 2 --frames 1 --samples 8 > out/gate.log 2>&1
echo "  blender exit=$?（期望非 0）"
grep -E "动作覆盖|拒绝出片|缺少|占位" out/gate.log | sed 's/[^ -~]//g' | head -8
if [ -f out/pedestrian/_gate/frames/f0001.png ]; then
  echo "  !! 闸门没拦住：竟然出图了"
else
  echo "  闸门生效：没有出图"
fi
