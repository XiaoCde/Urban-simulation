import bpy, sys, os
paths = sys.argv[sys.argv.index('--')+1:]
for path in paths:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=path)
    arms=[o for o in bpy.data.objects if o.type=='ARMATURE']
    meshes=[o for o in bpy.data.objects if o.type=='MESH']
    a=arms[0] if arms else None
    bones=[b.name for b in a.data.bones] if a else []
    print('==', os.path.basename(path))
    print('   mesh names:', [m.name for m in meshes])
    print('   nverts:', [len(m.data.vertices) for m in meshes])
    print('   nbones:', len(bones), 'sample:', bones[:5], '...', bones[-3:])
    print('   actions:', [(ac.name, tuple(round(v,1) for v in ac.frame_range)) for ac in bpy.data.actions])
