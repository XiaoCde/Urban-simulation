# -*- coding: utf-8 -*-
"""把 .osm 按"整栋建筑归属"切成 N×N 网格块（城市级流水线第 3 步）。

## 为什么不能按 bbox 硬裁

按 bbox 裁时，跨过切割线的建筑，它的节点不全在任何一块里，两块都不要它
—— 实测整块 42 栋切成两块只剩 38 栋，丢了 4 栋。

## 为什么"按 way 质心"也不够

第一版按**每条 way 的质心**归属，解决了"单个轮廓被切断"，但**没解决 relation**：
一栋楼若由多个 way 组成（multipolygon，比如带内院的政府大楼、L 形办公楼），
它的外圈 way 可能分属两格 → 那个 relation 在**任何一块里都凑不齐成员** → 整栋楼消失。

实测华盛顿市中心：源文件 1,677 个 relation，16 块合计只剩 1,568 个，丢了 109 个，
其中**真·建筑 3 栋**（`building=government` ×2、`building=office` ×1）。

## 为什么"贪心拽回"还是不够

第二版按成员数从大到小贪心：relation 归哪一格，就把成员 way 拽过去。
结果大 relation 会把小 relation 的 way 抢走 —— 实测仍有 2 个 multipolygon 丢失
（一个 `area:highway=footway`、一个 `amenity=parking`），因为它们的 way 被
几十个成员的地铁/公交 `route` relation 抢走了。

## 现在的做法：并查集，只对"有几何意义"的 relation 强制原子

关键洞察：**不是所有 relation 都产出几何**。

| relation 类型 | 产出三维几何？ |
|---|---|
| `multipolygon`、`building`、`waterway` | ✅ 是（水面、绿地、多部件建筑） |
| `route`、`restriction`、`connectivity`、`boundary` | ❌ 否（纯导航/管理信息） |

所以：
1. **对几何类 relation**：用**并查集**把它的成员 way 全部 union 在一起，
   整个连通分量（可能含多个 relation）作为一个**原子**归入同一格。
   → 数学上保证"一栋楼/一片水面的所有零件永远在同一块"，**零丢失**。
2. **对非几何类 relation**：不强制，成员恰好都在同一格就保留，否则丢弃。
   （丢的只是导航信息，不影响模型，也不会造成分块不均。）

用法:
    python grid_split.py <输入.osm> <输出目录> <N> [前缀]
例:
    python grid_split.py data/osm/dc_downtown.osm data/osm/tiles_dt 4 dt
"""
import os
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from clip_osm import load, write, extent

# 这些 relation 会产出三维几何，必须保证成员 way 不被拆散
GEOMETRIC_REL = {"multipolygon", "building", "waterway"}


def _tags(el):
    return {t.get("k"): t.get("v") for t in el if t.tag == "tag"}


