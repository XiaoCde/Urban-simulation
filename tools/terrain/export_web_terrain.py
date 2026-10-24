# -*- coding: utf-8 -*-
"""
把 terrain_dtm.tif + landcover.tif 导出成 three.js 能直接读的二进制高度场。

为什么不在浏览器里读 GeoTIFF：
  - 5978x5120 的 Float32 是 122 MB，浏览器扛不住；geotiff.js 也不在依赖里。
  - 场景只需要一个窗口，按 3 m 重采样后 600x600 就够了（72 万三角形，1 次 draw call）。

产物（web/assets/terrain/）：
  height.i16      Int16，单位厘米，行优先（北→南），little-endian。CM 精度远超需求，体积只有 Float32 的一半。
  landcover.u8    UInt8，0 水体/1 建筑/2 硬化/3 草地/4 林地/5 裸土（§5.1）
  wet.u8          UInt8，离水体的距离，0=水边 255=≥30 m（滨水湿土过渡带用，§3.1）
  terrain.json    元数据：窗口原点、步长、行列数、高程范围、字节序

坐标约定：与 out/dc_real3_clean.blend 同一套场景米制。
  planX -> three.x ，planY -> three.-z ，高程 -> three.y
  窗口原点是窗口左下角（planX 最小、planY 最小）的像素中心。
"""

import json
import os

import numpy as np
import rasterio
from affine import Affine
from rasterio.features import rasterize
from rasterio.windows import Window
from shapely.geometry import LineString

import tm

# ---------------------------------------------------------------- 窗口参数
# 全幅：与 terrain_dtm.tif 完全相同的范围（x -1277..4701, y -931..4189）＝ 5.98 × 5.12 km。
# §12.4 的判定要求「同一场设计暴雨，低洼街区进水、高地街区不进水」，
# 这必须是整座城市的地形，不能只切白宫那一块。
WIN_X0 = -1277.0
WIN_Y0 = -931.0
WIN_X1 = 4701.0
WIN_Y1 = 4189.0
STEP = 6.0                 # 显示用重采样步长（米）；1 m 原始数据仍在 data/derived 里

COLS = int(round((WIN_X1 - WIN_X0) / STEP))
ROWS = int(round((WIN_Y1 - WIN_Y0) / STEP))
N = COLS                   # 兼容旧变量名（wet 扩散按最大边长算）
WET_MAX_DIST = 30.0        # 湿土过渡带的收敛距离（米）
ROAD_PAD = 3.2             # 路权（right-of-way）在profile半宽之外再留的宽度（米）


def road_mask():
    """把 24,660 条 OSM way 按剖面半宽 + ROAD_PAD 铺进 6 m 网格。

    为什么需要：`landcover.tif` 是 1 m 的权威分类，但重采样到 6 m 之后，
    路缘与建筑之间那一条窄带经常落成「草地」——在渲染里就表现为**一块块
    绿色楔形从铺装里穿出来**，也就是用户说的「路面像在穿模」。
    真实世界里那一条是路缘石 + 人行道 + 建筑散水，全是硬化面。
    所以**只在 web 渲染资产里**把路权范围内的格子按硬化处理；
    `data/derived/landcover.tif`（§9 第 5 条要验的那份）一个字都不动。
    """
    with open(os.path.join('data', 'streets', 'dc_streets.json'), encoding='utf-8') as f:
        src = json.load(f)
    profs = src.get('profiles', {})
    shapes = []
    for w in src['ways']:
        pr = profs.get(w['prof'])
        pts = w.get('pts') or []
        if not pr or len(pts) < 2:
            continue
        half = max(abs(pr[0][0]), abs(pr[-1][0]))
        if half <= 0:
            continue
        shapes.append((LineString(pts).buffer(half + ROAD_PAD, quad_segs=2,
                                             cap_style=2, join_style=2), 1))
    t6 = Affine(1, 0, WIN_X0, 0, -1, WIN_Y1)
    m = rasterize(shapes, out_shape=(ROWS, COLS), transform=t6,
                  fill=0, dtype='uint8', all_touched=True)
    return m.astype(bool), len(shapes)


def sample_grid(src_arr, transform, xs, ys):
    """按窗口中心坐标做最近邻取样（1 m 源，3 m 目标 → 取格心）。"""
    cols = np.floor((xs - transform.c) / transform.a).astype(np.int64)
    rows = np.floor((transform.f - ys) / (-transform.e)).astype(np.int64)
    cols = np.clip(cols, 0, src_arr.shape[1] - 1)
    rows = np.clip(rows, 0, src_arr.shape[0] - 1)
    return rows, cols


