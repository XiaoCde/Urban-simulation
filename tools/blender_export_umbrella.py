"""把 classic_umbrella.fbx 里并排的 4 个模型拆成两把独立雨伞 glb。

源文件是一组展示模型（撑开的伞 / 收起的伞 / 伞架 / 另一把收起的伞），
沿 X 一字排开，整体 3.85 m 宽。浏览器只需要「一把伞」，所以：
  1) 只挑出目标 mesh，把它的世界变换烘进顶点；
  2) 按同一比例缩放到真实尺寸（撑开的伞直径约 1.1 m、高约 0.96 m）；
  3) 居中到原点、伞柄底端贴 y=0；
  4) 单独导出 GLB（保留原材质颜色）。

用法： blender.exe -b --python tools/blender_export_umbrella.py
"""
import os
import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "data", "characters", "classic_umbrella.fbx")
OUT = os.path.join(ROOT, "web", "assets", "props")

# 4 个模型共用同一比例：撑开的伞宽 1.54 m → 目标 1.10 m
SCALE = 1.10 / 1.54
JOBS = [
    ("classic_umbrela_opened", "umbrella_open.glb"),
    ("classic_umbrela_closed", "umbrella_closed.glb"),
]


def bbox_of(me):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for v in me.vertices:
        for k in range(3):
            lo[k] = min(lo[k], v.co[k])
            hi[k] = max(hi[k], v.co[k])
    return lo, hi


def convert(name, outfile):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=SRC)
    src = next((o for o in bpy.context.scene.objects if o.name == name and o.type == "MESH"), None)
    if src is None:
        raise RuntimeError("找不到 mesh: " + name)

    me = src.data.copy()
    me.transform(src.matrix_world)          # 把对象变换烘进顶点
    lo, hi = bbox_of(me)
    cx, cy = (lo.x + hi.x) * 0.5, (lo.y + hi.y) * 0.5
    for v in me.vertices:
        v.co = Vector(((v.co.x - cx) * SCALE,
                       (v.co.y - cy) * SCALE,
                       (v.co.z - lo.z) * SCALE))
    for m in src.data.materials:
        me.materials.append(m)

    # 只留新对象，导出 selection
    for o in list(bpy.context.scene.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    lo2, hi2 = bbox_of(me)
    print("[umbrella]", name, "->", outfile,
          "size", tuple(round(v, 3) for v in (hi2 - lo2)))

    path = os.path.join(OUT, outfile)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True,
        export_yup=True, export_apply=False,
    )
    print("[umbrella] wrote", path, os.path.getsize(path), "bytes")


os.makedirs(OUT, exist_ok=True)
for n, f in JOBS:
    convert(n, f)
