import bpy, math
from mathutils import Vector
bpy.ops.wm.open_mainfile(filepath=r"out\dc_real3_clean.blend")
g=bpy.data.objects.get("ground")
cs=[g.matrix_world @ Vector(c) for c in g.bound_box]
print("[ground] x %.2f .. %.2f   y %.2f .. %.2f   z %.3f" % (min(c.x for c in cs),max(c.x for c in cs),min(c.y for c in cs),max(c.y for c in cs),min(c.z for c in cs)))
xs=[];ys=[]
for o in bpy.data.objects:
    if o.type in ("MESH","CURVE"):
        xs.append(o.matrix_world.translation.x); ys.append(o.matrix_world.translation.y)
print("[objects] x %.0f .. %.0f  y %.0f .. %.0f" % (min(xs),max(xs),min(ys),max(ys)))
print("[count] mesh %d curve %d" % (len([o for o in bpy.data.objects if o.type=="MESH"]),len([o for o in bpy.data.objects if o.type=="CURVE"])))
names=[o.name for o in bpy.data.objects if o.type=="MESH"][:5]
print("[names]",names)
