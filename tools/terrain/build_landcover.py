# -*- coding: utf-8 -*-
r"""栅格化 6 类下垫面 -> data\derived\landcover.tif（1 m UInt8，与 terrain_dtm 同网格）。
同时产出 data\derived\building_mask.tif（0/1 UInt8，水文用的建筑占据掩膜）。

分类定义（任务书 §5.1）：
    0 水体 / 1 建筑 / 2 硬化路面 / 3 草地 / 4 林地 / 5 裸土

## 语义约定（重要，决定了优先级）
landcover 描述的是**地面被什么覆盖**，不是"从天上往下看到什么"：
- 行道树的树冠悬在路面上方，但地面仍然是人行道 → 那一片算 class 2，不算 class 4。
  树冠的立体高度由 terrain_dsm.tif 负责，不在这里重复。
- 因此 林地的定义是「树冠 ∩ 非硬化 ∩ 非建筑 ∩ 非水体」，即长在透水地面上的树。

优先级（低 -> 高）：
    默认 3 草地
    <- 5 裸土（vacant lots）
    <- 4 林地（树冠圆盘，但只保留透水地面上的部分）
    <- 2 硬化（DCGIS Impervious 2025，排除 DESCRIPTION=Building）
    <- 1 建筑（场景轮廓 ∪ DCGIS Building，见下）
    <- 0 水体（DCGIS Waterbodies + 水系中线缓冲 + DTM 低洼连通域）

## 为什么建筑取并集
场景 out\dc_real3_clean.blend 的楼来自 OSM/blosm：21,943 栋、8.08 km2；
DCGIS Impervious 2025 的 Building 面：31,612 个、8.48 km2（DCGIS 把大型建筑群
拆成单体，OSM 常常一整块）。两者质心基本吻合（21,943 栋里 98.4% 的质心落在
DCGIS 建筑面内，零偏移最优 → 投影/配准没问题），差的是"楼的覆盖范围"：
DCGIS 有而场景没有 2.09 km2。

landcover / building_mask 是**水文产品**——§5.1 明确说"建筑占的地方水过不去"。
只要任一权威源认定是建筑，水就不该穿过去，所以这里取并集。
场景本身的楼（building_mask 的渲染用途、terrain_dsm）仍按场景轮廓单独留一份。
并集带来的差异写进 tags，等场景补楼后再收敛。
"""
import json
import os
import sys

import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.transform import Affine

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tm  # noqa: E402

SRC = os.path.join('data', 'dcgis', 'landcover')
DTM = os.path.join('data', 'derived', 'terrain_dtm.tif')
FOOT = os.path.join('data', 'derived', 'buildings_footprints.json')
OUT = os.path.join('data', 'derived', 'landcover.tif')
OUT_BM = os.path.join('data', 'derived', 'building_mask.tif')

W, H = tm.WIDTH, tm.HEIGHT
TRANSFORM = Affine(1.0, 0.0, tm.GRID_X0, 0.0, -1.0, tm.GRID_Y1)

NAMES = {0: 'water', 1: 'building', 2: 'paved', 3: 'grass', 4: 'forest', 5: 'bare'}
RUNOFF = {'0': 0.0, '1': 0.95, '2': 0.90, '3': 0.15, '4': 0.10, '5': 0.35}


def load(name):
    p = os.path.join(SRC, name + '.json')
    if not os.path.exists(p):
        print('  [warn] missing', p)
        return []
    with open(p, encoding='utf-8') as f:
        return json.load(f)['features']


def geom_to_mask(features, all_touched=True, value=1, dtype='uint8'):
    """GeoJSON(4326) -> 场景米制栅格掩膜。"""
    shapes = []
    for f in features:
        g = f.get('geometry')
        if not g:
            continue
        coords = g.get('coordinates')
        if not coords:
            continue
        shapes.append((coords, g['type']))
    if not shapes:
        return np.zeros((H, W), dtype=dtype)

    def conv(c):
        if isinstance(c[0], (int, float)):
            x, y = tm.from_geographic(c[1], c[0])
            return (float(x), float(y))
        return [conv(i) for i in c]

    polys = []
    for coords, typ in shapes:
        c = conv(coords)
        if typ == 'Polygon':
            polys.append({'type': 'Polygon', 'coordinates': c})
        elif typ == 'MultiPolygon':
            for p in c:
                polys.append({'type': 'Polygon', 'coordinates': p})

    if not polys:
        return np.zeros((H, W), dtype=dtype)

    return rasterize([(p, value) for p in polys], out_shape=(H, W),
                     transform=TRANSFORM, fill=0, all_touched=all_touched,
                     dtype=dtype)


