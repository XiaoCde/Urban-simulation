"""把某个 flood 运行结果里的一帧渲成 PNG，纯用 numpy+PIL，用来目视检查
「水连不连成片」——不需要开浏览器。

用法：
  python tools/flood/_preview.py data/flood/_p4_f 9 out/_p4_f_f9.png
"""
import json
import os
import sys

import numpy as np
from PIL import Image


def main() -> int:
    src = sys.argv[1]
    want = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    out = sys.argv[3]
    man = json.load(open(os.path.join(src, "frames", "manifest.json"), encoding="utf-8"))
    fr = man["frames"][min(want, len(man["frames"]) - 1)]
    f = os.path.join(src, "frames", fr["file"])
    h, w = int(fr["rows"]), int(fr["cols"])
    d = np.fromfile(f, dtype=np.uint8).reshape(h, w).astype("float32")
    d = d / 255.0 * float(man["scale_m"])
    # 配色：0 = 透明底（暗灰），1 cm 起浅蓝 → 50 cm 亮蓝 → 2 m 深蓝
    a = np.clip(d / 0.30, 0.0, 1.0)
    t = np.clip((d - 0.30) / 1.70, 0.0, 1.0)
    r = (60 + 0 * a).astype("uint8")
    g = (60 + 120 * a + 40 * t).astype("uint8")
    b = (66 + 150 * a + 20 * t).astype("uint8")
    rgb = np.stack([r, g, b], axis=-1)
    wet = d > 0.01
    rgb[wet] = np.stack([r[wet], g[wet], b[wet]], axis=-1)
    Image.fromarray(rgb).save(out)
    print(f"{out}  帧 {fr['file']} t={fr['t_min']} min  湿面积 "
          f"{float(wet.sum()) * (fr['step_m'] ** 2) / 1e4:.1f} ha  "
          f"最大水深 {float(d.max()):.2f} m  step {fr['step_m']} m")
    return 0


if __name__ == "__main__":
    sys.exit(main())