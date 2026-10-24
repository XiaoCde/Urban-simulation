# -*- coding: utf-8 -*-
"""探：dc_streets 里跨水（landcover==0）的连续段，按名字聚类。"""
import json, math, collections
import numpy as np, rasterio

lc = rasterio.open('data/derived/landcover.tif').read(1)
H, W = lc.shape

def water(x, y):
    c = int(round(x + 1277.0)); r = int(round(4189.0 - y))
    if c < 0 or r < 0 or c >= W or r >= H: return False
    return lc[r, c] == 0

st = json.load(open('data/streets/dc_streets.json', encoding='utf-8'))
found = collections.defaultdict(list)
for w in st['ways']:
    pts = w['pts']
    if len(pts) < 2: continue
    flags = [water(p[0], p[1]) for p in pts]
    i = 0; n = len(pts)
    while i < n:
        if not flags[i]: i += 1; continue
        j = i
        while j < n and flags[j]: j += 1
        if i > 0 and j < n:
            seg = pts[i-1:j+1]
            L = sum(math.dist(seg[k], seg[k+1]) for k in range(len(seg)-1))
            if L >= 25:
                cx = sum(p[0] for p in seg)/len(seg); cy = sum(p[1] for p in seg)/len(seg)
                found[(w['name'] or '(无名)', w['h'])].append((round(L,1), round(cx), round(cy), w['prof']))
        i = j
rows = sorted(((k, v) for k, v in found.items()), key=lambda kv: -max(x[0] for x in kv[1]))
print('跨水段名目', len(rows))
for k, v in rows[:40]:
    print(f'{k[0][:42]:42s} {k[1][:12]:12s} n={len(v):2d} max={max(x[0] for x in v):6.1f} at {v[0][1]},{v[0][2]}')
