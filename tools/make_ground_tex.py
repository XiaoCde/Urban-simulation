# -*- coding: utf-8 -*-
r"""生成一张"中性灰的路面"贴图，专门给全城地面基底用。

**为什么要自己生成，而不是从 ambientCG 挑一张**：
    1. 我们下载的现成铺装贴图（Concrete047A 等）平均色都是**暖黄**（144,135,115），
       铺满 30.6 km^2 的整城地面时，从 400 m 高空看就是一片**沙漠**。
    2. 在 Blender 里插 HueSaturation 去饱和可以救 .blend，但 **glTF 不支持这个节点**，
       导出的 .glb 又变回土黄 —— 实测两版渲染图对比确认过。
    所以正确做法是**把"灰色"直接烘进贴图文件本身**，这样 .blend 和 .glb 完全一致。

**生成的内容**：中性灰底 + 8x8 块板缝（1024 / 8 = 128 px 整除，所以四方连续无缝）
                 + 每块轻微色差 + 细噪点（避免大面积纯色的"塑料感"）。

用法:
    <dsh python> tools\make_ground_tex.py [输出路径.jpg]
    默认输出 D:\citysim\textures\_generated\pavement_gray_1k.jpg
"""
import os
import sys

import numpy as np
from PIL import Image

W = 1024
SLAB = 256          # 每块板 256 px；1024/256 = 4，整除 => 无缝；配 tile 3 m -> 每块 0.75 m
GROUT = 3           # 板缝宽（px）
BASE = 118          # 中性灰基准（0-255）
JITTER = 6          # 每块板的色差幅度
NOISE = 5           # 细噪点幅度

DEFAULT_OUT = r"D:\citysim\textures\_generated\pavement_gray_1k.jpg"


def main():
    out = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    rng = np.random.default_rng(20261018)

    v = np.full((W, W), float(BASE))

    # 每块板一个轻微色差（逐板常数，所以不会破坏无缝性）
    n = W // SLAB
    for iy in range(n):
        for ix in range(n):
            v[iy * SLAB:(iy + 1) * SLAB, ix * SLAB:(ix + 1) * SLAB] += rng.integers(-JITTER, JITTER + 1)

    # 板缝：横竖各 n 条，落在块边界上
    for k in range(n):
        v[k * SLAB:k * SLAB + GROUT, :] *= 0.80
        v[:, k * SLAB:k * SLAB + GROUT] *= 0.80

    # 细噪点
    v += rng.normal(0.0, NOISE, (W, W))

    v = np.clip(v, 0, 255).astype(np.uint8)
    rgb = np.dstack([v, v, v])

    os.makedirs(os.path.dirname(out), exist_ok=True)
    Image.fromarray(rgb, "RGB").save(out, quality=92, optimize=True)

    a = rgb.astype(np.float32)
    print("生成 %s" % out)
    print("  %dx%d  %.0f KB  平均 RGB (%.0f, %.0f, %.0f)  标准差 %.1f"
          % (W, W, os.path.getsize(out) / 1024, a[..., 0].mean(), a[..., 1].mean(),
             a[..., 2].mean(), a.std()))
    print("  校验：R==G==B 全图？%s（中性灰，色相无偏）" % bool(np.all(rgb[..., 0] == rgb[..., 1])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
