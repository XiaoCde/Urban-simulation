# -*- coding: utf-8 -*-
r"""把 data/characters 下的 Mixamo FBX 压成两个 web 用的 GLB（男角色 / 女角色）。

为什么必须在 Blender 里预处理，而不是浏览器直接读 FBX：
  1. 这 15 个 FBX 每个 28~60 MB，每个都内嵌同一套 22 张 2048/4096 贴图 ——
     直接用就是 400 MB 级，网页加载不了。
  2. 每个 FBX 只带**一段**动作，而网页里要一个角色带 13 段动作、按名字切。
  3. 每个角色 7 个 submesh / 7 个材质 → 上百个行人就是上千次 drawcall。
     这里把材质并到 4 个桶（皮肤/衣服/头发/鞋），贴图压到 512 JPEG。

产物：web/assets/ped/{male,female}.glb + clips.json
"""
import bpy
import os
import json

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.join(ROOT, 'data', 'characters')
OUT = os.path.join(ROOT, 'web', 'assets', 'ped')

# 动作名 -> FBX 文件。动作名就是网页里 AnimationMixer 用的 clip 名（全小写）。
CLIPS = [
    ('walk', 'Walking.fbx'),
    ('run', 'Running.fbx'),
    ('idle', 'Breathing Idle.fbx'),
    ('idle2', 'Body Block.fbx'),
    ('look', 'Looking Around.fbx'),
    ('side_l', 'Walk Strafe Left.fbx'),
    ('side_r', 'Walk Strafe Right.fbx'),
    ('back', 'Walking Backwards.fbx'),
    ('turn180', 'Walking Turn 180.fbx'),
    ('start', 'Start Walking.fbx'),
    ('stop', 'Stop Walking.fbx'),
    ('run_stop', 'Run To Stop.fbx'),
    ('crouch', 'Crouching Idle.fbx'),
]
FEMALE_BASE = 'Standing Idle.fbx'
FEMALE_EXTRA = [('idle2', 'Idle.fbx')]
TEX_SIZE = 512


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_fbx(name):
    p = os.path.join(SRC, name)
    if not os.path.exists(p):
        raise SystemExit('缺文件：' + p)
    bpy.ops.import_scene.fbx(filepath=p, use_anim=True)


def armatures():
    return [o for o in bpy.data.objects if o.type == 'ARMATURE']


def meshes():
    return [o for o in bpy.data.objects if o.type == 'MESH']


def channelbags(act):
    """Blender 4.4+ 的 Action 是「分层/槽」结构，fcurves 挂在 channelbag 上。

    `act.fcurves` 在 4.4 之后被移除（本机 5.2 会 AttributeError）。这里把每个
    槽的 channelbag 都摊平出来，兼容新旧两种 API。
    """
    out = []
    try:
        for layer in act.layers:
            for strip in layer.strips:
                for cb in strip.channelbags:
                    out.append(cb)
    except AttributeError:
        pass
    return out


def fcurves_of(act):
    if hasattr(act, 'fcurves'):
        return list(act.fcurves)
    res = []
    for cb in channelbags(act):
        res.extend(cb.fcurves)
    return res


def remove_fcurve(act, fc):
    for cb in channelbags(act):
        if fc in list(cb.fcurves):
            cb.fcurves.remove(fc)
            return True
    return False


def strip_root_motion(action, hip='Hips'):
    """把 Hips 的 location 曲线整条拍成首帧常数。

    Mixamo 的 walking 每个循环带 1.96 m 根位移（世界 -Y）。网页里位置由导航决定，
    照抄这条曲线就会「走一段闪回一次」。拍平而不是删除：删除会让骨骼掉回原点。
    """
    n = 0
    for fc in fcurves_of(action):
        if '.bones["' not in fc.data_path or '].location' not in fc.data_path:
            continue
        if hip not in fc.data_path:
            continue
        if not fc.keyframe_points:
            continue
        v0 = fc.keyframe_points[0].co[1]
        for kp in fc.keyframe_points:
            kp.co[1] = v0
            kp.handle_left[1] = v0
            kp.handle_right[1] = v0
        fc.update()
        n += 1
    return n


def retarget_action(act, new_name, dst_arm, prefix_map=None):
    """改名 + （跨性别复用时）重写骨骼前缀、丢掉目标骨架没有的骨骼。

    男（remy）与女（Ch22）骨骼拓扑一致，只有前缀 mixamorig: / mixamorig2: 不同；
    女角色缺 LeftEye/RightEye 两根。
    """
    act.name = new_name
    act.use_fake_user = True
    if prefix_map:
        old, new = prefix_map
        bones = set(b.name for b in dst_arm.data.bones)
        for fc in fcurves_of(act):
            p = fc.data_path
            if '.bones["' not in p:
                continue
            bn = p.split('"')[1]
            bn2 = bn.replace(old, new) if bn.startswith(old) else bn
            if bn2 not in bones:
                remove_fcurve(act, fc)
                continue
            if bn2 != bn:
                fc.data_path = p.replace('"%s"' % bn, '"%s"' % bn2)
    return act


