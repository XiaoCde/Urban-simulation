# -*- coding: utf-8 -*-
r"""白宫专题：四个角度拍白宫复合体。

机位是围绕白宫主楼中心（场景坐标 1148.4, 816.0）算出来的：
    北侧正立面 / 正俯视 / 南草坪 / 西南低空斜视
经纬换算与 export_conditions.py 完全一致，四个机位都写的是 WGS84。

用法:
    blender --background --python tools\render_whitehouse.py -- <输入.blend> <输出目录>
"""
import importlib.util
import os
import sys

import bpy

TOOLS = os.path.dirname(os.path.abspath(__file__))


def load_mod(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(TOOLS, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ec = load_mod("ec", "export_conditions.py")

# 白宫主楼中心：经纬 (-77.03650, 38.89770) -> 场景 (1148.4, 816.0)
# 主楼是东西向的（52.2 x 23.0），所以南北两个方向看到的是正面/背面。
WH = (-77.03650, 38.89770)

SHOTS = [
    # 从北边拉法叶广场上空往南看 —— 白宫北立面（这个是"标准证件照"角度）
    ("A_北侧正立面", "白宫北立面（从拉法叶广场上空往南看）", dict(
        lens=52.0, near=60.0, far=1400.0,
        loc_geo=(-77.03650, 38.898956, 90.0),
        tgt_geo=(-77.03650, 38.897700, 12.0))),

    # 正俯视：白宫主楼 + 西翼 + 柱廊 + 北草坪 + 拉法叶广场，一次看全
    ("B_正俯视", "白宫复合体正俯视（330 m 垂直向下）", dict(
        lens=50.0, near=250.0, far=900.0,
        loc_geo=(-77.03650, 38.897770, 330.0),
        tgt_geo=(-77.03650, 38.897700, 0.0))),

    # 从南边（椭圆广场上空）往北看 —— 白宫南立面 + 南草坪
    ("C_南草坪", "白宫南立面（从南草坪上空往北看）", dict(
        lens=52.0, near=60.0, far=1400.0,
        loc_geo=(-77.03650, 38.896172, 85.0),
        tgt_geo=(-77.03650, 38.897700, 14.0))),

    # 西南低空 45 度斜视，把白宫和西翼、EEOB 的体量关系一起带进来
    ("D_西南低空", "西南低空斜视（白宫 + 西翼 + 艾森豪威尔行政楼）", dict(
        lens=45.0, near=80.0, far=1600.0,
        loc_geo=(-77.038348, 38.896262, 130.0),
        tgt_geo=(-77.03650, 38.897700, 20.0))),

    # 北立面"证件照"：退到 170 m 外、压到 48 m 高，把俯角从 63 度压到约 12 度，
    # 这样北门廊（North Portico）不会被压扁 —— 上面 A 机位俯角太大，
    # 拍出来是"从楼顶往下看"，这一个是"站在拉法叶广场抬头看"。
    ("E_主楼正面", "白宫北立面正面照（170 m 外，俯角约 12 度）", dict(
        lens=50.0, near=60.0, far=1400.0,
        loc_geo=(-77.03650, 38.899226, 48.0),
        tgt_geo=(-77.03650, 38.897700, 13.0))),

    # 主楼特写：100 m 外、34 m 高，主楼基本填满画面
    ("F_主楼特写", "白宫主楼特写（100 m 外，北门廊正面）", dict(
        lens=65.0, near=50.0, far=1200.0,
        loc_geo=(-77.03650, 38.898597, 34.0),
        tgt_geo=(-77.03650, 38.897700, 14.0))),
]


def main(blend, outdir, only=None):
    outdir = os.path.abspath(outdir)
    os.makedirs(outdir, exist_ok=True)

    scene = ec.open_blend(blend)
    ec.setup_render(scene)
    print("[wh] 场景载入完成：物体 %d 个" % len(bpy.data.objects))

    for name, title, cfg in SHOTS:
        if only and name not in only:
            continue
        full = dict(cfg)
        full["kind"] = "fixed"
        print("[wh] === %s : %s ===" % (name, title))
        ec.place(scene, name, full)
        ec.render_beauty(scene, os.path.join(outdir, "%s.png" % name))
    print("[wh] 全部完成 -> %s" % outdir)


if __name__ == "__main__":
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    if len(argv) < 2:
        print(__doc__)
        sys.exit(1)
    main(argv[0], argv[1], argv[2].split(",") if len(argv) > 2 else None)
