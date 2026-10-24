# -*- coding: utf-8 -*-
"""量用户自己保存的 .blend：列出每个 mesh 物体的尺寸和顶点 Z 分布。"""
import bpy

print("=" * 92)
print("blend 文件:", bpy.data.filepath)
print("场景:", bpy.context.scene.name)
print("=" * 92)

print("【场景集合层级】")
for coll in bpy.data.collections:
    print("  集合: %-40s 物体数=%d" % (coll.name, len(coll.objects)))
    for o in coll.objects:
        print("      - %s [%s]" % (o.name, o.type))
for o in bpy.context.scene.collection.objects:
    print("  场景根: %s [%s]" % (o.name, o.type))

print("=" * 92)
print("【所有物体】")
for o in bpy.data.objects:
    if o.type == "MESH":
        zs = [v.co.z for v in o.data.vertices]
        zs.sort()
        print("MESH  %s" % o.name)
        print("      X=%.2f  Y=%.2f  Z=%.2f  顶点=%d"
              % (o.dimensions.x, o.dimensions.y, o.dimensions.z, len(o.data.vertices)))
        if zs:
            print("      最低Z=%.2f 最高Z=%.2f  Z>20:%d  Z>50:%d  Z>100:%d  不同Z值=%d"
                  % (zs[0], zs[-1],
                     sum(1 for z in zs if z > 20),
                     sum(1 for z in zs if z > 50),
                     sum(1 for z in zs if z > 100),
                     len(set(round(z, 3) for z in zs))))
            print("      最高 15 个 Z: %s" % [round(z, 2) for z in zs[-15:]])
    else:
        print("%-5s %s" % (o.type, o.name))

print("=" * 92)
print("【自定义属性（blosm 写在物体上的场景信息）】")
for o in bpy.data.objects:
    if o.keys():
        print("  %s: %s" % (o.name, dict(o.items())))
print("场景自定义属性:", dict(bpy.context.scene.items()))
