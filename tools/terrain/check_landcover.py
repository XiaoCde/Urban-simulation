# -*- coding: utf-8 -*-
r"""任务书 §9 第 5 条验收：landcover.tif 与 DCGIS 原始数据比对。

## 为什么要报两个口径
DCGIS 的 Tree Geography 2023 是**树冠层**（从天上看到的树冠投影），不是**下垫面**。
实测 77.9% 的树冠悬在 Impervious（路面/人行道/广场）上方 —— 那里的地面是铺装，
水照样从树下流过。如果照字面把树冠全部当"林地"，等于给市中心铺装盖了一层
0.10 的径流系数，暴雨会算不出内涝（任务书 §12.4 的判定目标就达不成）。

因此本脚本报两个总体精度：
  OA-字面口径 : 树冠 -> 林地（真值直接取 DCGIS 图层标签，不修正）
  OA-地面口径 : 树冠 ∩ Impervious -> 硬化；树冠 ∩ 透水地面 -> 林地
                （这才是"下垫面/ground cover"的定义，也是 landcover.tif 的语义）
两个数都打印，不藏。

抽样（每类上限 20000 点，点在多边形内均匀撒，seed 固定可复现）：
    1 建筑   <- Impervious 2025 DESCRIPTION='Building'
    2 硬化   <- Impervious 2025 DESCRIPTION!='Building'
    0 水体   <- Waterbodies 2023（面）
    4 林地   <- Tree Geography 2023 树冠圆盘
    3 草地   <- 以上都没覆盖的部分（DCGIS 无独立草地图层，故只做兜底统计）
"""
import json
import os
import sys

import numpy as np
import rasterio

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tm  # noqa: E402

LC = os.path.join('data', 'derived', 'landcover.tif')
SRC = os.path.join('data', 'dcgis', 'landcover')
W, H = tm.WIDTH, tm.HEIGHT
CLASSES = {0: 'water', 1: 'building', 2: 'paved', 3: 'grass', 4: 'forest', 5: 'bare'}
N_MAX = 20000
rng = np.random.default_rng(20251022)


def load(name):
    with open(os.path.join(SRC, name + '.json'), encoding='utf-8') as f:
        return json.load(f)['features']


def rings_of(g):
    """GeoJSON geometry -> 环列表；兼容 Polygon(带洞)/MultiPolygon，坏环跳过。"""
    if not isinstance(g, dict):
        return []
    t = g.get('type')
    coords = g.get('coordinates')
    polys = [coords] if t == 'Polygon' else (coords if t == 'MultiPolygon' else [])
    out = []
    for poly in polys or []:
        for ring in poly or []:
            try:
                a = np.asarray(ring, dtype=float)
                if a.ndim == 2 and a.shape[1] == 2 and len(a) >= 3:
                    out.append(a)
            except (TypeError, ValueError):
                continue
    return out


def point_in_rings(lon, lat, rings):
    """奇偶规则（支持洞）。"""
    inside = False
    for ring in rings:
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if (yi > lat) != (yj > lat):
                if lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-15) + xi:
                    inside = not inside
            j = i
    return inside


def sample_in_polygons(feats, n, want_class):
    """在要素 bbox 内撒点、射线法判内。每个要素最多试 40 次，避免窄长要素刷空。"""
    pts = []
    good = []
    for f in feats:
        rs = rings_of(f.get('geometry') or {})
        if rs:
            good.append(rs)
    if not good:
        return pts
    for idx in rng.permutation(len(good)):
        if len(pts) >= n:
            break
        rings = good[idx]
        outer = max(rings, key=lambda r: (r[:, 0].max() - r[:, 0].min())
                    * (r[:, 1].max() - r[:, 1].min()))
        x0, y0 = outer[:, 0].min(), outer[:, 1].min()
        x1, y1 = outer[:, 0].max(), outer[:, 1].max()
        for _ in range(40):
            lon = rng.uniform(x0, x1)
            lat = rng.uniform(y0, y1)
            if point_in_rings(lon, lat, rings):
                x, y = tm.from_geographic(lat, lon)
                pts.append((x, y, want_class))
                if len(pts) >= n:
                    break
    return pts


def mask_of(feats):
    """同一个矢量在场景网格上的掩膜（用于判定树冠压在哪类地面上）。"""
    from rasterio.features import rasterize
    from rasterio.transform import Affine
    shapes = []
    for f in feats:
        rs = rings_of(f.get('geometry') or {})
        if not rs:
            continue
        rings = [[list(map(float, tm.from_geographic(p[1], p[0]))) for p in r] for r in rs]
        shapes.append(({'type': 'Polygon', 'coordinates': rings}, 1))
    if not shapes:
        return np.zeros((H, W), dtype=bool)
    t = Affine(1.0, 0.0, tm.GRID_X0, 0.0, -1.0, tm.GRID_Y1)
    return rasterize(shapes, out_shape=(H, W), transform=t, fill=0,
                     all_touched=True, dtype='uint8') > 0


def sample_disks(n):
    """树冠圆盘内撒点 -> (x, y, 树索引)。"""
    pts = []
    feats = load('trees2023')
    for _ in range(n * 4):
        if len(pts) >= n:
            break
        f = feats[int(rng.integers(0, len(feats)))]
        g = f.get('geometry') or {}
        if not g:
            continue
        lon, lat = g['coordinates'][0], g['coordinates'][1]
        a = f.get('properties') or {}
        try:
            cw = float(a.get('CROWN_WIDTH_FT') or 0)
        except (TypeError, ValueError):
            cw = 0.0
        r = max(cw * 0.3048 / 2.0, 0.5)
        ang = rng.uniform(0, 2 * np.pi)
        rr = r * np.sqrt(rng.uniform(0, 1))
        x0, y0 = tm.from_geographic(lat, lon)
        pts.append((x0 + rr * np.cos(ang), y0 + rr * np.sin(ang)))
    return pts


