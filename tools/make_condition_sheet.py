# -*- coding: utf-8 -*-
r"""把两个机位 x 四种图拼成一张带标签的总览图。

用法:
    python tools\make_condition_sheet.py <输出.png> <输入目录>
输出:
    <输出.png>  —— 2 行（机位）x 4 列（基座渲染 / 深度 / 法线 / 语义分割）
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

CELL_W, CELL_H = 620, 388
LABEL_H = 42
PAD = 14
TOP = 46
ROWS = [("street", "机位 A：连排屋街区（邵区，低空斜视 70 m）"),
        ("mall", "机位 B：国家广场中轴（低空 120 m）")]
COLS = [("beauty", "① 基座渲染"), ("depth", "② 深度图"), ("normal", "③ 法线图"),
        ("semantic", "④ 语义分割")]


def font(size):
    for p in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf"):
        if os.path.isfile(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def main(out, indir):
    w = PAD + len(COLS) * (CELL_W + PAD)
    h = TOP + len(ROWS) * (CELL_H + LABEL_H + PAD) + PAD
    sheet = Image.new("RGB", (w, h), (250, 250, 250))
    d = ImageDraw.Draw(sheet)
    d.text((PAD, 12), "华盛顿城市基座 —— 大模型渲染条件图（同一机位、同一分辨率 1920x1200）",
           font=font(22), fill=(20, 20, 20))

    for r, (key, title) in enumerate(ROWS):
        y0 = TOP + r * (CELL_H + LABEL_H + PAD)
        d.text((PAD, y0), title, font=font(18), fill=(30, 30, 120))
        y = y0 + LABEL_H - 12
        for c, (suffix, label) in enumerate(COLS):
            x = PAD + c * (CELL_W + PAD)
            p = os.path.join(indir, "cond_%s_%s.png" % (key, suffix))
            if not os.path.isfile(p):
                d.rectangle([x, y, x + CELL_W, y + CELL_H], fill=(230, 230, 230), outline=(180, 180, 180))
                d.text((x + 10, y + 10), "缺图 %s" % p, font=font(14), fill=(200, 0, 0))
                continue
            im = Image.open(p).convert("RGB")
            im.thumbnail((CELL_W, CELL_H), Image.LANCZOS)
            ox = x + (CELL_W - im.width) // 2
            oy = y + (CELL_H - im.height) // 2
            d.rectangle([x, y, x + CELL_W, y + CELL_H], outline=(190, 190, 190))
            sheet.paste(im, (ox, oy))
            d.rectangle([x, y + CELL_H - 26, x + 190, y + CELL_H], fill=(255, 255, 255))
            d.text((x + 6, y + CELL_H - 24), label, font=font(17), fill=(0, 0, 0))

    sheet.save(out)
    print("写出 %s  (%d x %d, %d 字节)" % (out, sheet.width, sheet.height, os.path.getsize(out)))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "out/conditions")
