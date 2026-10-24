# -*- coding: utf-8 -*-
"""拼左右对比图（中文标题），用 PIL。

用法:
    python make_compare.py <左图> <左标题> <右图> <右标题> <输出>

标题用微软雅黑；底部再加一行小字说明。
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

FONT = "C:/Windows/Fonts/msyh.ttc"
FONT_B = "C:/Windows/Fonts/msyhbd.ttc"
BAR_H = 56
SUB_H = 34


def font(size, bold=False):
    for p in ([FONT_B, FONT] if bold else [FONT]):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def main():
    a, ta, b, tb, out = sys.argv[1:6]
    sub = sys.argv[6] if len(sys.argv) > 6 else ""
    ia, ib = Image.open(a).convert("RGB"), Image.open(b).convert("RGB")
    h = min(ia.height, ib.height)
    ia = ia.resize((int(ia.width * h / ia.height), h), Image.LANCZOS)
    ib = ib.resize((int(ib.width * h / ib.height), h), Image.LANCZOS)

    W = ia.width + ib.width
    H = h + BAR_H + (SUB_H if sub else 0)
    canvas = Image.new("RGB", (W, H), (24, 24, 26))
    d = ImageDraw.Draw(canvas)

    canvas.paste(ia, (0, BAR_H))
    canvas.paste(ib, (ia.width, BAR_H))

    f = font(28, bold=True)
    d.text((16, 12), ta, fill=(255, 255, 255), font=f)
    d.text((ia.width + 16, 12), tb, fill=(120, 220, 160), font=f)
    d.line([(ia.width, 0), (ia.width, H)], fill=(90, 90, 95), width=2)

    if sub:
        d.text((16, BAR_H + h + 6), sub, fill=(190, 190, 195), font=font(20))

    out = os.path.abspath(out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    canvas.save(out, quality=92)
    print("→ %s  %d 字节  %dx%d" % (out, os.path.getsize(out), canvas.width, canvas.height))


main()
