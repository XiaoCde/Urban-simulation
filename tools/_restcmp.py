import bpy, mathutils
def load(p):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=p)
    a=[o for o in bpy.data.objects if o.type=='ARMATURE'][0]
    return a
A=load('data/characters/Walking.fbx')
ma={b.name.split(':')[-1]: b.matrix_local.copy() for b in A.data.bones}
B=load('data/characters/Standing Idle.fbx')
mb={b.name.split(':')[-1]: b.matrix_local.copy() for b in B.data.bones}
names=['Hips','Spine','Spine1','LeftArm','RightArm','LeftUpLeg','LeftLeg','LeftFoot','Neck','Head']
for n in names:
    if n in ma and n in mb:
        da=ma[n].to_quaternion(); db=mb[n].to_quaternion()
        ang=da.rotation_difference(db).angle
        la=ma[n].translation.length; lb=mb[n].translation.length
        print(f'{n:12s} rot_diff={ang*57.3:7.2f}deg  len_a={la:.4f} len_b={lb:.4f}')
