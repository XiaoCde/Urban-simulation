# -*- coding: utf-8 -*-
"""
把 dc_streets.json 的 24,660 条路导出成 three.js 可用的带状网格（web/assets/roads/*）。

为什么 web 场景里"路面像纸糊的"：
    L2_road 这一层之前**根本没建**。画面上的灰色是 landcover 顶点色涂在 6 m 地形
    网格上，没有任何道路几何、没有沥青纹理、没有路缘。所以先要有真几何。

做法：
  - 每条 way 按 profile 的半宽向两侧偏移，生成 ribbon（n 点 -> 2n 顶点）。
  - 顶点只存 (x, -planY, u, v)，**高程 y 留 0，由 JS 用 terrain.sampleHeight 落地**。
    原因：地形网格是 6 m 双线性插值，若在 Python 里用 1 m DTM 算高程，
    路面会在地形起伏处悬空/穿模。
  - 沥青路（profile_roads_*）和硬质步道（profile_paths_*）分两个文件，
    各自一套材质。

产物（web/assets/roads/）：
  roads.mesh / roads.idx    沥青车道
  paths.mesh / paths.idx    人行道 / 步道 / 台阶
  roads.json                元数据（count/tile_m/宽度统计）

顶点布局 stride=6: [x, y(JS 里补), z, u, v, grade(高程偏移)]
"""

import json
import math
import os

import numpy as np

# 一张沥青贴图覆盖多少米（与 材质库.md 一致）
TILE_ASPHALT = 2.6   # 近景能看到沥青颗粒；6 m 一贴时平视像一块素色平板
TILE_PAVE = 1.7      # 人行道混凝土板缝约 1.7 m，与真实板宽一致
WALK_W = 1.8      # 每条车道两侧程序化长出的路缘石 + 人行道宽度（米）


# ---------------------------------------------------------------- 立体化（grade）
#
# 用户反馈：「你完全没有体现出立体感」「城市里肯定有立交桥」「路都是一节一节的」。
#
# OSM 的 way 没有高程，DC 的真实立交全靠人工；但 DC 的立体道路其实**就那么几条**，
# 而且名字就能认出来（数据里 hfcs = 'Other Freeway and Expressway' 共 28 条）：
#   +7.0  Whitehurst Freeway        —— 真实高架，悬在 K St 上方
#   +6.5  Potomac Freeway (I-395)   —— SW 滨江高架
#   -6.0  12th Street Expressway    —— 真·下沉路堑（从 Mall 底下穿过）
#   -5.5  9th Street Expressway     —— 同上
#   -5.0  E Street Expressway       —— 同上
# 其余一律 0（贴地）。宁可只做 5 条真的，也不要给全城乱加假高架。
GRADE_RULES = [
    ('whitehurst', 7.0),
    ('potomac freeway', 6.5),
    ('12th street expressway', -6.0),
    ('9th street expressway', -5.5),
    ('e street expressway', -5.0),
]
RAMP_LEN = 55.0   # 高架/路堑两端各用多少米爬到设计高程


def grade_of(w):
    nm = str(w.get('name') or '').lower()
    if not nm or str(w.get('prof', '')).startswith('profile_paths_'):
        return 0.0
    for key, g in GRADE_RULES:
        if key in nm:
            return g
    return 0.0


def _ep_key(x, y):
    return (round(float(x) / 6.0), round(float(y) / 6.0))


def mark_grade_ends(ways):
    """标记每条 graded way 的首/末点是否与另一条同等级 way 相连（相连就不用做坡）。"""
    ends = {}
    for wi, w in enumerate(ways):
        g = grade_of(w)
        if g == 0.0:
            continue
        pts = w.get('pts') or []
        if len(pts) < 2:
            continue
        for which, p in ((0, pts[0]), (1, pts[-1])):
            ends.setdefault(_ep_key(*p), []).append((wi, which))
    for wi, w in enumerate(ways):
        if grade_of(w) == 0.0:
            continue
        pts = w.get('pts') or []
        flags = []
        for which, p in ((0, pts[0]), (1, pts[-1])):
            peers = [e for e in ends.get(_ep_key(*p), []) if e[0] != wi]
            flags.append(bool(peers))
        w['_graded_ends'] = flags


