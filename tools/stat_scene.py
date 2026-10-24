# -*- coding: utf-8 -*-
"""导入完成后统计结果：物体数、材质槽、顶点色层、UV 层、包围盒。"""
import bpy


def stat(tag="RESULT"):
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    print("=" * 90)
    print("[%s] 场景物体总数: %d / MESH: %d" % (tag, len(bpy.context.scene.objects), len(meshes)))

    withMat, withoutMat = 0, 0
    matNames = {}
    uvLayers, colLayers = set(), set()
    zmax = 0.0
    for o in meshes:
        mats = [s.material.name for s in o.material_slots if s.material]
        if mats:
            withMat += 1
            for n in mats:
                matNames[n] = matNames.get(n, 0) + 1
        else:
            withoutMat += 1
        for uv in o.data.uv_layers:
            uvLayers.add(uv.name)
        for c in o.data.color_attributes:
            colLayers.add(c.name)
        for v in o.data.vertices:
            if v.co.z > zmax:
                zmax = v.co.z

    print("[%s] 有材质槽的物体: %d / 没有材质槽的: %d" % (tag, withMat, withoutMat))
    print("[%s] 用到的不重复材质数: %d" % (tag, len(matNames)))
    for n, c in sorted(matNames.items(), key=lambda kv: -kv[1])[:15]:
        print("      %-28s 用于 %d 个物体" % (n, c))
    print("[%s] UV 层: %s" % (tag, sorted(uvLayers)))
    print("[%s] 颜色属性层: %s" % (tag, sorted(colLayers)))
    print("[%s] 最高顶点 Z = %.2f m" % (tag, zmax))
    print("=" * 90)
    return dict(meshes=len(meshes), withMat=withMat, mats=len(matNames), zmax=zmax)


if __name__ == "__main__":
    stat()
