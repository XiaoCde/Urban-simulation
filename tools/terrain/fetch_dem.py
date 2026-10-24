# -*- coding: utf-8 -*-
r"""拉取 USGS 3DEP 1 m DEM（覆盖整个场景 30.6 km²），落到 data\dem\dc_1m_geo.tif。

为什么分块：
    elevation.nationalmap.gov 的 exportImage 单次请求 6120x5260 会 504；1400x1400
    稳定返回（实测 7.9 MB / 3 s）。所以按 1600 像素一块切成 5x4 左右，逐块拉，
    失败按指数退避重试，最终拼成一张细于 1 m 的地理网格 GeoTIFF。

为什么是地理网格而不是直接要米制：
    服务只认标准 CRS（4326/UTM），认不出 blosm 的球面 TM。所以这里先拿「比 1 m 还密
    一点的经纬度网格」，再由 fetch_dem.py / build_terrain.py 用 tools\terrain\tm.py
    的双线性采样投到场景本地 1 m 网格上 —— 全程只做一次重采样，不叠加误差。
"""
import os
import sys
import time
import math
import urllib.parse
import urllib.request

import numpy as np
import rasterio
from rasterio.windows import Window

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tm  # noqa: E402

OUT = os.path.join(tm.__file__.rsplit("tools", 1)[0], "data", "dem", "dc_1m_geo.tif")
TMP = OUT + ".part.tif"
SERVICE = ("https://elevation.nationalmap.gov/arcgis/rest/services/"
           "3DEPElevation/ImageServer/exportImage")

# 地理网格步长（米）。0.8 m < 1 m，保证重采样到 1 m 时不会先丢信息。
STEP_M = 0.8
CHUNK = 1500          # 每块像素
NODATA = -999999.0


def geo_bbox():
    """用本地网格四角反算经纬度包围盒，外扩 60 m。"""
    xs = [tm.GRID_X0, tm.GRID_X1]
    ys = [tm.GRID_Y0, tm.GRID_Y1]
    lats, lons = [], []
    for x in xs:
        for y in ys:
            la, lo = tm.to_geographic(x, y)
            lats.append(float(la))
            lons.append(float(lo))
    m_lat = 1.0 / 111132.0
    m_lon = 1.0 / (111320.0 * math.cos(math.radians(sum(lats) / len(lats))))
    pad = 60.0
    return (min(lons) - pad * m_lon, min(lats) - pad * m_lat,
            max(lons) + pad * m_lon, max(lats) + pad * m_lat)


def fetch(url, tries=6):
    last = None
    for k in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=300) as r:
                buf = r.read()
            if len(buf) < 20000:
                raise IOError("response too small: %d bytes" % len(buf))
            return buf
        except Exception as e:                      # noqa: BLE001
            last = e
            wait = min(2 ** k, 20)
            print("[dem]   重试 %d/%d (%s)，等 %ds" % (k + 1, tries, e, wait))
            time.sleep(wait)
    raise RuntimeError("download failed: %s" % last)


def main():
    west, south, east, north = geo_bbox()
    latmid = (south + north) / 2
    dlat = STEP_M / 111132.0
    dlon = STEP_M / (111320.0 * math.cos(math.radians(latmid)))
    w = int(math.ceil((east - west) / dlon))
    h = int(math.ceil((north - south) / dlat))
    print("[dem] 地理网格 %d x %d @ %.2f m  bbox %.6f,%.6f,%.6f,%.6f"
          % (w, h, STEP_M, west, south, east, north))

    prof = dict(driver="GTiff", width=w, height=h, count=1, dtype="float32",
                crs="EPSG:4326", nodata=NODATA, tiled=True,
                blockxsize=512, blockysize=512,
                compress="deflate", predictor=2, BIGTIFF="IF_SAFER")
    transform = rasterio.transform.from_bounds(west, south, east, north, w, h)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with rasterio.open(TMP, "w", transform=transform, **prof) as dst:
        nx = (w + CHUNK - 1) // CHUNK
        ny = (h + CHUNK - 1) // CHUNK
        total = nx * ny
        done = 0
        for iy in range(ny):
            for ix in range(nx):
                cw = min(CHUNK, w - ix * CHUNK)
                ch = min(CHUNK, h - iy * CHUNK)
                # 该块的地理范围（按块像素边界取，避免块间错半像素）
                l = west + ix * CHUNK * (east - west) / w
                r = west + (ix * CHUNK + cw) * (east - west) / w
                t = north - iy * CHUNK * (north - south) / h
                b = north - (iy * CHUNK + ch) * (north - south) / h
                q = urllib.parse.urlencode({
                    "bbox": "%.10f,%.10f,%.10f,%.10f" % (l, b, r, t),
                    "bboxSR": "4326", "imageSR": "4326",
                    "size": "%d,%d" % (cw, ch),
                    "format": "tiff", "pixelType": "F32",
                    "noData": str(int(NODATA)),
                    "interpolation": "RSP_BilinearInterpolation",
                    "f": "image",
                })
                buf = fetch(SERVICE + "?" + q)
                tmpc = TMP + ".chunk.tif"
                with open(tmpc, "wb") as fh:
                    fh.write(buf)
                with rasterio.open(tmpc) as src:
                    data = src.read(1)
                if data.shape != (ch, cw):
                    raise RuntimeError("块尺寸不符 %s != %s" % (data.shape, (ch, cw)))
                dst.write(data, 1, window=Window(ix * CHUNK, iy * CHUNK, cw, ch))
                done += 1
                pct = 100.0 * done / total
                print("[dem] %3d/%3d 块 (%5.1f%%)  %d x %d  %s"
                      % (done, total, pct, cw, ch, "下" if pct < 99.9 else "完成"))
    if os.path.exists(TMP + ".chunk.tif"):
        os.remove(TMP + ".chunk.tif")
    if os.path.exists(OUT):
        os.remove(OUT)
    os.replace(TMP, OUT)
    with rasterio.open(OUT) as s:
        a = s.read(1, out_shape=(512, 512))
        print("[dem] 写出 %s  %.1f MB  %dx%d  crs=%s"
              % (OUT, os.path.getsize(OUT) / 1048576.0, s.width, s.height, s.crs))
        print("[dem] 抽样高程 min %.2f  max %.2f  mean %.2f"
              % (float(a.min()), float(a.max()), float(np.mean(a))))


if __name__ == "__main__":
    main()
