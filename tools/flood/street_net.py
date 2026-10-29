"""
P4：一维街道管网（dual drainage，街道作为排水通道与二维洼地耦合）。

【为什么要做这一步】
P3 试过「楼当墙」「街道下压」「微坑阈值」三个旋钮，全部无效 —— 连通块始终是
几十到上百块。诊断结论是：问题不在参数，而在内核。老内核是「洼地填平 + 蓄满
才溢流」（fill-and-spill），它把城市切成一个个互不相通的洼地，每个洼地各自
蓄水、蓄满了才往下一个洼地传。真实城区不是这样：雨水落到街面就被路缘石和
路面纵坡组织进街道，沿街连续流到低处 —— 街道本身就是排水通道。

所以 P4 换的是结构，不是参数：在二维洼地之外再加一维街道管网。
  · 落在街道格上的水，不再进洼地，而是进街道管网（1D）；
  · 街道按 Manning 公式沿真实路网向下游输水（坡度取自 DEM，宽度取真实路宽）；
  · 街道水深超过路缘石高度（默认 0.15 m）后，多余的水留在**路面上**继续沿街
    往下游淌（漫流 sheet flow），只有流到街道死端才漫回二维地面；
  · 街道流到河边的节点直接排进河道，不再一路往下传算作「出域」。

这是国际上城市内涝模型的标准做法（「双排水 dual drainage」：1D 管网/街道 +
2D 地表漫流），也是为什么做完这一步水会连成整条街，而不是散成芝麻。

数据：`data/streets/dc_streets.json`（24,660 条 way，来自 out/dc_real3_clean.blend）。
"""

import json
import os

import numpy as np


def _prof_halfwidths(sj):
    """路网横断面半宽（米），键是 prof 名（profile_roads_tertiary 之类）。"""
    prof = {}
    for k, v in (sj.get("profiles") or {}).items():
        try:
            prof[k] = max(abs(float(p[0])) for p in v[:2]) if len(v) >= 2 else 3.0
        except Exception:
            prof[k] = 3.0
    return prof


