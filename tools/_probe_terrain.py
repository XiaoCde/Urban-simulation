import bpy, math
from mathutils import Vector
bpy.ops.wm.open_mainfile(filepath=r"out\dc_real3_clean.blend")
def wb(o):
    cs=[o.matrix_world @ Vector(c) for c in o.bound_box]
    return (min(c.z for c in cs), max(c.z for c in cs),
            min(c.x for c in cs), max(c.x for c in cs),
            min(c.y for c in cs), max(c.y for c in cs))
meshes=[o for o in bpy.data.objects if o.type=="MESH"]
# 地面
g=bpy.data.objects.get("ground")
if g:
    z0,z1,x0,x1,y0,y1=wb(g)
    print("[probe] ground: z %.3f ~ %.3f  (高差 %.3f m)  顶点 %d  面 %d  面积 %.2f km2"
          % (z0,z1,z1-z0,len(g.data.vertices),len(g.data.polygons),(x1-x0)*(y1-y0)/1e6))
# 水体
water=[]
for o in meshes:
    for s in o.material_slots:
        if s.material and "water" in s.material.name.lower():
            water.append(o); break
print("[probe] 水体物体 %d 个" % len(water))
for o in water[:6]:
    z0,z1,_,_,_,_=wb(o)
    print("        %-22s z %.2f ~ %.2f  verts %d" % (o.name[:22], z0, z1, len(o.data.vertices)))
# 大网格（可能是地形）
big=sorted([o for o in meshes if len(o.data.vertices)>800], key=lambda o:-len(o.data.vertices))[:8]
print("[probe] 顶点最多的 8 个 mesh：")
for o in big:
    z0,z1,x0,x1,y0,y1=wb(o)
    print("        %-20s verts %6d  z %.2f~%.2f  跨度 %.0fx%.0f m"
          % (o.name[:20], len(o.data.vertices), z0, z1, x1-x0, y1-y0))
# 全场景 z 分布（建筑高度）
zs=[]
for o in meshes:
    if len(o.vertex_groups):  # 跳过
        pass
print("[probe] 物体总数 %d / MESH %d / CURVE %d"
      % (len(bpy.data.objects), len(meshes), len([o for o in bpy.data.objects if o.type=="CURVE"])))
