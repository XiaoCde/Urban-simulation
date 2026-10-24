# -*- coding: utf-8 -*-
r"""比两张 PNG 的像素差 —— 用来判定"两个视频逐帧一致"到底是真一致还是编码噪声。

为什么不比 md5 就下结论：
    md5 只能回答"字节一不一样"，回答不了"差多少、算不算同一个画面"。
    H.264 是有损编码，而且不同线程调度的码率决策可以让同一个输入编出
    不同的字节流；这时解码出来会有 ±1~2 LSB 的差异。
    这种差异**不是画面差异**，但如果不开量化直接报"不一致"，就会去改本来
    正确的仿真代码 —— 那是更大的浪费。

用法:
    python tools\diff_frames.py A.png B.png [更多成对文件...]
"""
import sys

import numpy as np
from PIL import Image


def one(a_path, b_path):
    a = np.asarray(Image.open(a_path).convert("RGB")).astype(np.int16)
    b = np.asarray(Image.open(b_path).convert("RGB")).astype(np.int16)
    if a.shape != b.shape:
        print("%-28s 形状不同 %s vs %s" % (a_path.split("/")[-1], a.shape, b.shape))
        return False
    d = np.abs(a - b)
    per_px = d.max(axis=2)
    diff_px = int(np.count_nonzero(per_px))
    total = per_px.size
    print("%-24s 最大差 %3d/255   平均差 %.5f   不同像素 %d/%d（%.4f%%）  "
          "差>2 的像素 %d"
          % (a_path.split("/")[-1], int(d.max()), float(d.mean()),
             diff_px, total, 100.0 * diff_px / total,
             int(np.count_nonzero(per_px > 2))))
    return True


def main(argv):
    if len(argv) < 2 or len(argv) % 2:
        print(__doc__)
        return 1
    for i in range(0, len(argv), 2):
        one(argv[i], argv[i + 1])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
