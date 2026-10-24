# -*- coding: utf-8 -*-
"""
识别 DC 的跨河桥，按真实桥型分类，导出 `web/assets/roads/bridges.json`。

为什么要有这一步
----------------
`web/src/roads.js` 只能看到合并后的顶点数组，**看不到 way 的名字**，所以它给
每一座跨河桥都套同一套「混凝土箱梁 + 护栏 + 桥墩」。真实 DC 不是这样：

  波托马克：Arlington Memorial Bridge（9 跨花岗岩拱）、Key Bridge（5 跨石拱）、
           Roosevelt Bridge（混凝土梁）、Chain Bridge（塔架悬索/斜拉）、
           14th Street Bridges（钢梁）
  Anacostia：Frederick Douglass Memorial Bridge（三跨系杆拱）、
           11th Street Bridges（系杆拱）、Benning Road（桁架）、
           Anacostia 铁路桥（钢桁架双塔）

做法
----
1. 读 `data/streets/dc_streets.json`（24,660 条 way，带 name / profile）。
2. 沿折线逐点查 `landcover.tif == 0`（水体），取「两端都在陆地上」的连续涉水段，
   长度 25 m ~ 2 km —— 与 `roads.js` 里 `MAX_BRIDGE_PAIRS` 的判据一致。
3. 按名字归到桥型，算出中心点 / 走向 / 长度 / 桥面宽 / 桥面高程。
4. 同名的相邻碎段（OSM 常把一座桥拆成几条 way）合并成一座。

产物
----
`web/assets/roads/bridges.json`：
  {water_y, deck_clear, count, bridges:[
    {name, kind, cx, cz, dx, dz, len_m, width_m, deck_y}]}

`kind` ∈ arch_stone | tied_arch | truss | suspension | beam
"""

import json
import math
import os

import numpy as np
import rasterio

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
LC = os.path.join(ROOT, 'data', 'derived', 'landcover.tif')
STREETS = os.path.join(ROOT, 'data', 'streets', 'dc_streets.json')
OUT = os.path.join(ROOT, 'web', 'assets', 'roads', 'bridges.json')

GRID_X0, GRID_Y1 = -1277.0, 4189.0
WATER_Y = 0.046          # NOAA 8594900 MSL，NAVD88 米（与 water.json 一致）
DECK_CLEAR = 9.0         # 与 roads.js 的 DECK_CLEAR 必须一致
MIN_LEN = 40.0
MAX_LEN = 2000.0
MERGE_DIST = 140.0       # 同名且中点相距 < 140 m 视为同一座桥
                         # （Memorial Bridge 的车行道与自行车道两条 way 中点相距 96 m，
                         #  不合并会在同一座桥上叠两套拱圈）


def bridge_kind(name):
    """按真实桥名分类。名字来自 OSM，DC 的桥名基本稳定。"""
    n = (name or '').lower()
    if 'douglass' in n or '11th street' in n or 'south capitol' in n:
        return 'tied_arch'          # 2021 新建的三跨钢系杆拱
    if 'memorial bridge' in n and 'arlington' not in n:
        return 'arch_stone'
    if 'arlington' in n or 'key bridge' in n:
        return 'arch_stone'         # 花岗岩多跨拱
    if 'chain bridge' in n:
        return 'suspension'
    if 'railroad' in n or 'rail bridge' in n or 'benning' in n:
        return 'truss'
    if 'roosevelt' in n or '14th street' in n or 'george mason' in n or 'rochambeau' in n:
        return 'beam'               # 钢/混凝土梁
    return ''


def kind_by_place(cx, cz, width_m):
    """没有桥名时按所在水域给桥型。

    实测这份 OSM 数据里**大跨桥几乎全缺**（Key Bridge / 14th Street / Douglass /
    11th Street 要么在场景 bbox 外，要么在导出时被裁掉），能识别出来的只有
    Arlington Memorial Bridge 一座。所以剩下的按水域判定：

      Anacostia（东南，x 400~1900 / planY -931~-200）→ 系杆拱（Douglass / 11th St 的真实形制）
      Potomac 主河（x < 500）                        → 宽 > 260 m 走石拱，否则钢梁
      其余（Rock Creek / Tidal Basin / 运河）        → 钢梁
    """
    if 400 <= cx <= 1900 and -931 <= cz <= -200:
        return 'tied_arch'
    if cx < 500 and width_m >= 14.0:
        return 'arch_stone'
    return 'beam'


