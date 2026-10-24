# -*- coding: utf-8 -*-
"""
导出「路面下切栅格」web/assets/roads/cut.i16 —— 让地形在路廊范围内让位。

为什么需要它（用户投诉「路跟地融在一块、经常穿模」）：
    路面在 JS 里是零厚度 ribbon，高程取**中心线**附近的最高值（为了交叉口对齐，
    见 roads.js 的 RPAD 注释）。但一条路连人行道有 12~14 m 宽，山城般的地形
    在 6 m 网格上是斜的：外侧顶点还按中心线高度铺，周围地形却高出一两米，
    于是地形从路面上穿出来，看起来就是「路和地融在一起」。

    正确做法不是把路抬成高架（那会到处冒出假桥），而是**让地形让位** ——
    真实城市也是这么修的：道路切进坡里，两侧形成挖方边坡。

做法：
    1. 复刻 JS 的路面高程公式（中心线 ±3.2 m 五采样取最大，量化到 5 cm，+0.16 m）。
    2. 沿每条 way 每 2 m 取一个断面，把该断面高程写入它覆盖到的所有 6 m 栅格
       （含人行道宽度 + 0.8 m 余量）。多路交叠时取 max，与 JS 的「交叉口同高」一致。
    3. 存 Int16 厘米，-32768 = 该格没有路（取 max 时自然被真实高程盖掉）。

JS 端 terrain.js:applyRoadCut() 读它，把路廊内的地形顶点压到 `cut - 3 cm`。
"""

import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, HERE)

from export_web_roads import WALK_W, snap_ways, mark_grade_ends, grade_of, grade_at_point  # noqa: E402

TERRAIN_DIR = os.path.join(ROOT, 'web', 'assets', 'terrain')
OUT = os.path.join(ROOT, 'web', 'assets', 'roads', 'cut.i16')
OUT_SURF = os.path.join(ROOT, 'web', 'assets', 'roads', 'surf.i16')
STREETS = os.path.join(ROOT, 'data', 'streets', 'dc_streets.json')

RPAD = 3.2       # 与 roads.js 的 RPAD 一致
LIFT = 0.16      # 与 roads.js 的 LIFT 一致
SINK = 0.12      # 地形压到路面以下多少（留足插值余量，见下）
MARGIN = 2.2     # 路廊两侧额外余量

# 【surf.i16 的抬升量】：行人必须站在**铺装顶面**上，而不是地形上。
# 用户投诉「人的脚/半个身子在路面以下」的根因就在这里：
#   人行道 ribbon 的顶点 = 可见地面 + LIFT(0.16) + extraLift(0.30) = 地面 + 0.46 m，
#   而 ped.js 用的是 T.sampleHeight（纯地形），于是每个人的脚都埋在人行道板下面 0.46 m。
# 1.82 m 的人埋 0.46 m ≈ 小腿以下全没了；坡地上地形被下切 0.12 m，还要再多埋一截。
# 这里按路面层各自的抬升量写一份「可站立高度」，ped.js 取 max(地形, surf) 即可。
LIFT_WALK = 0.30  # roads.js 里人行道 walk 层的 extraLift
LIFT_PATH = 0.02  # roads.js 里步道 path 层的 extraLift

# 【为什么 SINK 不是 3 cm】地形是 6 m 一格的三角网，路面 ribbon 是 12 m 宽的一整条。
# 只有落在走廊里的顶点会被压低，外侧相邻顶点不会 —— 于是那两个顶点之间的三角面
# 是斜的，插值后仍可能高于路面，把路面"顶"出一个个小绿包（用户说的"路跟地融在
# 一起"）。压 12 cm + 两侧各留 2.2 m 余量，插值余量就够了。


