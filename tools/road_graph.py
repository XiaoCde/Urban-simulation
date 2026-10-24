# -*- coding: utf-8 -*-
r"""路网拓扑 + 人行道图（**纯 python，不 import bpy**）。

分层（计划表硬规矩，别破坏）：
    ped_fsm.py     纯函数：下一个状态是什么
    road_graph.py  纯 python：路网在哪、谁能到谁、该走哪条边   <- 本文件
    ped_sim.py     纯 python：谁在哪儿、谁挡着谁
    ped_demo.py    Blender：把状态画出来

本文件回答三个问题：
    1. 24,660 条曲线怎么变成一个图？（节点 = 折线顶点按毫米量化去重，边 = 相邻顶点）
    2. 这个图连不连通？断成多少块？（**这是 Day 2 唯一的硬风险**，先量再动手）
    3. 从 A 到 B 怎么走？（Dijkstra，确定性，不碰随机数）

为什么节点量化到毫米：
    浮点相等不可靠。blender 导出的坐标已 round 到 4 位小数，OSM 里同一个路口
    节点在两条 way 里坐标完全相同，量化成整数键之后能被 dict 精确合并，
    不用容差、不会有"差 1e-9 就断开"的幽灵故障。

为什么边不预先合并成"路段"：
    合并 degree-2 节点只是好看，对导航没有任何影响，却会引入一堆"合并到哪
    一条"的边界 bug。DOG 先跑通：顶点图 -> Dijkstra -> 折线。要"路段"视图
    时在报告里数一次就够了。

用法:
    python tools\road_graph.py            # 建图 + 报连接性（Day 2.1 验收证据）
    python tools\road_graph.py --snap 0.5 # 额外报告加吸附容差后的连通性
"""
import heapq
import json
import math
import os
import sys
from collections import defaultdict, deque

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_JSON = os.path.join(ROOT, "data", "streets", "dc_streets.json")

# 行人能走的 highway 类别。故意**不含** service（车道/内部路）和
# primary/secondary/... （机动车道）—— demo 里人要走在人行道上。
WALK_KLASSES = ("footway", "path", "pedestrian", "steps", "cycleway", "living_street")

MILLI = 1000.0     # 坐标量化：1 mm


def qkey(x, y):
    """把 (x, y) 量化成整数键。1 mm 精度，够用且精确。"""
    return (int(round(x * MILLI)), int(round(y * MILLI)))


def dkey(k):
    """整数键 -> 米制坐标。"""
    return (k[0] / MILLI, k[1] / MILLI)


class Edge(object):
    __slots__ = ("u", "v", "length", "klass", "f", "name", "prof", "z",
                 "lanes", "maxspeed", "oneway", "width")

    def __init__(self, u, v, length, way, width):
        self.u = u
        self.v = v
        self.length = length
        self.klass = way.get("h", "")
        self.f = way.get("f", "")
        self.name = way.get("name", "")
        self.prof = way.get("prof", "")
        self.z = way.get("z", 0.0)
        self.lanes = way.get("lanes", "")
        self.maxspeed = way.get("maxspeed", "")
        self.oneway = way.get("oneway", "")
        self.width = width

    @property
    def kind(self):
        """人话版类别：sidewalk / crossing / steps / path / cycleway / ..."""
        if self.f == "sidewalk":
            return "sidewalk"
        if self.f == "crossing":
            return "crossing"
        if self.klass == "steps":
            return "steps"
        return self.klass or "?"


