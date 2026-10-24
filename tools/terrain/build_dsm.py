# -*- coding: utf-8 -*-
r"""合成 data\derived\terrain_dsm.tif（含建筑与树冠高程）。

数据契约（任务书 §5.1）：
    terrain_dsm.tif  含建筑与树冠高程   1 m 网格，Float32，米

为什么必须自己合成：
    DCGIS 的 Digital_Surface_Model_2018 只有切片缓存、没有 ImageServer，
    取不到可用的 1 m DSM 原始栅格。所以 DSM = DTM + 建筑(高度) + 树冠(实测树高)。

高程基准：
    基底 blend 里的建筑是立在 z≈0 平面上的（min_z 只有 -0.25/0/0.2/2.2/4.642），
    与 DTM 的 NAVD88 不是同一基准。所以不能直接用 blend 的 zmax 当顶面高程，
    必须把每栋楼"落地"到它脚下那块 DTM 高程，再往上加 height_m。

    DSM(x,y) = max( DTM(x,y),
                    建筑底面所在 DTM + height_m   （建筑掩膜内）,
                    DTM + HEIGHT_FT*0.3048        （树冠圆盘内） )

输出：
    data\derived\terrain_dsm.tif
"""
import json
import os
import sys

import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.transform import Affine

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tm  # noqa: E402

DTM = os.path.join('data', 'derived', 'terrain_dtm.tif')
FOOT = os.path.join('data', 'derived', 'buildings_footprints.json')
TREES = os.path.join('data', 'dcgis', 'landcover', 'trees2023.json')
OUT = os.path.join('data', 'derived', 'terrain_dsm.tif')

W, H = tm.WIDTH, tm.HEIGHT
TRANSFORM = Affine(1.0, 0.0, tm.GRID_X0, 0.0, -1.0, tm.GRID_Y1)


def disks_max(dtm, pts, use_ground=True):
    """把 (x, y, 树高 m, 半径 m) 的树冠圆盘抬到 DTM 上，逐像素取 max。

    返回的数组用 -inf 填充"无树"像素：若用 0 填充，最后 dsm=np.maximum(dsm, canopy)
    会把 DTM 的负高程（Potomac 河床 -7 m）截平成 0。
    """
    out = np.full((H, W), -np.inf, dtype=np.float32)
    for x, y, hgt, rad in pts:
        if hgt <= 0.0:
            continue
        c = int(np.floor(x - tm.GRID_X0))
        rr = int(np.floor(tm.GRID_Y1 - y))
        ri = int(np.ceil(max(rad, 0.5)))
        if rr + ri < 0 or rr - ri >= H or c + ri < 0 or c - ri >= W:
            continue
        r0 = max(0, rr - ri); r1 = min(H - 1, rr + ri)
        c0 = max(0, c - ri); c1 = min(W - 1, c + ri)
        gy, gx = np.mgrid[r0:r1 + 1, c0:c1 + 1]
        d = np.sqrt((gx - c) ** 2 + (gy - rr) ** 2)
        sa = d <= rad
        if not sa.any():
            continue
        ground = dtm[r0:r1 + 1, c0:c1 + 1] if use_ground else 0.0
        sub = out[r0:r1 + 1, c0:c1 + 1]
        np.maximum(sub, np.where(sa, ground + hgt, -np.inf).astype(np.float32), out=sub)
    return out


