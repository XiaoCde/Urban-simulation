# -*- coding: utf-8 -*-
"""诊断：国家广场一带的 way 是否存在「重复/近重复」线（z-fighting 虚线的来源）。

判据：
  1) 完全相同 pts（正/反序）算重复；
  2) 中心线相距 < 1.2 m 且走向平行、且 profile 半宽相近 —— 算近重复（会叠在一起闪）。
"""
import json, math, os, collections

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
st = json.load(open(os.path.join(ROOT, 'data', 'streets', 'dc_streets.json'), encoding='utf-8'))
profs = st['profiles']
ways = st['ways']

# Mall 范围
X0, X1, Y0, Y1 = 1250, 3450, -380, 80

def in_mall(w):
    for x, y in w.get('pts', []):
        if X0 <= x <= X1 and Y0 <= y <= Y1:
            return True
    return False

mw = [w for w in ways if in_mall(w)]
print('Mall 范围内 way 数:', len(mw))

def half_of(w):
    pr = profs.get(w.get('prof')) or []
    return max((abs(float(q[0])) for q in pr), default=0.0)

# 1) 完全相同
sig = collections.defaultdict(list)
for w in mw:
    k = tuple((round(x, 1), round(y, 1)) for x, y in w['pts'])
    sig[k].append(w['id'])
    sig[k[::-1]].append(w['id'])
dups = {k: v for k, v in sig.items() if len(set(v)) > 1}
seen = set()
uniq_dups = []
for k, v in dups.items():
    s = frozenset(v)
    if s in seen:
        continue
    seen.add(s)
    uniq_dups.append(sorted(set(v)))
print('完全相同 pts 的重复组:', len(uniq_dups))
for g in uniq_dups[:10]:
    for w in mw:
        if w['id'] == g[0]:
            print('   ', w.get('name'), w.get('prof'), len(w['pts']), '半宽', half_of(w), 'y', w.get('z'), 'ids', len(g))

# 2) 近重复：用格点哈希找中心线接近的
CELL = 4.0
grid = collections.defaultdict(set)
for i, w in enumerate(mw):
    for x, y in w['pts']:
        grid[(int(x // CELL), int(y // CELL))].add(i)

pairs = set()
for cell, idxs in grid.items():
    if len(idxs) < 2:
        continue
    li = sorted(idxs)
    for a in range(len(li)):
        for b in range(a + 1, len(li)):
            pairs.add((li[a], li[b]))
print('候选近邻对:', len(pairs))

def dist_pt_seg(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy or 1e-9
    t = ((px - ax) * dx + (py - ay) * dy) / L2
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    return math.hypot(px - (ax + dx * t), py - (ay + dy * t))

def min_dist(w1, w2):
    best = 1e9
    for x, y in w1['pts'][::2]:
        p = w2['pts']
        for k in range(len(p) - 1):
            d = dist_pt_seg(x, y, p[k][0], p[k][1], p[k + 1][0], p[k + 1][1])
            if d < best:
                best = d
                if best < 0.3:
                    return best
    return best

near = []
for a, b in pairs:
    w1, w2 = mw[a], mw[b]
    h1, h2 = half_of(w1), half_of(w2)
    if h1 <= 0 or h2 <= 0:
        continue
    d = min_dist(w1, w2)
    if d < 1.2 and abs(h1 - h2) < 0.6:
        near.append((round(d, 2), w1.get('name'), w1.get('prof'), h1, w2.get('name'), w2.get('prof'), h2))
near.sort(key=lambda r: r[0])
print('近重复对 (<1.2m, 半宽相近):', len(near))
for r in near[:15]:
    print('   ', r)