def main():
    meta = json.load(open(os.path.join(TERRAIN_DIR, 'terrain.json'), encoding='utf-8'))
    g = meta['grid']
    x0, y1 = float(g['x0']), float(g['y1'])
    step = float(g['step_m'])
    cols, rows = int(g['cols']), int(g['rows'])
    H = np.fromfile(os.path.join(TERRAIN_DIR, 'height.i16'), dtype=np.int16)
    if H.size != cols * rows:
        raise SystemExit(f'height.i16 长度 {H.size} != {cols*rows}')
    Hm = H.reshape(rows, cols).astype(np.float32) * 0.01   # 米，row0 = 北

    def sample(x, plan_y):
        """复刻 terrain.js makeSampler：双线性，越界 0。"""
        fx = (x - x0) / step - 0.5
        fy = (y1 - plan_y) / step - 0.5
        c0 = math.floor(fx)
        r0 = math.floor(fy)
        tx, ty = fx - c0, fy - r0
        def at(c, r):
            c = min(max(c, 0), cols - 1)
            r = min(max(r, 0), rows - 1)
            return Hm[r, c]
        v00, v10 = at(c0, r0), at(c0 + 1, r0)
        v01, v11 = at(c0, r0 + 1), at(c0 + 1, r0 + 1)
        return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty

    st = json.load(open(STREETS, encoding='utf-8'))
    profs = st.get('profiles', {})
    ways = st['ways']
    snap_ways(ways, log=False)
    mark_grade_ends(ways)

    # 哨兵用 Int16 最小值：多路交叠要取 max，哨兵必须是「更小」才行
    NONE = -32768
    cut = np.full((rows, cols), NONE, dtype=np.int16)
    # surf = 该格**行人可站立的铺装顶面高程**（Int16 厘米）。
    # 与 cut 的区别：cut 是「把地形压到这里」，surf 是「人应该站在这里」。
    # road 层的路廊包含两侧人行道，人行道顶面 = 路面 + LIFT_WALK，所以对
    # road way 写 yy + LIFT_WALK；path way（OSM 步道，抬 0.02）写 yy + LIFT_PATH。
    # 多路交叠取 max（人永远不会站在更低的那个面上，也就不会陷进去）。
    surf = np.full((rows, cols), NONE, dtype=np.int16)

    def stamp_seg(ax, ay, bx, by, half, yy, lift=None):
        """把一段路（线段）覆盖到的格子写入路面高程。

        必须按**到线段的垂距**判定，不能用方框：6 m 格子的方框会把一条 12 m 宽的
        街灌成 24×24 m 的方块，全城 45% 的地形都被压低 —— 那是抹平城市，不是修路。

        lift 给定时同时写「可站立铺装面」= 该**格心**的 DTM + lift。
        必须逐格心取 DTM：拿断面中点算会在坡上把人格子抬高三米多。
        """
        pad = half + MARGIN
        c_lo = max(int(math.floor((min(ax, bx) - pad - x0) / step)), 0)
        c_hi = min(int(math.ceil((max(ax, bx) + pad - x0) / step)), cols - 1)
        r_lo = max(int(math.floor((y1 - max(ay, by) - pad) / step)), 0)
        r_hi = min(int(math.ceil((y1 - min(ay, by) + pad) / step)), rows - 1)
        if c_lo > c_hi or r_lo > r_hi:
            return 0
        v = int(round(yy * 100))
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy or 1e-9
        n = 0
        for r in range(r_lo, r_hi + 1):
            py = y1 - (r + 0.5) * step
            for c in range(c_lo, c_hi + 1):
                px = x0 + (c + 0.5) * step
                t = ((px - ax) * dx + (py - ay) * dy) / L2
                t = 0.0 if t < 0 else (1.0 if t > 1 else t)
                qx, qy = ax + dx * t, ay + dy * t
                if (px - qx) ** 2 + (py - qy) ** 2 <= pad * pad:
                    if v > cut[r, c]:
                        cut[r, c] = v
                    if lift is not None:
                        vt = int(round((sample(px, py) + lift) * 100))
                        if vt > surf[r, c]:
                            surf[r, c] = vt
                    n += 1
        return n

    n_stamp = 0
    for w in ways:
        pts = w.get('pts') or []
        if len(pts) < 2:
            continue
        pr = profs.get(w.get('prof'))
        if not pr:
            continue
        half = max(abs(float(q[0])) for q in pr)
        if half <= 0:
            continue
        is_road = str(w.get('prof', '')).startswith('profile_roads_')
        w_out = (half + WALK_W) if is_road else half
        g_of_way = grade_of(w) if is_road else 0.0
        # 【高架不切地形】高架桥本来就在地面之上，把地形切下去会凭空挖出一道沟，
        # 从下面看桥墩全部悬空。只有路堑（grade < 0）需要把地形切下去。
        if g_of_way > 0.5:
            continue
        for k in range(len(pts) - 1):
            ax, ay = pts[k]
            bx, by = pts[k + 1]
            L = math.hypot(bx - ax, by - ay)
            if L < 1e-6:
                continue
            # 按 <= 8 m 切块：每块用自己中点的路面高程，块内再用垂距判定。
            # 不按 2 m 逐点采样是为了避免几十万次 Python 循环，
            # 8 m 内的地形起伏 < 0.5 m，配上 5 cm 量化足够。
            nchunk = max(1, int(math.ceil(L / 8.0)))
            for t in range(nchunk):
                u0, u1 = t / nchunk, (t + 1) / nchunk
                sx, sy = ax + (bx - ax) * u0, ay + (by - ay) * u0
                ex, ey = ax + (bx - ax) * u1, ay + (by - ay) * u1
                mx, my = (sx + ex) / 2, (sy + ey) / 2
                m = max(sample(mx, my),
                        sample(mx + RPAD, my), sample(mx - RPAD, my),
                        sample(mx, my + RPAD), sample(mx, my - RPAD))
                yy = round(m * 20) / 20 + LIFT
                if g_of_way < -0.5:
                    # 路堑：地形必须切到路堑底以下，否则路面会被两侧土坡埋掉
                    yy += grade_at_point(w, mx, my)
                # 铺装顶面（人站的面）。与 roadmesh.js 真正写出来的顶点对齐：
                #   walk 顶点 y = gsurf(顶点) + LIFT + extraLift，gsurf = min(DTM, cut-0.12)。
                #   因为 cut = max5(DTM)+LIFT，cut-0.12 恒 >= DTM → gsurf == DTM。
                # 所以人行道实际顶面 = 该点 DTM + LIFT + LIFT_WALK。逐格心取 DTM，
                # 不能用断面中点（坡上会把人抬高三米多）。
                lift = LIFT + (LIFT_WALK if is_road else LIFT_PATH)
                n_stamp += stamp_seg(sx, sy, ex, ey, w_out, yy, lift=lift)

    cut.tofile(OUT)
    surf.tofile(OUT_SURF)
    n_road = int((cut != NONE).sum())
    n_s = int((surf != NONE).sum())
    print(f'[roadcut] {n_stamp} 个断面 → {n_road} 格有路 '
          f'({n_road / (cols * rows) * 100:.1f}%)，写出 {os.path.relpath(OUT, ROOT)}')
    print(f'[roadcut] 可站立铺装面 {n_s} 格 '
          f'({n_s / (cols * rows) * 100:.1f}%)，写出 {os.path.relpath(OUT_SURF, ROOT)}')


if __name__ == '__main__':
    main()
