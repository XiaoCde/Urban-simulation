# -*- coding: utf-8 -*-
"""找出「水面上的路面」：中心线落在水里、但仍会被画出来的 way。

判定：沿 way 每 2 m 取样，取 height.i16（可见地面 = min(DTM, cut-0.12)），
若 hDem < WATER_Y + 0.35 且 bed.i16 在该格有值（= 这是被挖过的水体），
记为「水上断面」。统计每条 way 的水上断面数与连续段长，按名字输出。

用法：py tools/terrain/_overwater.py
"""
import json, math, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, HERE)
from export_web_roads import snap_ways  # noqa: E402

TDIR = os.path.join(ROOT, 'web', 'assets', 'terrain')
RDIR = os.path.join(ROOT, 'web', 'assets', 'roads')
WATER_Y = 0.046

meta = json.load(open(os.path.join(TDIR, 'terrain.json'), encoding='utf-8'))
g = meta['grid']
x0, y1 = float(g['x0']), float(g['y1'])
step = float(g['step_m'])
cols, rows = int(g['cols']), int(g['rows'])
H = np.fromfile(os.path.join(TDIR, 'height.i16'), dtype=np.int16).reshape(rows, cols).astype(np.float32) * 0.01
WDIR = os.path.join(ROOT, 'web', 'assets', 'water')
B = np.fromfile(os.path.join(WDIR, 'bed.i16'), dtype=np.int16).reshape(rows, cols)
C = np.fromfile(os.path.join(RDIR, 'cut.i16'), dtype=np.int16).reshape(rows, cols)

def samp(x, py):
    fx = (x - x0) / step - 0.5
    fy = (y1 - py) / step - 0.5
    c0, r0 = math.floor(fx), math.floor(fy)
    tx, ty = fx - c0, fy - r0
    def at(c, r):
        c = min(max(c, 0), cols - 1); r = min(max(r, 0), rows - 1)
        return H[r, c]
    v00, v10 = at(c0, r0), at(c0 + 1, r0)
    v01, v11 = at(c0, r0 + 1), at(c0 + 1, r0 + 1)
    return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty

def cell(x, py):
    c = int(round((x - x0) / step - 0.5))
    r = int(round((y1 - py) / step - 0.5))
    if c < 0 or r < 0 or c >= cols or r >= rows:
        return None
    return c, r

st = json.load(open(os.path.join(ROOT, 'data', 'streets', 'dc_streets.json'), encoding='utf-8'))
ways = st['ways']
snap_ways(ways, log=False)

res = []
for w in ways:
    pts = w.get('pts') or []
    if len(pts) < 2:
        continue
    tot = 0
    wet = 0
    runs = []
    cur = 0
    for k in range(len(pts) - 1):
        ax, ay = pts[k]; bx, by = pts[k + 1]
        L = math.hypot(bx - ax, by - ay)
        n = max(1, int(math.ceil(L / 2.0)))
        for i in range(n):
            t = (i + 0.5) / n
            px, py = ax + (bx - ax) * t, ay + (by - ay) * t
            tot += 1
            h = samp(px, py)
            cr = cell(px, py)
            isb = cr is not None and B[cr[1], cr[0]] != 32767
            cu = cr is not None and C[cr[1], cr[0]] != -32768
            if h < WATER_Y + 0.35 and isb:
                wet += 1
                cur += 1
            else:
                if cur:
                    runs.append(cur); cur = 0
            _ = cu
    if cur:
        runs.append(cur)
    if wet:
        res.append((wet, total_len := sum(math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]) for k in range(len(pts) - 1)),
                    max(runs) * 2.0, w.get('name') or '', w.get('prof', ''), len(runs), w.get('hfcs') or ''))

res.sort(reverse=True)
print(f'共 {len(res)} 条 way 有水上断面（共 {len(ways)} 条）')
print(f'{"wetPts":>7} {"lenM":>8} {"maxRunM":>8} {"runs":>4}  name / prof')
for wet, ln, mr, name, prof, nruns, hf in res[:45]:
    print(f'{wet:7d} {ln:8.0f} {mr:8.0f} {nruns:4d}  {name!r:34s} {prof} {hf}')
