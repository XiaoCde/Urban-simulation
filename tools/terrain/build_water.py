#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""水体边界条件（任务书 §5.3）—— landcover class 0 → water.json + bed.i16。

产出
----
data/derived/water.json       契约交付物：bodies[] 每项含
                              id / outline / bed_elevation_m / design_water_level_m
                              / normal_water_level_m / flow_direction
web/assets/water/water.json   同内容（web 直接 fetch）
web/assets/water/bed.i16      996×853 Int16 厘米。河道内有值 = 河床高程；
                              河道外 32767。terrain.js 用它把地形网格挖成河槽，
                              否则地形在河里是一块 -0.33 m 的平台，水面浮在上面
                              看不出河道，内涝仿真也没有容积。

水位来源（都有出处，不拍脑袋）
--------------------------
NOAA CO-OPS 基准站 8594900「Washington, DC」，epoch 1983-2001，benchmarks 用 NAVD88，
Station Datum 比 NAVD88 低 5.95 ft：
    MSL   6.10 ft → (6.10-5.95)*0.3048 =  0.046 m NAVD88  ← 常年水位
    MHHW  7.72 ft →  0.539 m                              ← 大潮高水位
    MLW   4.71 ft → -0.378 m；MLLW 4.55 ft → -0.427 m
FEMA「Floodplains - Base Flood Elevation」(DCGIS Environment_Flood/MapServer/5,
V_DATUM=NAVD88)：场景内最低 BFE = 12 ft = 3.658 m NAVD88 ← 设计水位（1% 年超越）

