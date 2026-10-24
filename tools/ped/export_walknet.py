# -*- coding: utf-8 -*-
r"""从 OSM 街道导出一条供网页行人寻路用的「人行道网络」（assets/ped/walknet.json）。

为什么人不能直接沿车行道中心线走：
  真实街道两侧各有一条人行道，`export_web_roads.py` 也是这么长出来的
  （off_l = half + WALK_W）。行人系统如果沿中心线走，人会走在马路正中间，
  一眼假。所以这里对每条车行道生成**左右两条偏移折线**（偏移 = half + WALK_W/2），
  再加上 OSM 里独立的 footway / pedestrian / steps / cycleway 中心线。

产物结构（尽量小）：
  { "nodes": [[x, z], ...], "chains": [[i0, i1, ...], ...], "meta": {...} }
  —— 坐标是场景米制 plan(x,y)，网页里 z = -y。
  —— chain 是折线，相邻节点之间是一条可行走边；运行时按 chain 走。
"""
import json
import os
import math

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.join(ROOT, 'data', 'streets', 'dc_streets.json')
OUT_DIR = os.path.join(ROOT, 'web', 'assets', 'ped')
WALK_W = 1.8          # 必须与 export_web_roads.py 的 WALK_W 一致
SNAP = 6.0            # 端点合并半径（米）
EPS = 0.8             # 折线简化容差（米）
MIN_CHAIN_LEN = 12.0  # 短于此的 chain 直接丢掉（没意义、还增加节点数）


def load():
    d = json.load(open(SRC, encoding='utf-8'))
    return d['profiles'], d['ways']


def half_of(prof):
    pr = prof
    return max(abs(pr[0][0]), abs(pr[-1][0]))


def offset_line(pts, off):
    """把折线整体法向平移 off 米（左正右负）。逐段做法向，顶点取相邻两段的平均法向。"""
    n = len(pts)
    if n < 2:
        return None
    seg_n = []
    for i in range(n - 1):
        dx = pts[i + 1][0] - pts[i][0]
        dy = pts[i + 1][1] - pts[i][1]
        L = math.hypot(dx, dy)
        if L < 1e-9:
            seg_n.append((0.0, 0.0))
        else:
            seg_n.append((-dy / L, dx / L))   # 左法向
    out = []
    for i in range(n):
        if i == 0:
            nx, ny = seg_n[0]
        elif i == n - 1:
            nx, ny = seg_n[-1]
        else:
            ax, ay = seg_n[i - 1]
            bx, by = seg_n[i]
            nx, ny = ax + bx, ay + by
            L = math.hypot(nx, ny)
            if L < 1e-9:
                nx, ny = seg_n[i]
            else:
                nx, ny = nx / L, ny / L
        out.append([pts[i][0] + nx * off, pts[i][1] + ny * off])
    return out


def rdp(pts, eps):
    """Ramer–Douglas–Peucker。街道折线大多数只有 4 个点，这一步主要是去掉共线点。"""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy)
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if L < 1e-9:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs((px - ax) * dy - (py - ay) * dx) / L
            if d > best:
                best, bi = d, i
        if best > eps:
            keep[bi] = True
            stack.append((a, bi))
            stack.append((bi, b))
    return [p for p, k in zip(pts, keep) if k]


def chain_len(pts):
    return sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
               for i in range(len(pts) - 1))


class Snapper:
    """端点合并：把互相在 SNAP 半径内的端点归到同一个节点。"""

    def __init__(self, cell=8.0):
        self.cell = cell
        self.buckets = {}
        self.nodes = []       # [[x,y], ...]
        self.used = []        # 每节点已挂的 chain 数（用来挑「路口」）

    def get(self, x, y):
        cx, cy = int(math.floor(x / self.cell)), int(math.floor(y / self.cell))
        best, bi = SNAP * SNAP, -1
        for gx in (cx - 1, cx, cx + 1):
            for gy in (cy - 1, cy, cy + 1):
                for idx in self.buckets.get((gx, gy), ()):
                    nx, ny = self.nodes[idx]
                    d = (nx - x) ** 2 + (ny - y) ** 2
                    if d < best:
                        best, bi = d, idx
        if bi >= 0:
            return bi
        i = len(self.nodes)
        self.nodes.append([x, y])
        self.used.append(0)
        self.buckets.setdefault((cx, cy), []).append(i)
        return i


def main():
    profs, ways = load()
    os.makedirs(OUT_DIR, exist_ok=True)
    snap = Snapper()
    chains = []
    n_ways_used = 0

    for w in ways:
        pr = profs.get(w['prof'])
        if not pr:
            continue
        pts = w['pts']
        if len(pts) < 2:
            continue
        is_road = w['prof'].startswith('profile_roads_')
        half = half_of(pr)
        lines = []
        if is_road:
            # 两侧人行道中心线。人行道本身由 roads 层按 half..half+WALK_W 铺出。
            for off in (half + WALK_W * 0.5, -(half + WALK_W * 0.5)):
                L = offset_line(pts, off)
                if L:
                    lines.append(L)
        else:
            lines.append([[p[0], p[1]] for p in pts])

        for L in lines:
            L = rdp(L, EPS)
            if chain_len(L) < MIN_CHAIN_LEN:
                continue
            ids = [snap.get(p[0], p[1]) for p in L]
            clean = [ids[0]]
            for i in ids[1:]:
                if i != clean[-1]:
                    clean.append(i)
            if len(clean) < 2:
                continue
            chains.append(clean)
            for i in clean:
                snap.used[i] += 1
            n_ways_used += 1

    nodes = [[round(p[0], 1), round(p[1], 1)] for p in snap.nodes]
    doc = {
        'nodes': nodes,
        'chains': chains,
        'meta': {
            'ways_used': n_ways_used,
            'nodes': len(nodes),
            'chains': len(chains),
            'snap_m': SNAP,
            'eps_m': EPS,
            'walk_w_m': WALK_W,
            'coord': 'plan (x, y); three z = -y',
        },
    }
    p = os.path.join(OUT_DIR, 'walknet.json')
    json.dump(doc, open(p, 'w', encoding='utf-8'), separators=(',', ':'))
    sz = os.path.getsize(p) / 1e6
    deg = {}
    for c in chains:
        for i in (c[0], c[-1]):
            deg[i] = deg.get(i, 0) + 1
    inter = sum(1 for v in deg.values() if v >= 3)
    print('[walknet] ways %d -> nodes %d chains %d  路口(deg>=3) %d  文件 %.2f MB'
          % (n_ways_used, len(nodes), len(chains), inter, sz))


if __name__ == '__main__':
    main()
