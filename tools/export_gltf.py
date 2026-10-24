# -*- coding: utf-8 -*-
"""导出 glTF(.glb) 并渲染一张预览图。"""
import bpy, os, math
from mathutils import Vector

SRC = r"D:\Users\asus\Desktop\项目\out\manhattan_250m_solid.blend"
OUT = r"D:\Users\asus\Desktop\项目\out\manhattan_250m.glb"
PNG = r"D:\Users\asus\Desktop\项目\out\manhattan_250m_预览.png"

bpy.ops.wm.open_mainfile(filepath=SRC)

# ---------- 1. 导出 glTF ----------
try:
    bpy.ops.preferences.addon_enable(module="io_scene_gltf2")
except Exception as e:
    print("addon_enable:", e)

bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    use_selection=False,
    export_apply=True,
    export_yup=True,
    export_cameras=False,
    export_lights=False,
)
print("GLB 已导出: %s  (%d 字节)" % (OUT, os.path.getsize(OUT)))

# ---------- 2. 渲染预览图 ----------
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
xs, ys, zs = [], [], []
for o in meshes:
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        xs.append(w.x); ys.append(w.y); zs.append(w.z)
cx, cy = (min(xs)+max(xs))/2, (min(ys)+max(ys))/2
sx, sy, sz = max(xs)-min(xs), max(ys)-min(ys), max(zs)-min(zs)
print("场景包围盒: X=%.1f Y=%.1f Z=%.1f" % (sx, sy, sz))

cam_data = bpy.data.cameras.new("PreviewCam")
cam = bpy.data.objects.new("PreviewCam", cam_data)
bpy.context.scene.collection.objects.link(cam)
cam.location = (cx - sx*0.75, cy - sy*0.95, min(zs) + sz*1.15)
cam.rotation_euler = (math.radians(58), 0, math.radians(-38))
cam_data.lens = 32

scene = bpy.context.scene
scene.camera = cam
scene.render.engine = "BLENDER_WORKBENCH"
scene.render.resolution_x = 1600
scene.render.resolution_y = 1000
scene.render.resolution_percentage = 100
scene.render.film_transparent = False
sh = scene.display.shading
sh.light = "STUDIO"
sh.color_type = "MATERIAL"
sh.show_shadows = True
sh.show_cavity = True
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = PNG
bpy.ops.render.render(write_still=True)
print("预览图:", PNG, os.path.getsize(PNG), "字节")
