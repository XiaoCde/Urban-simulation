# -*- coding: utf-8 -*-
r"""通用拼图：把若干张图按指定列数拼成一张带中文标题的总览图。

用法:
    python tools\make_grid_sheet.py <出图.png> <列数> <标题> <图1>|<标签1> <图2>|<标签2> ...
例:
    python tools\make_grid_sheet.py out\wh.png 2 "白宫" out\whitehouse\A.png|北立面 out\whitehouse\B.png|正俯视
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = r"C:\Windows\Fonts\msyh.ttc"


def main(outpath, cols, title, items):
    cols = int(cols)
    rows = (len(items) + cols - 1) // cols

    CELL = (900, 563)   # 原图 1600x1000 -> 9:5.63
    PAD, BAR, HEAD = 14, 46, 62
    W = cols * CELL[0] + (cols + 1) * PAD
    H = HEAD + rows * (CELL[1] + BAR) + (rows - 1) * PAD + PAD

    sheet = Image.new("RGB", (W, H), (24, 26, 30))
    d = ImageDraw.Draw(sheet)
    fnt = ImageFont.truetype(FONT, 23)
    fnt2 = ImageFont.truetype(FONT, 34)
    d.text((PAD, 14), title, font=fnt2, fill=(240, 242, 246))

    for i, it in enumerate(items):
        path, _, label = it.partition("|")
        path = os.path.abspath(path)
        if not os.path.exists(path):
            print("[grid] 缺图：%s" % path)
            continue
        im = Image.open(path).convert("RGB").resize(CELL, Image.LANCZOS)
        c, r = i % cols, i // cols
        x = PAD + c * (CELL[0] + PAD)
        y = HEAD + r * (CELL[1] + BAR + PAD)
        sheet.paste(im, (x, y))
        d.rectangle([x - 1, y - 1, x + CELL[0], y + CELL[1]], outline=(70, 76, 86), width=1)
        d.text((x + 2, y + CELL[1] + 8), label, font=fnt, fill=(214, 219, 228))

    sheet.save(outpath)
    print("[grid] 已保存 %s（%dx%d）" % (outpath, sheet.size[0], sheet.size[1]))


if __name__ == "__main__":
    if len(sys.argv) < 5:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:])
