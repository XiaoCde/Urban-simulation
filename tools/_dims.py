import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath='data/characters/Walking.fbx')
import mathutils
mn=[1e9]*3; mx=[-1e9]*3
for o in bpy.data.objects:
    if o.type!='MESH': continue
    for c in o.bound_box:
        w=o.matrix_world @ mathutils.Vector(c)
        for i in range(3):
            mn[i]=min(mn[i],w[i]); mx[i]=max(mx[i],w[i])
print('bbox min', [round(v,3) for v in mn])
print('bbox max', [round(v,3) for v in mx])
print('size', [round(mx[i]-mn[i],3) for i in range(3)])
imgs=[i for i in bpy.data.images if i.source=='FILE']
print('imgs', len(imgs), [(i.name, tuple(i.size), i.packed_file is not None) for i in imgs])
