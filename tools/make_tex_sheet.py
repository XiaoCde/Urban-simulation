# -*- coding: utf-8 -*-
r"""贴图前后对照图：左=原来的纯灰模型，右=贴了现成纹理之后。

用法: python tools\make_tex_sheet.py <输出.png>
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

WS = r"D:\Users\asus\Desktop\项目"
CELL_W, CELL_H = 700, 438
PAD = 16
TOP = 74
ROWS = [
    ("机位 A  连排屋街区（邵区，70 m 斜视）",
     os.path.join(WS, "out", "conditions", "cond_street_beauty.png"),
     os.path.join(WS, "out", "tex_street.png")),
    ("机位 B2  国家广场高斜视（380 m，西南望东北）",
     os.path.join(WS, "out", "conditions", "cond_mall2_beauty.png"),
     os.path.join(WS, "out", "tex_mall2.png")),
    ("机位 B3  国会山斜视（330 m，密集城区）",
     os.path.join(WS, "out", "conditions", "cond_mall3_beauty.png"),
     os.path.join(WS, "out", "tex_mall3.png")),
]


def font(size):
    for p in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf"):
        if os.path.isfile(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def main(out):
    w = PAD + 2 * (CELL_W + PAD)
    h = TOP + len(ROWS) * (CELL_H + 62) + PAD
    sheet = Image.new("RGB", (w, h), (248, 248, 248))
    d = ImageDraw.Draw(sheet)
    d.text((PAD, 12), "华盛顿城市基座 —— 直接贴现成的纹理贴图（ambientCG，全部 CC0 公有领域）",
           font=font(25), fill=(15, 15, 15))
    d.text((PAD, 46), "不做实时渲染、不走大模型，按导师指示\"找现成的贴图直接用\"；39 个材质包，按建筑高度自动分配",
           font=font(16), fill=(95, 95, 95))

    for r, (title, before, after) in enumerate(ROWS):
        y0 = TOP + r * (CELL_H + 62)
        d.text((PAD, y0), title, font=font(19), fill=(20, 20, 120))
        y = y0 + 28
        for c, (p, lab) in enumerate([(before, "贴图前（纯灰基座）"), (after, "贴图后（现成纹理）")]):
            x = PAD + c * (CELL_W + PAD)
            if not os.path.isfile(p):
                d.rectangle([x, y, x + CELL_W, y + CELL_H], fill=(235, 235, 235), outline=(180, 180, 180))
                d.text((x + 10, y + 10), "缺图: " + os.path.basename(p), font=font(14), fill=(190, 0, 0))
                continue
            im = Image.open(p).convert("RGB")
            im.thumbnail((CELL_W, CELL_H), Image.LANCZOS)
            d.rectangle([x, y, x + CELL_W, y + CELL_H], outline=(185, 185, 185))
            sheet.paste(im, (x + (CELL_W - im.width) // 2, y + (CELL_H - im.height) // 2))
            d.rectangle([x, y, x + 210, y + 26], fill=(255, 255, 255))
            d.text((x + 7, y + 4), lab, font=font(17), fill=(0, 0, 0))

    sheet.save(out)
    print("写出 %s (%dx%d, %d KB)" % (out, sheet.width, sheet.height, os.path.getsize(out) // 1024))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(WS, "out", "贴图对照.png"))