def line_to_mask(features, width_m):
    """线要素按宽度缓冲 -> 掩膜（先栅格化线段本身，再用方形核膨胀）。"""
    segs = []
    for f in features:
        g = f.get('geometry') or {}
        if g.get('type') != 'LineString':
            continue
        pts = [tm.from_geographic(c[1], c[0]) for c in g['coordinates']]
        for a, b in zip(pts, pts[1:]):
            segs.append((float(a[0]), float(a[1]), float(b[0]), float(b[1])))
    m = np.zeros((H, W), dtype=np.uint8)
    if not segs:
        return m
    r = max(1, int(round(width_m / 2.0)))
    for x0, y0, x1, y1 in segs:
        n = max(2, int(max(abs(x1 - x0), abs(y1 - y0))) + 1)
        xs = np.linspace(x0, x1, n)
        ys = np.linspace(y0, y1, n)
        cols = np.round(xs - tm.GRID_X0).astype(np.int64)
        rows = np.round(tm.GRID_Y1 - ys).astype(np.int64)
        ok = (cols >= 0) & (cols < W) & (rows >= 0) & (rows < H)
        m[rows[ok], cols[ok]] = 1
    return dilate(m, r)


def dilate(m, r):
    """方形核膨胀（可分离，两次 1D 最大值滤波）。"""
    if r <= 0:
        return m
    a = m.copy()
    for _ in range(r):
        b = a.copy()
        b[1:, :] |= a[:-1, :]
        b[:-1, :] |= a[1:, :]
        a = b
    for _ in range(r):
        b = a.copy()
        b[:, 1:] |= a[:, :-1]
        b[:, :-1] |= a[:, 1:]
        a = b
    return a


def disks_mask(points):
    """点 + 半径 -> 圆盘掩膜（逐行跨度填充，避免 rasterize 的巨量多边形）。"""
    m = np.zeros((H, W), dtype=np.uint8)
    for (x, y, r) in points:
        if r < 0.3:
            continue
        c = int(round(x - tm.GRID_X0))
        rr = int(round(tm.GRID_Y1 - y))
        ri = int(np.ceil(r))
        if c + ri < 0 or c - ri >= W or rr + ri < 0 or rr - ri >= H:
            continue
        for dy in range(-ri, ri + 1):
            row = rr + dy
            if row < 0 or row >= H:
                continue
            half = int(np.floor(np.sqrt(max(0.0, r * r - dy * dy))))
            if half <= 0:
                continue
            c0 = max(0, c - half)
            c1 = min(W - 1, c + half)
            if c1 >= c0:
                m[row, c0:c1 + 1] = 1
    return m


def flood_low(dtm, seed, thr=1.0, max_iter=400):
    """从 seed 出发，在 dtm<thr 的连通域上迭代膨胀，补齐窄河/运河/低洼水面。"""
    allowed = dtm < thr
    cur = seed & allowed
    for i in range(max_iter):
        nxt = dilate(cur, 1) & allowed
        if np.array_equal(nxt, cur):
            print('    flood converged at iter', i)
            break
        cur = nxt
    return cur


def tree_points():
    pts = []
    for f in load('trees2023'):
        g = f.get('geometry') or {}
        if not g:
            continue
        c = g['coordinates']
        a = f.get('properties') or {}
        try:
            cw = float(a.get('CROWN_WIDTH_FT') or 0)
        except (TypeError, ValueError):
            cw = 0.0
        x, y = tm.from_geographic(c[1], c[0])
        pts.append((float(x), float(y), max(cw * 0.3048 / 2.0, 0.0)))
    return pts


