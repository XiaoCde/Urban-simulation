import bpy
def bones(p):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=p)
    a=[o for o in bpy.data.objects if o.type=='ARMATURE'][0]
    return set(b.name.split(':')[-1] for b in a.data.bones)
m=bones('data/characters/Walking.fbx')
f=bones('data/characters/Standing Idle.fbx')
print('male only:', sorted(m-f))
print('female only:', sorted(f-m))
print('common:', len(m&f))
