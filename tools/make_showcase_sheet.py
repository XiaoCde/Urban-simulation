# -*- coding: utf-8 -*-
r"""把 out\showcase\ 里的 8 张展示图拼成一张 4x2 的总览图（含中文标题）。

用法: python tools\make_showcase_sheet.py <图片目录> <输出.png>
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = r"C:\Windows\Fonts\msyh.ttc"

# 顺序即展示顺序：先地标/城市级，再街区级，最后人眼街面
ITEMS = [
    ("01_全城鸟瞰.png",        "① 全城鸟瞰  西南 1800 m 高空，一眼看完整座华盛顿中心城区"),
    ("02_国家广场.png",        "② 国家广场  西南 380 m 斜视：纪念碑在近、国会山在远"),
    ("03_国会山.png",          "③ 国会山    330 m 斜视，以国会大厦为主的密集城区"),
    ("04_正俯视总平面.png",     "④ 正俯视总平面 900 m 垂直向下：街道网与建筑轮廓清清楚楚"),
    ("05_连排屋街区.png",      "⑤ 连排屋街区 邵区 70 m 低空：DCGIS 补出来的锯齿状坡屋面"),
    ("street_adamsmorgan.png", "⑥ 亚当斯摩根 18th St 人眼高度 1.70 m，镜头 35 mm"),
    ("street_shaw.png",        "⑦ 邵区街道  人眼高度 1.70 m，镜头 35 mm"),
    ("street_capitolhill.png", "⑧ 国会山街道 人眼高度 1.70 m，镜头 35 mm"),
]

CELL = (900, 563)          # 每格宽高（原图 1600x1000，按 9:5.63 缩放）
PAD = 14
BAR = 46


def main(srcdir, outpath):
    srcdir = os.path.abspath(srcdir)
    cols, rows = 4, 2
    fnt = ImageFont.truetype(FONT, 23)
    fnt2 = ImageFont.truetype(FONT, 34)

    head = 62
    W = cols * CELL[0] + (cols + 1) * PAD
    H = head + rows * (CELL[1] + BAR) + (rows - 1) * PAD + PAD
    sheet = Image.new("RGB", (W, H), (24, 26, 30))
    d = ImageDraw.Draw(sheet)
    d.text((PAD, 14), "城市仿真基座 · 华盛顿 DC", font=fnt2, fill=(240, 242, 246))

    for i, (fn, label) in enumerate(ITEMS):
        p = os.path.join(srcdir, fn)
        if not os.path.exists(p):
            print("[sheet] 缺图：%s" % p)
            continue
        im = Image.open(p).convert("RGB").resize(CELL, Image.LANCZOS)
        c, r = i % cols, i // cols
        x = PAD + c * (CELL[0] + PAD)
        y = head + r * (CELL[1] + BAR + PAD)
        sheet.paste(im, (x, y))
        d.rectangle([x - 1, y - 1, x + CELL[0], y + CELL[1]], outline=(70, 76, 86), width=1)
        d.text((x + 2, y + CELL[1] + 8), label, font=fnt, fill=(214, 219, 228))

    sheet.save(outpath)
    print("[sheet] 已保存 %s（%dx%d）" % (outpath, sheet.size[0], sheet.size[1]))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
