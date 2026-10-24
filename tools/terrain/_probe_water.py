# -*- coding: utf-8 -*-
"""探测：水体多边形清单 + 岸线横断面（决定水位与过渡带做法）。"""
import json
import numpy as np
import rasterio
from rasterio import features
from shapely.geometry import shape

dtm_src = rasterio.open('data/derived/terrain_dtm.tif')
dtm = dtm_src.read(1)
lc = rasterio.open('data/derived/landcover.tif').read(1)
T = dtm_src.transform
water = (lc == 0)

polys = []
for geom, val in features.shapes(water.astype(np.uint8), mask=water, transform=T):
    if val != 1:
        continue
    g = shape(geom)
    polys.append(g)
polys.sort(key=lambda g: -g.area)
print('bodies (area>=400 m2):', sum(1 for g in polys if g.area >= 400), 'of', len(polys))

def sample(x, y):
    c = int(np.floor(x - T.c))
    r = int(np.floor((T.f - y) / 1.0))
    if 0 <= r < dtm.shape[0] and 0 <= c < dtm.shape[1]:
        return float(dtm[r, c])
    return None

for i, g in enumerate(polys[:12]):
    c = g.centroid
    w = dtm[water & ~np.zeros_like(water)]  # noqa
    print('%2d area %9.0f m2  c=(%7.1f,%7.1f)  bounds x %.0f..%.0f y %.0f..%.0f  npts %d'
          % (i, g.area, c.x, c.y, g.bounds[0], g.bounds[2], g.bounds[1], g.bounds[3],
             len(g.exterior.coords)))

# 横断面：从水体内部向岸边走，打印 DTM
print('\n--- 横断面（每 1 m，从水里向岸上） ---')
def transect(x0, y0, dx, dy, n=14, label=''):
    vals = []
    for k in range(n):
        x, y = x0 + dx * k, y0 + dy * k
        vals.append('%6.2f' % (sample(x, y) if sample(x, y) is not None else np.nan))
    print('%-16s %s' % (label, ' '.join(vals)))

# 波托马克河 → 西波托马克公园（东岸）。水面在 x≈-600 一带
big = polys[0]
bb = big.bounds
print('potomac bounds', bb)
transect(-300, 400, 8, 0, 12, 'potomac->land x+')
transect(-150, 1200, 8, 0, 12, 'memorial x+')
# 潮汐湖东岸
tb = [g for g in polys if abs(g.area - 161877) < 20000]
if tb:
    b = tb[0].bounds
    print('tidal basin approx bounds', b)
    transect(b[2] - 30, (b[1] + b[3]) / 2, 6, 0, 12, 'tidal->east')
# 倒影池
rp = [g for g in polys if abs(g.area - 31077) < 8000]
if rp:
    b = rp[0].bounds
    print('reflecting pool bounds', b)
    transect((b[0] + b[2]) / 2, b[3] - 6, 0, 6, 10, 'reflpool->north')