def grade_profile(w):
    """返回这条 way 每个点的高程偏移（含两端 RAMP_LEN 的线性爬升）。"""
    g = grade_of(w)
    pts = w.get('pts') or []
    if g == 0.0 or len(pts) < 2:
        return None
    p = np.asarray(pts, dtype=np.float64)
    seg = np.hypot(*(p[1:] - p[:-1]).T)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    L = float(cum[-1])
    if L < 1e-6:
        return None
    cs, ce = w.get('_graded_ends', [False, False])
    ramp = min(RAMP_LEN, L * 0.45)
    f = np.ones_like(cum)
    if not cs and ramp > 1e-6:
        f = np.minimum(f, cum / ramp)
    if not ce and ramp > 1e-6:
        f = np.minimum(f, (L - cum) / ramp)
    np.clip(f, 0.0, 1.0, out=f)
    return (float(g) * f).astype(np.float32)


def grade_at_point(w, x, y):
    """沿 way 上离 (x,y) 最近的点取 grade（给 export_road_cut 用）。"""
    gp = grade_profile(w)
    if gp is None:
        return 0.0
    p = np.asarray(w['pts'], dtype=np.float64)
    d = (p[:, 0] - x) ** 2 + (p[:, 1] - y) ** 2
    return float(gp[int(np.argmin(d))])


def ribbon(pts, half_w, tile, off_l=None, off_r=None, grade=None):
    """把折线做成一圈一圈的带子，返回 (verts[n,6], tris[m,3])。

    off_l / off_r 是相对中心线的**有符号**偏移（正 = 左法线方向）。
    默认对称：左 +half_w、右 -half_w（车行道本身）。
    传入 off_l=half+WALK_W, off_r=half 就得到「左侧路缘石 + 人行道」那条带子。

    grade: 每个点的高程偏移（米），None = 全 0。正值 = 高架，负值 = 路堑。
    """
    p = np.asarray(pts, dtype=np.float64)
    # 去掉重合点，否则法线会 NaN
    keep = np.ones(len(p), dtype=bool)
    keep[1:] = np.hypot(*(p[1:] - p[:-1]).T) > 1e-6
    p = p[keep]
    n = len(p)
    if n < 2:
        return None, None

    gv_src = np.zeros(n, dtype=np.float64) if grade is None else np.asarray(grade, dtype=np.float64)[keep]

    # ---- 长段细分
    #
    # 【必须做，否则路面就是一块纸板】
    # OSM 里有些 way 只有两个端点，而这两点相距几百米（例如岸线步道、快速路
    # 的直线跨段、被简化过的路段）。ribbon 每个 way 点只产生一圈横断面，
    # 于是整段路只有首尾两圈 → 一个刚性四边形，高程按 way 点量化成常数，
    # 既不跟地形起伏，在坡上还会整片悬空/插进山里 —— 用户说的
    # 「路面像一层纸 / 河边的路飞到天上 / 桥一节一节」里，绝大多数是这一类。
    # 修法：把任何长于 MAX_SEG 的线段按等弧长插值补点，让横断面密度
    # 恒等于 MAX_SEG 米，路面自然就跟着地形走了。
    MAX_SEG = 6.0
    seg0 = p[1:] - p[:-1]
    seg0_len = np.hypot(seg0[:, 0], seg0[:, 1])
    if np.any(seg0_len > MAX_SEG):
        np_, ng_ = [p[0]], [gv_src[0]]
        for k in range(len(p) - 1):
            L = seg0_len[k]
            m = max(1, int(np.ceil(L / MAX_SEG)))
            for s in range(1, m + 1):
                t = s / m
                np_.append(p[k] * (1.0 - t) + p[k + 1] * t)
                ng_.append(gv_src[k] * (1.0 - t) + gv_src[k + 1] * t)
        p = np.asarray(np_)
        gv_src = np.asarray(ng_)
        n = len(p)

    seg = p[1:] - p[:-1]
    seg_len = np.hypot(seg[:, 0], seg[:, 1])
    seg_n = np.stack([-seg[:, 1] / seg_len, seg[:, 0] / seg_len], axis=1)  # 左法线

    nrm = np.zeros((n, 2))
    nrm[0] = seg_n[0]
    nrm[-1] = seg_n[-1]
    nrm[1:-1] = seg_n[:-1] + seg_n[1:]
    ln = np.hypot(nrm[:, 0], nrm[:, 1])
    ln[ln < 1e-9] = 1.0
    nrm /= ln[:, None]

    cum = np.concatenate([[0.0], np.cumsum(seg_len)])

    ol = half_w if off_l is None else off_l
    orr = -half_w if off_r is None else off_r
    width = abs(ol - orr)

    verts = np.zeros((n * 2, 6), dtype=np.float32)
    left = p + nrm * ol
    right = p + nrm * orr
    gv = gv_src.astype(np.float32)
    verts[0::2, 0] = left[:, 0]
    verts[0::2, 2] = -left[:, 1]
    verts[0::2, 3] = cum / tile
    verts[0::2, 4] = 0.0
    verts[0::2, 5] = gv
    verts[1::2, 0] = right[:, 0]
    verts[1::2, 2] = -right[:, 1]
    verts[1::2, 3] = cum / tile
    verts[1::2, 4] = width / tile
    verts[1::2, 5] = gv

    i = np.arange(n - 1)
    a = i * 2
    tris = np.concatenate([
        np.stack([a, a + 1, a + 2], axis=1),
        np.stack([a + 1, a + 3, a + 2], axis=1),
    ]).astype(np.uint32)
    return verts, tris