class UnionFind:
    def __init__(self):
        self.parent = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        root = x
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[x] != root:      # 路径压缩
            self.parent[x], x = root, self.parent[x]
        return root

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def grid_split(src, outdir, n, prefix=None, verbose=True):
    nodes, ways, rels, others, root = load(src)
    s, w, no, e = extent(src)
    prefix = prefix or os.path.splitext(os.path.basename(src))[0]
    os.makedirs(outdir, exist_ok=True)

    dlat = (no - s) / n
    dlon = (e - w) / n
    if verbose:
        print("源范围: 南%.5f 西%.5f 北%.5f 东%.5f  →  %.0f m x %.0f m"
              % (s, w, no, e, (no - s) * 111000, (e - w) * 111000 * 0.778))
        print("切成 %d x %d = %d 块，每块约 %.0f m x %.0f m"
              % (n, n, n * n, (no - s) * 111000 / n, (e - w) * 111000 * 0.778 / n))

    def cell(lat, lon):
        return (min(n - 1, max(0, int((lat - s) / dlat))),
                min(n - 1, max(0, int((lon - w) / dlon))))

    def way_centroid(way):
        refs = [r for r in (c.get("ref") for c in way if c.tag == "nd") if r in nodes]
        if not refs:
            return None
        return (sum(float(nodes[r].get("lat")) for r in refs) / len(refs),
                sum(float(nodes[r].get("lon")) for r in refs) / len(refs))

    way_by_id = {x.get("id"): x for x in ways}

    # ---------- 用并查集把"几何类 relation"的成员 way 绑成原子 ----------
    uf = UnionFind()
    n_geom_rel = 0
    for r in rels:
        if _tags(r).get("type") not in GEOMETRIC_REL:
            continue
        mrefs = [c.get("ref") for c in r if c.tag == "member"
                 and c.get("type") == "way" and c.get("ref") in way_by_id]
        if len(mrefs) < 2:
            continue
        n_geom_rel += 1
        for other in mrefs[1:]:
            uf.union(mrefs[0], other)

    # ---------- 每个"原子组"按合并质心归格 ----------
    group_pts = {}      # root -> [lat, lon, count]
    for way in ways:
        c = way_centroid(way)
        if not c:
            continue
        g = uf.find(way.get("id"))
        acc = group_pts.setdefault(g, [0.0, 0.0, 0])
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += 1

    way_cell = {}
    for way in ways:
        c = way_centroid(way)
        if not c:
            continue
        g = uf.find(way.get("id"))
        acc = group_pts.get(g)
        if acc and acc[2]:
            way_cell[way.get("id")] = cell(acc[0] / acc[2], acc[1] / acc[2])
        else:
            way_cell[way.get("id")] = cell(*c)

    if verbose:
        multi = sum(1 for g, acc in group_pts.items() if acc[2] > 1)
        bound = sum(acc[2] for g, acc in group_pts.items() if acc[2] > 1)
        print("几何类 relation %d 个 → 并查集绑定出 %d 个多成员原子组（共 %d 条 way 被锁在一起）"
              % (n_geom_rel, multi, bound))

    # ---------- 分桶 ----------
    buckets = {}
    for way in ways:
        rc = way_cell.get(way.get("id"))
        if rc is None:
            continue
        b = buckets.setdefault(rc, ([], set()))
        b[0].append(way)
        b[1].update(c.get("ref") for c in way if c.tag == "nd")

    order = {x.get("id"): i for i, x in enumerate(root) if x.tag == "node"}
    results = []
    for row in range(n):
        for col in range(n):
            kept_ways, need = buckets.get((row, col), ([], set()))
            if not kept_ways:
                results.append((row, col, None, 0, 0, 0, 0))
                continue
            kept_ids = {x.get("id") for x in kept_ways}
            # 成员 way 全在本格才保留（几何类保证满足；非几何类顺其自然）
            kept_rels = [r for r in rels
                         if all(c.get("ref") in kept_ids
                                for c in r if c.tag == "member" and c.get("type") == "way")
                         and any(c.tag == "member" and c.get("type") == "way" for c in r)]
            kept_nodes = sorted((nodes[i] for i in need if i in nodes),
                                key=lambda x: order.get(x.get("id"), 0))
            name = "%s_r%dc%d.osm" % (prefix, row, col)
            dst = os.path.join(outdir, name)
            size = write(dst, kept_nodes, kept_ways, kept_rels, others)
            tags = [x.tag for x in ET.parse(dst).getroot()]
            ok = ("node" not in tags) or (tags.index("node") < (tags.index("way") if "way" in tags else len(tags)))
            if verbose:
                print("  r%dc%d: node=%5d way=%4d rel=%3d  %8.2f KB  %s"
                      % (row, col, len(kept_nodes), len(kept_ways), len(kept_rels),
                         size / 1024, "顺序OK" if ok else "!! 顺序异常 !!"))
            results.append((row, col, name, len(kept_nodes), len(kept_ways), len(kept_rels), size))

    tot_w = sum(r[4] for r in results)
    tot_r = sum(r[5] for r in results)
    # 几何类 relation 必须一个不丢
    geom_ids = {r.get("id") for r in rels if _tags(r).get("type") in GEOMETRIC_REL}
    kept_ids_all = set()
    for row in range(n):
        for col in range(n):
            p = os.path.join(outdir, "%s_r%dc%d.osm" % (prefix, row, col))
            if os.path.exists(p):
                _, _, rr, _, _ = load(p)
                kept_ids_all.update(x.get("id") for x in rr)
    geom_lost = geom_ids - kept_ids_all
    if verbose:
        print("合计: %d 块（%d 块非空）" % (len(results), len([r for r in results if r[2]])))
        print("  way      %d（源 %d）→ %s"
              % (tot_w, len(ways), "不丢不重 ✓" if tot_w == len(ways) else "!! 丢了 %d 条 !!" % (len(ways) - tot_w)))
        print("  relation %d（源 %d），非几何类 relation 允许丢弃" % (tot_r, len(rels)))
        print("  ★ 几何类 relation %d（源 %d）→ %s"
              % (len(geom_ids) - len(geom_lost), len(geom_ids),
                 "零丢失 ✓" if not geom_lost else "!! 仍丢 %d 个: %s !!" % (len(geom_lost), sorted(geom_lost)[:5])))
    return results


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    grid_split(sys.argv[1], sys.argv[2], int(sys.argv[3]),
               sys.argv[4] if len(sys.argv) > 4 else None)
