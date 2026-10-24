# -*- coding: utf-8 -*-
"""
把 ambientCG（CC0）的 1K 贴图压成 web 直接可用的单张 PNG。

产物（web/assets/tex/）：
  <key>.png      512x512  RGB
  index.json     [{key, pack, tile_m, url}, ...]

为什么一张一张存，不做图集：
  图集最容易踩的坑是 mipmap 跨格渗色 —— 远处的墙会糊成一片平均色。
  一张一个文件，RepeatWrapping + mipmap + anisotropy 全部正常工作，
  代价只是 17 个 512x512 的小文件。

tile_m = 一张贴图覆盖多少米，**不能拍脑袋**：
  * Facade003 一张 1K 图里 10x11 个窗格，按真实窗距 3 m → 一张 30 m
    （按 4 m 铺 = 每 0.4 m 一个窗，整面墙糊成噪点）
  * Bricks051 一张里 14 行砖 → 一行 0.22 m → 一张 3.0 m
  * RoofingTiles / Asphalt / Grass 是细骨料，2.5~6 m 都成立

用法: <带 PIL 的 python> tools/terrain/make_web_tex.py
"""

import json
import os

from PIL import Image

SRC = r'D:\citysim\textures'
OUT = os.path.join('web', 'assets', 'tex')
SIZE = 512
QUALITY = 90

LAYERS = [
    ('brick_a',     'Bricks051',         3.0),
    ('brick_b',     'Bricks097',         3.0),
    ('paint_a',     'PaintedPlaster017', 3.0),
    ('stone_a',     'Granite002A',       3.5),
    ('conc_a',      'Concrete046',       3.5),
    ('facade_a',    'Facade003',        30.0),
    ('facade_b',    'Facade017',        30.0),
    ('facade_c',    'Facade002',        30.0),
    ('facade_d',    'Facade012',        30.0),
    ('glass_a',     'Facade001',        30.0),
    ('glass_b',     'Facade005',        30.0),
    ('roof_slate',  'RoofingTiles001',   2.5),
    ('roof_tile',   'RoofingTiles012A',  2.5),
    ('roof_gravel', 'Gravel043',         4.0),
    ('asphalt',     'Asphalt033',        6.0),
    ('pave',        'Concrete047A',      3.0),
    ('grass',       'Grass005',          6.0),
]


def main():
    os.makedirs(OUT, exist_ok=True)
    index = []
    total = 0
    for key, pack, tile in LAYERS:
        p = os.path.join(SRC, pack, f'{pack}_1K-JPG_Color.jpg')
        if not os.path.exists(p):
            raise SystemExit(f'缺贴图: {p}')
        im = Image.open(p).convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)
        dst = os.path.join(OUT, key + '.jpg')
        im.save(dst, quality=QUALITY, optimize=True, progressive=True)
        sz = os.path.getsize(dst)
        total += sz
        index.append({'key': key, 'pack': pack, 'tile_m': tile,
                      'url': f'assets/tex/{key}.jpg'})
        print(f'  {key:12s} <- {pack:18s} tile {tile:5.1f} m  {sz//1024:4d} KB')

    json.dump({'size': SIZE, 'layers': index},
              open(os.path.join(OUT, 'index.json'), 'w'), indent=1)
    print(f'[tex] 17 层, 合计 {total/1048576:.2f} MB')


if __name__ == '__main__':
    main()