# ---------------------------------------------------------------- 路网连通
#
# 用户反馈的核心问题：「OSM 导进去的路是一段一段的，不是连起来的」。
# 这是数据本身的性质：OSM 在**每个交叉口**都会把一条路切成多条 way，
# 而且相邻 way 的端点常常差 1~15 m（绘图误差、不同编辑者、roundabout 拆段）。
# 直接按 way 分别生成 ribbon，得到的是一根根互不相连的带子：
#   - 交叉口中心是空的（四个端点各差几米，谁也不碰到谁）
#   - 路中段出现台阶（前后两段按下同的量化高程）
#   - 桥面被切成几截（见 export_web_bridges.py）
#
# 修法：**端点吸附**（endpoint snapping），分两轮：
#   1) 端点 → 端点：14 m 内的端点聚成一簇，全部移到簇心（union-find）。
#      交叉口、断头路、roundabout 接缝都靠这一轮闭合。
#   2) 残留孤立端点 → 最近的其他 way 顶点：30 m 内吸附过去。
#      专治 T 型路口（一条路终止在另一条路的**中段**，那里没有端点可配）。
# 吸附只动首/末顶点，不改中间形状，所以不会把路拉歪。
SNAP_EE = 14.0     # 端点-端点吸附半径（米）
SNAP_ET = 30.0     # 端点-道路顶点吸附半径（米）
GRID = 32.0        # 空间哈希格子


def _hash_key(x, y, cell=GRID):
    return (int(math.floor(x / cell)), int(math.floor(y / cell)))