class StreetNet:
    """
    一维街道管网。构建一次，之后每步调用 `step()`。

    节点：路网顶点按 snap_m 归并（默认 2 m），边上保留真实路宽与长度。
    每个节点带 `z`（DEM 地面高程）、`w`（路面宽 m）、`len`（节点代表的沿程长度 m）、
    `dn`（下游节点号，-1 表示本地洼地/入河/出域）。
    """

    def __init__(self, grid, res, h, w, z, street_mask=None,
                 snap_m=2.0, manning=0.016, half_min=2.0, cache=None,
                 collect_m=0.0, conn_ok=None):
        self.res = float(res)
        self.h, self.w = int(h), int(w)
        self.x0, self.y1 = float(grid["x0"]), float(grid["y1"])
        self.manning = float(manning)
        self.curb_m = 0.15
        if cache and os.path.exists(cache):
            d = np.load(cache)
            if int(d["h"]) == self.h and int(d["w"]) == self.w:
                self._load(d)
                return
        self._build(z, street_mask, snap_m=snap_m, half_min=half_min,
                    collect_m=float(collect_m or 0.0), conn_ok=conn_ok)
        if cache:
            self._save(cache)

    # ------------------------------------------------------------------ 构建
    def _build(self, z, street_mask, snap_m=2.0, half_min=2.0,
               collect_m=0.0, conn_ok=None):
        fp = os.path.join(os.path.dirname(os.path.dirname(
            os.path.dirname(os.path.abspath(__file__)))),
            "data", "streets", "dc_streets.json")
        sj = json.load(open(fp, encoding="utf-8"))
        prof = _prof_halfwidths(sj)
        snap = float(snap_m)
        keys = {}
        nx, ny = [], []
        edges = []            # (a, b, L, half_w)

        def nid(x, y):
            k = (int(round(x / snap)), int(round(y / snap)))
            i = keys.get(k)
            if i is None:
                i = len(nx)
                keys[k] = i
                nx.append(k[0] * snap)
                ny.append(k[1] * snap)
            return i

        for wy in sj.get("ways") or []:
            pts = wy.get("pts") or []
            if len(pts) < 2:
                continue
            hw = max(half_min * 0.5, prof.get(wy.get("prof") or "", 3.0))
            prev = None
            for p in pts:
                try:
                    x, y = float(p[0]), float(p[1])
                except Exception:
                    prev = None
                    continue
                cur = nid(x, y)
                if prev is not None and cur != prev:
                    a, b = nx[prev], ny[prev]
                    c, d = nx[cur], ny[cur]
                    L = ((c - a) ** 2 + (d - b) ** 2) ** 0.5
                    if L >= 0.5:                       # 丢掉 0.5 m 内的重复顶点
                        edges.append((prev, cur, L, hw))
                prev = cur

        n = len(nx)
        self.n_edges_raw = len(edges)
        ex = np.array(nx, dtype="float64")
        ey = np.array(ny, dtype="float64")
        # 节点地面高程：直接采 DEM（街道路面就是地面）
        cc = np.clip(((ex - self.x0) / self.res).astype("int32"), 0, self.w - 1)
        rr = np.clip(((self.y1 - ey) / self.res).astype("int32"), 0, self.h - 1)
        nz = z[rr, cc].astype("float64")

        # 下游节点：沿边找 z 更低的邻居；没有更低的就本地蓄水/入河
        # 【坑】best 必须初始化成「节点自己的高程」，不能是 inf。用 inf 时第一条边
        # 无条件把自己记成下游 —— 哪怕邻居比自己高，于是 41,000 条街段全是「往高处
        # 流」的假链接，指针跳跃把整张图判成环、断环逻辑把 100% 的节点清成死水。
        # （实测：dn_before=64,161 / cyc=64,161，等于没有一条能流。）
        best = nz.copy()
        dn = np.full(n, -1, dtype="int32")
        wmax = np.full(n, 0.0)
        lsum = np.zeros(n)
        lcnt = np.zeros(n)
        for a, b, L, hw in edges:
            wmax[a] = max(wmax[a], hw)
            wmax[b] = max(wmax[b], hw)
            lsum[a] += L
            lsum[b] += L
            lcnt[a] += 1
            lcnt[b] += 1
            if nz[b] < best[a] - 1e-3:
                best[a], dn[a] = nz[b], b
            if nz[a] < best[b] - 1e-3:
                best[b], dn[b] = nz[a], a
        self.node_x, self.node_y, self.node_z = ex, ey, nz
        self.n_dn_before = int((dn >= 0).sum())
        self.node_w = np.maximum(wmax, max(2.0, half_min * 2.0 * 0.5) * 2.0)
        self.node_len = np.where(lcnt > 0, lsum / np.maximum(lcnt, 1.0), 10.0)
        # 自环去掉（模型里节点会把自己当下游）
        dn[dn < 0] = -1
        dn[dn == np.arange(n)] = -1
        # 断环：指针跳跃，非 -1 的节点必须最终走到 -1
        p = dn.copy()
        for _ in range(64):
            pp = p.copy()
            m = pp >= 0
            pp[m] = p[pp[m]]
            if np.array_equal(pp, p):
                break
            p = pp
        cyc = p >= 0
        self.n_cyc = int(cyc.sum())
        dn[cyc] = -1
        # 【死胡同要接出去】只沿边找下游，4 m DEM 的噪声会让 20% 的节点（实测
        # 13,195 个）变成「本地死水」：水进了它们就再也出不来，只能等漫过路缘
        # 石退回地面 —— 于是管网退化成一台「把水搬回原地」的泵，街上永远只有
        # 一层薄水膜，不连片。真实边沟不会在路口断掉，所以给这些节点找「最近的
        # 一个明显更低的节点」当虚拟下游（300 m 内，至少低 0.3 m）。
        orph = np.nonzero(dn < 0)[0]
        self.n_orphan = int(orph.size)
        if orph.size and ex.size > 1:
            from scipy.spatial import cKDTree
            tree3 = cKDTree(np.column_stack([ex, ey]))
            kk = int(min(16, ex.size))
            _, nn3 = tree3.query(np.column_stack([ex[orph], ey[orph]]),
                                 k=kk, distance_upper_bound=300.0)
            nn3 = np.atleast_2d(nn3)
            cand_z = np.where(nn3 < n, nz[np.minimum(nn3, n - 1)], np.inf)
            lower = cand_z < (nz[orph, None] - 0.3)
            if lower.any():
                best3 = np.argmin(np.where(lower, cand_z, np.inf), axis=1)
                pick = nn3[np.arange(orph.size), best3]
                ok3 = lower[np.arange(orph.size), best3]
                dn[orph[ok3]] = pick[ok3].astype("int32")
                self.n_orphan_fixed = int(ok3.sum())
        self.node_dn = dn.astype("int32")
        self.n = n

        # 每个街道格归属最近的节点（水落到街上就进管网）
        if street_mask is None:
            street_mask = np.ones((self.h, self.w), dtype=bool)
        ci, cj = np.nonzero(street_mask)
        self.cell_node = np.full(self.h * self.w, -1, dtype="int32")
        if ci.size:
            from scipy.spatial import cKDTree
            tree = cKDTree(np.column_stack([ex, ey]))
            px = self.x0 + (cj + 0.5) * self.res
            py = self.y1 - (ci + 0.5) * self.res
            _, nn = tree.query(np.column_stack([px, py]), k=1,
                               distance_upper_bound=self.res * 3.0)
            ok = nn < n
            self.cell_node[ci[ok] * self.w + cj[ok]] = nn[ok]
        self.cell_node = self.cell_node.reshape(self.h, self.w)

        # 节点代表的格（漫出时把水放回这一格）与节点集水面积
        self.node_area = np.bincount(
            self.cell_node.ravel()[self.cell_node.ravel() >= 0],
            minlength=n).astype("float64") * (self.res ** 2)
        self.node_cell = np.full(n, -1, dtype="int64")
        flat = self.cell_node.ravel()
        nz_idx = np.nonzero(flat >= 0)[0]
        self.node_cell[flat[nz_idx]] = nz_idx
        # 节点本身所在的格（没有集水面积的节点也要能排水）
        nc = rr * self.w + cc
        self.node_cell[self.node_cell < 0] = nc[self.node_cell < 0]
        self.vol = np.zeros(n, dtype="float64")
        self.sheet = np.zeros(n, dtype="float64")

        # ---- 汇水格（cell_conn）：街区里的水怎么进管网 ----
        # 【为什么需要它】街道格本身只占 10.85 km²，只把「落在街面上的雨」收进
        # 管网，管网就只是台抽水机，街道上永远只有一层薄水膜，还是不连片。真实
        # 的雨水是从屋顶/院落/人行道顺着坡进边沟的 —— 街道网的汇水面积约等于
        # 半条街的街区面积。所以再建一张「汇水格 → 最近节点」的表，范围
        # `collect_m` 米（默认 0 = 关，只收街面），只在降雨分流时用。
        self.cell_conn = np.full(self.h * self.w, -1, dtype="int32")
        self.collect_m = float(collect_m or 0.0)
        if self.collect_m > 0.0 and ci.size:
            if conn_ok is None:
                mask2 = np.ones((self.h, self.w), dtype=bool)
            else:
                mask2 = np.asarray(conn_ok, dtype=bool)
            qi, qj = np.nonzero(mask2)
            if qi.size:
                from scipy.spatial import cKDTree
                tree2 = cKDTree(np.column_stack([ex, ey]))
                qx = self.x0 + (qj + 0.5) * self.res
                qy = self.y1 - (qi + 0.5) * self.res
                _, nn2 = tree2.query(np.column_stack([qx, qy]), k=1,
                                     distance_upper_bound=self.collect_m)
                ok2 = nn2 < n
                self.cell_conn[qi[ok2] * self.w + qj[ok2]] = nn2[ok2]
        self.cell_conn = self.cell_conn.reshape(self.h, self.w)

    def _save(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        np.savez_compressed(
            path, h=np.int32(self.h), w=np.int32(self.w), n=np.int32(self.n),
            node_x=self.node_x, node_y=self.node_y, node_z=self.node_z,
            node_w=self.node_w, node_len=self.node_len, node_dn=self.node_dn,
            cell_node=self.cell_node.astype("int32"),
            node_area=self.node_area, node_cell=self.node_cell,
            cell_conn=self.cell_conn.astype("int32"))

    def _load(self, d):
        self.n = int(d["n"])
        self.node_x = d["node_x"]
        self.node_y = d["node_y"]
        self.node_z = d["node_z"]
        self.node_w = d["node_w"]
        self.node_len = d["node_len"]
        self.node_dn = d["node_dn"].astype("int32")
        self.cell_node = d["cell_node"].astype("int32")
        self.node_area = d["node_area"]
        self.node_cell = d["node_cell"]
        self.cell_conn = (d["cell_conn"].astype("int32")
                          if "cell_conn" in d else np.full(self.h * self.w, -1,
                                                           dtype="int32")).reshape(
            self.h, self.w)
        self.vol = np.zeros(self.n, dtype="float64")
        self.sheet = np.zeros(self.n, dtype="float64")

    # ------------------------------------------------------------------ 步进
    def step(self, dt, inject, river_level=-99.0, river_nodes=None, relax=4,
             boundary_m=None):
        """
        推进一步。

        inject     : 节点入流（m³），长度 n
        river_level: 河水位；地面高程低于它的街道节点直接排进河道
        返回 dict：to_river / retained / spill_node(m³) / depth_node(m)
        """
        V = self.vol
        V += inject
        n = self.n
        dn = self.node_dn
        has = dn >= 0
        W = self.node_w
        L = self.node_len
        z = self.node_z

        # 沿程坡降（用地面高差/沿程长度），平地给最小坡降
        S = np.full(n, 1e-4)
        S[has] = np.maximum((z[has] - z[dn[has]]) / np.maximum(L[has], 1.0), 1e-4)
        S = np.minimum(S, 0.2)

        # 入河 / 出域：地面低于河水位的节点，水直接进河
        to_river = 0.0
        if river_level > -90.0:
            rv = z <= river_level
            if rv.any():
                to_river += float(V[rv].sum())
                V[rv] = 0.0

        # Manning 输水：q = (1/n) * W * d^(5/3) * sqrt(S)
        for _ in range(max(1, int(relax))):
            area = np.maximum(W * L, 1.0)
            d = V / area
            cap = (1.0 / self.manning) * W * np.power(np.maximum(d, 0.0), 5.0 / 3.0) \
                * np.sqrt(S)
            q = np.minimum(V / max(dt, 1e-9), cap)
            q[~has] = 0.0
            mv = q * dt
            mv = np.minimum(mv, V)
            if mv.max() <= 1e-9:
                break
            V -= mv
            np.add.at(V, dn[has], mv[has])

        # 超过路缘石的水：老做法是立刻漫回地面（沿街格分摊），实测 93% 的水
        # 一进节点就原地倒回，街上永远只有一层薄水膜、连不成片。真实情况是
        # 路缘石挡不住的时候，水在**路面上**继续往下游淌（漫流 sheet flow），
        # 只有流到街道的死端（本地洼地/不能走）才真的漫到地面。
        # 所以这里拆成两本账：
        #   G —— 边沟里的水（不超过路缘石）。区域 W*L，按 Manning 输送，坡度陡。
        #   Sh —— 路面上漫流的水。区域取"路面 + 两侧人行道"，坡降用街道纵坡。
        # 两者都沿同一张路网往下游走；到死端才记 spill_node 还给二维模型。
        area = np.maximum(W * L, 1.0)
        d = V / area
        over = np.maximum(0.0, d - self.curb_m) * area
        if over.max() > 1e-9:
            V -= over
            self.sheet += over

        # 漫流层：路面宽 + 两侧路缘石外 1.5 m（水真的会在人行道上淌）
        Sh = self.sheet
        Ws = W + 3.0
        area_s = np.maximum(Ws * L, 1.0)
        for _ in range(max(1, int(relax))):
            ds = Sh / area_s
            cap_s = (1.0 / self.manning) * Ws * np.power(np.maximum(ds, 0.0), 5.0 / 3.0) \
                * np.sqrt(S)
            qs = np.minimum(Sh / max(dt, 1e-9), cap_s)
            qs[~has] = 0.0
            ms = qs * dt
            ms = np.minimum(ms, Sh)
            if ms.max() <= 1e-12:
                break
            Sh -= ms
            np.add.at(Sh, dn[has], ms[has])

        # 死端（本地洼地）：漫流到这里走不动了，才漫到地面
        sink = ~has
        spill_node = np.where(sink, np.maximum(Sh, 0.0), 0.0)
        Sh = np.where(sink, 0.0, Sh)
        # 极端情况（坡度极缓、一步灌爆）：超过 1.5 m 的部分也还给地面，
        # 否则会在一条街上堆出几米深的水柱
        deep = np.maximum(0.0, Sh / area_s - 1.5) * area_s
        if deep.max() > 1e-12:
            Sh -= deep
            spill_node = spill_node + deep
        self.sheet = Sh

        self.vol = V
        return {"to_river": to_river, "retained": float(V.sum() + Sh.sum()),
                "spill_node": spill_node, "depth_node": d + Sh / area_s}

    def depth_grid(self):
        """街道水深铺到栅格（只有街道格有值），供画面上叠加。

        取「边沟水 + 路面漫流」的合成深度 —— 铺到街面上就是一条连续的水带。
        """
        g = np.zeros(self.h * self.w, dtype="float32")
        flat = self.cell_node.ravel()
        m = flat >= 0
        area = np.maximum(self.node_w * self.node_len, 1.0)
        area_s = np.maximum((self.node_w + 3.0) * self.node_len, 1.0)
        d = (self.vol / area + self.sheet / area_s).astype("float32")
        g[m] = d[flat[m]]
        return g.reshape(self.h, self.w)