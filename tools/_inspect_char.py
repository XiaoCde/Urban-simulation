import bpy, sys, os
def inspect(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=path)
    objs=list(bpy.data.objects)
    arms=[o for o in objs if o.type=='ARMATURE']
    meshes=[o for o in objs if o.type=='MESH']
    print('==',os.path.basename(path))
    print('  objs',len(objs),'arms',[o.name for o in arms],'meshes',[o.name for o in meshes][:5])
    for a in arms:
        print('  arm',a.name,'bones',len(a.data.bones),'scale',tuple(round(v,4) for v in a.matrix_world.to_scale()))
    for m in meshes[:3]:
        print('  mesh',m.name,'verts',len(m.data.vertices),'uv',len(m.data.uv_layers),'mats',[ms.name if ms else None for ms in m.data.materials][:3])
    print('  actions',[(a.name, tuple(round(v,1) for v in a.frame_range)) for a in bpy.data.actions])
    print('  images',[(i.name, tuple(i.size), i.source) for i in bpy.data.images][:6])
for p in sys.argv[sys.argv.index('--')+1:]:
    inspect(p)