class StreetGraph(object):
    def __init__(self):
        self.nodes = {}          # kkey -> index
        self.pos = []            # index -> kkey
        self.adj = defaultdict(list)   # index -> [edge_idx]
        self.edges = []
        self.ways_used = 0
        self.ways_skipped = 0

    # ---------------------------------------------------------------- 建图
    def add_way(self, way, profiles):
        pts = way.get("pts") or []
        if len(pts) < 2:
            return
        prof = profiles.get(way.get("prof", ""))
        width = 0.0
        if prof:
            xs = [p[0] for p in prof]
            width = max(xs) - min(xs)
        keys = [qkey(p[0], p[1]) for p in pts]
        # 去掉连续重复点（导入/量化后可能出现零长度段）
        dedup = [keys[0]]
        for k in keys[1:]:
            if k != dedup[-1]:
                dedup.append(k)
        if len(dedup) < 2:
            self.ways_skipped += 1
            return
        idx = [self._node(k) for k in dedup]
        z = way.get("z", 0.0)
        for a, b in zip(idx, idx[1:]):
            pa, pb = dkey(self.pos[a]), dkey(self.pos[b])
            ln = math.hypot(pb[0] - pa[0], pb[1] - pa[1])
            if ln <= 0.0:
                continue
            e = Edge(a, b, ln, way, width)
            e.z = z
            ei = len(self.edges)
            self.edges.append(e)
            self.adj[a].append(ei)
            self.adj[b].append(ei)
        self.ways_used += 1

    def _node(self, k):
        i = self.nodes.get(k)
        if i is None:
            i = len(self.pos)
            self.nodes[k] = i
            self.pos.append(k)
        return i

    # ---------------------------------------------------------------- 吸附
    def snap(self, tol_m):
        """把容差内的节点合并成一个（就地改边），返回合并次数。

        为什么要容差：blosm 会做几何简化，两条 OSM way 名义上共享同一个
        路口节点，但简化后可能一个保留、一个被丢，于是图在这里断开。
        真实症状是"人行道网络碎成几千块，人一步都走不动"。
        """
        cell = max(tol_m, 1e-6)
        buckets = defaultdict(list)
        for i, k in enumerate(self.pos):
            x, y = dkey(k)
            buckets[(int(math.floor(x / cell)), int(math.floor(y / cell)))].append(i)
        parent = list(range(len(self.pos)))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        merged = 0
        tol2 = tol_m * tol_m
        for (cx, cy), ids in sorted(buckets.items()):
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    other = buckets.get((cx + dx, cy + dy))
                    if not other:
                        continue
                    for i in ids:
                        xi, yi = dkey(self.pos[i])
                        for j in other:
                            if j <= i:
                                continue
                            xj, yj = dkey(self.pos[j])
                            dd = (xi - xj) ** 2 + (yi - yj) ** 2
                            if dd <= tol2:
                                ri, rj = find(i), find(j)
                                if ri != rj:
                                    parent[rj] = ri
                                    merged += 1
        if merged == 0:
            return 0
        # 重新映射
        remap = {}
        newpos = []
        for i in range(len(self.pos)):
            r = find(i)
            j = remap.get(r)
            if j is None:
                j = len(newpos)
                remap[r] = j
                newpos.append(self.pos[r])
        self.pos = newpos
        self.nodes = {}
        for i, k in enumerate(newpos):
            self.nodes[k] = i
        for e in self.edges:
            e.u = remap[find(e.u)]
            e.v = remap[find(e.v)]
        # 扔掉自环和零长度
        newadj = defaultdict(list)
        kept = []
        for e in self.edges:
            if e.u == e.v or e.length <= 0.0:
                continue
            ei = len(kept)
            kept.append(e)
            newadj[e.u].append(ei)
            newadj[e.v].append(ei)
        self.edges = kept
        self.adj = newadj
        return merged

    # ---------------------------------------------------------------- 查询
    def component_sizes(self):
        """每个连通块的大小（节点数）。顺带返回每个节点属于哪块。"""
        comp = [-1] * len(self.pos)
        sizes = []
        for s in range(len(self.pos)):
            if comp[s] != -1:
                continue
            cid = len(sizes)
            n = 0
            dq = deque([s])
            comp[s] = cid
            while dq:
                u = dq.popleft()
                n += 1
                for ei in self.adj[u]:
                    e = self.edges[ei]
                    w = e.v if e.u == u else e.u
                    if comp[w] == -1:
                        comp[w] = cid
                        dq.append(w)
            sizes.append(n)
        self.comp = comp
        return sizes

    def nearest_node(self, x, y, comp_min=0):
        """最近节点（暴力扫；只在 demo 初始化时用几次，不值得上 KD 树）。"""
        qx, qy = x, y
        best, bd = None, 1e18
        for i, k in enumerate(self.pos):
            if comp_min and len(self.adj[i]) == 0:
                continue
            if comp_min and getattr(self, "comp", None) and \
                    self._comp_size_of(i) < comp_min:
                continue
            px, py = dkey(k)
            d = (px - qx) ** 2 + (py - qy) ** 2
            if d < bd:
                bd, best = d, i
        return best, math.sqrt(bd) if best is not None else None

    def _comp_size_of(self, i):
        return getattr(self, "_sizes", [0])[self.comp[i]] if getattr(self, "comp", None) else 0

    def shortest_path(self, s, t):
        """Dijkstra。返回 (节点列表, 总长)。不可达返回 (None, inf)。

        确定性：邻居按边序号升序压堆，堆比较键带序号，不依赖字典顺序。
        """
        if s == t:
            return [s], 0.0
        dist = {s: 0.0}
        prev = {}
        pq = [(0.0, s)]
        seen = set()
        while pq:
            d, u = heapq.heappop(pq)
            if u in seen:
                continue
            seen.add(u)
            if u == t:
                break
            for ei in self.adj[u]:
                e = self.edges[ei]
                w = e.v if e.u == u else e.u
                nd = d + e.length
                if nd < dist.get(w, 1e18) - 1e-12:
                    dist[w] = nd
                    prev[w] = u
                    heapq.heappush(pq, (nd, w))
        if t not in dist:
            return None, float("inf")
        path = [t]
        while path[-1] != s:
            path.append(prev[path[-1]])
        path.reverse()
        return path, dist[t]

    def polyline(self, path):
        return [dkey(self.pos[i]) for i in path]

    def stats(self):
        tot = sum(e.length for e in self.edges)
        return {
            "ways_used": self.ways_used,
            "ways_skipped": self.ways_skipped,
            "nodes": len(self.pos),
            "edges": len(self.edges),
            "total_km": round(tot / 1000.0, 3),
        }


