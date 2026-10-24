# -*- coding: utf-8 -*-
r"""只读诊断（第二版）：按**全部材质槽 + 面积**统计，回答用户提的四个问题。

第一版的错：只看了 `material_slots[0]`。但建筑是**多材质槽**的 —— 外墙一个槽、
屋顶一个槽，按面索引分。只看第一个槽会把屋顶全漏掉，结论会完全反过来。

**只读**，不保存、不修改任何文件。

四项：
    1. 几何规模 —— 面数是否精确等于"原样 + 14,789 x 54 面"（① 是否真写进去）
    2. 材质覆盖 —— 按**面积**算每个材质占多少（这才看得出"谁在盖谁的屋顶"）
    3. 纯色/无材质 —— 哪些物体根本没有图像纹理（用户说的"纯色很假"）
    4. 抽样 —— 随机挑几栋楼，把它的材质槽和每个槽占的面数/面积摊开

用法:
    D:\blender\blender.exe --background --python tools\diagnose_appearance.py -- <blend>
"""
import os
import sys
from collections import Counter, defaultdict

import bpy

FEATURES = 14789
FACES_PER = 54
BASE_FACES = 241757


def log(m):
    print("[dx] %s" % m, flush=True)


def img_of(mat):
    if not mat or not mat.use_nodes:
        return None
    for n in mat.node_tree.nodes:
        if n.type == "TEX_IMAGE" and n.image:
            return (n.image.name, n.image.size[0], n.image.size[1])
    return None


def tile_of(mat):
    if not mat or not mat.use_nodes:
        return None
    for n in mat.node_tree.nodes:
        if n.type == "MAPPING":
            s = n.inputs["Scale"].default_value
            if s[0] > 0:
                return round(1.0 / s[0], 2)
    return None


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not argv:
        print(__doc__)
        return 1
    bpy.ops.wm.open_mainfile(filepath=os.path.abspath(argv[0]))
    log("打开 %s" % os.path.basename(argv[0]))

    objs = list(bpy.data.objects)
    meshes = [o for o in objs if o.type == "MESH" and o.data]
    verts = sum(len(o.data.vertices) for o in meshes)
    faces = sum(len(o.data.polygons) for o in meshes)

    # ---------- 1. 几何规模 ----------
    expect = BASE_FACES + FEATURES * FACES_PER
    log("=" * 72)
    log("1) 几何规模（① 是否真写进去的硬证据）")
    log("   物体 %d   顶点 %d   面 %d" % (len(objs), verts, faces))
    log("   ① 之前 %d 面 + %d 栋 x %d 面 = 预期 %d 面" % (BASE_FACES, FEATURES, FACES_PER, expect))
    log("   >>> 实际 - 预期 = %+d  %s"
        % (faces - expect, "==> ① 确实写进几何了" if faces == expect else "==> 对不上"))

    # ---------- 2/3. 按面积的材质覆盖 ----------
    area = defaultdict(float)       # 材质名 -> 面积 m^2
    poly_cnt = Counter()
    nslot_hist = Counter()
    no_tex_area = defaultdict(float)
    objs_no_tex = 0
    objs_no_mat = 0
    for o in meshes:
        slots = [s.material for s in o.material_slots]
        nslot_hist[len(slots)] += 1
        if not any(slots):
            objs_no_mat += 1
        if not any(img_of(m) for m in slots if m):
            objs_no_tex += 1
        me = o.data
        for p in me.polygons:
            mi = p.material_index
            mm = slots[mi] if mi < len(slots) else None
            nm = mm.name if mm else "(无材质)"
            area[nm] += p.area
            poly_cnt[nm] += 1
            if img_of(mm) is None:
                no_tex_area[nm] += p.area

    log("=" * 72)
    log("2) 按【面积】的材质覆盖（占全部网格面积的比例）")
    tot = sum(area.values()) or 1.0
    tot_o = sum(area.values())
    log("   材质占用面积合计 %.4f km^2" % (tot_o / 1e6))
    log("   %-38s %10s %7s  %s" % ("材质", "面积km^2", "占比", "贴图"))
    for nm, a in sorted(area.items(), key=lambda kv: -kv[1])[:26]:
        im = img_of(bpy.data.materials.get(nm))
        log("   %-38s %10.4f %6.2f%%  %s"
            % (nm, a / 1e6, 100.0 * a / tot, ("%s %dx%d tile=%s m" % (
                im[0][:26], im[1], im[2], tile_of(bpy.data.materials.get(nm)))) if im else "** 纯色 **"))

    log("=" * 72)
    log("3) 物体数按【材质槽数量】分布（看是不是多槽结构）")
    for k, v in sorted(nslot_hist.items()):
        log("   %d 个材质槽的物体：%6d 个" % (k, v))
    log("   材质里完全没有图像纹理的物体：%d / %d (%.1f%%)"
        % (objs_no_tex, len(meshes), 100.0 * objs_no_tex / max(len(meshes), 1)))
    log("   完全没有材质的物体：%d 个" % objs_no_mat)
    log("   纯色材质占的面积：%.4f km^2 (%.2f%%)"
        % (sum(no_tex_area.values()) / 1e6, 100.0 * sum(no_tex_area.values()) / tot))

    # ---------- 4. 抽样 ----------
    log("=" * 72)
    log("4) 抽样 6 栋楼，摊开它的材质槽与每个槽占的面/面积")
    step = max(1, len(meshes) // 7)
    shown = 0
    for o in meshes[::step]:
        if shown >= 6:
            break
        slots = [s.material for s in o.material_slots]
        if not slots or len(o.data.polygons) < 200:
            continue
        per = Counter()
        ar = defaultdict(float)
        for p in o.data.polygons:
            mi = p.material_index
            per[mi] += 1
            ar[mi] += p.area
        zs = [v.co.z for v in o.data.vertices]
        log("   %s  高 %.1f m  共 %d 面" % (o.name, max(zs) - min(zs) if zs else 0, len(o.data.polygons)))
        for mi in sorted(per):
            mm = slots[mi] if mi < len(slots) else None
            nm = mm.name if mm else "(无材质)"
            has = "有图" if img_of(mm) else "纯色"
            log("      槽%d %-38s %5d 面 %8.1f m^2  %s" % (mi, nm, per[mi], ar[mi], has))
        shown += 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