def main():
    out_dir = os.path.join('web', 'assets', 'terrain')
    os.makedirs(out_dir, exist_ok=True)

    xs = WIN_X0 + (np.arange(COLS) + 0.5) * STEP
    ys = WIN_Y0 + (np.arange(ROWS)[::-1] + 0.5) * STEP   # 第 0 行 = 最北
    gx, gy = np.meshgrid(xs, ys)

    with rasterio.open('data/derived/terrain_dtm.tif') as d:
        rows, cols = sample_grid(d.read(1), d.transform, gx, gy)
        dtm = d.read(1)[rows, cols].astype(np.float32)
        dtm_transform = d.transform

    with rasterio.open('data/derived/landcover.tif') as l:
        lc = l.read(1)[rows, cols].astype(np.uint8)

    # 路权范围内强制按下垫面=硬化（只改 web 渲染资产，不改 landcover.tif）
    rm, n_way = road_mask()
    before = int((lc == 3).sum())
    lc = np.where(rm & (lc != 0) & (lc != 1), np.uint8(2), lc)
    print('[terrain] 路权掩膜 %d 条 way → 覆盖 %d 格（%.2f km2），草地转硬化 %d 格'
          % (n_way, int(rm.sum()), rm.sum() * STEP * STEP / 1e6, before - int((lc == 3).sum())))

    # 水体距离（滨水湿土过渡带）：从 class 0 起做多轮膨胀，收敛到 WET_MAX_DIST
    water = lc == 0
    dist = np.full(lc.shape, 255, dtype=np.uint8)
    if water.any():
        cur = water.copy()
        dist[water] = 0
        step_px = 1
        max_iter = int(np.ceil(WET_MAX_DIST / STEP))
        for it in range(1, max_iter + 1):
            nxt = cur.copy()
            nxt[1:, :] |= cur[:-1, :]
            nxt[:-1, :] |= cur[1:, :]
            nxt[:, 1:] |= cur[:, :-1]
            nxt[:, :-1] |= cur[:, 1:]
            new = nxt & ~cur
            dist[new] = np.uint8(min(255, round(it * STEP / WET_MAX_DIST * 255)))
            cur = nxt
        dist[dist == 255] = 255

    zmin, zmax = float(dtm.min()), float(dtm.max())
    # 厘米量化（Int16 范围 ±327 m，DC 全域 -7..90 m 完全够）
    height_cm = np.round(dtm * 100.0).astype(np.int16)
    back = height_cm.astype(np.float32) / 100.0
    err = float(np.abs(back - dtm).max())

    height_cm.astype('<i2').tofile(os.path.join(out_dir, 'height.i16'))
    lc.tofile(os.path.join(out_dir, 'landcover.u8'))
    dist.tofile(os.path.join(out_dir, 'wet.u8'))

    # 供建筑落地用：全幅 DTM 的窗口偏移（世界坐标 = 场景坐标）
    meta = {
        'grid': {
            'x0': WIN_X0, 'y0': WIN_Y0, 'x1': WIN_X1, 'y1': WIN_Y1,
            'width_m': WIN_X1 - WIN_X0, 'height_m': WIN_Y1 - WIN_Y0,
            'step_m': STEP, 'cols': COLS, 'rows': ROWS,
            'layout': 'row-major, row 0 = north edge, col 0 = west edge',
        },
        'height': {
            'file': 'height.i16', 'dtype': 'int16', 'endian': 'little',
            'unit': 'cm', 'z_min': zmin, 'z_max': zmax,
            'quant_error_max_m': err,
        },
        'landcover': {
            'file': 'landcover.u8', 'dtype': 'uint8',
            'classes': {'0': 'water', '1': 'building', '2': 'paved',
                        '3': 'grass', '4': 'forest', '5': 'bare'},
        },
        'wet': {'file': 'wet.u8', 'dtype': 'uint8',
                'meaning': '0 at water edge, 255 at >= %.0f m' % WET_MAX_DIST},
        'parent_grid': {
            'x0': float(dtm_transform.c), 'y1': float(dtm_transform.f),
            'step_m': float(dtm_transform.a), 'cols': 5978, 'rows': 5120,
        },
        'source': ['data/derived/terrain_dtm.tif', 'data/derived/landcover.tif'],
        'vertical_datum': 'NAVD88',
        'projection': 'local TM (see data/derived/terrain_dtm.tif tags)',
    }
    with open(os.path.join(out_dir, 'terrain.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    print('[terrain] window x %.0f..%.0f  y %.0f..%.0f  %dx%d @ %.1f m'
          % (WIN_X0, WIN_X1, WIN_Y0, WIN_Y1, COLS, ROWS, STEP))
    print('[terrain] z %.2f..%.2f m   quant err %.4f m' % (zmin, zmax, err))
    cls, cnt = np.unique(lc, return_counts=True)
    for c, n in zip(cls, cnt):
        print('   class %d  %8.1f ha  %5.1f%%' % (c, n * STEP * STEP / 1e4,
                                                  n / lc.size * 100))
    print('[terrain] wet: water px %d, mean dist %.1f'
          % (int(water.sum()), float(dist[~water].mean()) if (~water).any() else 0))
    for f in ('height.i16', 'landcover.u8', 'wet.u8', 'terrain.json'):
        p = os.path.join(out_dir, f)
        print('   %-14s %8.1f KB' % (f, os.path.getsize(p) / 1024))


if __name__ == '__main__':
    main()
