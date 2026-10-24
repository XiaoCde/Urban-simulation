"""
导出真实树冠点（DCGIS Urban Tree Canopy 2023）到 web 资产。

为什么用这份数据而不是「随机撒树」：
    trees2023 有 36,620 棵**实测**树，每棵带 HEIGHT_FT（树高）、CROWN_WIDTH_FT
    （冠幅）、DBH（胸径）、SCI_NM（学名）。行道树、公园树、庭院树的位置和体量
    都是真的 —— 这是把「一堆盒子」读成「一座城市」最划算的一步：
    一个 InstancedMesh 就能画完全城，几乎不花 draw call。

输出：
    web/assets/trees/trees.mesh   每棵 4 个 float32：x, z(three 坐标), height_m, crown_m
    web/assets/trees/trees.json  {count, note, bbox}

坐标系：场景米制（planY → three 的 z = -planY），与 buildings.mesh 同一套。
"""
import io
import json
import math
import os
import struct

import numpy as np
import rasterio

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.join(ROOT, 'data', 'dcgis', 'landcover', 'trees2023.json')
OUT_DIR = os.path.join(ROOT, 'web', 'assets', 'trees')
DTM = os.path.join(ROOT, 'data', 'derived', 'terrain_dtm.tif')

WIN_X0, WIN_Y0 = -1277.0, -931.0
WIN_X1, WIN_Y1 = 4701.0, 4189.0

# 冠幅/树高的合理范围（ft）。DCGIS 有 DBH=0 的树苗与个别异常值，
# 直接用会让几棵树变成 30 m 的大蘑菇。
H_MIN, H_MAX = 8.0, 90.0
CW_MIN, CW_MAX = 4.0, 70.0
FT = 0.3048


def main():
    print('[trees] 读', SRC)
    d = json.load(io.open(SRC, encoding='utf-8'))
    feats = d['features'] if isinstance(d, dict) else d
    print('[trees] 要素', len(feats))

    # 场景坐标：先用与 buildings 相同的 TM 变换（tm.from_geographic 的反算），
    # 这里直接复用 tools/terrain/tm.py 的投影参数。
    import sys
    sys.path.insert(0, os.path.dirname(__file__))
    import tm as T

    dtm = rasterio.open(DTM)
    assert dtm.crs is not None
    H, W = dtm.height, dtm.width
    tr = dtm.transform
    z = dtm.read(1)

    rows = []
    skipped = {'out': 0, 'bad': 0}
    for f in feats:
        g = f.get('geometry') or {}
        c = g.get('coordinates')
        if not c:
            skipped['bad'] += 1
            continue
        lon, lat = float(c[0]), float(c[1])
        if not (-77.13 < lon < -76.93 and 38.83 < lat < 38.98):
            skipped['bad'] += 1
            continue
        p = f.get('properties') or {}
        try:
            hf = float(p.get('HEIGHT_FT') or 0)
            cw = float(p.get('CROWN_WIDTH_FT') or 0)
        except (TypeError, ValueError):
            skipped['bad'] += 1
            continue
        if not (H_MIN <= hf <= H_MAX) or not (CW_MIN <= cw <= CW_MAX):
            skipped['bad'] += 1
            continue
        x, y = T.from_geographic(lat, lon)
        if not (WIN_X0 < x < WIN_X1 and WIN_Y0 < y < WIN_Y1):
            skipped['out'] += 1
            continue
        # 落地点：按 DTM 采样（树必须站在地上，不能浮空）
        cc = int((x - tr.c) / tr.a)
        rr = int((tr.f - y) / tr.a)
        if not (0 <= rr < H and 0 <= cc < W):
            skipped['out'] += 1
            continue
        base = float(z[rr, cc])
        if base < -900 or base > 200:
            skipped['bad'] += 1
            continue
        rows.append((x, -y, base + hf * FT, cw * FT))

    a = np.asarray(rows, dtype=np.float32)
    print('[trees] 保留 %d 棵，跳过 %s' % (len(a), skipped))
    if len(a) == 0:
        raise SystemExit('没有可用树点')

    os.makedirs(OUT_DIR, exist_ok=True)
    # 每棵 5 个 float：x, z, 树顶 y, 冠幅 m, 落地 y
    out = np.empty((len(a), 5), dtype=np.float32)
    out[:, 0] = a[:, 0]     # x
    out[:, 1] = a[:, 1]     # z (= -planY)
    out[:, 2] = a[:, 2]     # top y
    out[:, 3] = a[:, 3]     # crown m
    out[:, 4] = a[:, 2] - 0.0  # 占位，落地 y 在下面重算
    # 落地 y：top - height
    heights = (a[:, 2] - 0.0)
    # 回读 DTM 求落地高程
    for i in range(len(a)):
        x, yy = float(a[i, 0]), float(-a[i, 1])
        cc = int((x - tr.c) / tr.a)
        rr = int((tr.f - yy) / tr.a)
        out[i, 4] = float(z[rr, cc])

    bin_path = os.path.join(OUT_DIR, 'trees.mesh')
    out.tofile(bin_path)

    meta = {
        'count': int(len(out)),
        'stride_floats': 5,
        'layout': ['x', 'z', 'top_y', 'crown_m', 'base_y'],
        'source': 'DCGIS Urban Tree Canopy 2023 (Urban_Tree_Canopy/MapServer/44)',
        'note': '实测树高 HEIGHT_FT / 冠幅 CROWN_WIDTH_FT，落地高程由 terrain_dtm 采样',
        'bbox': [float(out[:, 0].min()), float(out[:, 1].min()), float(out[:, 0].max()), float(out[:, 1].max())],
    }
    with io.open(os.path.join(OUT_DIR, 'trees.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    print('[trees] ->', bin_path, os.path.getsize(bin_path), 'B')
    print('[trees] 树高 m p5/p50/p95:',
          np.round(np.percentile(out[:, 2] - out[:, 4], [5, 50, 95]), 1).tolist())
    print('[trees] 冠幅 m p5/p50/p95:',
          np.round(np.percentile(out[:, 3], [5, 50, 95]), 1).tolist())
    print('[trees] bbox', meta['bbox'])


if __name__ == '__main__':
    main()