def merge_materials(objs):
    def bucket(name):
        n = name.lower()
        if 'hair' in n or 'eyelash' in n:
            return 'hair'
        if 'shoe' in n or 'sneaker' in n:
            return 'shoe'
        if 'body' in n or 'eye' in n or 'skin' in n:
            return 'skin'
        return 'cloth'

    made = {}
    for o in objs:
        for i, ms in enumerate(list(o.data.materials)):
            if ms is None:
                continue
            b = bucket(ms.name)
            if b not in made:
                made[b] = ms
                ms.name = 'ped_' + b
            else:
                o.data.materials[i] = made[b]
    for o in objs:
        seen, keep = set(), []
        for ms in o.data.materials:
            if ms is None or ms.name in seen:
                continue
            seen.add(ms.name)
            keep.append(ms)
        while len(o.data.materials):
            o.data.materials.pop()
        for ms in keep:
            o.data.materials.append(ms)
    return made


def shrink_textures(max_size=TEX_SIZE):
    n = 0
    for img in bpy.data.images:
        if img.source != 'FILE' and img.packed_file is None:
            continue
        w, h = img.size
        if w <= 0 or h <= 0:
            continue
        if max(w, h) > max_size:
            s = max_size / float(max(w, h))
            img.scale(max(1, int(w * s)), max(1, int(h * s)))
            n += 1
        img.file_format = 'JPEG'
    return n


def join_parts(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    return o


def export_character(base_fbx, clip_list, out_name):
    reset()
    import_fbx(base_fbx)
    dst = armatures()[0]
    dst_mesh_objs = meshes()
    bn = dst.data.bones[0].name
    dst_prefix = bn.split(':')[0] + ':' if ':' in bn else ''

    if not bpy.data.actions:
        raise SystemExit('基础文件没有 action：' + base_fbx)
    all_acts = {}
    all_acts[clip_list[0][0]] = retarget_action(bpy.data.actions[-1], clip_list[0][0], dst)

    for clip, fname in clip_list[1:]:
        before = set(bpy.data.objects)
        before_acts = set(bpy.data.actions)
        import_fbx(fname)
        new_objs = [o for o in bpy.data.objects if o not in before]
        new_acts = [a for a in bpy.data.actions if a not in before_acts]
        new_arms = [o for o in new_objs if o.type == 'ARMATURE']
        src_prefix = ''
        if new_arms and new_arms[0].data.bones:
            b2 = new_arms[0].data.bones[0].name
            src_prefix = b2.split(':')[0] + ':' if ':' in b2 else ''
        pm = (src_prefix, dst_prefix) if src_prefix and src_prefix != dst_prefix else None
        all_acts[clip] = retarget_action(new_acts[-1], clip, dst, pm)
        for o in new_objs:
            bpy.data.objects.remove(o, do_unlink=True)

    drift = sum(strip_root_motion(a) for a in all_acts.values())
    n_mats = len(merge_materials(dst_mesh_objs))
    nt = shrink_textures()
    one = join_parts(dst_mesh_objs, 'ped_body')

    keep = set(all_acts.values())
    for a in list(bpy.data.actions):
        if a not in keep:
            bpy.data.actions.remove(a)
    # 【必须最后再正名】上面删除之前，重名 action 会被 Blender 自动加 .001 后缀
    # （female 的 idle2 就变成了 idle2.001，网页按 clip 名取动作会取不到）。
    for clip, act in all_acts.items():
        act.name = clip

    bpy.ops.object.select_all(action='DESELECT')
    one.select_set(True)
    dst.select_set(True)
    bpy.context.view_layer.objects.active = dst

    out = os.path.join(OUT, out_name)
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format='GLB',
        use_selection=True,
        export_animations=True,
        export_animation_mode='ACTIONS',
        export_bake_animation=False,
        export_anim_slide_to_zero=True,
        export_force_sampling=True,
        export_image_format='JPEG',
        export_image_quality=72,
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
    clips = sorted(all_acts.keys())
    print('[ped] %-11s %6.2f MB  clips=%d %s  mats=%d  tex=%d rootmotion=%d'
          % (out_name, sz, len(clips), clips, n_mats, nt, drift))
    return out, clips


def main():
    os.makedirs(OUT, exist_ok=True)
    res = {}
    res['male'] = export_character('Walking.fbx', CLIPS, 'male.glb')
    res['female'] = export_character(FEMALE_BASE, FEMALE_EXTRA + CLIPS, 'female.glb')
    json.dump({k: {'clips': v[1], 'bytes': os.path.getsize(v[0])} for k, v in res.items()},
              open(os.path.join(OUT, 'clips.json'), 'w', encoding='utf-8'), indent=1)
    print('[ped] done')


if __name__ == '__main__':
    main()
