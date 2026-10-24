import bpy, mathutils
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath='data/characters/Walking.fbx')
for o in bpy.data.objects:
    print(o.name, o.type, 'scale', tuple(round(v,4) for v in o.scale), 'parent', o.parent.name if o.parent else None)
a=[o for o in bpy.data.objects if o.type=='ARMATURE'][0]
print('arm world scale', tuple(round(v,4) for v in a.matrix_world.to_scale()))
m=[o for o in bpy.data.objects if o.type=='MESH'][0]
print('mesh world scale', tuple(round(v,4) for v in m.matrix_world.to_scale()))
