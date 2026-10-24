# -*- coding: utf-8 -*-
r"""比较两个 FBX/GLB 里 armature 的骨骼 rest 朝向（滚转 / matrix_local）。

为什么需要它：
    "骨骼头位置和长度都一样"并不代表骨骼一样 —— 骨骼还有滚转（roll），
    它决定骨头局部坐标系绕自身轴的朝向。两个文件的骨头若滚转不同，
    同一个 rotation_quaternion 套到另一副骨架上就会摆出完全不同的姿势
    （典型症状：整副骨架折叠成一团、身高从 1.93 m 掉到 0.98 m）。
    这是"跨文件套 Mixamo 动作会塌"唯一还没排除的假设。

用法:
    blender --background --python tools\probe_orient.py -- <a.fbx|a.glb> <b.fbx|b.glb>
"""
import os
import sys

import bpy


def load(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ext = os.path.splitext(path)[1].lower()
    if ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    else:
        bpy.ops.import_scene.gltf(filepath=path)
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    arm = arms[0]
    out = {}
    for b in arm.data.bones:
        m = b.matrix_local
        q = m.to_3x3().to_quaternion()
        out[b.name] = (round(q.w, 4), round(q.x, 4), round(q.y, 4), round(q.z, 4))
    return arm.name, out


def main(paths):
    res = []
    for p in paths:
        name, d = load(p)
        res.append((p, name, d))
        print("[orient] %s" % p)
        print("[orient]   armature=%s  骨头 %d 根" % (name, len(d)))
    if len(res) < 2:
        return
    a, b = res[0][2], res[1][2]
    keys = sorted(set(a) & set(b))
    diff = [k for k in keys if a[k] != b[k]]
    print("")
    print("[orient] 共有骨头 %d 根，其中 rest 朝向不同的 %d 根" % (len(keys), len(diff)))
    for k in diff[:20]:
        print("[orient]   %-30s A=%s  B=%s" % (k, a[k], b[k]))
    if not diff:
        print("[orient] => 两副骨架的 rest 朝向完全一致，跨文件套动作本身没问题")


if __name__ == "__main__":
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    if len(argv) < 2:
        print(__doc__)
        sys.exit(1)
    main(argv)