def main():
    with rasterio.open(DTM) as s:
        dtm = s.read(1).astype(np.float32)
        profile = s.profile.copy()
    print('[dtm] %dx%d  z %.2f..%.2f' % (W, H, float(dtm.min()), float(dtm.max())))

    dsm = dtm.copy()

    # ---------- 建筑：落地到 DTM 再加檐高 ----------
    with open(FOOT, encoding='utf-8') as f:
        bd = json.load(f)

    bld_top = np.full((H, W), -np.inf, dtype=np.float32)
    n = 0
    n_skip = 0
    for b in bd['features']:
        rings = b['rings']
        h = b.get('height_m') or 0.0
        if not rings or b['id'] == 'ground' or h <= 0.0:
            n_skip += 1
            continue
        ring = np.array(rings[0], dtype=float)
        cx, cy = ring[:, 0].mean(), ring[:, 1].mean()
        # 底面高程 = 轮廓内 DTM 的稳健值（中位数，避免边坡/树影拉偏）
        c0 = int(np.clip(cx - tm.GRID_X0, 0, W - 1))
        r0 = int(np.clip(tm.GRID_Y1 - cy, 0, H - 1))
        gy0, gy1 = max(0, r0 - 3), min(H, r0 + 4)
        gx0, gx1 = max(0, c0 - 3), min(W, c0 + 4)
        base = float(np.median(dtm[gy0:gy1, gx0:gx1]))
        top = float(base + float(h))
        # 只在轮廓 bbox 的窗口内栅格化（全图 rasterize × 2 万栋会慢到不可用）
        wx0 = int(np.floor(ring[:, 0].min())) - 2
        wx1 = int(np.ceil(ring[:, 0].max())) + 2
        wy1 = int(np.ceil(ring[:, 1].max())) + 2
        wy0 = int(np.floor(ring[:, 1].min())) - 2
        cc0 = max(0, int(wx0 - tm.GRID_X0))
        cc1 = min(W, int(wx1 - tm.GRID_X0))
        rr0 = max(0, int(tm.GRID_Y1 - wy1))
        rr1 = min(H, int(tm.GRID_Y1 - wy0))
        if cc1 <= cc0 or rr1 <= rr0:
            n_skip += 1
            continue
        win_tr = Affine(1.0, 0.0, tm.GRID_X0 + cc0, 0.0, -1.0, tm.GRID_Y1 - rr0)
        poly = {'type': 'Polygon',
                'coordinates': [[[float(p[0]), float(p[1])] for p in ring]]}
        m = rasterize([(poly, 1)], out_shape=(rr1 - rr0, cc1 - cc0),
                      transform=win_tr, fill=0, all_touched=True, dtype='uint8')
        sub = bld_top[rr0:rr1, cc0:cc1]
        np.maximum(sub, np.where(m > 0, top, -np.inf).astype(np.float32), out=sub)
        n += 1
    np.maximum(dsm, bld_top, out=dsm)
    print('[building] %d 落地建模, 跳过 %d (ground/height<=0), 最高 %.2f m'
          % (n, n_skip, float(np.where(np.isfinite(bld_top), bld_top, 0).max())))

    # ---------- 树冠：实测 HEIGHT_FT ----------
    pts = []
    if os.path.exists(TREES):
        with open(TREES, encoding='utf-8') as f:
            tj = json.load(f)
        for ft in tj['features']:
            g = ft.get('geometry') or {}
            if not g:
                continue
            lon, lat = g['coordinates'][0], g['coordinates'][1]
            a = ft.get('properties') or {}
            try:
                hf = float(a.get('HEIGHT_FT') or 0)
            except (TypeError, ValueError):
                hf = 0.0
            try:
                cw = float(a.get('CROWN_WIDTH_FT') or 0)
            except (TypeError, ValueError):
                cw = 0.0
            x, y = tm.from_geographic(lat, lon)
            pts.append((float(x), float(y), hf * 0.3048, max(cw * 0.3048 / 2.0, 0.5)))
    canopy = disks_max(dtm, pts)
    np.maximum(dsm, canopy, out=dsm)
    if pts:
        print('[tree] %d 棵, 树高 m pct50/95 = %.1f / %.1f, 冠幅半径 max %.1f m'
              % (len(pts),
                 float(np.percentile([p[2] for p in pts], 50)),
                 float(np.percentile([p[2] for p in pts], 95)),
                 float(max(p[3] for p in pts))))

    # ---------- 写盘 ----------
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    profile.update(dtype='float32', count=1, nodata=-9999.0,
                   compress='deflate', tiled=True,
                   blockxsize=256, blockysize=256)
    with rasterio.open(OUT, 'w', **profile) as d:
        d.write(dsm, 1)
        d.update_tags(
            grid='x -1277..4701, y -931..4189, 1 m, pixel-center',
            origin_lat=str(tm.LAT0), origin_lon=str(tm.LON0),
            projection='blosm spherical transverse mercator, k=1, R=6378137',
            vertical_datum='NAVD88 (DTM from 3DEP 1m)',
            composition='DTM + building roofs (base=local DTM + height_m) '
                        '+ tree canopy (DCGIS Tree Geography 2023 HEIGHT_FT)',
            source='terrain_dtm.tif + buildings_footprints.json + trees2023.json',
        )

    dlt = dsm - dtm
    print('\n=== terrain_dsm.tif ===')
    print('  z %.2f .. %.2f m  (max 抬升 %.2f m)' % (float(dsm.min()), float(dsm.max()), float(dlt.max())))
    print('  加高像素 %d (%.2f%%), >1m %d (%.2f%%)'
          % (int((dlt > 0.05).sum()), 100.0 * (dlt > 0.05).mean(),
             int((dlt > 1.0).sum()), 100.0 * (dlt > 1.0).mean()))
    print('[done]', OUT, '%.1f MB' % (os.path.getsize(OUT) / 1e6))


if __name__ == '__main__':
    main()
