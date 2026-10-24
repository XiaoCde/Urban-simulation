# -*- coding: utf-8 -*-
r"""把 data\dem\dc_1m_geo.tif（EPSG:4326，0.8 m）重采样到场景本地 1 m 栅格，存 terrain_dtm.tif。

思路（只重采样一次，不叠误差）：
    本地网格每个像素中心 (x, y) --tm.to_geographic--> (lat, lon)
    --在源栅格上做手工双线性采样--> 高程
    这样得到的是「真实裸地面高程」，与 blend 里的 x/y 一一对应，不需要任何仿射拟合。

为什么不用 rasterio.sample / reproject：
    sample 是逐点 Python 调用，30.6M 点会跑几十分钟；reproject 只认标准 CRS，
    认不出 blosm 这套球面 TM。所以整幅读进内存（约 200 MB），自写向量化双线性 —— 分块
    处理，每块 256 行，几秒钟就完。

为什么 DTM = 3DEP DEM：
    3DEP 1 m DEM 是 lidar 派生、hydro-flattened 的**裸地面**产品（不含建筑与树），
    正是 §5.1 要的 terrain_dtm。DSM 后面由 DTM + 建筑高度 + 树冠单独叠出来。
"""
import os
import sys
import numpy as np
import rasterio

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tm  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "data", "dem", "dc_1m_geo.tif")
OUT = os.path.join(ROOT, "data", "derived", "terrain_dtm.tif")
NODATA = -9999.0


def bilinear(src, T, lat, lon, nodata):
    """在源栅格上做双线性采样（浮点行列，不是 rowcol 的取整版本）。

    rasterio 的 rowcol() 只返回整数、而且必须传**正变换**；这里要亚像素精度，
    所以直接解仿射：col = (lon - T.c)/T.a ，row = (lat - T.f)/T.e（T.e 为负）。
    """
    rows = (np.asarray(lat, dtype=np.float64) - T.f) / T.e
    cols = (np.asarray(lon, dtype=np.float64) - T.c) / T.a
    h, w = src.shape
    np.clip(rows, 0, h - 1.001, out=rows)
    np.clip(cols, 0, w - 1.001, out=cols)
    r0 = np.floor(rows).astype(np.int64)
    c0 = np.floor(cols).astype(np.int64)
    r1 = np.minimum(r0 + 1, h - 1)
    c1 = np.minimum(c0 + 1, w - 1)
    fr = rows - r0
    fc = cols - c0
    v00 = src[r0, c0].astype(np.float64)
    v01 = src[r0, c1].astype(np.float64)
    v10 = src[r1, c0].astype(np.float64)
    v11 = src[r1, c1].astype(np.float64)
    bad = (v00 <= nodata / 2) | (v01 <= nodata / 2) | (v10 <= nodata / 2) | (v11 <= nodata / 2)
    out = (v00 * (1 - fr) * (1 - fc) + v01 * (1 - fr) * fc +
           v10 * fr * (1 - fc) + v11 * fr * fc)
    out[bad] = np.nan
    return out


def fill_nan(a, iters=4):
    """NaN 用 3x3 邻域均值迭代填补（纯 numpy，不依赖 scipy）。"""
    for _ in range(iters):
        bad = ~np.isfinite(a)
        if not bad.any():
            break
        m = np.where(np.isfinite(a), a, 0.0)
        c = np.isfinite(a).astype(np.float64)
        k = np.ones((3, 3))
        sm = np.zeros_like(m)
        sc = np.zeros_like(c)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                sm += np.roll(np.roll(m, dy, 0), dx, 1)
                sc += np.roll(np.roll(c, dy, 0), dx, 1)
        fill = sm / np.maximum(sc, 1e-9)
        a = np.where(bad & (sc > 0), fill, a)
        print("[dtm]   补洞后剩余无效 %d" % int((~np.isfinite(a)).sum()))
    return a


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)

    with rasterio.open(SRC) as ds:
        geo = ds.read(1)
        T = ds.transform
        geo_nodata = ds.nodata if ds.nodata is not None else NODATA
        print("[dtm] 源 %dx%d  res %s  nodata %s" % (ds.width, ds.height, ds.res, geo_nodata))
    print("[dtm] 源高程 min %.2f max %.2f" % (float(geo.min()), float(geo.max())))

    xs = tm.GRID_X0 + np.arange(tm.WIDTH) + 0.5
    # ★ 行 0 = 最北（y = GRID_Y1），与 north-up GeoTIFF 一致；写反了整个地形会南北颠倒
    ys = tm.GRID_Y1 - np.arange(tm.HEIGHT) - 0.5
    dtm = np.empty((tm.HEIGHT, tm.WIDTH), dtype=np.float32)

    B = 256
    for r0 in range(0, tm.HEIGHT, B):
        r1 = min(r0 + B, tm.HEIGHT)
        gx, gy = np.meshgrid(xs, ys[r0:r1])
        lat, lon = tm.to_geographic(gx, gy)
        z = bilinear(geo, T, lat, lon, geo_nodata).reshape(r1 - r0, tm.WIDTH)
        dtm[r0:r1, :] = z.astype(np.float32)
        print("[dtm] 行 %5d/%d  z %7.2f .. %7.2f  nan %d"
              % (r1, tm.HEIGHT, np.nanmin(z), np.nanmax(z), int(np.isnan(z).sum())))

    a = dtm.astype(np.float64)
    n_bad0 = int((~np.isfinite(a)).sum())
    a = fill_nan(a)
    print("[dtm] 初始无效 %d -> 最终剩余 %d" % (n_bad0, int((~np.isfinite(a)).sum())))
    a = np.where(np.isfinite(a), a, NODATA)

    transform = rasterio.transform.from_origin(tm.GRID_X0, tm.GRID_Y1, 1.0, 1.0)
    prof = dict(driver="GTiff", width=tm.WIDTH, height=tm.HEIGHT, count=1,
                dtype="float32", nodata=NODATA,
                crs=("+proj=tmerc +lat_0=38.89038015 +lon_0=-77.04975645 +k=1 "
                     "+x_0=0 +y_0=0 +R=6378137 +units=m +no_defs"),
                tiled=True, blockxsize=512, blockysize=512,
                compress="deflate", predictor=3, BIGTIFF="IF_SAFER")
    with rasterio.open(OUT, "w", transform=transform, **prof) as dst:
        dst.write(a.astype(np.float32), 1)
        dst.update_tags(
            origin_lat="38.89038015", origin_lon="-77.04975645",
            projection="blosm spherical transverse mercator, k=1, R=6378137",
            vertical_datum="NAVD88 (USGS 3DEP 1m DEM)",
            purpose="terrain_dtm: bare-earth, no buildings/trees",
            source="USGS 3DEP 1m DEM via elevation.nationalmap.gov exportImage",
            grid="x -1277..4701, y -931..4189, 1 m, pixel-center",
        )
    print("[dtm] 写出 %s  %.1f MB  %dx%d"
          % (OUT, os.path.getsize(OUT) / 1048576.0, tm.WIDTH, tm.HEIGHT))
    fin = a[a > NODATA / 2]
    print("[dtm] 全幅 z min %.2f max %.2f mean %.2f std %.2f"
          % (fin.min(), fin.max(), fin.mean(), fin.std()))


if __name__ == "__main__":
    main()
