"""blender_probe_fbx.py — 只读探测 fbx 里的对象清单（不导出、不改文件）。

用法：
  blender.exe -b --python tools/blender_probe_fbx.py -- <in.fbx> [out.json]
"""
import json
import os
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
src = argv[0]
out_path = argv[1] if len(argv) > 1 else ""

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src)

objs = []
for o in bpy.data.objects:
    if o.type != 'MESH':
        continue
    # 世界坐标包围盒
    bb = [o.matrix_world @ __import__('mathutils').Vector(c) for c in o.bound_box]
    xs = [v.x for v in bb]; ys = [v.y for v in bb]; zs = [v.z for v in bb]
    objs.append({
        "name": o.name,
        "verts": len(o.data.vertices),
        "polys": len(o.data.polygons),
        "size": [round(max(xs) - min(xs), 2), round(max(ys) - min(ys), 2), round(max(zs) - min(zs), 2)],
        "center": [round((max(xs) + min(xs)) / 2, 1), round((max(ys) + min(ys)) / 2, 1),
                   round((max(zs) + min(zs)) / 2, 1)],
    })

result = {"file": os.path.basename(src), "count": len(objs), "objects": objs}
print("[probe] " + json.dumps(result, ensure_ascii=False))
if out_path:
    json.dump(result, open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
