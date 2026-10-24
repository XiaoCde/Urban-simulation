# -*- coding: utf-8 -*-
r"""下载 landcover.tif 所需的 DCGIS 矢量源（一次性，落 data\dcgis\landcover\）。

为什么走 DCGIS 而不是 OSM：
    OSM 在本区 landuse/leisure 标签极稀疏（landuse=residential 只有 25 个 way），
    无法支撑 1 m 六级下垫面。DCGIS 有 2025 实测不透水面（249k 面）、
    2023 水体、2023 树冠点位（36k，带 HEIGHT_FT / CROWN_WIDTH_FT）、公园面。

契约：所有输出统一转 EPSG:4326（lat/lon），再由 tm.from_geographic 转场景米制，
      避免 26985 / 102100 混用导致的错位。
"""
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request

OUT = os.path.join('data', 'dcgis', 'landcover')
BASE = 'https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/'

# 场景 bbox（经纬度）—— 由 tm.py 反算，留 30 m 余量
BBOX = (-77.06479, 38.88174, -76.99509, 38.92829)
IN_SR = 4326


def _get(url, tries=4, timeout=180):
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return json.loads(r.read().decode('utf-8', 'replace'))
        except Exception as e:
            last = e
            time.sleep(2 + 2 * i)
    raise RuntimeError('GET failed: %s (%r)' % (url[:160], last))


def query_all(svc, lid, out_fields='*', page=2000, where='1=1', cap=None):
    """按 resultOffset 分页把整层拉完，返回 GeoJSON-ish 的 features 列表。"""
    url = BASE + '%s/MapServer/%d/query' % (svc, lid)
    out, offset = [], 0
    while True:
        p = {
            'where': where,
            'geometry': ','.join('%.6f' % v for v in BBOX),
            'geometryType': 'esriGeometryEnvelope',
            'inSR': str(IN_SR),
            'outSR': '4326',
            'spatialRel': 'esriSpatialRelIntersects',
            'outFields': out_fields,
            'returnGeometry': 'true',
            'f': 'geojson',
            'resultOffset': str(offset),
            'resultRecordCount': str(page),
        }
        d = _get(url + '?' + urllib.parse.urlencode(p))
        feats = d.get('features') or []
        if not feats:
            break
        out.extend(feats)
        offset += len(feats)
        sys.stdout.write('    ... %d\r' % len(out))
        sys.stdout.flush()
        if len(feats) < page or (cap and len(out) >= cap):
            break
    print('    total %d' % len(out))
    return out


def save(name, features, note=''):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name + '.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'crs': 'EPSG:4326', 'note': note, 'count': len(features),
                   'features': features}, f, ensure_ascii=False)
    print('[save] %-22s %6d  %.1f MB' % (name, len(features),
                                        os.path.getsize(path) / 1e6))


def main():
    os.makedirs(OUT, exist_ok=True)

    # 1) 不透水面 2025 —— class 2 硬化（含 Road/Sidewalk/Parking/Alley/...）
    #    DESCRIPTION='Building' 的留给 building_mask，这里保留以便兜底
    print('[1/6] impervious 2025')
    save('impervious2025', query_all(
        'Environment_Stormwater_Management', 74,
        'OBJECTID,DESCRIPTION,FEATURE_AREA'),
        'DCGIS Impervious Surface 2025, polygon')

    # 2) 水体 2023 —— class 0
    print('[2/6] waterbodies 2023')
    save('waterbodies2023', query_all('Planimetrics_2023', 14,
                                      'OBJECTID,DESCRIPTION'),
         'DCGIS Planimetrics 2023 Waterbodies')

    # 3) 水系中心线 2023 —— 用来加密窄河/运河（栅格化时按宽度缓冲）
    print('[3/6] hydrography lines 2023')
    save('hydro_lines2023', query_all('Planimetrics_2023', 6,
                                      'OBJECTID,DESCRIPTION'),
         'DCGIS Planimetrics 2023 Hydrography Lines')

    # 4) 树冠点位 2023 —— class 4 林地（按 CROWN_WIDTH_FT 画圆）
    print('[4/6] tree geography 2023')
    save('trees2023', query_all('Urban_Tree_Canopy', 44,
                                'OBJECTID,HEIGHT_FT,CROWN_WIDTH_FT,DBH,SCI_NM,CMMN_NM'),
         'DCGIS Tree Geography 2023 (points, measured height & crown width)')

    # 5) 公园面 —— class 3 草地
    print('[5/6] parks')
    feats = query_all('Recreation_WebMercator', 9, 'OBJECTID,NAME')
    save('parks_dc', feats, 'DC Parks')
    feats2 = query_all('Recreation_WebMercator', 10, 'OBJECTID,NAME')
    save('parks_national', feats2, 'National Parks')

    # 6) 裸土候选：vacant/blighted 地块
    print('[6/6] vacant lots')
    try:
        save('vacant_lots', query_all('Property_and_Land', 81, 'OBJECTID'),
             'DCGIS Vacant and Blighted Building Footprints (bare-soil candidate)')
    except Exception as e:
        print('    vacant failed: %r' % (e,))
        save('vacant_lots', [], 'unavailable')

    print('\n[done] ->', OUT)


if __name__ == '__main__':
    main()