河床：3DEP 1 m DEM 是 hydro-flattened 产品，河道被压平成 -0.33 / -0.27 两个平台值
（那是航摄时刻的水面，不是河床），所以 bed_elevation_m 按经验剖面另造，字段
bed_source 里如实标注，不伪装成实测水下地形。
"""
import json
import os
import sys

import numpy as np
import rasterio
from rasterio.transform import Affine

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, HERE)
import tm  # noqa: E402,F401

DTM = os.path.join(ROOT, 'data', 'derived', 'terrain_dtm.tif')
LC = os.path.join(ROOT, 'data', 'derived', 'landcover.tif')
OUT_JSON = os.path.join(ROOT, 'data', 'derived', 'water.json')
WEB_DIR = os.path.join(ROOT, 'web', 'assets', 'water')

STEP = 6.0
COLS, ROWS = 996, 853

# ---- 水位（NAVD88 米）------------------------------------------------
MSL_M = 0.046
MHHW_M = 0.539
BFE_MIN_M = 3.658

# ---- 经验河深（m）----------------------------------------------------
DEPTH = {'potomac_main': 6.0, 'anacostia_river': 2.5}
DEFAULT_DEPTH = 1.2
AREA_MIN = 150.0        # 小于此值当喷泉/雨水口碎片，不入 bodies
HOLE_MIN = 40.0         # 小于此值的洞（桥墩缝）丢掉，减少三角化负担
MAX_CUT = 7.0           # 单点最大下切（m）。波托马克深槽经验值 6 m，留 1 m 余量


def dominant_level(z):
    """(水面高程, 平坦度, p20, p50, p80)。平坦度 = |z-mode| ≤ 0.35 的占比。

    hydro-flattened 的湖/河面 ≈ 0.8~1.0；沿程跌落的溪流会很低（<0.45）。
    """
    z = z[np.isfinite(z)]
    if z.size == 0:
        return 0.0, 0.0, 0.0, 0.0, 0.0
    p20 = float(np.percentile(z, 20))
    p50 = float(np.percentile(z, 50))
    p80 = float(np.percentile(z, 80))
    lo = float(np.floor(z.min() * 50) / 50.0)
    hi = float(np.ceil(z.max() * 50) / 50.0)
    if hi - lo < 0.02:
        lv = float(np.median(z))
    else:
        h, e = np.histogram(z, bins=np.arange(lo, hi + 0.02, 0.02))
        i = int(np.argmax(h))
        lv = float((e[i] + e[i + 1]) * 0.5)
    return lv, float((np.abs(z - lv) <= 0.35).mean()), p20, p50, p80


def ring_normals(ring):
    """闭合环（首尾不重复）每点的外法线。shapely 外环逆时针 → 右手法线 (dy,-dx) 朝外。"""
    p = np.asarray(ring, dtype=np.float64)
    a2 = float(np.sum(p[:, 0] * np.roll(p[:, 1], -1) - np.roll(p[:, 0], -1) * p[:, 1]))
    sign = 1.0 if a2 > 0 else -1.0
    d = np.roll(p, -1, axis=0) - np.roll(p, 1, axis=0)
    ln = np.hypot(d[:, 0], d[:, 1])
    ln[ln < 1e-9] = 1.0
    return np.stack([d[:, 1] / ln * sign, -d[:, 0] / ln * sign], axis=1)


def box_blur(a, r):
    """可分离盒式模糊（半径 r 格），用 cumsum 实现，无 scipy。"""
    k = 2 * r + 1
    pad = np.pad(a, r, mode='edge')
    c = np.cumsum(pad, axis=0)
    c = np.vstack([np.zeros((1, c.shape[1])), c])
    b = (c[k:] - c[:-k]) / k
    c = np.cumsum(b, axis=1)
    c = np.hstack([np.zeros((c.shape[0], 1)), c])
    out = (c[:, k:] - c[:, :-k]) / k
    return out


def interior_dist(mask, cap):
    """4 邻域迭代腐蚀求内部距离（1,2,...,cap）。没有 scipy，只能这样。"""
    dist = np.zeros(mask.shape, dtype=np.int16)
    cur = mask.copy()
    dist[cur] = 1
    it = 0
    while it < cap:
        it += 1
        e = cur.copy()
        e[1:, :] &= cur[:-1, :]
        e[:-1, :] &= cur[1:, :]
        e[:, 1:] &= cur[:, :-1]
        e[:, :-1] &= cur[:, 1:]
        e[0, :] = False
        e[-1, :] = False
        e[:, 0] = False
        e[:, -1] = False
        if not e.any():
            break
        cur = e
        dist[cur] = it + 1
    return dist, it


def ring_outside(mask, cap):
    """水面 mask 之外每一圈膨胀的环号 1..cap（岸上坡带用）。"""
    dist = np.zeros(mask.shape, dtype=np.int16)
    visited = mask.copy()
    cur = mask.copy()
    for it in range(1, cap + 1):
        d = np.zeros_like(cur)
        d[1:, :] |= cur[:-1, :]
        d[:-1, :] |= cur[1:, :]
        d[:, 1:] |= cur[:, :-1]
        d[:, :-1] |= cur[:, 1:]
        d &= ~visited
        if not d.any():
            break
        dist[d] = it
        visited |= d
        cur = d
    return dist


def block_mean_6(a):
    """5978×5120 → 853×996（6 m 块均值），行 0 = 最北。"""
    h, w = a.shape
    R, C = h // 6, w // 6
    return a[:R * 6, :C * 6].reshape(R, 6, C, 6).mean(axis=(1, 3))


def main():
    from rasterio.features import shapes as rio_shapes, rasterize
    from shapely.geometry import shape as mk_shape, Polygon

    with rasterio.open(DTM) as ds:
        dtm = ds.read(1).astype(np.float64)
        T = ds.transform
    with rasterio.open(LC) as ds:
        lc = ds.read(1)
    x0, y1 = float(T.c), float(T.f)
    H, W = dtm.shape
    print(f'DTM {dtm.shape}  x0={x0}  y1={y1}')

    water = (lc == 0)
    polys = []
    for geom, val in rio_shapes(water.astype(np.uint8), mask=water,
                                transform=T, connectivity=4):
        g = mk_shape(geom)
        if g.area >= AREA_MIN:
            polys.append(g)
    polys.sort(key=lambda g: -g.area)
    print(f'水体多边形 {len(polys)} 个（≥{AREA_MIN:.0f} m²）')

    # ---- 内部距离 → 河床斜坡因子 -------------------------------------
    dist1, n_it = interior_dist(water, 60)
    print(f'内部距离迭代 {n_it} 次，max = {dist1.max()} m')

    d6 = np.zeros((ROWS, COLS), dtype=np.float64)
    tmp = block_mean_6(dtm)
    d6[:tmp.shape[0], :tmp.shape[1]] = tmp
    T6 = Affine(STEP, 0.0, x0, 0.0, -STEP, y1)
    bed6 = np.full((ROWS, COLS), 32767, dtype=np.int16)

    bodies = []
    for i, g in enumerate(polys):
        minx, miny, maxx, maxy = g.bounds
        bw, bh = maxx - minx, maxy - miny
        # 斜坡宽度按水体尺寸走：60 m 的斜坡套在 20 m 的小池子上等于没有碗
        ramp = float(np.clip(0.5 * min(bw, bh), 4.0, 60.0))

        # 取样只取多边形内部（bbox 会把 L 形/斜向水体外面的坡地算进来）
        c0 = max(0, int(np.floor(minx - x0)))
        c1 = min(W, int(np.ceil(maxx - x0)) + 1)
        r0 = max(0, int(np.floor(y1 - maxy)))
        r1 = min(H, int(np.ceil(y1 - miny)) + 1)
        if c1 <= c0 or r1 <= r0:
            continue
        Tw = Affine(1.0, 0.0, x0 + c0, 0.0, -1.0, y1 - r0)
        wm = rasterize([(g, 1)], out_shape=(r1 - r0, c1 - c0), transform=Tw,
                       fill=0, all_touched=False).astype(bool)
        px = dtm[r0:r1, c0:c1][wm]
        if px.size < 8:
            continue
        lv, flat, p20, p50, p80 = dominant_level(px)

        if i == 0:
            bid, depth, flow, tidal = 'potomac_main', DEPTH['potomac_main'], [0.0, -1.0], True
        elif i == 1:
            bid, depth, flow, tidal = 'anacostia_river', DEPTH['anacostia_river'], [-0.78, -0.63], True
        else:
            bid, depth, flow, tidal = 'water_%02d' % i, DEFAULT_DEPTH, [0.0, 0.0], False

        # 沿程跌落的溪流：单一水位必然要么淹上游要么架空下游
        streamy = (not tidal) and (p80 - p20) > 1.0 and flat < 0.45

        if tidal:
            normal, design, srf = MSL_M, BFE_MIN_M, 'flat'
            lsrc = 'NOAA 8594900 MSL 6.10 ft = 0.046 m NAVD88'
            dsrc = 'FEMA BFE 12 ft NAVD88 = 3.658 m (1% annual chance, lowest in scene)'
            bed = normal - depth
        elif streamy:
            normal, design, srf = p50, p50 + 0.30, 'follow_terrain'
            lsrc = 'DEM median %.2f m (falling stream, surface follows terrain)' % p50
            dsrc = 'stream: median + 0.30 m'
            bed = p20 - depth
        else:
            normal, design, srf = lv, lv + 0.30, 'flat'
            lsrc = 'DEM hydro-flattened plateau %.2f m (histogram mode)' % lv
            dsrc = 'normal + 0.30 m freeboard (inland pond, no tidal datum)'
            bed = normal - depth

        # ---- 轮廓：外环 + 洞 -----------------------------------------
        # 【关键】landcover class 0 来自 1 m 栅格，rasterio.features.shapes 出的
        # 边界是 1 m 的轴对齐台阶。之前用 simplify(0.6)，容差比台阶间距还小，
        # 一个台阶都删不掉 —— 这就是岸线上一排锯齿的真正来源（不是河床、不是
        # 湿滩带，反复隔离截图确认过）。
        # 先用 buffer(+1.2)/buffer(-1.2) 做形态学平滑把台阶抹圆，再简化为
        # 2.5 m 容差。小水体只用平滑不做大简化，避免把喷泉水池抹没。
        big = g.area > 20000.0
        sm = g.buffer(1.2).buffer(-1.2) if big else g.buffer(0.7).buffer(-0.7)
        if not isinstance(sm, Polygon) or sm.is_empty:
            sm = g
        cand_polys = [sm] if isinstance(sm, Polygon) else \
                     [p for p in getattr(sm, 'geoms', []) if isinstance(p, Polygon)]
        sm = max(cand_polys, key=lambda p: p.area) if cand_polys else g
        tol = 2.5 if big else 0.5
        simp = sm.simplify(tol, preserve_topology=True)
        if not isinstance(simp, Polygon):
            cand = [p for p in getattr(simp, 'geoms', []) if isinstance(p, Polygon)]
            simp = max(cand, key=lambda p: p.area) if cand else sm
        if simp.area < AREA_MIN or len(simp.exterior.coords) > 4000:
            simp = sm
        ring = np.round(np.asarray(simp.exterior.coords, dtype=np.float64)[:-1], 1)
        holes = []
        for h in simp.interiors:
            hp = np.asarray(h.coords, dtype=np.float64)[:-1]
            if len(hp) >= 3 and abs(_area2(hp)) * 0.5 >= HOLE_MIN:
                holes.append(np.round(hp, 1).tolist())
        if len(ring) > 6000:      # 19k 点的波托马克环会让三角化变慢，放过一次
            simp = sm.simplify(4.0, preserve_topology=True)
            if isinstance(simp, Polygon):
                ring = np.round(np.asarray(simp.exterior.coords, dtype=np.float64)[:-1], 1)

        # ---- 岸线过渡带：外法线方向 1.5~2.5 m（宽度随机，避免直线感）----
        nrm = ring_normals(ring)
        rng = np.random.default_rng(20251022 + i)
        fw = 1.5 + rng.random(len(ring)) * 1.0
        outer = np.round(ring + nrm * fw[:, None], 1)

        # ---- 场景窗口边界标记（edge[]）--------------------------------------
        # landcover class 0 在场景窗口处被**截断**，所以那里的「岸线」是数据
        # 边界、不是真河岸。波托马克南端有一条 885 m 的边正好压在窗口下边界
        # （y=-931）上，shoreline 从 [502,-931] 直线走到 [-383,-930]。
        # 水面必须画到窗口边（否则河里出现空白），但湿滩带如果沿这条直边铺，
        # 它整条贴在水平面上（lvl+0.06），在贴水视角里就是一条横穿水面的
        # 灰白直线（排查了很久，隔离图 out_z6_all / out_z6_tw 才定位到）。
        # 这里逐点标记，water.js 见到标 1 的四边形直接跳过不画。
        EDGE_TOL = 3.0
        wx1 = x0 + W * float(T.a)          # 数据右边界（1 m 栅格）
        wy0 = y1 - H * float(T.a)          # 数据下边界（注意不是 ROWS*STEP，
                                           # 6 m 网格比数据短 2 m）
        edge = ((np.abs(ring[:, 0] - x0) <= EDGE_TOL) |
                (np.abs(ring[:, 0] - wx1) <= EDGE_TOL) |
                (np.abs(ring[:, 1] - y1) <= EDGE_TOL) |
                (np.abs(ring[:, 1] - wy0) <= EDGE_TOL)).astype(np.int8)
        # ---- 水面网格用的轮廓：比真实岸线再外扩 EXPAND 米 ----------------
        # 【为什么要外扩】水面如果正好止于岸线，可见水线就是「多边形直边」，
        # 与 6 m 地形三角形交错，贴水面看必然是一排锯齿（试过 10+ 轮参数都
        # 消不掉）。正确做法是让水面**盖到岸坡下面**，由地形把它挡掉（深度
        # 测试），真实水线就变成「水平面与地形网格的相交等高线」——天然平滑，
        # 没有任何多边形直边。所以水面轮廓外扩，地形在岸外 2 环内抬回地面。
        # 外扩量要盖住整个岸坡抬升段（RAMP_RING*STEP=18 m），否则地形在
        # 水面之上抬升的那一段没有水盖着，又会出现干泥带。小水体按自身
        # 尺寸收着来，免得喷泉水池变成一片大湖。
        # 外扩量必须 ≥ 缓滩段宽度（SHELF_RINGS*STEP = 12 m），否则缓滩那圈
        # 被压到水面以下却没有水盖着，露出一圈「水下干坑」和直边水带
        # （EXPAND 收到 10 m 时贴水视角出现的深色直边楔形就是这个）。
        # 上限 24 m：再大就会把水面铺到远处陆地上。
        EXPAND = float(np.clip(0.12 * min(bw, bh), 14.0, 24.0))
        try:
            ext = sm.buffer(EXPAND, quad_segs=4)
            if not isinstance(ext, Polygon) or ext.is_empty:
                ext = sm
            extp = max([p for p in getattr(ext, 'geoms', [ext]) if isinstance(p, Polygon)],
                       key=lambda p: p.area)
            ring_w = np.round(np.asarray(extp.exterior.coords, dtype=np.float64)[:-1], 2)
            if len(ring_w) > 6000:
                ring_w = np.round(np.asarray(
                    extp.simplify(1.0, preserve_topology=True).exterior.coords,
                    dtype=np.float64)[:-1], 2)
        except Exception:
            ring_w = ring.copy()

        # ---- 河床：z = surface - depth * t，t 由内部距离/ramp 决定 ------
        #
        # 【坑】landcover class 0 在波托马克那条 1.62 km² 的多边形里，北端把
        # Rock Creek 上游（高程 40 m 以上）也连了进来；只按 normal(0.046) 挖，
        # 会把整片高地挖成 -5.95 m 的巨坑。所以挖之前必须加两道体检：
        #   ① 只挖「local ground 本来就在这个水体水位附近」的像素
        #      （GUARD 以内的岸坡允许，超过 4 m 的一律不是这个水体的水）；
        #   ② MAX_CUT 限制单点下切，防止任何一处出现不合理的深井。
        t1 = np.clip((dist1.astype(np.float64) - 1.0) / ramp, 0.0, 1.0)
        tb = np.clip(block_mean_6(t1), 0.0, 1.0)
        if tb.shape != (ROWS, COLS):
            pad = np.zeros((ROWS, COLS))
            pad[:tb.shape[0], :tb.shape[1]] = tb
            tb = pad
        m = rasterize([(g, 1)], out_shape=(ROWS, COLS), transform=T6,
                      fill=0, all_touched=True).astype(bool)
        # 【关键】挖槽范围必须用「画出来的那条轮廓」（外扩后的 ring_w），
        # 不能用原始 g。水面网格是 ring_w 三角化出来的：水面故意盖到岸坡下面，
        # 靠地形遮挡来形成真实水线。所以挖槽也按 ring_w 算，岸外再由 ramp
        # 把地形抬回地面。
        try:
            from shapely.geometry import Polygon as _Poly
            gdraw = _Poly(ring_w, holes)
            if not gdraw.is_valid:
                gdraw = gdraw.buffer(0)
            if isinstance(gdraw, Polygon) and not gdraw.is_empty:
                g = gdraw
                # 【坑·曾用 all_touched=False】栅格化只按「格心是否在面内」标记，
                # 于是多边形边界与 6 m 网格之间的那一条窄带格子**不被挖**，保持
                # 原地形高度（岸边 2~3 m），而相邻内侧格已挖到水下 → 沿整条岸线
                # 留下一道 1 格宽、高出水面 2~3 m 的土埂。贴水视角就是用户看到
                # 的那条横穿水面的浅灰亮线（诊断图 web/diag_above.png 里贴着
                # 岸线的红色细条，全图 5939 格）。
                # 改成 all_touched=True：只要多边形碰到就挖，配合下面的 shelf
                # 渐变，岸线处不再留未挖的格子。
                m = rasterize([(g, 1)], out_shape=(ROWS, COLS), transform=T6,
                              fill=0, all_touched=True).astype(bool)
        except Exception as e:      # 轮廓自交太严重时退回原始面，不让整个脚本挂掉
            print(f'  ! {bid}: 画出的轮廓无效（{e}），挖槽退回原始面')
        # 【关键】水面多边形是 shapely 的斜线边界，地形是 6 m 方格。若只在
        # 面内挖槽，斜向岸线上就有整格未被挖的地形从水面穿出来，形成一排露出
        # 水面的三角尖（反复截图确认）。所以挖槽范围向外膨胀，
        # 并在 rings 之内把岸边高差平滑抬回真实地形，做到「无台阶」。
        #
        # 【坑】dout 的上限必须 = SHELF_RINGS + RAMP_OUT，否则 t2 恒为 0，
        # 外接渐变完全不生效（曾把 dout 封在 SHELF_RINGS，白忙一轮）。
        SHELF_RINGS = 1          # 缓滩段 1 环（6 m）——2 环会让岸边出现 12 m 宽的
                                 # 浅灰平台，DC 的波托马克岸是驳岸/草坡，不该有沙滩
        RAMP_OUT = 5.0           # 再往外 5 环渐变抬回真实地形（30 m）
        N_RING = SHELF_RINGS + int(RAMP_OUT)
        dig = m.copy()
        for _ in range(N_RING):
            d = np.zeros_like(dig)
            d[1:, :] |= dig[:-1, :]
            d[:-1, :] |= dig[1:, :]
            d[:, 1:] |= dig[:, :-1]
            d[:, :-1] |= dig[:, 1:]
            dig |= d
        # dout=0 在面内，1..N_RING 是面外每一圈（每圈 6 m）
        dout = ring_outside(m, N_RING)
        near_shore = (dout > 0) | (tb <= 0.15)

        plausible = np.ones((ROWS, COLS), dtype=bool)
        if srf == 'flat':
            # 水位是平的，地面比水位高出 4 m 以上的地方肯定不是这个水体的水
            plausible = d6 <= (normal + 4.0)
        # 【关键·2026-10-24 修】不可信区（多边形里误连进来的高地）**一律不挖**。
        #
        # 原代码写 `z = np.where(plausible, z, np.minimum(normal - SINK, d6))`，
        # 本意是「只压到水面下 2 cm」，但 np.minimum 取的是两者更小值 ——
        # Rock Creek 上游 28 m 的地面被直接压到 -0.30 m，全城累计挖出
        # **2.44 km² / 最深 68.89 m** 的巨坑（实测 67,852 格）。
        # 这就是用户截图里「岸边一大片浅灰平板/纸片」「路浮在水面上」的根源：
        # 地形被削掉几十米，路面和水面却按原 DTM 摆，两者直接脱开。
        #
        # 正确做法：不可信 = 那里根本不是水。不挖，让真实地形留着 ——
        # 水面多边形（经过 14~24 m 外扩平滑）会在坡脚被地形自然切掉，
        # 看到的是「山坡伸进水里」，而不是「挖开的坑」。
        # 真正的岸边尖刺问题由下面的缓滩段（shelf + RAMP_OUT）解决，
        # 那一圈 d6 与 normal 只差一两米，本来就在 plausible 内。
        sel = dig & (bed6 == 32767)
        if srf == 'flat':
            sel = sel & plausible
        skipped = 0
        # 水面以下的下沉量：不能让河床贴着水面（1~2 cm 会与水面网格产生
        # 深度冲突，在斜看时表现为岸线上一排闪烁的锯齿）。压到 35 cm 以下，
        # 水面网格（平滑多边形）自然就是干净的水印。
        SINK = 0.35
        # 岸上格子必须高于水面多少（米）。取 0.25：既不会让水面多边形边缘
        # 出现水陆一层的深度冲突，也不会在岸边留下可见缝隙。
        EDGE_UP = 0.25
        if sel.any():
            if srf == 'follow_terrain':
                target = d6 - depth
            else:
                target = normal - depth
            # 从「岸边原地形」渐变到「河心 target」——tb=0 在岸线、1 在河心
            z = d6 + (target - d6) * tb
            if srf == 'flat':
                # 不可信区（多边形里误连进来的高地）只压到水面以下
                z = np.where(plausible, z, np.minimum(normal - SINK, d6))
                if dout.any():
                    # 【岸坡：消除锯齿的关键·第五版（定案）】
                    #
                    # 机制：可见水线 = 水平面 ∩ 6 m 三角网。每个三角形贡献一条
                    # 直线段，所以水线天生是折线；锯齿幅度 ≈ 岸坡斜率 × 6 m。
                    # Georgetown 岸 12 m 内抬 5~35 m（斜率 0.4~2.9）→ 锯齿
                    # 2.5~17 m，靠调「第几环」怎么都消不掉（out_sh_a/c/d 均证）。
                    #
                    # 前四版都在改环号/改混合比，**都没解决**，因为环号本身是
                    # 4 邻域膨胀出来的轴对齐整数，天然带台阶。
                    # 定案做法分两步：
                    #  ① 岸外 0~N_RING 环只抬 SMALL_RISE（0.85 m），把陡崖的
                    #     根部变成一段很缓的滩（这是 DC 河边真实存在的驳岸/滩涂）；
                    #     水线落在这一段里，因为坡缓 → 锯齿 < 0.2 m。
                    #  ② 整段 z 再做一次 box_blur，把残留的 6 m 台阶抹成连续
                    #     斜坡（模糊只作用于近岸带，不动远处真实地形）。
                    #
                    # 【代价】岸边约 18~48 m 会变成缓坡而不是原陡崖，视觉上是
                    # 「河滩」。为了岸线干净，这个取舍是必要的（§9 第 6 条）。
                    doutf = np.clip(dout.astype(np.float64) / float(SHELF_RINGS), 0.0, 1.0)
                    rs = doutf * doutf * (3.0 - 2.0 * doutf)          # smoothstep
                    # 缓滩段必须**跨过水位**：起点在水面下 SINK，终点抬到水面
                    # 之上 SMALL_RISE-SINK。这样可见水线落在这段 0.07 缓坡里，
                    # 锯齿幅度 ≈ 斜率×6 m ≈ 0.4 m，肉眼不可辨。
                    # 若 SMALL_RISE < SINK（如 0.22），整段都在水下，水线就跑到
                    # 后面陡的 RAMP_OUT 段上，锯齿全回来了。
                    SMALL_RISE = 0.85
                    shelf = (normal - SINK) + SMALL_RISE * rs
                    # 【棚区回到真实地形：必须也是渐变】
                    # 上一版在缓滩段末尾直接从 0.55 m 跳回真实岸高
                    # （Georgetown 5~35 m），那一圈就是一道直立的墙，墙顶又是
                    # 6 m 三角网的阶梯 —— 截图右侧那片锯齿就是这么来的。
                    # 现在在外侧再接 RAMP_OUT 环渐变抬回 d6。
                    t2 = np.clip((dout.astype(np.float64) - SHELF_RINGS) / RAMP_OUT, 0.0, 1.0)
                    t2 = t2 * t2 * (3.0 - 2.0 * t2)
                    d6s = box_blur(d6, 2)
                    near = (dout > 0) & (dout <= N_RING)
                    z = np.where(near, shelf * (1.0 - t2) + d6s * t2, z)
                    # 【坑·别再对 z 做模糊】曾写 z = where(near, box_blur(z,2), z)。
                    # 因为 near 外侧紧邻真实崖体（+5~35 m），5×5 平均会把崖高
                    # 拖进缓滩段，同时把缓滩内侧拉低到水位以下 → 水面沿 6 m
                    # 网格往外漫，水线又变回一格一格的锯齿。缓滩段本身已经是
                    # dout 的连续函数（smoothstep），不需要再抹。
                else:
                    z = np.minimum(z, normal - SINK)
            # 单点最大下切，杜绝巨坑
            z = np.maximum(z, np.minimum(d6, normal) - MAX_CUT)
            # 【只挖不填】对**水体内部**成立（不能把河底垫高）；但岸坡混合场
            # 必须允许「填」——台阶就是靠把低格子填上来抹平的。填的量限在
            # 原地形以上 FILL_MAX 米，免得岸上凭空长出一道墙。
            FILL_MAX = 6.0
            inside_water = m | (dout == 0)
            if srf == 'flat':
                # 【坑·这是「横穿水面的浅灰亮线」的真正根因】水面多边形内缘
                # 的 tb=0（interior_dist 在边界上就是 1），于是 z=d6，而 d6 是
                # 6 m 块均值，岸边那一格半陆半水（+1~3 m）→ 多边形内侧沿整条
                # 岸线留一圈高出水面 1~3 m 的土埂。水面多边形比岸线外扩了
                # EXPAND(14~24 m)，这圈土埂正好压在开阔水面上，就是那条亮线
                # （web/diag_above.png 里沿北岸/东岸的红色细条，5939 格）。
                # 水体内一律不许高于水位，只在岸外（dout>0）允许靠缓滩抬起来。
                z = np.where(inside_water,
                             np.minimum(z, np.minimum(d6, normal - SINK)),
                             np.minimum(z, d6 + FILL_MAX))
            else:
                z = np.where(inside_water, np.minimum(z, d6),
                             np.minimum(z, d6 + FILL_MAX))
            bed6[sel] = np.round(z[sel] * 100).astype(np.int16)

        bodies.append({
            'id': bid,
            'outline': ring_w.tolist(),
            'shoreline': ring.tolist(),
            'holes': holes,
            'bed_elevation_m': round(float(bed), 3),
            'design_water_level_m': round(float(design), 3),
            'normal_water_level_m': round(float(normal), 3),
            'flow_direction': flow,
            # ---- 溯源 / 渲染附加字段 ----
            'area_m2': round(float(g.area), 1),
            'center': [round(float(g.centroid.x), 1), round(float(g.centroid.y), 1)],
            'surface_mode': srf,
            'tidal': tidal,
            'dem_plateau_m': round(float(lv), 3),
            'dem_p20_m': round(float(p20), 3),
            'dem_p80_m': round(float(p80), 3),
            'flat_ratio': round(float(flat), 3),
            'depth_model_m': depth,
            'bed_ramp_m': round(ramp, 1),
            'level_source': lsrc,
            'design_source': dsrc,
            'bed_source': ('empirical cross-section: 3DEP 1 m DEM is hydro-flattened, '
                           'no public bathymetry available'),
            'fringe_outer': outer.tolist(),
            'shore_edge': edge.tolist(),
        })

    # ---- 落盘 ---------------------------------------------------------
    os.makedirs(WEB_DIR, exist_ok=True)
    bp = os.path.join(WEB_DIR, 'bed.i16')
    with open(bp, 'wb') as f:
        f.write(bed6.astype('<i2').tobytes())
    nz = bed6[bed6 != 32767]
    print(f'bed.i16 {os.path.getsize(bp)} B  有河床像素 {nz.size} '
          f'({nz.size / bed6.size * 100:.1f}%)  z {nz.min() / 100:.2f}..{nz.max() / 100:.2f} m')

    doc = {
        'grid': {'x0': x0, 'y1': y1, 'step_m': STEP, 'cols': COLS, 'rows': ROWS,
                 'layout': 'row-major, row 0 = north edge'},
        'vertical_datum': 'NAVD88',
        'flow_direction_convention': 'plan (+x east, +y north), unit vector',
        'levels': {
            'MSL_m': MSL_M, 'MHHW_m': MHHW_M, 'BFE_min_m': BFE_MIN_M,
            'tide_station': 'NOAA CO-OPS 8594900 Washington DC, epoch 1983-2001, NAVD88',
            'bfe_source': 'DCGIS Environment_Flood/MapServer/5, V_DATUM=NAVD88',
        },
        'bed_note': ('3DEP 1 m DEM is hydro-flattened (river reads -0.33/-0.27 m as a '
                     'flat plateau). bed_elevation_m and bed.i16 are synthesised from an '
                     'empirical depth model, not measured bathymetry.'),
        'bodies': bodies,
    }
    for p in (OUT_JSON, os.path.join(WEB_DIR, 'water.json')):
        with open(p, 'w', encoding='utf-8') as f:
            json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
        print(f'{p}  {os.path.getsize(p)} B')

    print('\n=== bodies ===')
    for b in bodies:
        print(f"{b['id']:<16} {b['surface_mode']:<14} area={b['area_m2']:>10.0f}  "
              f"normal={b['normal_water_level_m']:>7.3f}  design={b['design_water_level_m']:>7.3f}  "
              f"bed={b['bed_elevation_m']:>7.3f}  pts={len(b['outline']):<5} "
              f"holes={len(b['holes']):<3} ramp={b['bed_ramp_m']:>4.0f}")
    tot = sum(b['area_m2'] for b in bodies)
    print(f'\n合计 {tot / 1e6:.3f} km²，{len(bodies)} 个水体')


def _area2(p):
    return float(np.sum(p[:, 0] * np.roll(p[:, 1], -1) - np.roll(p[:, 0], -1) * p[:, 1]))


if __name__ == '__main__':
    main()
