# -*- coding: utf-8 -*-
"""诊断：材质到底走的是 diffuse_color 还是节点树？节点名是不是被中文化了？

    D:\blender\blender.exe --background --python tools\probe_material_nodes.py -- <blend>
"""
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
BLEND = argv[0] if argv else r"D:\Users\asus\Desktop\项目\out\dc_quick.blend"
bpy.ops.wm.open_mainfile(filepath=BLEND)
print("[open] %s" % BLEND)

print("=" * 80)
print("语言设置: %r" % (bpy.context.preferences.view.language,))
print("=" * 80)

for name in ("dc_stone_01", "dc_ground", "vegetation", "water", "wall", "roof", "Material"):
    m = bpy.data.materials.get(name)
    if not m:
        print("%-14s <不存在>" % name)
        continue
    nodes = [(n.name, n.type) for n in m.node_tree.nodes] if m.node_tree else None
    bsdf = None
    if m.node_tree:
        bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    print("%-14s use_nodes=%-5s  node_tree=%-5s  diffuse=(%.2f,%.2f,%.2f)"
          % (name, m.use_nodes, m.node_tree is not None, m.diffuse_color[0], m.diffuse_color[1], m.diffuse_color[2]))
    print("               节点: %s" % (nodes,))
    if bsdf:
        print("               Principled 名=%r  BaseColor=%s"
              % (bsdf.name, tuple(round(x, 2) for x in bsdf.inputs["Base Color"].default_value)))

print("=" * 80)
print("抽查 3 个建筑对象的材质槽:")
n = 0
for o in bpy.data.objects:
    if o.type != "MESH" or o.name in ("Cube", "ground"):
        continue
    info = [(s.link, s.material.name if s.material else None) for s in o.material_slots]
    print("  %-30s %s" % (o.name, info))
    n += 1
    if n >= 6:
        break

print("=" * 80)
print("渲染设置:")
sc = bpy.context.scene
print("  engine=%s  view_transform=%s  look=%s  exposure=%.2f"
      % (sc.render.engine, sc.view_settings.view_transform, sc.view_settings.look, sc.view_settings.exposure))
print("  film_transparent=%s" % sc.render.film_transparent)
print("  world=%s" % (sc.world.name if sc.world else None,))
if sc.world and sc.world.node_tree:
    bg = sc.world.node_tree.nodes.get("Background")
    if bg:
        print("  world bg=%s strength=%.2f"
              % (tuple(round(x, 2) for x in bg.inputs["Color"].default_value),
                 bg.inputs["Strength"].default_value))
for o in bpy.data.objects:
    if o.type == "LIGHT":
        print("  light %s type=%s energy=%.2f angle=%.3f use_shadow=%s"
              % (o.name, o.data.type, o.data.energy, o.data.angle, getattr(o.data, "use_shadow", None)))