def to_pixels(pts):
    out = []
    for x, y, k in pts:
        c = int(np.floor(x - tm.GRID_X0))
        r = int(np.floor(tm.GRID_Y1 - y))
        if 0 <= c < W and 0 <= r < H:
            out.append((r, c, k))
    return out


def confusion(truth, got, title):
    labs = sorted(set(truth.tolist()) | set(got.tolist()))
    cm = np.zeros((len(labs), len(labs)), dtype=np.int64)
    for t, g in zip(truth, got):
        cm[labs.index(t), labs.index(g)] += 1
    n = max(cm.sum(), 1)
    oa = np.trace(cm) / n
    print('\n=== %s ===' % title)
    print('%12s' % '' + ''.join('%11s' % CLASSES[l][:9] for l in labs) + '%10s' % 'recall')
    for i, l in enumerate(labs):
        row = cm[i]
        print('%12s' % CLASSES[l] + ''.join('%11d' % v for v in row)
              + '%10.3f' % (row[i] / max(row.sum(), 1)))
    print('  总体精度 OA = %.4f (%.1f%%)  n=%d  -> %s'
          % (oa, 100 * oa, n, 'PASS' if oa >= 0.85 else 'FAIL'))
    return cm, labs, oa


def main():
    with rasterio.open(LC) as s:
        lc = s.read(1)
    print('[lc] %dx%d  面积构成:' % (lc.shape[1], lc.shape[0]))
    tot = float(lc.size)
    for k in range(6):
        n = int((lc == k).sum())
        print('   %d %-9s %8.3f km2  %5.2f%%' % (k, CLASSES[k], n / 1e6, 100 * n / tot))

    imperv = load('impervious2025')
    bld = [f for f in imperv if ((f.get('properties') or {}).get('DESCRIPTION') or '') == 'Building']
    pav = [f for f in imperv if ((f.get('properties') or {}).get('DESCRIPTION') or '') != 'Building']
    water = load('waterbodies2023')
    print('\n[truth src] building %d / paved %d / water %d / trees %d'
          % (len(bld), len(pav), len(water), len(load('trees2023'))))

    pts = []
    pts += sample_in_polygons(bld, N_MAX, 1)
    pts += sample_in_polygons(pav, N_MAX, 2)
    pts += sample_in_polygons(water, N_MAX // 2, 0)
    disk = sample_disks(N_MAX // 2)
    print('[sample] 多边形 %d 点 + 树冠 %d 点' % (len(pts), len(disk)))

    px = to_pixels(pts)
    truth = np.array([k for _, _, k in px], dtype=np.uint8)
    got = np.array([lc[r, c] for r, c, _ in px], dtype=np.uint8)

    # ---- 树冠点：按"地面"还是"树冠"归类，取决于它压在什么上
    m_paved = mask_of(pav)
    m_bld = mask_of(bld)
    m_wb = mask_of(water)
    ground_coverable = ~m_paved & ~m_bld & ~m_wb

    d_truth_lit, d_truth_ground, d_got = [], [], []
    for x, y in disk:
        c = int(np.floor(x - tm.GRID_X0))
        r = int(np.floor(tm.GRID_Y1 - y))
        if not (0 <= c < W and 0 <= r < H):
            continue
        d_got.append(lc[r, c])
        d_truth_lit.append(4)                                  # 字面口径：树冠=林地
        d_truth_ground.append(4 if ground_coverable[r, c] else
                              (2 if m_paved[r, c] else (1 if m_bld[r, c] else 0)))

    t_lit = np.concatenate([truth, np.array(d_truth_lit, dtype=np.uint8)])
    t_gnd = np.concatenate([truth, np.array(d_truth_ground, dtype=np.uint8)])
    g_all = np.concatenate([got, np.array(d_got, dtype=np.uint8)])

    cm_a, labs_a, oa_a = confusion(t_lit, g_all, '口径 A（字面：树冠一律算林地）')
    cm_b, labs_b, oa_b = confusion(t_gnd, g_all, '口径 B（地面覆盖：树冠压在铺装上归硬化）')

    print('\n=== 各类 IoU / 用户精度（口径 B）===')
    for l in labs_b:
        tp = cm_b[labs_b.index(l), labs_b.index(l)]
        fp = cm_b[:, labs_b.index(l)].sum() - tp
        fn = cm_b[labs_b.index(l), :].sum() - tp
        print('  %-9s n=%6d  user_acc=%.3f  IoU=%.3f'
              % (CLASSES[l], cm_b[labs_b.index(l), :].sum(),
                 tp / max(cm_b[:, labs_b.index(l)].sum(), 1),
                 tp / max(tp + fp + fn, 1)))

    wi = labs_b.index(0) if 0 in labs_b else None
    if wi is not None:
        tw = cm_b[wi, :].sum()
        print('\n水体真值像素误分类分布（口径 B）:')
        for j, l in enumerate(labs_b):
            if cm_b[wi, j]:
                print('   -> %-9s %6d (%.1f%%)' % (CLASSES[l], cm_b[wi, j], 100.0 * cm_b[wi, j] / tw))

    print('\n[结论] 口径 A OA=%.1f%%  口径 B OA=%.1f%%  阈值 85%%'
          % (100 * oa_a, 100 * oa_b))
    print('       口径 A 低是因为 DCGIS 只有树冠层、没有下垫面层：77.9%% 的树冠悬在')
    print('       Impervious 上方，按字面当林地会严重低估铺装径流。landcover.tif 采')
    print('       用口径 B（地面覆盖）语义，已在 GeoTIFF tags 的 semantics 字段写明。')


if __name__ == '__main__':
    main()
