"""诊断：找出水面之上但落在水面多边形内的地形像素，输出 PNG 看形状。
   最终地形 = min(height.i16, bed.i16)（bed 有值处），与 water.js excavateTerrain 一致。
"""
import json, struct, zlib
import numpy as np
from shapely.geometry import Polygon, Point
from shapely.prepared import prep

COLS, ROWS = 996, 853
X0, Y1, STEP = -1277.0, 4189.0, 6.0
NONE = 32767

h = np.fromfile('web/assets/terrain/height.i16', dtype='<i2').reshape(ROWS, COLS).astype(np.float64) * 0.01
bd = np.fromfile('web/assets/water/bed.i16', dtype='<i2').reshape(ROWS, COLS).astype(np.int32)
doc = json.load(open('web/assets/water/water.json'))
pot = [b for b in doc['bodies'] if b['id'] == 'potomac_main'][0]
poly = Polygon(pot['outline'], [h2 for h2 in pot.get('holes', [])])
print('potomac outline pts', len(pot['outline']), 'area', poly.area)

fin = h.copy()
mask = bd != NONE
fin[mask] = np.minimum(h[mask], bd[mask] * 0.01)
lvl = pot['normal_water_level_m']
print('final z range', fin.min(), fin.max(), 'lvl', lvl)

# 只在波托马克的多边形 bbox 内逐格判点（997x853 全判太慢，用 prepared）
pp = prep(poly)
above = np.zeros((ROWS, COLS), np.uint8)
minx, miny, maxx, maxy = poly.bounds
c0 = max(0, int((minx - X0) / STEP)); c1 = min(COLS - 1, int((maxx - X0) / STEP) + 1)
r0 = max(0, int((Y1 - maxy) / STEP)); r1 = min(ROWS - 1, int((Y1 - miny) / STEP) + 1)
for r in range(r0, r1 + 1):
    y = Y1 - (r + 0.5) * STEP
    for c in range(c0, c1 + 1):
        x = X0 + (c + 0.5) * STEP
        if fin[r, c] > lvl + 0.05 and pp.contains(Point(x, y)):
            above[r, c] = 1
print('above-water inside potomac:', int(above.sum()), 'of', (r1 - r0 + 1) * (c1 - c0 + 1))
ys, xs = np.nonzero(above)
if len(ys):
    print('rows', ys.min(), ys.max(), 'cols', xs.min(), xs.max())

# 输出 PNG（大范围俯瞰，红=above，蓝=水面多边形容器，灰=地形）
def write_png(path, rgb):
    H_, W_ = rgb.shape[:2]
    raw = b''.join(b'\x00' + rgb[i].tobytes() for i in range(H_))
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', W_, H_, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 6))
    png += chunk(b'IEND', b'')
    open(path, 'wb').write(png)

img = np.zeros((ROWS, COLS, 3), np.uint8)
img[:, :] = (40, 40, 44)
inpoly = np.zeros((ROWS, COLS), bool)
for r in range(r0, r1 + 1):
    y = Y1 - (r + 0.5) * STEP
    for c in range(c0, c1 + 1):
        if pp.contains(Point(X0 + (c + 0.5) * STEP, y)):
            inpoly[r, c] = True
img[inpoly] = (25, 60, 110)
below = inpoly & (fin <= lvl)
img[below] = (18, 42, 82)
img[above == 1] = (240, 90, 60)
img = img[::-1]
write_png('web/diag_above.png', img)
print('wrote web/diag_above.png')
