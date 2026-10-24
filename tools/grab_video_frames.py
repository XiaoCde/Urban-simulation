# -*- coding: utf-8 -*-
r"""从渲染出来的 mp4 里抽帧 —— 用来验收**成片本身**，而不是验收渲染脚本。

为什么要绕这一下：
    渲染进程 exit 0 只说明"文件写出来了"，不说明"画面对"。
    看日志收工是典型的自嗨闭环。这里的做法是把交付物重新打开、抽帧看一眼。
    系统里没有 ffmpeg，但 blender 自带 ffmpeg（这段 H.264 就是它编的），
    所以用 VSE 把 mp4 当素材载进来、定位到指定帧、渲成 PNG。

用法:
    blender --background --python tools\grab_video_frames.py -- <mp4> <出目录> [帧号...]
"""
import os
import sys

import bpy

argv = sys.argv
argv = argv[argv.index("--") + 1:] if "--" in argv else []
if len(argv) < 2:
    print(__doc__)
    sys.exit(1)
mp4 = os.path.abspath(argv[0])
outdir = os.path.abspath(argv[1])
frames = [int(x) for x in argv[2:]] or [1, 30, 60, 90, 120]

if not os.path.exists(mp4):
    raise SystemExit("找不到 mp4：%s" % mp4)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.sequence_editor_create()
se = scene.sequence_editor
# Blender 4.4 起 sequence_editor.sequences 改名成 strips，两套都兼容
coll = getattr(se, "strips", None)
if coll is None:
    coll = se.sequences
try:
    strip = coll.new_movie(name="v", filepath=mp4, channel=1, frame_start=1)
except TypeError:
    strip = coll.new_movie("v", mp4, 1, 1)

el = strip.elements[0]
n = int(strip.frame_final_duration)
print("[grab] 载入 %s" % mp4)
print("[grab] 素材尺寸 %dx%d  总帧数 %d  帧率 %.3f"
      % (el.orig_width, el.orig_height, n, scene.render.fps))

scene.render.resolution_x = el.orig_width
scene.render.resolution_y = el.orig_height
scene.render.resolution_percentage = 100
scene.render.film_transparent = False
scene.view_settings.view_transform = "Standard"
if hasattr(scene.render, "use_sequencer"):
    scene.render.use_sequencer = True
if hasattr(scene.render.image_settings, "media_type"):
    scene.render.image_settings.media_type = "IMAGE"
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGB"
try:
    scene.render.engine = "BLENDER_EEVEE_NEXT"
except TypeError:
    scene.render.engine = "BLENDER_EEVEE"

os.makedirs(outdir, exist_ok=True)
for f in frames:
    if f < 1 or f > n:
        print("[grab] 跳过越界帧 %d（总 %d 帧）" % (f, n))
        continue
    scene.frame_set(f)
    scene.render.filepath = os.path.join(outdir, "v%04d.png" % f)
    bpy.ops.render.render(write_still=True)
    print("[grab] 已抽帧 %d -> %s" % (f, scene.render.filepath))
print("[grab] 抽帧完成")
