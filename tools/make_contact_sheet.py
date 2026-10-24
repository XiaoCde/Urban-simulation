# -*- coding: utf-8 -*-
r"""把一组渲染图拼成联系表（contact sheet），方便一眼比较构图好坏。

用法：
    <python> tools\make_contact_sheet.py <输出.png> <图1> <图2> ...
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONTS = [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf"]


def font(size):
    for p in FONTS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def main():
    dst = sys.argv[1]
    srcs = sys.argv[2:]
    cols = 3
    cell = 740
    rows = (len(srcs) + cols - 1) // cols
    label_h = 34
    f = font(24)

    # 先按第一张的宽高比定单元格高度
    im0 = Image.open(srcs[0])
    cell_h = round(cell * im0.height / im0.width)

    sheet = Image.new("RGB", (cell * cols, (cell_h + label_h) * rows), (250, 250, 250))
    d = ImageDraw.Draw(sheet)
    for i, p in enumerate(srcs):
        im = Image.open(p).convert("RGB")
        im = im.resize((cell, cell_h), Image.LANCZOS)
        cx = (i % cols) * cell
        cy = (i // cols) * (cell_h + label_h)
        sheet.paste(im, (cx, cy + label_h))
        name = os.path.splitext(os.path.basename(p))[0]
        name = name.split("_", 1)[-1] if "_" in name else name
        d.text((cx + 10, cy + 6), "%d  %s" % (i + 1, name), font=f, fill=(20, 20, 20))
        d.rectangle([cx, cy + label_h, cx + cell - 1, cy + label_h + cell_h - 1],
                    outline=(150, 150, 150))
    sheet.save(dst, quality=88)
    print("%s  %d x %d  %d KB" % (dst, sheet.width, sheet.height,
                                  os.path.getsize(dst) // 1024))


main()
