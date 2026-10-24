# -*- coding: utf-8 -*-
"""把导入出来的建筑物体按"松散块"拆开，数一数里面到底有几个独立建筑。"""
import bpy

TARGET = "manhattan_times-square_556x435m.osm_buildings"

ob = bpy.data.objects[TARGET]
print("拆分前: %s  顶点=%d  X=%.2f Y=%.2f Z=%.2f"
      % (ob.name, len(ob.data.vertices), ob.dimensions.x, ob.dimensions.y, ob.dimensions.z))

bpy.ops.object.select_all(action="DESELECT")
bpy.context.view_layer.objects.active = ob
ob.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.separate(type="LOOSE")
bpy.ops.object.mode_set(mode="OBJECT")

parts = [o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith(TARGET)]
print("=" * 92)
print("松散块总数: %d" % len(parts))
print("=" * 92)
for o in sorted(parts, key=lambda x: -x.dimensions.x * x.dimensions.y):
    zs = sorted(v.co.z for v in o.data.vertices)
    print("  %-52s 顶点=%4d  底面积=%8.1f x %7.1f  高(Z)=%6.2f  最高Z=%6.2f"
          % (o.name[:52], len(o.data.vertices), o.dimensions.x, o.dimensions.y,
             o.dimensions.z, zs[-1] if zs else 0.0))
