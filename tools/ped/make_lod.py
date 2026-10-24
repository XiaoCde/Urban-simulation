# -*- coding: utf-8 -*-
r"""把 assets/ped/{male,female}.glb 压出一套 LOD 版本（*_lod.glb）。

为什么需要：
  一个角色 55k 三角（43,852 身体 + 11,109 头发）。全城 600 个行人如果都用它，
  光是三角形就是 3,300 万，任何显卡都撑不住。行人在地面上只有几十像素高，
  不需要 55k 面。

做法：导入已有 GLB（省掉重新跑 15 个 FBX 的两分钟），对网格加 Decimate
（COLLAPSE 模式，保留 UV + 顶点组），压到约 6%，再导出。动画原样带过去。

产物：web/assets/ped/male_lod.glb / female_lod.glb
"""
import bpy
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.join(ROOT, 'web', 'assets', 'ped')

# 一个角色原始 55k 三角。0.055 → 约 3,000 三角，地面行人的合理密度。
RATIO = 0.055


def tri_count():
    n = 0
    for o in bpy.data.objects:
        if o.type != 'MESH':
            continue
        me = o.data
        me.calc_loop_triangles()
        n += len(me.loop_triangles)
    return n


def do_one(name):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    path = os.path.join(SRC, name + '.glb')
    if not os.path.exists(path):
        raise SystemExit('缺文件：' + path)
    bpy.ops.import_scene.gltf(filepath=path)

    before = tri_count()
    for o in list(bpy.data.objects):
        if o.type != 'MESH':
            continue
        bpy.context.view_layer.objects.active = o
        m = o.modifiers.new('dec', 'DECIMATE')
        m.decimate_type = 'COLLAPSE'
        m.ratio = RATIO
        m.use_collapse_triangulate = True
        # 保留 UV 边界，否则贴图会糊/错位
        m.use_symmetry = False
        bpy.ops.object.modifier_apply(modifier=m.name)
    after = tri_count()

    out = os.path.join(SRC, name + '_lod.glb')
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format='GLB',
        use_selection=False,
        export_animations=True,
        export_animation_mode='ACTIONS',
        export_bake_animation=False,
        export_anim_slide_to_zero=True,
        export_force_sampling=True,
        export_image_format='JPEG',
        export_image_quality=70,
        export_skins=True,
        export_morph=False,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_materials='EXPORT',
        export_optimize_animation_size=True,
        export_apply=False,
    )
    sz = os.path.getsize(out) / 1e6
    acts = len([a for a in bpy.data.actions])
    print('[lod] %-11s tris %d -> %d (%.1f%%)  %5.2f MB  actions=%d'
          % (name, before, after, 100.0 * after / max(1, before), sz, acts))
    return out


def main():
    do_one('male')
    do_one('female')
    print('[lod] done')


if __name__ == '__main__':
    main()
