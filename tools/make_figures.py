# -*- coding: utf-8 -*-
r"""把渲染图整理成组会汇报要用的插图。

产出（都写到 out\报告图\）：
    fig1_连排屋对比.png   左=补真实数据之前  右=补真实数据之后（同一机位、同一配色）
    fig2_全城.png         之后的全城鸟瞰
    fig3_全城对比.png     全城视角的前后对照

用法：
    <python> tools\make_figures.py
"""
import os

from PIL import Image, ImageDraw, ImageFont

OUT = r"D:\Users\asus\Desktop\项目\out"
FIG = os.path.join(OUT, "报告图")

PAIRS = {
    "fig1_连排屋对比.png": (
        os.path.join(OUT, "before_rowhouse_shaw.png"),
        os.path.join(OUT, "dc_real3_连排屋_shaw.png"),
        "补真实数据之前：整片连排屋全是等高的平顶盒子",
        "补真实数据之后：锯齿状的真实坡屋顶",
    ),
    "fig3_全城对比.png": (
        os.path.join(OUT, "dc_downtown_v3_全景.png"),
        os.path.join(OUT, "dc_real3_全景.png"),
        "补真实数据之前的全城",
        "补真实数据之后的全城",
    ),
}

WHOLE = os.path.join(OUT, "dc_real3_全景.png")

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]


def font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def shrink(src, dst, width, quality=90):
    im = Image.open(src).convert("RGB")
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    im.save(dst, quality=quality)
    print("%-40s %4d x %4d  %5d KB" % (os.path.basename(dst), im.width, im.height,
                                       os.path.getsize(dst) // 1024))


def side_by_side(left_path, right_path, dst, titles, panel_w=1180, title_h=58, fs=30):
    a = Image.open(left_path).convert("RGB")
    b = Image.open(right_path).convert("RGB")
    h = round(a.height * panel_w / a.width)
    a = a.resize((panel_w, h), Image.LANCZOS)
    b = b.resize((panel_w, h), Image.LANCZOS)

    gap = 14
    canvas = Image.new("RGB", (panel_w * 2 + gap, h + title_h), (255, 255, 255))
    canvas.paste(a, (0, title_h))
    canvas.paste(b, (panel_w + gap, title_h))

    d = ImageDraw.Draw(canvas)
    f = font(fs)
    for i, text in enumerate(titles):
        x = i * (panel_w + gap)
        d.text((x + (panel_w - d.textlength(text, font=f)) / 2, 12), text,
               font=f, fill=(25, 25, 25))
    for i in (0, 1):
        x = i * (panel_w + gap)
        d.rectangle([x, title_h, x + panel_w - 1, title_h + h - 1], outline=(140, 140, 140))
    canvas.save(dst, quality=90)
    print("%-40s %4d x %4d  %5d KB" % (os.path.basename(dst), canvas.width, canvas.height,
                                       os.path.getsize(dst) // 1024))


if __name__ == "__main__":
    os.makedirs(FIG, exist_ok=True)
    for name, (l, r, tl, tr) in PAIRS.items():
        side_by_side(l, r, os.path.join(FIG, name), (tl, tr))
    shrink(WHOLE, os.path.join(FIG, "fig2_全城.png"), 1700)
