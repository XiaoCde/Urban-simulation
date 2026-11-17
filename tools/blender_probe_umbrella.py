"""探测 classic_umbrella.fbx 的尺寸与朝向（转换前的第一步）。"""
import os
import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "data", "characters", "classic_umbrella.fbx")

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=SRC)

objs = list(bpy.context.scene.objects)
meshes = [o for o in objs if o.type == "MESH"]
print("[probe] objects", len(objs), "meshes", len(meshes))
for o in objs[:20]:
    print("  ", o.type, repr(o.name), "loc", tuple(round(v, 3) for v in o.location))

lo = Vector((1e9, 1e9, 1e9))
hi = Vector((-1e9, -1e9, -1e9))
for o in meshes:
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        for k in range(3):
            lo[k] = min(lo[k], w[k])
            hi[k] = max(hi[k], w[k])
size = hi - lo
print("[probe] bbox lo", tuple(round(v, 3) for v in lo))
print("[probe] bbox hi", tuple(round(v, 3) for v in hi))
print("[probe] size", tuple(round(v, 3) for v in size))
print("[probe] materials", [m.name for m in bpy.data.materials][:10])
for o in meshes:
    l2 = Vector((1e9, 1e9, 1e9)); h2 = Vector((-1e9, -1e9, -1e9))
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        for k in range(3):
            l2[k] = min(l2[k], w[k]); h2[k] = max(h2[k], w[k])
    print("[probe] one", repr(o.name), "size", tuple(round(v, 3) for v in (h2 - l2)),
          "lo", tuple(round(v, 3) for v in l2), "mats", [m.name for m in o.data.materials])
