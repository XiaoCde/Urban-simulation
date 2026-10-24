import bpy
op = bpy.ops.export_scene.gltf
rna = op.get_rna_type()
keys = [p.identifier for p in rna.properties if p.identifier not in ('rna_type',)]
want = ['export_animations','export_animation_mode','export_nla_strips','export_image_format',
        'export_image_quality','export_skins','export_morph','export_apply','export_yup',
        'export_texcoords','export_normals','export_materials','export_optimize_animation_size',
        'export_bake_animation','export_frame_range','export_anim_slide_to_zero','export_force_sampling',
        'export_anim_single_armature','export_reset_pose_bones','export_original_specular','export_hierarchy_flatten_bones']
for w in want:
    print(w, 'OK' if w in keys else 'MISSING')
print('--- animation modes ---')
p = rna.properties['export_animation_mode']
print([ (i.identifier, i.name) for i in p.enum_items ])
