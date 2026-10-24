# -*- coding: utf-8 -*-
r"""把「基座渲染 / 深度条件图 / ControlNet 生成图」拼成对照图。

这张图要说明的事只有一件：
    左列是我们的几何（对的、但很假），中列是喂给生成模型的深度图，
    右列是生成结果 —— 右列**长得像真照片，但几何还是我们那份**。
三行的差别只在**机位**，用来证明：条件图的质量取决于机位，
画面里几何结构越多，生成越准。

用法:
    python tools\make_gen_sheet.py <输出.png>
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

WS = r"D:\Users\asus\Desktop\项目"
CELL_W, CELL_H = 620, 388
PAD = 14
TOP = 68
COND = os.path.join(WS, "out", "conditions")
GEN = os.path.join(WS, "out", "gen")

ROWS = [
    ("连排屋街区（机位 A，70 m）", "cond_street_beauty.png", "cond_street_depth.png",
     os.path.join(GEN, "gen_street_v1.png"),
     "满画面房子和屋脊 -> 成功"),
    ("国家广场 旧机位（120 m 低空顺着草坪看）", "cond_mall_beauty.png", "cond_mall_depth.png",
     os.path.join(GEN, "gen_mall_v3.png"),
     "深度图没结构 -> 模型只能编（先编成水面，加约束后编成农田）"),
    ("国家广场 新机位（380 m 高斜视）", "cond_mall2_beauty.png", "cond_mall2_depth.png",
     os.path.join(GEN, "gen_mall2_v1.png"),
     "深度图全是街区结构 -> 认出来了：纪念碑、林肯堂、林荫大道、联邦大楼"),
]
COLS = ["① 我们的基座渲染（几何对、长相假）", "② 喂进去的深度条件图", "③ ControlNet 生成结果（像真照片）"]


def font(size):
    for p in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf"):
        if os.path.isfile(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def main(out):
    w = PAD + 3 * (CELL_W + PAD)
    h = TOP + len(ROWS) * (CELL_H + 72) + PAD
    sheet = Image.new("RGB", (w, h), (250, 250, 250))
    d = ImageDraw.Draw(sheet)
    d.text((PAD, 12), "华盛顿城市基座 + 本机 ControlNet —— 几何是我们的，长相是生成模型补的",
           font=font(24), fill=(15, 15, 15))
    d.text((PAD, 42), "同机位、同分辨率；深度图锁死几何，生成模型只能改表面。三行只差机位："
                      "画面里几何结构越多，生成越准",
           font=font(16), fill=(90, 90, 90))

    for r, (title, base, depth, gen, note) in enumerate(ROWS):
        y0 = TOP + r * (CELL_H + 72)
        d.text((PAD, y0), "%s   —— %s" % (title, note), font=font(19), fill=(20, 20, 120))
        y = y0 + 30
        for c, p in enumerate([os.path.join(COND, base), os.path.join(COND, depth), gen]):
            x = PAD + c * (CELL_W + PAD)
            if not os.path.isfile(p):
                d.rectangle([x, y, x + CELL_W, y + CELL_H], fill=(235, 235, 235), outline=(180, 180, 180))
                d.text((x + 10, y + 10), "缺图: %s" % os.path.basename(p), font=font(14), fill=(190, 0, 0))
                continue
            im = Image.open(p).convert("RGB")
            im.thumbnail((CELL_W, CELL_H), Image.LANCZOS)
            d.rectangle([x, y, x + CELL_W, y + CELL_H], outline=(185, 185, 185))
            sheet.paste(im, (x + (CELL_W - im.width) // 2, y + (CELL_H - im.height) // 2))
            d.rectangle([x, y, x + CELL_W, y + 25], fill=(255, 255, 255))
            d.text((x + 6, y + 4), COLS[c], font=font(16), fill=(0, 0, 0))

    sheet.save(out)
    print("写出 %s  (%d x %d, %d KB)" % (out, sheet.width, sheet.height, os.path.getsize(out) // 1024))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(GEN, "对照图.png"))