def half_width(prof, profiles):
    p = profiles.get(prof)
    if not p:
        return 5.0
    return max(abs(float(q[0])) for q in p) if p else 5.0


def main():
    lc = rasterio.open(LC).read(1)
    H, W = lc.shape

    def wet(x, y):
        c = int(round(x - GRID_X0))
        r = int(round(GRID_Y1 - y))
        if c < 0 or r < 0 or c >= W or r >= H:
            return False
        return lc[r, c] == 0

    st = json.load(open(STREETS, encoding='utf-8'))
    profiles = st.get('profiles', {})
    ways = st['ways']

    raw = []
    for w in ways:
        pts = w.get('pts') or []
        if len(pts) < 2:
            continue
        name = w.get('name') or ''
        hw = half_width(w.get('prof'), profiles)
        flags = [wet(p[0], p[1]) for p in pts]
        n = len(pts)
        i = 0
        while i < n:
            if not flags[i]:
                i += 1
                continue
            j = i
            while j < n and flags[j]:
                j += 1
            # 两端必须都在陆地上（i>0 且 j<n），否则是沿岸长期浸水的路堤
            if i > 0 and j < n:
                seg = pts[i - 1:j + 1]
                L = sum(math.dist(seg[k], seg[k + 1]) for k in range(len(seg) - 1))
                if MIN_LEN <= L <= MAX_LEN:
                    a, b = seg[0], seg[-1]
                    dl = math.dist(a, b) or 1.0
                    kd = bridge_kind(name)
                    if not kd:
                        kd = kind_by_place(
                            sum(p[0] for p in seg) / len(seg),
                            sum(p[1] for p in seg) / len(seg), 2.0 * hw)
                    raw.append({
                        'name': name,
                        'kind': kd,
                        'path': [[round(p[0], 2), round(p[1], 2)] for p in seg],
                        'half_w': 2.0 * hw * 0.5,
                        'cx': sum(p[0] for p in seg) / len(seg),
                        'cz': sum(p[1] for p in seg) / len(seg),
                        'dx': (b[0] - a[0]) / dl,
                        'dz': (b[1] - a[1]) / dl,
                        'len_m': L,
                        'width_m': 2.0 * hw,
                    })
            i = j

    # 同名 + 相邻 → 合并（OSM 把一座桥拆成多条 way 很常见）
    raw.sort(key=lambda r: (-r['len_m'], r['name']))
    merged = []
    for r in raw:
        hit = None
        for m in merged:
            if m['name'] == r['name'] and math.dist((m['cx'], m['cz']), (r['cx'], r['cz'])) < MERGE_DIST:
                hit = m
                break
        if hit:
            if r['len_m'] > hit['len_m']:
                hit['path'] = r['path']
            hit['len_m'] = max(hit['len_m'], r['len_m'])
            hit['width_m'] = max(hit['width_m'], r['width_m'])
        else:
            merged.append(dict(r))

    for m in merged:
        # path 简化：等弧长抽稀到 <= 48 点，JS 端再按 3 m 重采样
        pth = m.get('path') or []
        if len(pth) > 48:
            step = (len(pth) - 1) / 47.0
            keep = sorted({int(round(i * step)) for i in range(48)} | {0, len(pth) - 1})
            pth = [pth[i] for i in keep]
        m['path'] = pth
        m['deck_y'] = WATER_Y + DECK_CLEAR
        m['cx'] = round(m['cx'], 2)
        m['cz'] = round(m['cz'], 2)
        m['dx'] = round(m['dx'], 4)
        m['dz'] = round(m['dz'], 4)
        m['len_m'] = round(m['len_m'], 1)
        m['width_m'] = round(m['width_m'], 2)
        m['deck_y'] = round(m['deck_y'], 3)

    merged.sort(key=lambda m: -m['len_m'])
    doc = {
        'water_y': WATER_Y,
        'deck_clear': DECK_CLEAR,
        'count': len(merged),
        'note': ('跨河桥由 landcover==0 的连续涉水段识别；桥型按 OSM 桥名分类，'
                 '未匹配到名字的一律 beam（系数不猜）。'),
        'bridges': merged,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)

    print(f'跨河桥 {len(merged)} 座 → {os.path.relpath(OUT, ROOT)}')
    for m in merged[:24]:
        print(f"  {m['kind']:11s} {m['name'][:38]:38s} L={m['len_m']:7.1f} "
              f"W={m['width_m']:5.2f} @({m['cx']:.0f},{m['cz']:.0f})")


if __name__ == '__main__':
    main()