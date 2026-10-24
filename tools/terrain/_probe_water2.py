# -*- coding: utf-8 -*-
"""探测 2：水体内部 DTM 分布（是否有真实河床）+ 各水体身份识别。"""
import numpy as np
import rasterio
from rasterio import features
from shapely.geometry import shape

import tm

src = rasterio.open('data/derived/terrain_dtm.tif')
dtm = src.read(1)
T = src.transform
lc = rasterio.open('data/derived/landcover.tif').read(1)
water = (lc == 0)

# 全幅 DTM 最低点在哪
i = np.unravel_index(np.argmin(dtm), dtm.shape)
print('DTM min %.2f at row %d col %d -> x %.0f y %.0f  in_water=%s'
      % (dtm[i], i[0], i[1], T.c + 0.5, T.f - 0.5, water[i]))

polys = [shape(g) for g, v in features.shapes(water.astype(np.uint8), mask=water, transform=T) if v == 1]
polys.sort(key=lambda g: -g.area)

rows = []
for g in polys:
    if g.area < 400:
        continue
    b = g.bounds
    c0 = int(max(0, np.floor(b[0] - T.c)))
    c1 = int(min(dtm.shape[1], np.ceil(b[2] - T.c)))
    r0 = int(max(0, np.floor(T.f - b[3])))
    r1 = int(min(dtm.shape[0], np.ceil(T.f - b[1])))
    sub_d = dtm[r0:r1, c0:c1]
    sub_w = water[r0:r1, c0:c1]
    v = sub_d[sub_w]
    if v.size == 0:
        continue
    lat, lon = tm.to_geographic(g.centroid.x, g.centroid.y)
    rows.append(dict(area=g.area, cx=g.centroid.x, cy=g.centroid.y,
                     lat=float(lat), lon=float(lon),
                     p1=float(np.percentile(v, 1)), p50=float(np.percentile(v, 50)),
                     p99=float(np.percentile(v, 99)), mn=float(v.min()), mx=float(v.max()),
                     n=v.size, g=g))

rows.sort(key=lambda d: -d['area'])
print('\n%4s %10s %8s %8s  %-14s %7s %7s %7s %7s %7s' %
      ('#', 'area_m2', 'x', 'y', 'lat,lon', 'min', 'p1', 'p50', 'p99', 'max'))
for k, d in enumerate(rows):
    print('%4d %10.0f %8.0f %8.0f  %.5f,%.5f %7.2f %7.2f %7.2f %7.2f %7.2f  n=%d'
          % (k, d['area'], d['cx'], d['cy'], d['lat'], d['lon'],
             d['mn'], d['p1'], d['p50'], d['p99'], d['mx'], d['n']))

print('\n--- 波托马克主水体内部剖面（沿 x 扫，y=800）---')
for x in range(-1270, 520, 120):
    r = int(T.f - 800)
    c = int(x - T.c)
    if 0 <= c < dtm.shape[1]:
        print('  x=%6d  dtm=%7.2f  water=%s' % (x, dtm[r, c], water[r, c]))
