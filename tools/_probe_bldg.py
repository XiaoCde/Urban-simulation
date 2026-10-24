import bpy, bmesh
from mathutils import Vector
bpy.ops.wm.open_mainfile(filepath=r"out\dc_real3_clean.blend")
objs=[o for o in bpy.data.objects if o.type=="MESH"]
print("[n]",len(objs))
import statistics
nv=[]
for o in objs[:2000]:
    nv.append(len(o.data.vertices))
print("[verts] min",min(nv),"med",statistics.median(nv),"max",max(nv))
o=objs[0]
mw=o.matrix_world
zs=[(mw@v.co).z for v in o.data.vertices]
print("[sample]",o.name,"z",round(min(zs),3),round(max(zs),3),"nv",len(o.data.vertices),"np",len(o.data.polygons),"mat",[s.material.name if s.material else None for s in o.material_slots])
print("[sample keys]",{k:str(o[k])[:40] for k in list(o.keys())[:20]})
# a few named
for nm in ["Washington Monument","United States Capitol","The White House","White House"]:
    x=bpy.data.objects.get(nm)
    print("[lookup]",nm,"->",x.name if x else None, x.type if x else "")
