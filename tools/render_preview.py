# -*- coding: utf-8 -*-
"""重新渲染两张预览图：3/4 透视 + 正俯视。"""
import bpy, os, math
from mathutils import Vector

SRC = r"D:\Users\asus\Desktop\项目\out\manhattan_250m_solid.blend"
bpy.ops.wm.open_mainfile(filepath=SRC)

meshes = [o for o in bpy.data.objects if o.type == "MESH"]
xs, ys, zs = [], [], []
for o in meshes:
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        xs.append(w.x); ys.append(w.y); zs.append(w.z)
lo = Vector((min(xs), min(ys), min(zs)))
hi = Vector((max(xs), max(ys), max(zs)))
center = (lo + hi) / 2
R = ((hi - lo) / 2).length
print("包围盒: %s ~ %s  R=%.1f" % (tuple(round(v,1) for v in lo), tuple(round(v,1) for v in hi), R))

scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.render.resolution_x = 1600
scene.render.resolution_y = 1000
sh = scene.display.shading
sh.light = "STUDIO"
sh.color_type = "MATERIAL"
sh.show_shadows = True
sh.show_cavity = True
sh.show_object_outline = False

cam_data = bpy.data.cameras.new("PreviewCam")
cam_data.lens = 35
cam = bpy.data.objects.new("PreviewCam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

fov = 2 * math.atan(18.0 / cam_data.lens)          # 半角（36mm 全幅）

def shoot(direction, name, extra=1.12):
    d = Vector(direction).normalized()
    dist = R / math.sin(fov / 2) * extra
    cam.location = center + d * dist
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    out = r"D:\Users\asus\Desktop\项目\out\%s" % name
    scene.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print("渲染:", out, os.path.getsize(out), "字节")

shoot((-0.75, -1.0, 0.60), "manhattan_250m_预览.png")
shoot((-0.02, -0.02, 1.00), "manhattan_250m_俯视图.png")
