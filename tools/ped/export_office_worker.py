# -*- coding: utf-8 -*-
"""把用户提供的 Ch33 西装男与现有 Mixamo 动作合成单人网页 GLB。"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from export_ped_glb import (
    CLIPS, OUT, SRC, armatures, fcurves_of, import_fbx, join_parts, meshes,
    reset, retarget_action, shrink_textures, strip_root_motion,
)

BASE = 'Ch33_nonPBR.fbx'
OUT_NAME = 'office_worker.glb'
EXTRA_CLIPS = [
    ('stairs_up', 'Walking Up The Stairs.fbx'),
    ('stairs_down', 'Descending Stairs.fbx'),
    ('crawl', 'Crawling.fbx'),
    ('sit', 'Shoved.fbx'),
    ('door', 'Opening Door Inwards.fbx'),
]
ALL_CLIPS = list(CLIPS) + EXTRA_CLIPS


def main():
    if not os.path.exists(os.path.join(SRC, BASE)):
        raise SystemExit('缺文件：' + os.path.join(SRC, BASE))
    reset()
    import_fbx(BASE)
    dst = armatures()[0]
    dst_meshes = meshes()
    if not dst_meshes:
        raise SystemExit('Ch33 没有网格')
    first_bone = dst.data.bones[0].name
    dst_prefix = first_bone.split(':')[0] + ':' if ':' in first_bone else ''
    print('[office-worker] skeleton=' + first_bone + ' meshes=' + str(len(dst_meshes)), flush=True)

    actions = {}
    for clip, fname in ALL_CLIPS:
        before = set(__import__('bpy').data.objects)
        before_actions = set(__import__('bpy').data.actions)
        import_fbx(fname)
        import bpy
        new_objects = [o for o in bpy.data.objects if o not in before]
        new_actions = [a for a in bpy.data.actions if a not in before_actions]
        if not new_actions:
            raise SystemExit('动作文件没有 action：' + fname)
        new_arms = [o for o in new_objects if o.type == 'ARMATURE']
        src_prefix = ''
        if new_arms and new_arms[0].data.bones:
            bone = new_arms[0].data.bones[0].name
            src_prefix = bone.split(':')[0] + ':' if ':' in bone else ''
        prefix_map = (src_prefix, dst_prefix) if src_prefix and src_prefix != dst_prefix else None
        action = max(new_actions, key=lambda a: len(fcurves_of(a)))
        actions[clip] = retarget_action(action, clip, dst, prefix_map)
        for obj in new_objects:
            bpy.data.objects.remove(obj, do_unlink=True)
        print('[office-worker] clip=' + clip + ' source=' + fname, flush=True)

    drift = sum(strip_root_motion(action) for action in actions.values())
    texture_count = shrink_textures()
    body = join_parts(dst_meshes, 'office_worker_body')

    keep = set(actions.values())
    for action in list(__import__('bpy').data.actions):
        if action not in keep:
            __import__('bpy').data.actions.remove(action)
    for clip, action in actions.items():
        action.name = clip

    import bpy
    bpy.ops.object.select_all(action='DESELECT')
    body.select_set(True)
    dst.select_set(True)
    bpy.context.view_layer.objects.active = dst
    os.makedirs(OUT, exist_ok=True)
    output = os.path.join(OUT, OUT_NAME)
    bpy.ops.export_scene.gltf(
        filepath=output,
        export_format='GLB',
        use_selection=True,
        export_animations=True,
        export_animation_mode='ACTIONS',
        export_bake_animation=False,
        export_anim_slide_to_zero=True,
        export_force_sampling=True,
        export_image_format='JPEG',
        export_image_quality=80,
        export_skins=True,
        export_morph=False,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_materials='EXPORT',
        export_optimize_animation_size=True,
        export_apply=False,
    )
    manifest = {
        'source_model': 'data/characters/Ch33_nonPBR.fbx',
        'source_note': '用户提供；原始许可待补记',
        'height_m': 1.82,
        'clips': sorted(actions),
        'bytes': os.path.getsize(output),
        'root_motion_curves_flattened': drift,
        'textures_resized': texture_count,
    }
    with open(os.path.join(OUT, 'office_worker.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print('[office-worker] done %.2f MB clips=%d' % (manifest['bytes'] / 1e6, len(actions)), flush=True)


if __name__ == '__main__':
    main()
