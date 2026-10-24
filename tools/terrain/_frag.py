# -*- coding: utf-8 -*-
"""统计 path / walk 类 way 的「碎片」与「悬空孤立」情况。

判据：
  碎片 = 长度 < LEN_MIN
  孤立 = 两个端点都不靠近任何其他 way 的顶点（>CONN 米）
"""
import json, math, os, collections

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
st = json.load(open(os.path.join(ROOT, 'data', 'streets', 'dc_streets.json'), encoding='utf-8'))
profs = st['profiles']
ways = st['ways']

def plen(p):
    return sum(math.hypot(p[i+1][0]-p[i][0], p[i+1][1]-p[i][1]) for i in range(len(p)-1))

CELL = 8.0
grid = collections.defaultdict(list)
for wi, w in enumerate(ways):
    for x, y in (w.get('pts') or []):
        grid[(int(x//CELL), int(y//CELL))].append(wi)

CONN = 3.0
stats = collections.Counter()
lens = collections.defaultdict(list)
orphans = 0
orphan_len = 0.0
for wi, w in enumerate(ways):
    prof = str(w.get('prof', ''))
    kind = 'road' if prof.startswith('profile_roads_') else 'path'
    p = w.get('pts') or []
    if len(p) < 2:
        stats[kind + '_short'] += 1
        continue
    L = plen(p)
    lens[kind].append(L)
    # 两端是否有邻居
    conn = 0
    for (x, y) in (p[0], p[-1]):
        found = False
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for wj in grid.get((int(x//CELL)+dx, int(y//CELL)+dy), ()):
                    if wj == wi:
                        continue
                    for (x2, y2) in (ways[wj].get('pts') or []):
                        if (x-x2)**2 + (y-y2)**2 <= CONN*CONN:
                            found = True
                            break
                    if found: break
                if found: break
            if found: break
        if found:
            conn += 1
    if conn == 0:
        orphans += 1
        orphan_len += L
        stats[kind + '_orphan'] += 1
    else:
        stats[kind + '_conn%d' % conn] += 1

for k in ('road', 'path'):
    arr = sorted(lens[k])
    if not arr: continue
    n = len(arr)
    print('%s: n=%d  len p10=%.0f p50=%.0f p90=%.0f max=%.0f  sum=%.0f km' % (
        k, n, arr[int(n*0.1)], arr[n//2], arr[min(n-1, int(n*0.9))], arr[-1], sum(arr)/1000.0))
print('孤立的 way（两端都不接任何路）=', orphans, ' 总长 %.1f km' % (orphan_len/1000.0))
for k in sorted(stats):
    print('  %-18s %d' % (k, stats[k]))

# 碎片：长度分布直方
import bisect
for k in ('road', 'path'):
    arr = sorted(lens[k])
    bins = [(0, 5), (5, 10), (10, 20), (20, 40), (40, 80), (80, 200), (200, 1e9)]
    print(k, '长度分布:')
    for a, b in bins:
        c = sum(1 for v in arr if a <= v < b)
        print('   %5.0f..%-8.0f %6d (%.1f%%)' % (a, b if b < 1e9 else 999999, c, 100.0*c/max(1,len(arr))))