def snap_ways(ways, log=True):
    """把 OSM 的碎段路吸附成连通路网（就地修改 way['pts']）。"""
    eps = []      # (way_index, end)  end=0 首点 / 1 末点
    pts_all = []  # 所有 way 的所有顶点（用于第二轮）
    for wi, w in enumerate(ways):
        p = w.get('pts') or []
        if len(p) < 2:
            continue
        eps.append((wi, 0))
        eps.append((wi, 1))
        pts_all.extend(p)
    if not eps:
        return

    def P(e):
        wi, end = e
        return ways[wi]['pts'][0 if end == 0 else -1]

    # ---- 第一轮：端点聚类（空间哈希 + 邻域搜索 + union-find）
    parent = list(range(len(eps)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    buckets = {}
    for i, e in enumerate(eps):
        x, y = P(e)
        buckets.setdefault(_hash_key(x, y), []).append(i)
    for i, e in enumerate(eps):
        x, y = P(e)
        kx, ky = _hash_key(x, y)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in buckets.get((kx + dx, ky + dy), ()):
                    if j <= i:
                        continue
                    x2, y2 = P(eps[j])
                    if (x - x2) ** 2 + (y - y2) ** 2 <= SNAP_EE ** 2:
                        union(i, j)

    clusters = {}
    for i in range(len(eps)):
        clusters.setdefault(find(i), []).append(i)

    moved = 0
    for members in clusters.values():
        if len(members) < 2:
            continue
        xs = [P(eps[i])[0] for i in members]
        ys = [P(eps[i])[1] for i in members]
        cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
        for i in members:
            wi, end = eps[i]
            w = ways[wi]
            p = w['pts']
            if end == 0:
                if math.dist(p[0], (cx, cy)) > 0.01:
                    moved += 1
                p[0] = (cx, cy)
            else:
                if math.dist(p[-1], (cx, cy)) > 0.01:
                    moved += 1
                p[-1] = (cx, cy)

    # ---- 第二轮：孤立端点吸到最近的其他 way 顶点（T 型路口）
    vgrid = {}
    for wi, w in enumerate(ways):
        for p in (w.get('pts') or []):
            vgrid.setdefault(_hash_key(p[0], p[1]), []).append((p[0], p[1], wi))

    tfix = 0
    for i, e in enumerate(eps):
        wi, end = e
        if len(clusters[find(i)]) > 1:
            continue                     # 第一轮已经闭合
        x, y = P(e)
        kx, ky = _hash_key(x, y)
        best, bd = None, SNAP_ET ** 2
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for (x2, y2, wj) in vgrid.get((kx + dx, ky + dy), ()):
                    if wj == wi:
                        continue
                    d = (x - x2) ** 2 + (y - y2) ** 2
                    if d < bd:
                        bd, best = d, (x2, y2)
        if best is not None:
            w = ways[wi]
            p = w['pts']
            p[0 if end == 0 else -1] = best
            tfix += 1

    if log:
        print(f'[roads] 路网吸附：端点聚簇 {sum(1 for m in clusters.values() if len(m) > 1)} 处，'
              f'移动 {moved} 个端点，T 型路口补齐 {tfix} 处')


# ---------------------------------------------------------------- 去重（治「蜘蛛网」）
#
# 【为什么必须做】
# 用户连续多轮投诉「整个平面全是浮在空中的蜘蛛网线条」。查了浮空顶点（bad=0）、
# 查了材质、查了隔离渲染，都不是。真正的来源是 **OSM 里大量 way 是共线重叠的**：
# 国家广场一带 1285 条 way 里就有 785 对相互重合 >15 m，累计双绘长度 22.4 km。
# 两条重合的路在完全相同的 y 上画同一张沥青贴图 → z-fighting，看上去就是
# 一层若隐若现的细网；再叠上两条路各自生成的白色边线 / 黄色中线，
# 草坪上就出现大片纵横交错的细深色线。
#
# 处理策略（保守，只在同类型之间做）：
#   1) 只比较 key 相同的 way（road 对 road、path 对 path），
#      不做 road↔path 的互相删除（人行道本来就贴着车行道）。
#   2) 只有当「较短的那条被对方覆盖的比例 >= DEDUP_COV」时才删，
#      短于 DEDUP_MIN_LEN 的碎段不参与（保留细部）。
#   3) 同长度时保留 id 小的，保证结果确定。
DEDUP_TOL = 0.35        # 中心线间距容差（米）
DEDUP_COV = 0.82        # 被判为重复所需的覆盖比例
DEDUP_MIN_LEN = 12.0    # 短于此长度的 way 不参与去重
DEDUP_CELL = 8.0


def _way_key(w):
    return 'road' if str(w.get('prof', '')).startswith('profile_roads_') else 'path'


def _plen(p):
    return sum(math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1])
               for i in range(len(p) - 1))


