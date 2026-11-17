"""
view_sw2d.py — 把 shallow2d 的峰值场出成图（无需 matplotlib）

用法：
    python tools/flood/view_sw2d.py data/flood/sw2d_p110/state.npz out/sw2d_peak.png
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def shade(z, lo=None, hi=None):
    """地形晕渲：灰度 + 简易山体阴影。"""
    z = z.astype("float32")
    lo = float(np.percentile(z, 1)) if lo is None else lo
    hi = float(np.percentile(z, 99)) if hi is None else hi
    a = np.clip((z - lo) / max(hi - lo, 1e-6), 0, 1)
    g = (150 + a * 85).astype("uint8")
    # 山体阴影（西北光）
    gy, gx = np.gradient(z)
    lit = np.clip(1.0 - 0.55 * (gx - gy) / 3.0, 0.55, 1.35)
    g = np.clip(g * lit, 40, 250).astype("uint8")
    return np.dstack([g, g, g])


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "data/flood/sw2d_p110/state.npz")
    dst = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "out/sw2d_peak.png")
    os.makedirs(os.path.dirname(dst), exist_ok=True)

    d = np.load(src)
    h = d["h"].astype("float32")
    z = d["z"]
    zmod = d["zmod"] if "zmod" in d else z
    street = d["street"]
    bld = d["bld"]
    res = int(d["res"])

    img = shade(z)
    # 建筑：淡灰蓝
    img[bld] = (img[bld] * 0.45 + np.array([190, 195, 205]) * 0.55).astype("uint8")
    # 街道：浅暖灰
    img[street & ~bld] = (img[street & ~bld] * 0.7 + np.array([235, 232, 226]) * 0.3).astype("uint8")

    # 水深：4 段色阶（薄水淡青 → 深水靛蓝）
    lev = [(0.01, (168, 205, 224)), (0.15, (104, 165, 208)),
           (0.40, (54, 110, 178)), (1.00, (22, 48, 120)), (99, (10, 16, 60))]
    wet = h > 0.01
    a = h.copy()
    for th, col in lev:
        m = wet & (a <= th)
        if m.any():
            img[m] = col
        a = np.where(m, 0, a)
    # 深水再加一点不透明
    deep = h > 1.0
    img[deep] = (32, 40, 110)

    im = Image.fromarray(img)
    # 放大 0.58 以便查看
    im = im.resize((int(im.width * 0.58), int(im.height * 0.58)), Image.NEAREST)

    dr = ImageDraw.Draw(im)
    n = int((h > 0.01).sum())
    area = n * res * res / 1e4
    txt = [f"sw2d peak depth  res={res} m   wet={area:.0f} ha   max={h.max():.2f} m",
           "blue = ponded water (inertial shallow-water kernel)"]
    for k, t in enumerate(txt):
        dr.rectangle([8, 8 + k * 16, 8 + 7 * len(t), 22 + k * 16], fill=(255, 255, 255))
        dr.text((12, 11 + k * 16), t, fill=(20, 20, 20))
    im.save(dst)
    print(dst, im.size)

    # 简单的连通块统计（4 邻域，按格计）
    for th in (0.01, 0.05, 0.15, 0.30):
        m = h > th
        print(f"  >{th*100:4.1f} cm : {m.sum()*res*res/1e4:8.1f} ha")


if __name__ == "__main__":
    main()
