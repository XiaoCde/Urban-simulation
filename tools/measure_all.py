# -*- coding: utf-8 -*-
"""量 .blend 里每个建筑层物体：尺寸 + 高度分布 + 松散块（= 实际建出几栋楼）。"""
import bpy

targets = [o for o in bpy.data.objects if o.type == "MESH" and o.name != "Cube"]

for ob in targets:
    zs = sorted(v.co.z for v in ob.data.vertices)
    print("=" * 96)
    print("物体: %s" % ob.name)
    print("  顶点=%d  X=%.2f  Y=%.2f  Z=%.2f" % (len(ob.data.vertices), ob.dimensions.x, ob.dimensions.y, ob.dimensions.z))
    if zs:
        print("  最低Z=%.2f  最高Z=%.2f  Z>20:%d  Z>50:%d  Z>100:%d  不同高度值=%d"
              % (zs[0], zs[-1], sum(1 for z in zs if z > 20), sum(1 for z in zs if z > 50),
                 sum(1 for z in zs if z > 100), len(set(round(z, 3) for z in zs))))

    before = set(bpy.data.objects)
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="LOOSE")
    bpy.ops.object.mode_set(mode="OBJECT")

    pieces = [ob] + [o for o in bpy.data.objects if o not in before]
    print("  >>> 松散块数（= 真正建出来的独立建筑数）: %d" % len(pieces))
    rows = []
    for p in pieces:
        pz = sorted(v.co.z for v in p.data.vertices)
        rows.append((pz[-1] if pz else 0.0, p.dimensions.x, p.dimensions.y, len(p.data.vertices), p.name))
    for z, x, y, nv, nm in sorted(rows, reverse=True):
        print("      高度=%8.2f m   底面=%6.1f x %6.1f m   顶点=%4d   %s" % (z, x, y, nv, nm[:44]))
