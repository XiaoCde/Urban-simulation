"""probe all street modules: bbox / origin / material names."""
import json, os, sys
import bpy
from mathutils import Vector

ROOT = r"D:/Users/asus/Desktop/项目/data/characters/street  FBX-20261102T114253Z-1-001/FBX"
files = sorted(f for f in os.listdir(ROOT) if f.lower().endswith('.fbx'))
for f in files:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    try:
        bpy.ops.import_scene.fbx(filepath=os.path.join(ROOT, f))
    except Exception as e:
        print('[mod] ERR', f, e)
        continue
    objs = []
    for o in bpy.data.objects:
        if o.type != 'MESH':
            continue
        bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
        xs = [v.x for v in bb]; ys = [v.y for v in bb]; zs = [v.z for v in bb]
        objs.append({
            'n': o.name,
            'sz': [round(max(xs)-min(xs), 2), round(max(ys)-min(ys), 2), round(max(zs)-min(zs), 2)],
            'lo': [round(min(xs), 2), round(min(ys), 2), round(min(zs), 2)],
            'hi': [round(max(xs), 2), round(max(ys), 2), round(max(zs), 2)],
            'v': len(o.data.vertices),
        })
    print('[mod] ' + json.dumps({'f': f, 'n': len(objs), 'o': objs[:8]}, ensure_ascii=False))
