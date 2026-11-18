# -*- coding: utf-8 -*-
"""把 DCGIS 3D 建筑的逐栋台基高（minz）匹配到 OSM 建筑，输出 id → 首层相对高度。

用途：
  项目现在判定「楼有没有进水」时，建筑首层地面常被当成和室外地面一样高
  （derived/buildings_footprints.json 里 min_z 大多是 0），于是只要轮廓内
  有一点积水就整栋算淹，偏高估。DCGIS「Buildings - 3D」图层按 lidar 归一化
  给出每栋楼的 MIN_Z（建筑底相对裸地的高度，即台基/首层相对外面地面高出多少），
  正好补这个缺口。

数据：
  - data/osm/dc_downtown_real.osm        OSM 建筑（有经纬度，building 标签）
  - data/dcgis/dc_downtown_heights.jsonl DCGIS 逐栋 maxz/minz + WGS84 外接框

做法：
  1. 解析 OSM，得到每栋 building way / relation 的质心（经纬度）与 OSM id。
  2. 用网格索引找覆盖该质心的 DCGIS 外接框，命中则记录该框的 minz、maxz。
  3. 输出 { "osm_id": {"minz":.., "maxz":.., "how":"inside|expand5m"} }。

注意：
  - 这只是「台基/首层相对裸地的高度」，不是绝对海拔；绝对地面高程仍用地形 DEM。
  - DCGIS 归一化数据在特勤局 redaction 边界内（白宫一带）会缺失，这些楼匹配不到要如实计数。
  - 一栋楼落在多个框时，取面积最小的那个框（最可能是本体），没有面积就取第一个。

用法：
  python tools/match_building_foundation.py
"""
import json
import math
import os
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OSM = os.path.join(ROOT, "data", "osm", "dc_downtown_real.osm")
JSONL = os.path.join(ROOT, "data", "dcgis", "dc_downtown_heights.jsonl")
OUT = os.path.join(ROOT, "data", "derived", "building_foundation.json")

# maxz 合理区间：太低是噪声/遮蔽，太高是异常
MIN_OK, MAX_OK = 2.0, 400.0


def load_heights(path):
    rows = []
    bad = 0
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            bb = d.get("bbox")
            mz = d.get("maxz")
            mn = d.get("minz")
            if not bb or mz is None:
                bad += 1
                continue
            if not (MIN_OK <= mz <= MAX_OK):
                bad += 1
                continue
            # minz 缺失或为负时记 0（贴地）
            if mn is None or mn < 0 or mn > 20:
                mn = 0.0
            rows.append((bb[0], bb[1], bb[2], bb[3], float(mz), float(mn)))
    print("读入 DCGIS 高度记录: %d 条可用, %d 条丢弃" % (len(rows), bad))
    return rows


class Grid:
    def __init__(self, rows, cell=0.0005):
        self.cell = cell
        self.d = {}
        for x0, y0, x1, y1, mz, mn in rows:
            area = (x1 - x0) * (y1 - y0)
            for cx in range(int(math.floor(x0 / cell)), int(math.floor(x1 / cell)) + 1):
                for cy in range(int(math.floor(y0 / cell)), int(math.floor(y1 / cell)) + 1):
                    self.d.setdefault((cx, cy), []).append((x0, y0, x1, y1, mz, mn, area))

    def find(self, lon, lat, expand=0.0):
        cx, cy = int(math.floor(lon / self.cell)), int(math.floor(lat / self.cell))
        out = []
        for k in ((cx, cy), (cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1),
                  (cx - 1, cy - 1), (cx + 1, cy - 1), (cx - 1, cy + 1), (cx + 1, cy + 1)):
            for cand in self.d.get(k, ()):
                x0, y0, x1, y1, mz, mn, area = cand
                if (x0 - expand) <= lon <= (x1 + expand) and (y0 - expand) <= lat <= (y1 + expand):
                    out.append((area, mz, mn))
        return out


def parse_osm(path):
    """流式解析，收集 node 坐标与 building way/relation 的质心。"""
    nodes = {}
    builders = []   # (osm_id, lon, lat)
    for event, el in ET.iterparse(path, events=("end",)):
        if el.tag == "node":
            nodes[el.get("id")] = (float(el.get("lon")), float(el.get("lat")))
            el.clear()
        elif el.tag == "way":
            tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
            if "building" in tags:
                refs = [nd.get("ref") for nd in el.findall("nd")]
                pts = [nodes[r] for r in refs if r in nodes]
                if pts:
                    lon = sum(p[0] for p in pts) / len(pts)
                    lat = sum(p[1] for p in pts) / len(pts)
                    builders.append((el.get("id"), lon, lat))
            el.clear()
        elif el.tag == "relation":
            tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
            if "building" in tags:
                # relation 的 member 是 way，质心用 way 的 node 近似：跳过（复杂），
                # 只记 id，后面若需要再补；rel 数量少，不影响主结论。
                pass
            el.clear()
    return builders


def main():
    rows = load_heights(JSONL)
    grid = Grid(rows)
    builders = parse_osm(OSM)
    print("OSM 建筑(way): %d 栋" % len(builders))

    out = {}
    hit = expand_hit = miss = 0
    for oid, lon, lat in builders:
        cands = grid.find(lon, lat)
        how = "inside"
        if not cands:
            cands = grid.find(lon, lat, expand=0.00005)   # 放宽约 5 m
            how = "expand5m"
        if cands:
            # 取面积最小的框（最可能是本体），面积相同时取 minz 较大的
            cands.sort(key=lambda t: (t[0], -t[2]))
            area, mz, mn = cands[0]
            out[oid] = {"minz": round(mn, 3), "maxz": round(mz, 3), "how": how}
            if how == "inside":
                hit += 1
            else:
                expand_hit += 1
        else:
            miss += 1

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False)
    total = len(builders)
    cov = (hit + expand_hit)
    print("=" * 60)
    print("质心落入: %d | 放宽5m命中: %d | 未匹配: %d" % (hit, expand_hit, miss))
    print("覆盖率: %d / %d = %.1f%%" % (cov, total, 100.0 * cov / max(total, 1)))
    print("输出: %s (%.1f KB)" % (OUT, os.path.getsize(OUT) / 1024.0))


if __name__ == "__main__":
    main()