# ------------------------------------------------------------------ 载入
def load_ways(path=DEFAULT_JSON, klasses=WALK_KLASSES):
    with open(path, encoding="utf-8") as fh:
        blob = json.load(fh)
    ways = [w for w in blob["ways"] if w.get("h") in klasses]
    return blob.get("profiles", {}), ways


def build(path=DEFAULT_JSON, klasses=WALK_KLASSES, snap_m=0.0):
    profiles, ways = load_ways(path, klasses)
    g = StreetGraph()
    for w in ways:
        g.add_way(w, profiles)
    if snap_m > 0:
        g.snap(snap_m)
    return g


# ------------------------------------------------------------------ 自测/报告
def _report(path=DEFAULT_JSON, snaps=(0.0, 0.3, 1.0, 2.0)):
    print("=" * 78)
    print("road_graph 报告 —— 可步行路网（%s）" % ", ".join(WALK_KLASSES))
    print("=" * 78)
    profiles, ways = load_ways(path)
    import time
    for sm in snaps:
        t0 = time.time()
        g = build(path, snap_m=sm)
        sizes = g.component_sizes()
        g._sizes = sizes
        st = g.stats()
        big = [s for s in sizes if s >= 30]
        giant = max(sizes) if sizes else 0
        print("\n[snap=%.2f m]  %.2f s" % (sm, time.time() - t0))
        print("  节点 %d  边 %d  总长 %.1f km" % (st["nodes"], st["edges"], st["total_km"]))
        print("  连通块 %d 个；最大块 %d 节点；>=30 节点的块 %d 个；"
              "单点孤立块 %d 个"
              % (len(sizes), giant, len(big), len([s for s in sizes if s == 1])))
        top = sorted(sizes, reverse=True)[:8]
        print("  最大 8 块节点数 %s" % top)
        if sm == snaps[-1]:
            # 最大块覆盖多少长度
            cid = sizes.index(giant)
            ln = sum(e.length for e in g.edges
                     if g.comp[e.u] == cid) / 1000.0
            print("  最大块总长 %.1f km（占全网 %.1f%%）"
                  % (ln, 100.0 * ln / max(1e-9, st["total_km"])))
    # 类别统计（用 snap=1.0 的图）
    g = build(path, snap_m=1.0)
    g._sizes = g.component_sizes()
    kinds = defaultdict(lambda: [0, 0.0])
    for e in g.edges:
        k = e.kind
        kinds[k][0] += 1
        kinds[k][1] += e.length
    print("\n边按类别（snap=1.0）：")
    for k, (n, ln) in sorted(kinds.items(), key=lambda kv: -kv[1][1]):
        print("    %-12s %7d 条  %8.1f km" % (k, n, ln / 1000.0))
    widths = defaultdict(list)
    for e in g.edges:
        widths[e.kind].append(e.width)
    print("每类宽度（米）：")
    for k, v in sorted(widths.items()):
        print("    %-12s 中位 %.2f  最小 %.2f  最大 %.2f"
              % (k, sorted(v)[len(v) // 2], min(v), max(v)))

    # ---------------------------------------------------------------- 全量路网
    # 计划表 2.1 的验收原文是"图能查连通性，边带长度/车道数/限速"。
    # 车道数/限速挂在**机动车道**的 OSM 标签上，人行道没有；所以这里额外
    # 用全量类别再建一次图，把这条验收按原文口径给证掉。
    print("\n全量路网（所有 highway 类别，含机动车道）：")
    _report_all(path)
    return g


def _report_all(path=DEFAULT_JSON):
    import json as _json
    with open(path, encoding="utf-8") as fh:
        blob = _json.load(fh)
    profiles = blob.get("profiles", {})
    ways = blob["ways"]
    ga = StreetGraph()
    for w in ways:
        ga.add_way(w, profiles)
    sizes = ga.component_sizes()
    st = ga.stats()
    print("  节点 %d  边 %d  总长 %.1f km  连通块 %d（最大 %d 节点，%.1f%%）"
          % (st["nodes"], st["edges"], st["total_km"], len(sizes),
             max(sizes), 100.0 * max(sizes) / max(1, len(ga.pos))))
    has_len = sum(1 for e in ga.edges if e.length > 0)
    print("  带长度的边 %d/%d（100%%）" % (has_len, len(ga.edges)))
    lanes = [e for e in ga.edges if e.lanes]
    mspd = [e for e in ga.edges if e.maxspeed]
    names = [e for e in ga.edges if e.name]
    print("  带车道数(lanes) 的边 %d 条（%.1f%%）" % (len(lanes), 100.0 * len(lanes) / len(ga.edges)))
    print("  带限速(maxspeed) 的边 %d 条（%.1f%%）" % (len(mspd), 100.0 * len(mspd) / len(ga.edges)))
    print("  带路名(name)   的边 %d 条（%.1f%%）" % (len(names), 100.0 * len(names) / len(ga.edges)))
    print("  样例边（长度 m / 类别 / 车道数 / 限速 / 路名）：")
    for e in lanes[:6]:
        print("    %7.1f m  %-12s lanes=%-3s maxspeed=%-5s %s"
              % (e.length, e.klass, e.lanes, e.maxspeed or "-", e.name[:34]))
    return 0


if __name__ == "__main__":
    snaps = (0.0, 0.3, 1.0, 2.0)
    if "--snap" in sys.argv:
        snaps = (float(sys.argv[sys.argv.index("--snap") + 1]),)
    _report(snaps=snaps)
