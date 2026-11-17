"""probe tile openings from BLACK asphalt polygons at each edge centre."""
import json, os
import bpy
from mathutils import Vector

ROOT = r"D:/Users/asus/Desktop/项目/data/characters/street  FBX-20261102T114253Z-1-001/FBX"
mods = ["Street_Straight", "Street_Curve", "Street_3Way", "Street_3Way_2",
        "Street_4Way", "Street_4Way_2", "Street_Deadend", "Street_Empty"]

for name in mods:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=os.path.join(ROOT, name + ".fbx"))
    o = next((x for x in bpy.data.objects if x.type == 'MESH'), None)
    if not o:
        continue
    cnt = {'-X': 0, '+X': 0, '-Y': 0, '+Y': 0}
    for p in o.data.polygons:
        mi = p.material_index
        mn = o.data.materials[mi].name if mi < len(o.data.materials) else ''
        if not mn.lower().startswith('black'):
            continue
        pts = [o.matrix_world @ o.data.vertices[vi].co for vi in p.vertices]
        cx = sum(v.x for v in pts) / len(pts)
        cy = sum(v.y for v in pts) / len(pts)
        if min(v.x for v in pts) < -0.9 and abs(cy) < 0.5: cnt['-X'] += 1
        if max(v.x for v in pts) > 0.9 and abs(cy) < 0.5: cnt['+X'] += 1
        if min(v.y for v in pts) < -0.9 and abs(cx) < 0.5: cnt['-Y'] += 1
        if max(v.y for v in pts) > 0.9 and abs(cx) < 0.5: cnt['+Y'] += 1
    opened = [k for k, v in cnt.items() if v >= 2]
    print('[open] ' + json.dumps({'name': name, 'cnt': cnt, 'open': opened}, ensure_ascii=False))
