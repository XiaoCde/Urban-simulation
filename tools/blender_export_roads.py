"""
blender_export_roads.py — 把用户最后导入的那套「模块化街道瓦片」导出成 web 可用 glb。

源：data/characters/street  FBX-20261102T114253Z-1-001/FBX/
    每个模块是 2 x 2 单位、原点在模块中心的低模瓦片（Z 向上）。
    glTF 导出会自动转成 Y-up，因此 web 里瓦片躺在 XZ 平面、高度在 Y。

输出：web/assets/roads/mod_<name>.glb

用法： blender.exe -b --python tools/blender_export_roads.py
"""
import json
import os

import bpy
from mathutils import Vector

ROOT = r"D:/Users/asus/Desktop/项目"
SRC = os.path.join(ROOT, "data/characters/street  FBX-20261102T114253Z-1-001/FBX")
DST = os.path.join(ROOT, "web/assets/roads")

ROAD_MODS = [
    "Street_Straight", "Street_Curve", "Street_3Way", "Street_3Way_2",
    "Street_4Way", "Street_4Way_2", "Street_Deadend", "Street_Empty",
]
PROP_MODS = [
    "Streetlight_Single", "Streetlight_Double", "Streetlight_Triple",
    "TrafficLight", "TrafficLight_2", "Sign_Stop", "Sign_NoParking",
]

os.makedirs(DST, exist_ok=True)


def export_one(name):
    src = os.path.join(SRC, name + ".fbx")
    if not os.path.exists(src):
        print("[roads] MISSING", name)
        return None
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=src)

    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    if not meshes:
        print("[roads] NO MESH", name)
        return None

    info = []
    for o in meshes:
        bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
        xs = [v.x for v in bb]; ys = [v.y for v in bb]; zs = [v.z for v in bb]
        info.append({
            "name": o.name,
            "size": [round(max(xs) - min(xs), 3), round(max(ys) - min(ys), 3), round(max(zs) - min(zs), 3)],
            "lo": [round(min(xs), 3), round(min(ys), 3), round(min(zs), 3)],
            "mats": [m.name if m else "" for m in o.data.materials],
            "v": len(o.data.vertices),
        })
        # 顶点色/材质兜底：FBX 常带一个没贴图的默认材质，保证 glb 里不是纯黑
        for m in o.data.materials:
            if m and m.use_nodes:
                bsdf = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
                if bsdf:
                    col = bsdf.inputs.get('Base Color')
                    if col and not col.is_linked:
                        c = list(col.default_value)
                        if max(c[:3]) < 0.06:
                            col.default_value = (0.42, 0.43, 0.44, 1.0)

    out = os.path.join(DST, "mod_" + name + ".glb")
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB', use_selection=False,
        export_apply=True, export_yup=True, export_materials='EXPORT',
        export_cameras=False, export_lights=False,
    )
    print("[roads] " + json.dumps({
        "name": name, "out": os.path.basename(out),
        "bytes": os.path.getsize(out), "meshes": info,
    }, ensure_ascii=False))
    return out


for n in ROAD_MODS + PROP_MODS:
    try:
        export_one(n)
    except Exception as e:
        print("[roads] ERR", n, e)
