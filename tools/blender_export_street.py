"""blender_export_street.py — 把 street 包与车包里的 fbx 转成 glb（一次性离线转换）。

【为什么必须用 Blender】这两个包**只有 fbx**（核查过：`street FBX`、`traffic-lights vol-02`、
`generic-passenger-car-pack` 全包 0 个 gltf/glb）。浏览器不能直接读 fbx，而
「MegaKit / Quaternius 有 gltf 所以不用 Blender」这条只对那两个包成立。
这里只做格式转换，不改模型、不做重定向。

车包的特殊之处：`fab.fbx` 是**一个场景里摆着 10 辆车 + 40 个轮子**（整块 21.7×21.7 m），
不是单车文件。所以按车型名找到车身，再按「距车身中心 < 3.2 m」挑出属于它的 4 个轮子，
其余全部删掉再导出。

用法：
  blender.exe -b --python tools/blender_export_street.py
"""
import math
import os
import sys

import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
STREET = os.path.join(ROOT, "data", "characters", "street  FBX-20261102T114253Z-1-001", "FBX")
CARS = os.path.join(ROOT, "data", "characters", "generic-passenger-car-pack", "source", "fab.fbx")
OUT = os.path.join(ROOT, "web", "assets", "street")


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mesh_center(o):
    bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
    return Vector((sum(v.x for v in bb) / 8, sum(v.y for v in bb) / 8, sum(v.z for v in bb) / 8))


def world_bbox(objs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector((min(lo.x, w.x), min(lo.y, w.y), min(lo.z, w.z)))
            hi = Vector((max(hi.x, w.x), max(hi.y, w.y), max(hi.z, w.z)))
    return lo, hi


def export(path, move_to_origin=False):
    """导出当前场景所有 mesh 为 glb。move_to_origin：把底面中心挪到原点。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    if not meshes:
        print(f"[skip] 空场景 {path}")
        return
    if move_to_origin:
        lo, hi = world_bbox(meshes)
        off = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
        for o in meshes:
            if o.parent is None:
                o.location -= off
        bpy.context.view_layer.update()

    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials='EXPORT',
        export_image_format='AUTO',
    )
    lo, hi = world_bbox(meshes)
    size = (hi - lo)
    print(f"[ok] {os.path.basename(path)}  mesh={len(meshes)}  "
          f"size={size.x:.2f}×{size.y:.2f}×{size.z:.2f}  "
          f"{os.path.getsize(path) // 1024} KB")


def do_simple(src_name, out_name):
    reset()
    src = os.path.join(STREET, src_name)
    if not os.path.exists(src):
        print("[miss]", src)
        return
    bpy.ops.import_scene.fbx(filepath=src)
    export(os.path.join(OUT, out_name), move_to_origin=True)


def do_car(body_kw, out_name):
    reset()
    bpy.ops.import_scene.fbx(filepath=CARS)
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    body = None
    for o in meshes:
        if body_kw.lower() in o.name.lower() and 'body' in o.name.lower():
            body = o
            break
    if body is None:
        print(f"[miss] 车包找不到 {body_kw}")
        return
    c = mesh_center(body)
    # 车身中心 3.2 m 内的轮子属于这辆车（同场景 10 辆车间距 > 3.5 m）
    keep = {body}
    for o in meshes:
        if o is body:
            continue
        if 'wheel' in o.name.lower() and (mesh_center(o) - c).length < 3.2:
            keep.add(o)
    # 删掉其余（含底座 Cylinder001，它是 21.7 m 的圆盘）
    for o in list(bpy.data.objects):
        if o.type == 'MESH' and o not in keep:
            bpy.data.objects.remove(o, do_unlink=True)
    print(f"[car] {body_kw}: 车身 + {len(keep) - 1} 个轮子")
    export(os.path.join(OUT, out_name), move_to_origin=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    # 信号灯与路灯（street 包）
    for n in ("TrafficLight", "TrafficLight_2",
              "Streetlight_Single", "Streetlight_Double"):
        do_simple(n + ".fbx", n + ".glb")
    # 三种车型
    do_car("Sedan", "car_sedan.glb")
    do_car("SUV", "car_suv.glb")
    do_car("Compact", "car_compact.glb")


if __name__ == "__main__":
    main()
