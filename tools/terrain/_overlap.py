# -*- coding: utf-8 -*-
"""量化 way 之间的「共线重叠长度」—— 这才是 z-fighting 虚线的真因。

对每个 way 的每个顶点，判断它是否落在另一条 way 的 0.35 m 缓冲带内；
统计顶点占比与估算重叠长度，输出重叠 > 15 m 的配对。
"""
import json, math, os, collections

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
st = json.load(open(os.path.join(ROOT, 'data', 'streets', 'dc_streets.json'), encoding='utf-8'))
profs = st['profiles']
ways = st['ways']

X0, X1, Y0, Y1 = 1250, 3450, -380, 80
def in_box(w):
    return any(X0 <= x <= X1 and Y0 <= y <= Y1 for x, y in w.get('pts', []))

mw = [w for w in ways if in_box(w)]
print('Mall way:', len(mw))

def seg_len(p):
    return sum(math.hypot(p[i+1][0]-p[i][0], p[i+1][1]-p[i][1]) for i in range(len(p)-1))

# 空间哈希：把所有 way 的线段塞进 8 m 格子
CELL = 8.0
grid = collections.defaultdict(list)
segs = []   # (wi, ax, ay, bx, by)
for wi, w in enumerate(mw):
    p = w['pts']
    for k in range(len(p) - 1):
        ax, ay = p[k]; bx, by = p[k+1]
        idx = len(segs)
        segs.append((wi, ax, ay, bx, by))
        x0, x1 = min(ax, bx), max(ax, bx)
        y0, y1 = min(ay, by), max(ay, by)
        for cx in range(int(x0//CELL), int(x1//CELL)+1):
            for cy in range(int(y0//CELL), int(y1//CELL)+1):
                grid[(cx, cy)].append(idx)

def d_pt_seg(px, py, ax, ay, bx, by):
    dx, dy = bx-ax, by-ay
    L2 = dx*dx + dy*dy
    if L2 < 1e-12:
        return math.hypot(px-ax, py-ay), 0.0
    t = ((px-ax)*dx + (py-ay)*dy) / L2
    t = max(0.0, min(1.0, t))
    return math.hypot(px-(ax+dx*t), py-(ay+dy*t)), t

TOL = 0.35
pairs = collections.defaultdict(float)   # (wa,wb) -> overlap length
for wi, w in enumerate(mw):
    p = w['pts']
    # 每个顶点落点 + 每段中点，双向统计
    probes = list(p) + [((p[k][0]+p[k+1][0])*0.5, (p[k][1]+p[k+1][1])*0.5) for k in range(len(p)-1)]
    step = seg_len(p) / max(1, len(probes) - 1)
    for (px, py) in probes:
        key = (int(px//CELL), int(py//CELL))
        seen = set()
        for si in grid.get(key, ()):
            wj, ax, ay, bx, by = segs[si]
            if wj == wi or wj in seen:
                continue
            # 只查以该点为中心的九宫格
            d, t = d_pt_seg(px, py, ax, ay, bx, by)
            if d <= TOL:
                seen.add(wj)
                a, b = (wi, wj) if wi < wj else (wj, wi)
                pairs[(a, b)] += step

overl = [(L, k) for k, L in pairs.items() if L > 15.0]
overl.sort(reverse=True)
print('重叠 >15 m 的配对:', len(overl))
tot = 0.0
for L, (a, b) in overl[:25]:
    wa, wb = mw[a], mw[b]
    print(f'  {L:8.1f} m  {wa.get("prof")}  <->  {wb.get("prof")}   '
          f'{wa.get("name")!r} / {wb.get("name")!r}')
for L, _ in overl:
    tot += L
print('总重叠长度(双向计) = %.0f m' % tot)

# 按 profile 对统计
cnt = collections.Counter()
for L, (a, b) in overl:
    pa, pb = mw[a].get('prof'), mw[b].get('prof')
    cnt[tuple(sorted((pa, pb)))] += 1
print('\n配对类型分布:')
for k, v in cnt.most_common(12):
    print('  ', k, v)
