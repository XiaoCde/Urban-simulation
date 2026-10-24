# -*- coding: utf-8 -*-
r"""第 0 档：街面近景对照图（1.70 m 人眼高，lens 35）。

左 = 只有贴图（dc_real3_tex2.blend），右 = 贴图 + ① 的 DC 连排屋特征 + 修过的地面
（dc_real3_dc2.blend）。两个 blend 的路网完全一样，所以 render_street_level.py
按同一个 lon/lat 找出来的机位也完全一样 —— 这是能对照的前提。

用法: python tools\make_close_sheet.py <输出.png>
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

WS = r"D:\Users\asus\Desktop\项目"
CELL_W, CELL_H = 780, 488
PAD = 16
TOP = 78
ROWS = [
    ("街面正视 · 街北侧立面（人眼 1.70 m，lens 35）", "vc_front_p1.png"),
    ("街面正视 · 街南侧立面（人眼 1.70 m，lens 35）", "vc_front_n1.png"),
    ("沿街纵深（人眼 1.70 m，lens 35）", "vc_along.png"),
]


def font(size):
    for p in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf"):
        if os.path.isfile(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def cell(sheet, d, x, y, path, lab):
    if not os.path.isfile(path):
        d.rectangle([x, y, x + CELL_W, y + CELL_H], fill=(235, 235, 235), outline=(180, 180, 180))
        d.text((x + 10, y + 10), "缺图: " + os.path.basename(path), font=font(14), fill=(190, 0, 0))
        return
    im = Image.open(path).convert("RGB")
    im.thumbnail((CELL_W, CELL_H), Image.LANCZOS)
    d.rectangle([x, y, x + CELL_W, y + CELL_H], outline=(185, 185, 185))
    sheet.paste(im, (x + (CELL_W - im.width) // 2, y + (CELL_H - im.height) // 2))
    tw = d.textlength(lab, font=font(17))
    d.rectangle([x, y, x + tw + 16, y + 28], fill=(255, 255, 255))
    d.text((x + 8, y + 4), lab, font=font(17), fill=(0, 0, 0))


def main(out):
    w = PAD + 2 * (CELL_W + PAD)
    h = TOP + len(ROWS) * (CELL_H + 62) + PAD
    sheet = Image.new("RGB", (w, h), (248, 248, 248))
    d = ImageDraw.Draw(sheet)
    d.text((PAD, 12), "第 0 档 · 华盛顿连排屋特征 —— 街面近景（人眼视角 1.70 m）",
           font=font(26), fill=(15, 15, 15))
    d.text((PAD, 48), "左：只有贴图   |   右：贴图 + ① 的凸窗 / 檐口 / 门廊台阶 + 修过的地面"
                      "（同一机位，由同一个 lon/lat 算出）",
           font=font(16), fill=(95, 95, 95))

    for r, (title, name) in enumerate(ROWS):
        y0 = TOP + r * (CELL_H + 62)
        d.text((PAD, y0), title, font=font(19), fill=(20, 20, 120))
        y = y0 + 30
        cell(sheet, d, PAD, y, os.path.join(WS, "out", "close_before", name), "只有贴图")
        cell(sheet, d, PAD + CELL_W + PAD, y, os.path.join(WS, "out", "close_after", name),
             "贴图 + ① 特征")

    sheet.save(out)
    print("写出 %s (%dx%d, %d KB)" % (out, sheet.width, sheet.height, os.path.getsize(out) // 1024))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(WS, "out", "第0档-街面近景.png"))
