# -*- coding: utf-8 -*-
"""诊断 .blend 场景：材质、建筑高度分布、地标是否在。

用法: blender.exe --background --python inspect_scene.py -- <xxx.blend>
"""
import collections
import sys

import bpy
from mathutils import Vector

path = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.open_mainfile(filepath=path)

objs = list(bpy.data.objects)
by = collections.Counter(o.type for o in objs)
print("=" * 90)
print("文件:", path)
print("物体类型:", dict(by))
print("材质数:", len(bpy.data.materials))
for m in list(bpy.data.materials)[:40]:
    print("   ", m.name, "| base=", getattr(m, "diffuse_color", None))

# 建筑高度分布
hs = []
for o in objs:
    if o.type != "MESH":
        continue
    zs = [(o.matrix_world @ Vector(c)).z for c in o.bound_box]
    h = max(zs) - min(zs)
    if h > 2:
        hs.append(round(h, 1))
hs.sort()
print()
print("建筑数(Z跨度>2m):", len(hs))
if hs:
    def q(p):
        return hs[min(len(hs) - 1, int(len(hs) * p))]
    print("高度分布: 最小=%.1f  25%%=%.1f  中位=%.1f  75%%=%.1f  90%%=%.1f  最大=%.1f"
          % (hs[0], q(.25), q(.5), q(.75), q(.9), hs[-1]))
    c = collections.Counter()
    for h in hs:
        c[int(h // 5) * 5] += 1
    print("高度直方图（每 5 m 一档，前 20 档）:")
    for k in sorted(c)[:20]:
        print("   %3d-%3d m : %6d  %s" % (k, k + 5, c[k], "#" * min(60, c[k] // 20)))
    top = sum(1 for h in hs if h > 50)
    print("   > 50 m 的高楼: %d 栋 (%.2f%%)" % (top, top / len(hs) * 100))

# 地标
print()
print("--- 候选地标（名字含关键词的物体）---")
KEYS = ["White House", "Capitol", "Monument", "Lincoln", "Jefferson", "Smithsonian",
        "Pentagon", "Union Station", "Kennedy", "Washington", "Mall", "Treasury",
        "Supreme", "Library of Congress", "National"]
found = collections.Counter()
for o in objs:
    n = o.name
    for k in KEYS:
        if k.lower() in n.lower():
            found[n] = 1
            break
if found:
    for n in sorted(found)[:60]:
        print("   ", n)
else:
    print("    （无）—— 说明物体名里不带地标名字")

# 找名字最多的物体
print()
print("--- 数据中带名字的物体样例（前 30）---")
named = [o.name for o in objs if any(ch.isalpha() for ch in o.name) and len(o.name) > 4]
for n in sorted(set(named))[:30]:
    print("   ", n)
