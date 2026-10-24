# -*- coding: utf-8 -*-
"""
把场景内的建筑轮廓导出成 three.js 直接可用的二进制（web/assets/city/buildings.*）。

为什么不直接给 buildings_footprints.json（4.3 MB）：
  - 里面 23,420 栋，而地形窗口内只有 1,600 多栋，其余是白传。
  - rings 是嵌套数组，解析 + 三角化在浏览器里会卡住首帧。

产物：
  buildings.mesh  顶点缓冲：每个顶点 (x, z, top_y, base_y) —— 见 meta 的 stride
  buildings.idx   Uint32 三角索引（扇形三角化，建筑轮廓几乎全是凸四边形）
  buildings.json  元数据 + 每栋属性（id/name/height)

注意扩展名是 .mesh 不是 .bin：Chrome 会把 .bin 拦成下载，fetch 得到 204 空响应。

坐标：与 terrain.json 同一套场景米制，x=planX, z=-planY, y=高程(NAVD88)。
"""

import json
import os

import numpy as np
import rasterio

# 与 export_web_terrain.py 保持一致（全幅，与 terrain_dtm.tif 同范围）
WIN_X0 = -1277.0
WIN_Y0 = -931.0
WIN_X1 = 4701.0
WIN_Y1 = 4189.0

# 建筑高度异常值下限（§5.4 檐高，不新增不改变；只过滤 0 高与地面平面）
SKIP_ZERO_HEIGHT = True


def main():
    out_dir = os.path.join('web', 'assets', 'city')
    os.makedirs(out_dir, exist_ok=True)

    with rasterio.open('data/derived/terrain_dtm.tif') as d:
        dtm = d.read(1)
        tr = d.transform

    def ground_at(x, y):
        """按场景坐标取 DTM 高程（3x3 中值，压掉单像素坑）。"""
        c = int((x - tr.c) / tr.a)
        r = int((tr.f - y) / (-tr.e))
        c = min(max(c, 2), dtm.shape[1] - 3)
        r = min(max(r, 2), dtm.shape[0] - 3)
        return float(np.median(dtm[r - 2:r + 3, c - 2:c + 3]))

    src = json.load(open('data/derived/buildings_footprints.json', encoding='utf-8'))
    verts = []      # (x, z, h, base)
    idx = []
    meta = []
    skipped_out = skipped_zero = 0

    for b in src['features']:
        if b['id'] == 'ground':
            continue
        h = b.get('height_m') or 0.0
        if SKIP_ZERO_HEIGHT and h <= 0.0:
            skipped_zero += 1
            continue
        ring = b['rings'][0]
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
        if not (WIN_X0 <= cx <= WIN_X1 and WIN_Y0 <= cy <= WIN_Y1):
            skipped_out += 1
            continue

        # 【每角单独落地，别再整栋共用一个基准】
        # 旧版用质心处的中值高程当整栋的 base_y，于是同一栋楼在坡地上会出现
        # 「一半悬空、一半埋进地形」——用户实测看到的就是这两种：楼板浮在空中
        # 和楼被地形切成两半。DC 的地形起伏有 96 m，一栋 30 m 长的房子跨 2 m
        # 高差很常见，质心基准必然有一侧差出去。
        # 现在按**每个轮廓点自己的 DTM** 落地（再降 0.35 m 作出檐/压地），
        # 顶面仍然取各角最高点 + 层高，保证屋脊是一条平的线。
        bases = [ground_at(px, py) for (px, py) in ring]
        bmax = max(bases)
        top = bmax + h
        i0 = len(verts)
        for (px, py), g in zip(ring, bases):
            verts.append((px, -py, top, g - 0.35))
        base = bmax
        n = len(ring)
        # 扇形三角化（DC 的 OSM 轮廓基本都是凸的；凹的也只是轻微内凹，不影响体块）
        for k in range(1, n - 1):
            idx.extend((i0, i0 + k, i0 + k + 1))

        meta.append({
            'id': b['id'],
            'name': b.get('name') or '',
            'function': b.get('building') or '',
            'height_m': round(float(h), 2),
            'base_m': round(base, 2),
            'base_min_m': round(min(bases) - 0.35, 2),
            'area_m2': round(float(b.get('footprint_area_m2') or 0), 1),
            'center': [round(cx, 1), round(-cy, 1)],
            'v0': i0, 'vc': n,
        })

    V = np.array(verts, dtype=np.float32)
    I = np.array(idx, dtype=np.uint32)
    V.tofile(os.path.join(out_dir, 'buildings.mesh'))
    I.tofile(os.path.join(out_dir, 'buildings.idx'))

    info = {
        'count': len(meta),
        'vertex_count': len(verts),
        'index_count': len(idx),
        'stride_floats': 4,
        'layout': ['x', 'z', 'top_y', 'base_y'],
        'window': {'x0': WIN_X0, 'y0': WIN_Y0, 'x1': WIN_X1, 'y1': WIN_Y1},
        'coords': 'x=planX, z=-planY, y=NAVD88 elevation (m)',
        'note': ('base_y 是各栋楼所在 DTM 高程，不是 0（§5.5）。'
                 'top_y = base_y + height_m。'),
        'skipped': {'out_of_window': skipped_out, 'zero_height': skipped_zero},
        'buildings': meta,
    }
    with open(os.path.join(out_dir, 'buildings.json'), 'w', encoding='utf-8') as f:
        json.dump(info, f, ensure_ascii=False)

    print('[buildings] %d 栋 / %d 顶点 / %d 三角'
          % (len(meta), len(verts), len(idx) // 3))
    print('[buildings] 跳过：窗口外 %d，零高 %d' % (skipped_out, skipped_zero))
    print('[buildings] base_y 范围 %.2f .. %.2f m'
          % (min(m['base_m'] for m in meta), max(m['base_m'] for m in meta)))
    for f in ('buildings.mesh', 'buildings.idx', 'buildings.json'):
        print('   %-16s %8.1f KB' % (f, os.path.getsize(os.path.join(out_dir, f)) / 1024))


if __name__ == '__main__':
    main()