def _d_pt_seg(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 < 1e-12:
        return math.hypot(px - ax, py - ay), 0.0
    t = ((px - ax) * dx + (py - ay) * dy) / L2
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    return math.hypot(px - (ax + dx * t), py - (ay + dy * t)), t


def dedup_ways(ways, log=True):
    """去掉共线重复的 way（就地返回保留标记列表，不改 ways 的 pts）。"""
    n = len(ways)
    lens = [0.0] * n
    for i, w in enumerate(ways):
        p = w.get('pts') or []
        lens[i] = _plen(p) if len(p) >= 2 else 0.0

    # 只把「够长」的 way 的线段塞进空间哈希
    segs = []          # (wi, ax, ay, bx, by, key)
    grid = {}
    for i, w in enumerate(ways):
        if lens[i] < DEDUP_MIN_LEN:
            continue
        p = w['pts']
        k = _way_key(w)
        for j in range(len(p) - 1):
            ax, ay = p[j]
            bx, by = p[j + 1]
            si = len(segs)
            segs.append((i, ax, ay, bx, by, k))
            for cx in range(int(min(ax, bx) // DEDUP_CELL), int(max(ax, bx) // DEDUP_CELL) + 1):
                for cy in range(int(min(ay, by) // DEDUP_CELL), int(max(ay, by) // DEDUP_CELL) + 1):
                    grid.setdefault((cx, cy), []).append(si)

    drop = [False] * n
    ndrop = 0
    for i, w in enumerate(ways):
        if lens[i] < DEDUP_MIN_LEN:
            continue
        p = w['pts']
        # 沿本 way 等距布探针（步长 <= 4 m）
        probes = [p[0]]
        for j in range(len(p) - 1):
            ax, ay = p[j]
            bx, by = p[j + 1]
            L = math.hypot(bx - ax, by - ay)
            m = max(1, int(math.ceil(L / 4.0)))
            for s in range(1, m + 1):
                t = s / m
                probes.append((ax + (bx - ax) * t, ay + (by - ay) * t))
        cov = 0
        myk = _way_key(w)
        for (px, py) in probes:
            hit = False
            for si in grid.get((int(px // DEDUP_CELL), int(py // DEDUP_CELL)), ()):
                wi, ax, ay, bx, by, k = segs[si]
                if wi == i or k != myk:
                    continue
                # 对方必须「不比我短太多」，否则短碎段也能吃掉长路
                if lens[wi] < lens[i] * 0.75:
                    continue
                d, _t = _d_pt_seg(px, py, ax, ay, bx, by)
                if d <= DEDUP_TOL:
                    hit = True
                    break
            if hit:
                cov += 1
        if cov / len(probes) >= DEDUP_COV:
            drop[i] = True
            ndrop += 1

    if log:
        print(f'[roads] 去重：删除共线重复 way {ndrop} 条（容差 {DEDUP_TOL} m，覆盖 >= {DEDUP_COV:.0%}）')
    return drop


def main():
    out_dir = os.path.join('web', 'assets', 'roads')
    os.makedirs(out_dir, exist_ok=True)

    src = json.load(open('data/streets/dc_streets.json', encoding='utf-8'))
    profs = src['profiles']
    ways = src['ways']

    snap_ways(ways)
    mark_grade_ends(ways)
    n_graded = sum(1 for w in ways if grade_of(w) != 0.0)
    print(f'[roads] 立体道路 {n_graded} 条（高架/路堑）')

    # 去重：OSM 共线重复 way 会在同高度重复绘制 → z-fighting 细网
    drop = dedup_ways(ways)
    kept = [w for i, w in enumerate(ways) if not drop[i]]
    print(f'[roads] 保留 way {len(kept)} / {len(ways)}')

    groups = {'road': ([], [], 0), 'path': ([], [], 0), 'walk': ([], [], 0),
              'marky': ([], [], 0), 'markw': ([], [], 0)}

    # 标线几何：DC 的真实做法是宽路画中心双黄 + 两侧白边线，窄巷只画边线或什么都不画。
    # 完全靠贴图刷标线做不到 —— 一条 way 的宽度、车道数都不同，贴图会被拉伸。
    # 所以按 way 宽度程序化生成窄带（宽 0.14 m），用纯色材质，与路面完全不共面。
    YEL_W = 0.14          # 黄线宽度
    WHT_W = 0.14          # 白线宽度
    CENTER_MIN = 3.5      # 半宽 >= 3.5 m 就画中心双黄（DC 的住宅街半宽普遍 4~4.5 m，
                      # 原来的 4.6 把绝大多数街道排除在外，用户看到的就是「只有几条大路有黄线」）
    EDGE_MIN = 2.4        # 半宽 >= 2.4 m 就画白色边线

    def push(key, v, t):
        if v is None:
            return
        vl, tl, base = groups[key]
        vl.append(v)
        tl.append(t + base)
        groups[key] = (vl, tl, base + len(v))

    for w in kept:
        pr = profs.get(w['prof'])
        if not pr:
            continue
        half = max(abs(pr[0][0]), abs(pr[-1][0]))
        if half <= 0:
            continue
        is_road = w['prof'].startswith('profile_roads_')
        key = 'road' if is_road else 'path'
        tile = TILE_ASPHALT if is_road else TILE_PAVE
        gp = grade_profile(w) if is_road else None
        v, t = ribbon(w['pts'], half, tile, grade=gp)
        push(key, v, t)

        # 车行道两侧程序化长出「路缘石 + 人行道」。
        # 为什么必须程序化：DC 的 OSM 只给 1.3 万条独立 footway，绝大多数街道
        # 没有单独的人行道几何 —— 于是车道与建筑之间那条带子直接露出 6 m 地形
        # 顶点色（草地/硬化块状拼接），看起来就是「路面在穿模」。
        if is_road:
            v2, t2 = ribbon(w['pts'], half, TILE_PAVE,
                            off_l=half + WALK_W, off_r=half, grade=gp)
            push('walk', v2, t2)
            v3, t3 = ribbon(w['pts'], half, TILE_PAVE,
                            off_l=half, off_r=-half - WALK_W, grade=gp)
            push('walk', v3, t3)

            # ---- 标线
            if half >= EDGE_MIN:
                for sign in (1, -1):
                    e0 = sign * (half - 0.30)
                    e1 = sign * (half - 0.30 - WHT_W)
                    vw, tw = ribbon(w['pts'], half, 1.0, off_l=e0, off_r=e1)
                    push('markw', vw, tw)
            if half >= CENTER_MIN:
                for a, b in ((0.02, 0.02 + YEL_W), (-0.02, -0.02 - YEL_W)):
                    vy, ty = ribbon(w['pts'], half, 1.0, off_l=a, off_r=b)
                    push('marky', vy, ty)

    meta = {'count': {}, 'tile_m': {'road': TILE_ASPHALT, 'path': TILE_PAVE,
                                    'walk': TILE_PAVE},
            'walk_w_m': WALK_W}
    for key, (vl, tl, total) in groups.items():
        if not vl:
            continue
        V = np.concatenate(vl)
        T = np.concatenate(tl)
        V.tofile(os.path.join(out_dir, key + '.mesh'))
        T.tofile(os.path.join(out_dir, key + '.idx'))
        meta['count'][key] = {'verts': int(len(V)), 'tris': int(len(T))}
        print(f'  {key}: {len(V)} verts, {len(T)} tris')

    json.dump(meta, open(os.path.join(out_dir, 'roads.json'), 'w'), indent=1)
    print('[roads] 写出', out_dir)


if __name__ == '__main__':
    main()
