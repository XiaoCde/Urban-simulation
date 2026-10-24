# -*- coding: utf-8 -*-
r"""诊断：渲染到底有没有用上材质基色。

做法：把场景里所有材质的 Base Color 强行改成洋红，渲染一张。
    变洋红 -> 材质生效，之前的"全灰"是 AgX/曝光/基色本来就灰的问题；
    仍然灰  -> 材质根本没贴到渲染的面上（比如面 material_index 全为 0 而槽位为空）。
用法：
    D:\blender\blender.exe --background out\realistic_times-square.blend --python tools\diag_material_color.py
"""
import os
import sys

import bpy

PROJECT = r"D:\Users\asus\Desktop\项目"

# 1) 先看每个物体的材质槽与面用到的 material_index
print("=" * 90)
for o in bpy.context.scene.objects:
    if o.type != "MESH":
        continue
    slots = [(i, s.material.name if s.material else None) for i, s in enumerate(o.material_slots)]
    idx = sorted(set(p.material_index for p in o.data.polygons))
    print("%-45s 面数=%-5d slots=%s 用到的index=%s" % (o.name, len(o.data.polygons), slots, idx))
    if o.name.startswith("3 Times") or o.name.startswith("AMC"):
        break
print("=" * 90)

# 2) 把所有材质改成洋红
n = 0
for m in bpy.data.materials:
    if not m.node_tree:
        continue
    b = m.node_tree.nodes.get("Principled BSDF")
    if b:
        b.inputs["Base Color"].default_value = (1.0, 0.0, 1.0, 1.0)
        n += 1
print("[diag] 已把 %d 个材质改成洋红" % n)

sys.path.insert(0, os.path.join(PROJECT, "tools"))
import render_scene  # noqa: E402

render_scene.main("out/diag_magenta.png")