def building_masks():
    """返回 (scene_mask, dcgis_mask, n_kept, n_ground, n_flat)。"""
    with open(FOOT, encoding='utf-8') as f:
        bd = json.load(f)
    bfeats = []
    n_ground = n_flat = 0
    for b in bd['features']:
        rings = b['rings']
        if not rings:
            continue
        # 基底 blend 里混进了非建筑要素：
        #   id='ground'  —— 整块地面平面（30.6 km2，会盖住全图）
        #   height_m<=0  —— 1476 个 plaza/平台（East Front Plaza 等），无体积
        if b['id'] == 'ground':
            n_ground += 1
            continue
        if not b.get('height_m') or b['height_m'] <= 0.0:
            n_flat += 1
            continue
        bfeats.append({'type': 'Polygon',
                       'coordinates': [[list(map(float, p)) for p in rings[0]]]})
    m_scene = np.zeros((H, W), dtype='uint8')
    if bfeats:
        m_scene = rasterize([(p, 1) for p in bfeats], out_shape=(H, W),
                            transform=TRANSFORM, fill=0, all_touched=True,
                            dtype='uint8')

    imperv = load('impervious2025')
    dcgis_bld = [f for f in imperv
                 if ((f.get('properties') or {}).get('DESCRIPTION') or '') == 'Building']
    m_dcgis = geom_to_mask(dcgis_bld)
    return m_scene, m_dcgis, len(bfeats), n_ground, n_flat


def main():
    with rasterio.open(DTM) as s:
        dtm = s.read(1)
        profile = s.profile.copy()

    imperv = load('impervious2025')

    # ---------- 各类掩膜 ----------
    m_bare = geom_to_mask(load('vacant_lots')) > 0
    m_canopy = disks_mask(tree_points()) > 0
    m_paved = geom_to_mask([f for f in imperv
                            if ((f.get('properties') or {}).get('DESCRIPTION') or '')
                            != 'Building']) > 0

    m_scene, m_dcgis, n_bld, n_ground, n_flat = building_masks()

    # 水体先算出来，下面判定建筑时要排除水面
    m_wb = geom_to_mask(load('waterbodies2023')) > 0
    m_ln = line_to_mask(load('hydro_lines2023'), 12.0) > 0
    seed = m_wb | m_ln
    low = flood_low(dtm, seed, thr=1.0)
    m_water = seed | low

    # 场景轮廓里有一部分是 OSM 把整块园区/广场画成了一栋楼：实测场景独有的
    # 1,696,460 px 中有 968,110 px（57.1%）落在 DCGIS Impervious 的非建筑面上。
    # 那些地方 DCGIS 认为是可下渗有限的铺装广场，水是能流过去的。
    # 所以场景轮廓只补"DCGIS 既不是建筑、也不是铺装/水面"的空缺（728,350 px），
    # 不覆盖 DCGIS 已判定为铺装的面 —— 以 DCGIS（专为雨洪做的官方数据集）为准。
    m_bld = (m_dcgis > 0) | ((m_scene > 0) & ~m_paved & ~m_water)

    # ---------- 合成（低 -> 高优先级） ----------
    lc = np.full((H, W), 3, dtype=np.uint8)            # 草地
    lc[m_bare] = 5                                      # 裸土
    m_forest = m_canopy & ~m_paved & ~m_bld & ~m_water   # 只在透水地面上的树冠
    lc[m_forest] = 4                                    # 林地
    lc[m_paved] = 2                                     # 硬化
    lc[m_bld] = 1                                       # 建筑（并集）
    lc[m_water] = 0                                     # 水体

    print('[5] bare      %8d px  %.3f km2' % (m_bare.sum(), m_bare.sum() / 1e6))
    print('[4] forest    %8d px  %.3f km2  (canopy %d px %.3f km2; %.1f%% 悬在硬化面上方归 class 2)'
          % (m_forest.sum(), m_forest.sum() / 1e6, m_canopy.sum(), m_canopy.sum() / 1e6,
             100.0 * (m_canopy & m_paved).sum() / max(m_canopy.sum(), 1)))
    print('[2] paved     %8d px  %.3f km2  (DCGIS Impervious 2025, 排除 Building)'
          % (m_paved.sum(), m_paved.sum() / 1e6))
    print('[1] building  %8d px  %.3f km2  (scene %d px %.3f km2 | DCGIS %d px %.3f km2 '
          '| union, DCGIS-only +%d px  %.3f km2)'
          % (m_bld.sum(), m_bld.sum() / 1e6,
             m_scene.sum(), m_scene.sum() / 1e6,
             m_dcgis.sum(), m_dcgis.sum() / 1e6,
             int((m_dcgis > 0).sum() - ((m_dcgis > 0) & (m_scene > 0)).sum()),
             ((m_dcgis > 0) & ~(m_scene > 0)).sum() / 1e6))
    print('    建筑过滤: ground=%d, height<=0 plaza=%d, 保留场景轮廓 %d 栋'
          % (n_ground, n_flat, n_bld))
    print('[0] water      %8d px  %.3f km2  (vector %d px, flood +%d px)'
          % (m_water.sum(), m_water.sum() / 1e6, seed.sum(), int(m_water.sum() - seed.sum())))

    # ---------- 写盘 ----------
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    profile.update(driver='GTiff', dtype='uint8', count=1, nodata=None,
                   compress='deflate', tiled=True, blockxsize=256, blockysize=256)
    with rasterio.open(OUT, 'w', **profile) as d:
        d.write(lc, 1)
        d.update_tags(
            grid='x -1277..4701, y -931..4189, 1 m, pixel-center',
            origin_lat=str(tm.LAT0), origin_lon=str(tm.LON0),
            projection='blosm spherical transverse mercator, k=1, R=6378137',
            vertical_datum='NAVD88 (from terrain_dtm)',
            classes='0 water / 1 building / 2 paved / 3 grass / 4 forest / 5 bare',
            semantics='ground-cover: 树冠悬在路面上方的部分仍归 class 2；树高见 terrain_dsm',
            building_source='DCGIS Impervious 2025 Building (31612) UNION scene footprints '
                            '(21943, 仅在 DCGIS 非铺装/非水面处补充 0.73 km2); '
                            '场景独有但 DCGIS 判为铺装的 0.97 km2 按铺装计',
            source='DCGIS Impervious 2025 + Planimetrics 2023 Waterbodies/Hydrography '
                   '+ Tree Geography 2023 + vacant lots + buildings_footprints.json',
        )
    print('[out]', OUT, '%.1f MB' % (os.path.getsize(OUT) / 1e6))

    with rasterio.open(OUT_BM, 'w', **profile) as d:
        d.write(m_bld.astype('uint8'), 1)
        d.update_tags(
            grid='x -1277..4701, y -931..4189, 1 m, pixel-center',
            origin_lat=str(tm.LAT0), origin_lon=str(tm.LON0),
            values='0 not building / 1 building (blocks water)',
            source='DCGIS Impervious 2025 Building UNION scene footprints '
                   '(仅在 DCGIS 非建筑/非铺装/非水面处补充)',
            note='水文掩膜：建筑占的地方水过不去；与 terrain_dsm 的建筑集可能不同',
        )
    print('[out]', OUT_BM, '%.1f MB' % (os.path.getsize(OUT_BM) / 1e6))

    with open(os.path.join('data', 'derived', 'impervious.json'), 'w',
              encoding='utf-8') as f:
        json.dump(RUNOFF, f, indent=1)

    tot = H * W
    stats = {}
    print('\\n=== landcover.tif 面积构成 ===')
    for k in range(6):
        n = int((lc == k).sum())
        stats[NAMES[k]] = round(n / 1e6, 4)
        print('  %d %-9s %8.3f km2  %5.2f%%' % (k, NAMES[k], n / 1e6, 100.0 * n / tot))
    print('  total      %8.3f km2' % (tot / 1e6))
    print('[done]', '%.1f MB' % (os.path.getsize(OUT) / 1e6))


if __name__ == '__main__':
    main()
