#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
简化排水模型（L1 快版）—— 不建实物管网，只用算术把水算掉。

依据 `项目总览.md` §5.8：
  产流 runoff = max(0, P - f_k) × C_k
  汇流 D8（最陡下降）
  排水 只在硬化路面按虚拟雨水口扣能力（30 m 间距 / 60 L/s / 服务带宽 12 m）
  下渗 f_k × 历时
  河道 landcover==0 当出口，水位取 water.json（normal 或 design）

输入：data/derived/{terrain_dtm,landcover,building_mask}.tif + water.json
      + buildings_footprints.json
输出：data/flood/{params.json, summary.json, depth_l1.tif, depth_l1.png,
      buildings_flooded.csv}

只依赖 numpy + PIL（venv 里没有 rasterio/GDAL）。

用法：
  python tools/flood/simple_drainage.py                          # 默认 2 m / 50 mm/h
  python tools/flood/simple_drainage.py --res 4 --p-mm-h 80      # 粗格粗算
  python tools/flood/simple_drainage.py --river-level design     # 用 1% 年遇水位（顶托）

  # 时间版（L2）+ 长历时雨型
  python tools/flood/simple_drainage.py --res 1 --l2 --p-mm-h 26 --dur-h 24 \\
      --dt 900 --tail-h 18 --hyetograph pulse --frame-min 45 --out data/flood/sc_24h
  python tools/flood/simple_drainage.py --res 1 --l2 --p-mm-h 18 --dur-h 72 \\
      --dt 1800 --tail-h 24 --hyetograph pulse --frame-min 90 --out data/flood/sc_72h

【雨型】--hyetograph 给的是时间形状（uniform/peak/pulse/front），
以平均雨强 --p-mm-h 归一化；峰值段能到平均值的 3~4 倍，才会打穿 30 mm/h 的管网。
长历时（24 h / 72 h）必须用非 uniform，否则均匀小雨根本打不穿管网、算出来没水。

【已知边界】L1 是稳态水量平衡，不做时间演进、不做管网、不做潮位过程；
算不出"某个雨水口倒灌"，也给不出退水曲线（那是 L2）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np
from PIL import Image

# 【坑】Windows 控制台默认 GBK，日志里的 "m³"/中文会抛 UnicodeEncodeError 直接打断计算。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DERIVED = os.path.join(ROOT, "data", "derived")


def build_street_raster(grid, res, h, w):
    """
    把真实路网烧成栅格（P3 用）。

    【为什么需要】P3 想让积水沿街道连成整条，而不是摊成上千个小水洼。光把
    「楼当墙」实测只把连通块从 40 块降到 34 块、最大块 34.7%→33.2%，几乎没用。
    因为水在街区之间仍是一格一格往低处走，没有「街道优先」这个偏好。
    真实城区里雨水是被路缘石和路面纵坡**主动组织**到街道上的，街道就是排水通道。

    数据来源：`data/streets/dc_streets.json`（24,660 条 way，来自
    `out/dc_real3_clean.blend`），每条带 `prof`（横断面半宽，米）与 `pts`（plan 坐标）。

    返回 bool 栅格 (h, w)；缓存到 `data/derived/street_mask_{res}.npz`。
    """
    import numpy as _np
    cache = os.path.join(DERIVED, f"street_mask_{res:g}.npz")
    if os.path.exists(cache):
        z = _np.load(cache)
        if int(z["h"]) == h and int(z["w"]) == w:
            return z["m"]
    fp = os.path.join(ROOT, "data", "streets", "dc_streets.json")
    if not os.path.exists(fp):
        log("      [warn] 没有 data/streets/dc_streets.json，跳过街道栅格")
        return _np.zeros((h, w), dtype=bool)
    sj = json.load(open(fp, encoding="utf-8"))
    prof = {}
    for k, v in (sj.get("profiles") or {}).items():
        try:
            prof[k] = max(abs(float(p[0])) for p in v[:2]) if len(v) >= 2 else 3.0
        except Exception:
            prof[k] = 3.0
    x0, y1 = float(grid["x0"]), float(grid["y1"])
    step = max(res * 0.5, 0.5)
    half_acc = _np.zeros((h, w), dtype=_np.float32)
    npt = 0
    for wy in sj.get("ways") or []:
        pts = wy.get("pts") or []
        if len(pts) < 2:
            continue
        hw = prof.get(wy.get("prof") or "", 3.0)
        if hw <= 0:
            hw = 3.0
        for i in range(len(pts) - 1):
            ax, ay = float(pts[i][0]), float(pts[i][1])
            bx, by = float(pts[i + 1][0]), float(pts[i + 1][1])
            L = ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5
            n = max(2, int(L / step) + 1)
            for t in range(n):
                f = t / (n - 1.0)
                px, py = ax + (bx - ax) * f, ay + (by - ay) * f
                cc = int((px - x0) / res)
                rr = int((y1 - py) / res)
                if 0 <= rr < h and 0 <= cc < w:
                    if hw > half_acc[rr, cc]:
                        half_acc[rr, cc] = hw
                    npt += 1
    m = half_acc > 0
    # 按半宽膨胀成带状（用统一最大半径 5 m，窄巷也跟着宽一点，对排水通道概念无碍）
    try:
        from scipy import ndimage as _ndi
        it = max(1, int(round(5.0 / res)))
        m = _ndi.binary_dilation(m, iterations=it)
    except Exception:
        pass
    _np.savez_compressed(cache, m=m, h=_np.int32(h), w=_np.int32(w))
    log(f"      街道栅格：{npt} 个采样点 → {int(m.sum())} 格（{int(m.sum()) * res * res / 1e6:.2f} km²）")
    return m
OUT = os.path.join(ROOT, "data", "flood")

# 参数表（文献初值，见 §5.8；跑出来再校）
# landcover: 0 水体 / 1 建筑 / 2 硬化 / 3 草地 / 4 林地 / 5 裸土
C_RUNOFF = np.array([0.00, 0.95, 0.90, 0.15, 0.10, 0.35], dtype="float32")

# ---- P2.5：真实下渗率与土壤蓄水（退水第一驱动）----
# 【为什么换】老口径 `F_INFIL` 是「每类地表一个常数下渗率」，既没有上限（下一场
# 72 h 的雨能在林地上"渗"进 1440 mm，比土层厚得多），也没有饱和过程（硬化面永远
# 以 2 mm/h 吸）。真实退水是**土壤吸饱了就不再吸**，所以必须给每类地表一个
# 「还能吸多少」的存量，下渗把它吃光就停。
#
# 【数据来源】
#   · 饱和导水率 Ks：Rawls, Brakensiek & Miller (1983) Green-Ampt 参数表
#     （砂壤 42 mm/h、壤土 13 mm/h、粉壤 6.8 mm/h、黏壤 1.5 mm/h）
#   · TR-55 (1986) 表 2-2 各水文土壤组「最小下渗率」下界
#     （HSG A 2.5 / B 1.3 / C 0.6 / D 0.03 mm/h），作为长历时已饱和后的残余速率
#   · DC 城区土壤以 HSG B/C 为主（Potomac 冲积阶地 + Piedmont 残积壤土），
#     建成区大量是压实填土（按 HSG C/D 取低值）
#   · 有效孔隙度 0.15~0.20（壤土），控制层厚取根系层/扰动层
# 所以每一类给三个数：初渗率 f0、稳定下渗率 fc、可吸存量 cap（mm）。
INFIL_F0 = np.array([0.0, 3.0, 6.0, 45.0, 60.0, 12.0], dtype="float32")   # mm/h 干土初渗
INFIL_FC = np.array([0.0, 1.0, 1.5, 13.0, 26.0, 4.0], dtype="float32")    # mm/h 稳定下渗
# 可吸存量 = 控制层厚 × 有效孔隙度（mm）
#   屋顶/硬化：只有接缝与路缘，5 mm
#   草地：0.3 m 根系层 × 0.15 = 45 mm（压实城市草坪取下界）
#   林地：0.6 m × 0.15 = 90 mm（DC 的 Rock Creek 廊道是原生壤土）
#   裸土/空地：0.2 m × 0.15 = 30 mm（多为压实填土，取低）
INFIL_CAP = np.array([0.0, 5.0, 5.0, 45.0, 90.0, 30.0], dtype="float32")  # mm 土壤蓄水
# 老口径常数（保留 --legacy-infil 复现 2026-10-27 之前的结果时用）
F_INFIL = INFIL_FC.copy()                                                 # mm/h（下游按 fc 用）
DRAINS = np.array([False, False, True, False, False, False])              # 只有硬化面有雨水口

# 管网设计排水强度（mm/h）：≈ 2 年一遇 60 分钟雨型（DC 口径，含调蓄富余）
# 【坑】别用「每个雨水口 60 L/s」去推：60 L/s × 30 m 间距 = 0.6 m/场次，
# 比 50 mm 的雨还大，会把全城的水排干（第一版就这么算，只剩 275 格积水）。
DRAIN_CAP_MM_H = 30.0
EPS_Z = 1e-5            # 高程判平阈值（m）
                        # 【坑】必须小于填洼时加的最小坡度：8 m 对角线的 eps=1e-3/11.3=8.8e-5，
                        # 阈值取 1e-4 时填平的格子会被当成"没有下游"的汇，全城的水都灌进这 164 个假坑里。


def log(msg: str) -> None:
    print(msg, flush=True)


def load_raster(name: str) -> np.ndarray:
    path = os.path.join(DERIVED, name)
    if not os.path.exists(path):
        raise SystemExit(f"缺输入：{path}")
    return np.array(Image.open(path))


def block_extent(a: np.ndarray, res: int) -> tuple[slice, slice]:
    rows = (a.shape[0] // res) * res
    cols = (a.shape[1] // res) * res
    return slice(0, rows), slice(0, cols)


def bmean(a: np.ndarray, res: int) -> np.ndarray:
    sl = block_extent(a, res)
    x = a[sl]
    return x.reshape(x.shape[0] // res, res, x.shape[1] // res, res).mean(axis=(1, 3))


def bmode(a: np.ndarray, res: int, ncls: int = 6) -> np.ndarray:
    """下垫面取块内众数（少数派草地被建筑吃掉，比均值更接近真实不透水面）。"""
    sl = block_extent(a, res)
    x = a[sl]
    h, w = x.shape[0] // res, x.shape[1] // res
    x = x.reshape(h, res, w, res).transpose(0, 2, 1, 3).reshape(h, w, res * res)
    out = np.zeros((h, w), dtype="uint8")
    for c in range(ncls):
        cnt = (x == c).sum(axis=2)
        out = np.where(cnt > (x.shape[2] // 2), c, out)
    # 众数不足半数时退回最大计数类
    best = np.zeros((h, w), dtype="int32")
    bestc = np.zeros((h, w), dtype="uint8")
    for c in range(ncls):
        cnt = (x == c).sum(axis=2)
        m = cnt > best
        best = np.where(m, cnt, best)
        bestc = np.where(m, c, bestc)
    out = np.where(best * 2 > x.shape[2], out, bestc)
    return out.astype("uint8")


def bmax(a: np.ndarray, res: int) -> np.ndarray:
    sl = block_extent(a, res)
    x = a[sl]
    return x.reshape(x.shape[0] // res, res, x.shape[1] // res, res).max(axis=(1, 3))


def priority_flood(z: np.ndarray, eps: float = 1e-3) -> np.ndarray:
    """
    洼地填平（Barnes 的 Priority-Flood + epsilon）。

    【为什么必须做】不填洼时，1~4 m 栅格上每一处「一格的坑」都会当成独立
    洼地攒水，结果整城布满孤立的小蓝点（第一版就是这样），看起来像噪声而不是
    内涝。填洼后水才能从坑里继续往低处走，只在大片低洼处停下来 —— 这才是
    「哪片低洼、多深」要的。
    """
    h, w = z.shape
    n = h * w
    zf = z.ravel().astype("float64")
    out = np.empty(n, dtype="float64")
    closed = np.zeros(n, dtype=bool)
    heap: list[tuple[float, int]] = []

    def push(i: int, base: float) -> None:
        closed[i] = True
        v = max(zf[i], base)
        out[i] = v
        heap.append((v, i))

    # 边界入堆
    for c in range(w):
        push(c, -1e9)
        push((h - 1) * w + c, -1e9)
    for r in range(h):
        push(r * w, -1e9)
        push(r * w + w - 1, -1e9)
    import heapq
    heapq.heapify(heap)

    while heap:
        e, i = heapq.heappop(heap)
        r, c = divmod(i, w)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                rr, cc = r + dy, c + dx
                if rr < 0 or rr >= h or cc < 0 or cc >= w:
                    continue
                j = rr * w + cc
                if closed[j]:
                    continue
                closed[j] = True
                v = zf[j]
                out[j] = v if v > e + eps else e + eps
                heapq.heappush(heap, (out[j], j))
    return out.reshape(h, w)


def d8_receiver(z: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """返回 (receiver_flat_index, is_sink)。最陡下降；平地不路由（当 sink）。"""
    h, w = z.shape
    n = h * w
    flat = z.ravel()
    best_slope = np.full(n, -np.inf, dtype="float64")
    recv = np.full(n, -1, dtype=np.int64)

    # 8 邻域：(dy, dx, dist)
    nbrs = [(-1, -1, 1.41421356), (-1, 0, 1.0), (-1, 1, 1.41421356),
            (0, -1, 1.0),                    (0, 1, 1.0),
            (1, -1, 1.41421356), (1, 0, 1.0), (1, 1, 1.41421356)]

    for dy, dx, dist in nbrs:
        zs = np.full(n, np.nan)
        rows = slice(max(0, dy), h + min(0, dy))
        cols = slice(max(0, dx), w + min(0, dx))
        rows_src = slice(max(0, -dy), h + min(0, -dy))
        cols_src = slice(max(0, -dx), w + min(0, -dx))
        zs.reshape(h, w)[rows_src, cols_src] = z[rows, cols]
        slope = (flat - zs) / dist
        ok = np.isfinite(zs) & (slope > best_slope) & (slope > EPS_Z)
        # 邻居的平面索引
        idx = np.arange(n, dtype=np.int64).reshape(h, w)
        nb_idx = np.full((h, w), -1, dtype=np.int64)
        nb_idx[rows_src, cols_src] = idx[rows, cols]
        nbi = nb_idx.ravel()
        ok = ok & (nbi >= 0)
        best_slope = np.where(ok, slope, best_slope)
        recv = np.where(ok, nbi, recv)

    is_sink = recv < 0
    return recv, is_sink


def route_accum(load: np.ndarray, recv: np.ndarray, drain_cap: np.ndarray,
                outlet: np.ndarray, storage: np.ndarray
                ) -> tuple[np.ndarray, np.ndarray, float, float, float]:
    """
    Kahn 拓扑累加（fill-and-spill 口径）。

    关键的一句：**填洼只能用来算流向，不能用填平后的地形当"不会积水"的地面。**
    填平会把所有洼地抹掉，水一路顺到出口，结果全城一滴不剩（第二版就是这个
    错：0 格积水）。正确做法是每个洼地有自己的蓄水容量 storage = (填平后 - 原始)
    × 格面积，水先灌满这个容量，满了才沿流向溢出去。

    - 硬化格在搬运前先扣掉管网排水能力（drain_cap，m³/格/场次）
    - 水进入 outlet（河道/计算域边界）= 出域
    返回 (滞留体积 m³, 每格留存体积 m³, 管网排掉, 出域, 无出口残余)
    """
    h, w = load.shape
    n = h * w
    recv_flat = recv.ravel()
    load_flat = load.ravel().astype("float64")
    cap_flat = drain_cap.ravel().astype("float64")
    out_flat = outlet.ravel()
    st_flat = storage.ravel().astype("float64")
    held_flat = np.zeros(n, dtype="float64")
    drained = 0.0
    discharged = float(load_flat[out_flat].sum())     # 出口格自己的产流直接走
    load_flat[out_flat] = 0.0

    indeg = np.bincount(recv_flat[recv_flat >= 0], minlength=n).astype("int32")
    frontier = np.flatnonzero(indeg == 0)
    it = 0
    while frontier.size:
        it += 1
        # 1) 管网先抽
        take = np.minimum(load_flat[frontier], cap_flat[frontier])
        if take.any():
            load_flat[frontier] -= take
            cap_flat[frontier] -= take
            drained += float(take.sum())
        # 2) 洼地先蓄满
        hold = np.minimum(load_flat[frontier], st_flat[frontier])
        if hold.any():
            held_flat[frontier] += hold
            load_flat[frontier] -= hold
            st_flat[frontier] -= hold

        # 3) 剩下的往下游送（注意 frontier 必须靠 indeg 推进，不能因为
        #    "这一层没有水要送"就 break —— 那会把下游所有格子整片漏掉，
        #    水就永远停在中间格子里，水量对不上）
        r = recv_flat[frontier]
        move = r >= 0
        if not move.any():
            break
        src = frontier[move]
        dst = r[move]
        amt = load_flat[src].copy()
        to_out = out_flat[dst]
        if to_out.any():
            discharged += float(amt[to_out].sum())
            amt[to_out] = 0.0
        # 先清零、后 add：同层里既收又发的格子才不会把新收到的水一起抹掉
        load_flat[src] = 0.0
        np.add.at(load_flat, dst, amt)
        rc = np.bincount(dst, minlength=n)
        touched = np.flatnonzero(rc)
        indeg[touched] -= rc[touched].astype("int32")
        frontier = touched[indeg[touched] == 0]
        if it > 2000000:
            log("  [警告] 拓扑层数超限，提前结束累加")
            break
    leftover = float(load_flat.sum())
    return (held_flat + load_flat).reshape(h, w), held_flat.reshape(h, w), drained, discharged, leftover


def level_basins(z: np.ndarray, vol: np.ndarray, pit_mask: np.ndarray,
                 min_area: int = 3, cell_area: float = 1.0) -> np.ndarray:
    """
    按「洼地」摊平水面 —— 这一步才是"哪片低洼、多深"的关键。

    【坑】不能只按单格蓄水量除面积。填洼容量是**一格一格**算的，水就停在
    14,000 个互不相连的小坑里，每格零点几米，出图就是撒了一地蓝芝麻。
    实际上一场雨过后，同一片洼地里的水位是平的：把洼地当连通域，用总体积
    反解水位（二分），水深 = max(0, 水位 - 地面高程)，才能得到连片的水面。
    """
    from scipy import ndimage as ndi

    depth = np.zeros_like(z)
    lab, nlab = ndi.label(pit_mask, structure=np.ones((3, 3), dtype=bool))
    if nlab == 0:
        return depth
    # 只处理真的有水的洼地
    sumv = ndi.sum(vol, lab, index=np.arange(1, nlab + 1))
    areas = ndi.sum(np.ones_like(z), lab, index=np.arange(1, nlab + 1))
    todo = np.flatnonzero((sumv > 1e-6) & (areas >= min_area))
    if todo.size == 0:
        return depth
    idx = np.flatnonzero(lab.ravel())
    lv = lab.ravel()[idx]
    zv = z.ravel()[idx]
    order = np.argsort(lv, kind="stable")
    idx, lv, zv = idx[order], lv[order], zv[order]
    starts = np.searchsorted(lv, todo + 1, side="left")
    ends = np.searchsorted(lv, todo + 1, side="right")
    depth_flat = depth.ravel()
    for k, bi in enumerate(todo):
        a, b = starts[k], ends[k]
        if b <= a:
            continue
        zs = zv[a:b]
        # 【坑·单位】vol 是 m³，下面 (水位-地面).sum() 是「米·格数」，两边差一个
        # 格面积。不除面积，解出来的水位会高出十几倍（L2 里一度最大水深 13 m，
        # 而且体积凭空多出来）。
        V = float(sumv[bi]) / max(1e-9, cell_area)
        # 【坑】上界写死 zs.min()+10 会让深坑（桥下、废矿坑、崖下）被截断在
        # 10 m：解不出水位，多出来的水量凭空消失（L2 里 retained 一度比总产流
        # 还大）。上界要按体积指数外扩。
        lo = float(zs.min())
        hi = lo + 1.0
        for _ in range(24):
            if float(np.maximum(0.0, hi - zs).sum()) >= V:
                break
            hi = lo + (hi - lo) * 2.0
        for _ in range(48):                     # 二分反解水位
            mid = 0.5 * (lo + hi)
            if float(np.maximum(0.0, mid - zs).sum()) * 1.0 > V:
                hi = mid
            else:
                lo = mid
        level = 0.5 * (lo + hi)
        depth_flat[idx[a:b]] = np.maximum(0.0, level - zs)
    return depth


def spread_ponding(z: np.ndarray, vol: np.ndarray, steps: int = 80, river_mask=None,
                   river_level: float = 0.0) -> np.ndarray:
    """
    洼地扩散：水不会堆在一个格子里，会摊到同一水面上。
    做若干轮「水面高差驱动」的再分配（vectorized 8 邻域），近似静水平衡。
    river_mask 的格子固定为河水位，水进去即出域。
    """
    h, w = z.shape
    depth = vol.copy()
    for s in range(steps):
        ws = z + depth
        if river_mask is not None:
            ws = np.where(river_mask, np.minimum(ws, river_level), ws)
        # 8 邻域最小水面
        mn = np.full((h, w), np.inf)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                sh = np.full((h, w), np.inf)
                ys = slice(max(0, dy), h + min(0, dy))
                yd = slice(max(0, -dy), h + min(0, -dy))
                xs = slice(max(0, dx), w + min(0, dx))
                xd = slice(max(0, -dx), w + min(0, -dx))
                sh[yd, xd] = ws[ys, xs]
                np.minimum(mn, sh, out=mn)
        drop = ws - mn
        move = np.where(drop > 1e-3, depth * 0.5, 0.0)
        if move.max() <= 0:
            break
        # 只往最陡的方向搬一半，简单又稳
        depth = depth - move
        # 找每个格最小邻居的位置
        ydx = np.zeros((h, w), dtype="int16")
        xdx = np.zeros((h, w), dtype="int16")
        best = np.full((h, w), np.inf)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                sh = np.full((h, w), np.inf)
                ys = slice(max(0, dy), h + min(0, dy))
                yd = slice(max(0, -dy), h + min(0, -dy))
                xs = slice(max(0, dx), w + min(0, dx))
                xd = slice(max(0, -dx), w + min(0, -dx))
                sh[yd, xd] = ws[ys, xs]
                m = sh < best
                best = np.where(m, sh, best)
                ydx = np.where(m, dy, ydx)
                xdx = np.where(m, dx, xdx)
        ty = np.clip(np.arange(h)[:, None] + ydx, 0, h - 1)
        tx = np.clip(np.arange(w)[None, :] + xdx, 0, w - 1)
        np.add.at(depth, (ty.ravel(), tx.ravel()), move.ravel())
    return depth


# 管网排水能力按下垫面给（mm/h）：
# 【坑】不能所有格子都给 30 —— 草地/林地下渗为主，管网覆盖的是硬化面；给草
# 地也 30 会让郊区的水一路消失，退水曲线变成直线掉到 0。
DRAIN_CLASS_MM_H = np.array([0.0, 30.0, 30.0, 5.0, 2.0, 3.0])


def flood_impact(depth, grid, res, cell_area, lc, tier_m=(0.01, 0.15, 0.30, 1.00),
                 road_step_m=6.0):
    """
    P0 口径：把「一个 wet_ha」拆成能对外说话的三本账。

    【为什么必须拆】原来只报「>15 cm 的面积 / 全域 30.6 km²」。两个毛病：
      1) 15 cm 是硬门槛，1 cm 口径的湿区面积是它的 2.8 倍，只报 15 cm 会
         把「路面积水」整个说没了；
      2) 分母用了含河道的全域，而波托马克河/潮汐湖/Anacostia 本身常年是水面，
         永远淹不着，混在分母里把比例压低。
    所以这里统一改成：**分母只算陆域**（landcover != 0），面积分四档报，
    另外给「淹没建筑数」和「受淹道路长度」—— 这两个才是非专业读者能懂的指标。
    """
    h, w = depth.shape
    x0, y1 = float(grid["x0"]), float(grid["y1"])
    land = lc != 0
    area_land_km2 = float(land.sum()) * cell_area / 1e6
    d_land = np.where(land, depth, 0.0)

    tiers = {}
    for m in tier_m:
        cells = int((d_land > m).sum())
        tiers[f"gt{int(round(m * 100))}cm"] = {
            "km2": round(cells * cell_area / 1e6, 4),
            "pct_land": round(100.0 * cells * cell_area / 1e6 / max(1e-9, area_land_km2), 2),
        }

    # ---- 淹没建筑：按轮廓 bbox 取峰值水深的最大值 ----
    bld = {"total": 0, "touched_m5cm": 0, "gt30cm": 0, "gt100cm": 0,
           "list": []}
    fp = os.path.join(DERIVED, "buildings_footprints.json")
    if os.path.exists(fp):
        bj = json.load(open(fp, encoding="utf-8"))
        for b in bj.get("features", []):
            rings = b.get("rings") or []
            if not rings or len(rings[0]) < 3:
                continue
            # 【坑】buildings_footprints.json 里混着三类不是「楼」的东西，
            # 直接统计会把报表搞得很荒谬（实测 `id="ground"` 那张 30.6 km² 的
            # 大面、以及 27 万 m² 的校园/停车场面都排进了 top 榜）：
            #   1) `building` 标签为空的（1,477 个，多是 landuse 面、水面、操场）
            #   2) 面积 > 6 万 m² 的（7 个，整体校园/园区，不是单栋楼）
            #   3) 面积 < 15 m² 的（棚子/门房，对内涝汇报没意义）
            # 所以只认「有 building 标签 且 15 ≤ 面积 ≤ 60000」的。
            tag = (b.get("building") or "").strip()
            barea = float(b.get("footprint_area_m2") or 0)
            if not tag or barea < 15.0 or barea > 60000.0:
                continue
            bld["total"] += 1
            pts = rings[0]
            c0 = int((min(p[0] for p in pts) - x0) / res)
            c1 = int((max(p[0] for p in pts) - x0) / res) + 1
            r0 = int((y1 - max(p[1] for p in pts)) / res)
            r1 = int((y1 - min(p[1] for p in pts)) / res) + 1
            c0, c1 = max(0, c0), min(w, c1)
            r0, r1 = max(0, r0), min(h, r1)
            if c1 <= c0 or r1 <= r0:
                continue
            d = float(d_land[r0:r1, c0:c1].max())
            if d > 0.05:
                bld["touched_m5cm"] += 1
                if d > 0.30:
                    bld["gt30cm"] += 1
                if d > 1.00:
                    bld["gt100cm"] += 1
                if d > 0.30:
                    bld["list"].append({
                        "id": b.get("id"), "name": b.get("name") or "",
                        "building": b.get("building") or "",
                        "area_m2": round(float(b.get("footprint_area_m2") or 0)),
                        "max_depth_m": round(d, 3)})
        bld["list"].sort(key=lambda q: -q["max_depth_m"])
        bld["list"] = bld["list"][:200]

    # ---- 受淹道路：沿街道折线按 road_step_m 采样，累加「水深 >15 cm」的长度 ----
    road = {"road_km_total": 0.0, "road_km_flooded": 0.0, "road_km_gt30cm": 0.0}
    sp = os.path.join(ROOT, "data", "streets", "dc_streets.json")
    if os.path.exists(sp):
        sj = json.load(open(sp, encoding="utf-8"))
        tot = fl = fl30 = 0.0
        for wy in sj.get("ways", []):
            pts = wy.get("pts") or []
            if len(pts) < 2:
                continue
            for i in range(len(pts) - 1):
                ax, ay = float(pts[i][0]), float(pts[i][1])
                bx, by = float(pts[i + 1][0]), float(pts[i + 1][1])
                seg = ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5
                if seg < 1e-6:
                    continue
                nsub = max(1, int(round(seg / road_step_m)))
                ds = seg / nsub
                tot += seg
                for j in range(nsub):
                    u = (j + 0.5) / nsub
                    x = ax + (bx - ax) * u
                    y = ay + (by - ay) * u
                    c = int((x - x0) / res)
                    r = int((y1 - y) / res)
                    if c < 0 or c >= w or r < 0 or r >= h:
                        continue
                    dv = float(depth[r, c])
                    if dv > 0.15:
                        fl += ds
                        if dv > 0.30:
                            fl30 += ds
        road["road_km_total"] = round(tot / 1000.0, 2)
        road["road_km_flooded"] = round(fl / 1000.0, 2)
        road["road_km_gt30cm"] = round(fl30 / 1000.0, 2)
        road["pct_flooded"] = round(100.0 * fl / max(1e-9, tot), 2)

    return {"area_land_km2": round(area_land_km2, 3), "tiers": tiers,
            "buildings": bld, "roads": road}


def l2_loop(z, recv, storage, pit_mask, outlet, lc_flow, cell_area,
            grid, args, outdir, river_level=0.0, river_area_m2=0.0):
    """
    L2 时间版：把 L1 的「稳态一次搬完」改成按 dt 步进。

    每一步：本步产流 → 扣管网 → 顺 D8 汇到所属洼地 → 洼地满了溢流给下游洼地
    → 按洼地体积反解水位。雨停之后洼地里的水继续按指数退水，于是自然出现
    「退水」曲线；出口（河道/计算域边界）进来的水直接出域。

    【为什么要重写这一版】第一版是「逐格 Python 循环 + 每层全网格 bincount」，
    2 m 还能忍（1,505 s），1 m 一步就要 16 分钟、整场 16 小时，没法用。
    现在把"水往哪流"在开场算成静态的 `term`（每格最终落到哪个洼地），
    每一步只剩几次 O(格数) 的 numpy 运算；洼地之间的溢流在图（几万个节点）上
    迭代，与格数无关。物理口径没变，只是把重复计算的拓扑搬到了开场。

    返回 summary dict，并落盘 frames/*.u8（给 web 用的降采样深度场）。
    """
    from scipy import ndimage as ndi

    h, w = z.shape
    n = h * w
    dt = float(args.dt)
    n_rain = max(1, int(round(args.dur_h * 3600.0 / dt)))
    tail = max(0, int(round(args.tail_h * 3600.0 / dt)))
    # 落帧间隔：默认 5 min；长历时时按总时长自动放大，保证帧数不失控。
    # 【注意】frame_every 的单位是「步」，不是秒 —— 长历时如果还用 300 s 一步的
    # 步长去算，24 h 会出 288 帧，web 上 240 MB，加载器会卡死。
    #
    # 【坑，别只留自动那一条】改成「按总帧数反算」之后，`--l2` 的默认参数
    # （dt=60 / dur 1 h / tail 2 h → 180 步）算出 frame_every=1，181 帧 ≈154 MB。
    # 老代码是 `round(300/dt)=5` → 36 帧 ≈31 MB。所以这里**同时**保留 300 s 的
    # 间隔下限：两边取大，短工况回到老行为，长工况靠自动放大压住帧数。
    if getattr(args, "frame_min", 0) and args.frame_min > 0:
        frame_every = max(1, int(round(args.frame_min * 60.0 / dt)))
    else:
        n_total = n_rain + tail
        by_budget = int(round(n_total / max(1, int(args.max_frames))))
        by_5min = int(round(300.0 / dt))
        frame_every = max(1, by_budget, by_5min)

    # 每个格子每步的管网排水体积（m3）：别忘了 /3600，否则 5 分钟一步会被当成
    # 300 小时，排水能力放大 3600 倍，全城秒干（踩过）。
    drain_step = ((DRAIN_CLASS_MM_H[lc_flow] / 1000.0) * (dt / 3600.0)) * cell_area

    # ---- 雨型（时间形状函数）----
    # 【为什么必须归一化到 1】`--p-mm-h` 是**整场平均雨强**，shape 只是一个
    # 无量纲的时间轮廓。若不归一化，峰值型雨型的**总量**会变成平均雨强的
    # 若干倍，闭合差那本账就对不上了。
    rain_shape = None
    kind = str(getattr(args, "hyetograph", "uniform") or "uniform")
    if kind != "uniform" and n_rain > 1:
        u = np.arange(n_rain, dtype="float64") / (n_rain - 1)   # 0..1
        if kind == "peak":
            # 单峰：长时间小雨 → 一段强降雨 → 缓退
            s = np.interp(u, [0.0, 0.55, 0.67, 1.0], [0.08, 2.6, 2.6, 0.06])
        elif kind == "pulse":
            # 双脉冲：真实长历时「下下停停」，两段对流单体各 ~2 h
            s = np.interp(u, [0.0, 0.10, 0.22, 0.34, 0.46, 0.55, 0.62, 0.78, 1.0],
                          [0.06, 0.50, 2.80, 0.12, 0.08, 2.20, 3.80, 0.10, 0.03])
        elif kind == "front":
            # 冷锋：先小后大，结尾陡收（最容易致灾的一类）
            s = np.interp(u, [0.0, 0.30, 0.62, 0.85, 1.0], [0.05, 0.25, 1.20, 3.60, 0.90])
        else:
            s = np.ones(n_rain, dtype="float64")
        # 归一化：∫shape = n_rain，保证整场雨量 = p_mm_h × dur_h
        m = float(s.mean())
        rain_shape = s / (m if m > 1e-9 else 1.0)

    zf = z.ravel().astype("float64")
    recv_f = recv.ravel().astype("int64")
    st_f = storage.ravel().astype("float64")
    # 【坑·下渗必须逐时刻扣】原来传进来的是 `vol_hour = max(0, p − F)·C·A`，
    # 即「按平均雨强扣完下渗再乘时间形状」—— 等于假设下渗也随时程缩放。
    # 后果一：p=18 mm/h 的 72 h 工况，林地 F_INFIL=20 > 18，林地那一类的
    #         vol_hour 恒为 0，整场不产一滴水（而 pulse 峰值 3.58×18≈64 mm/h
    #         早就把 20 mm/h 的下渗打穿了）。
    # 后果二：雨强越大，下渗被高估得越多（按峰值雨强去扣，等于假设地表
    #         能一直以最大速率吸水），硬化面的产流被系统性低估。
    # 正确口径：**逐格、逐时刻**算有效雨强 `max(0, 本步雨强 − F)`，
    # 下渗是场地属性（mm/h），不能跟着雨型缩放。
    # 所以这里只预存两个**与时间无关**的因子，真正的乘法在循环里做：
    #   runoff_gain = C / 1000 · A   （把 mm/h 换成 m³/h）
    #   infil_mm_h  = F[类别]        （mm/h）
    runoff_gain = (C_RUNOFF[lc_flow] / 1000.0 * cell_area).ravel()        # (m³/h) 每 mm/h
    # ---- P2.5：真实下渗（带土壤蓄水上限）----
    # 见文件头 INFIL_* 的注释：老口径是常数速率、无上限，等于假设土层无限厚。
    # 这里改成「干土初渗 f0 → 饱和后稳定下渗 fc」的线性衰退，外加可吸存量 cap：
    #   rate = fc + (f0 − fc) · (存量 / cap)      干土时 = f0，吸饱时 = fc
    #   rate = min(rate, 存量 / 本步时长)          不能吸出比存量更多的水
    # 存量被下渗吃掉，雨停后按 --soil-recover-h 缓慢回补（排水/蒸散腾出孔隙）。
    _legacy = bool(getattr(args, "legacy_infil", False))
    if _legacy:
        _f0 = F_INFIL[lc_flow].astype("float64").ravel()
        _fc = _f0.copy()
        _cap = np.full(_f0.shape, np.inf)
    else:
        _f0 = INFIL_F0[lc_flow].astype("float64").ravel()
        _fc = INFIL_FC[lc_flow].astype("float64").ravel()
        _cap = INFIL_CAP[lc_flow].astype("float64").ravel()
    soil_left = _cap.copy()                                               # mm 每格
    _soil_tau = max(1.0, float(getattr(args, "soil_recover_h", 24.0)) * 3600.0)
    _soil_rec = float(np.exp(-dt / _soil_tau)) if np.isfinite(_cap).any() else 1.0
    drain_f = drain_step.ravel().astype("float64")

    # ---- P1：管网调蓄（漏水桶）----
    # 【为什么要这一层】原来 `net = max(0, rain_vol - drain_f)` 把 30 mm/h 当成
    # 永不失效的能力：雨下 2 h 就排 2 h、下 72 h 就排 72 h，账面永远排得掉，
    # 于是「特大暴雨」在报表里只剩 5% 地面湿。真实情况是雨水口 20~40 min 满管，
    # 之后排水量掉到接近 0，水才开始在地面涨起来 —— 这才是内涝的形成机制。
    #
    # 建模方式：把管网看成一个有限容量的桶。桶里能存
    #   drain_fail_after_mm ×（接了雨水口的硬化面积）
    # 立方米的水；桶越满，进水能力越低（线性）；
    # 桶满了只剩 `drain_residual` 倍设计能力（漏损/泵站）；雨停后按
    # `drain_recover_h` 指数放空，于是下一场雨又能排。
    drain_area = float((DRAINS[lc_flow] & (lc_flow > 0)).sum()) * cell_area
    if args.drain_fail_after_mm and args.drain_fail_after_mm > 0:
        bucket_cap = args.drain_fail_after_mm / 1000.0 * drain_area
    else:
        bucket_cap = 0.0                       # 0 = 退回老口径（永不失效）
    residual = float(np.clip(getattr(args, "drain_residual", 0.05), 0.0, 1.0))
    tau_rec = max(1.0, float(getattr(args, "drain_recover_h", 6.0)) * 3600.0)
    rec_decay = float(np.exp(-dt / tau_rec))
    saturated_at_min = None
    peak_used_frac = 0.0                      # 管网预算最高占用率（0~1）
    drains_f = DRAINS[lc_flow].ravel()        # 哪些格接了雨水口（布尔）
    budget_used = 0.0                         # 管网已占用的调蓄预算（m³）
    if bucket_cap > 0:
        log(f"      管网调蓄容量 {bucket_cap:,.0f} m³"
            f"（{args.drain_fail_after_mm:.0f} mm × {drain_area / 1e6:.3f} km² 硬化面）")

    # ---- 开场一次性：给每格算「水流终点」 ----
    # 洼地格是自己的终点（自环），其他格沿 D8 走；指针倍增 32 轮（2^32 > 格数）
    # 就把整条链压成一步，等价于原来跑 2000 层的 Kahn 推进。
    lab, nlab = ndi.label(pit_mask.astype("uint8"),
                          structure=np.ones((3, 3), dtype=bool))
    lab_f = lab.ravel().astype("int64")
    is_pit = lab_f > 0
    if nlab == 0:
        raise SystemExit("[L2] 没有洼地（storage 全 0），时间版无从谈起")

    ar = np.arange(n, dtype="int64")
    tgt = np.where(is_pit, ar, recv_f)
    tgt = np.where(tgt < 0, -1, tgt)
    for _ in range(32):
        safe = np.where(tgt < 0, 0, tgt)
        tgt = np.where(tgt < 0, -1, tgt[safe])
    term = np.where((tgt >= 0) & (is_pit[np.maximum(tgt, 0)]),
                    lab_f[np.maximum(tgt, 0)], -1)
    to_basin = term >= 0

    # 每个洼地的蓄水容量 / 最低点；洼地之间的下游关系（0 = 直接出域）
    idx_b = np.flatnonzero(is_pit)
    z_b = zf[idx_b]
    lab_b = lab_f[idx_b]
    cap_b = np.bincount(lab_b, weights=st_f[idx_b], minlength=nlab + 1)
    minz_b = np.full(nlab + 1, np.inf)
    np.minimum.at(minz_b, lab_b, z_b)
    minz_b[0] = 0.0

    ds_b = np.zeros(nlab + 1, dtype="int64")
    r = recv_f[idx_b]
    out_edge = (r >= 0) & (lab_f[np.maximum(r, 0)] != lab_b) | (r < 0)
    rr = r[out_edge] if out_edge.any() else np.zeros(0, dtype="int64")
    # 每格的水流最终落到哪一格（填平后的地形上几乎每格都有终点）。
    # 必须在算 ds_b 之前定义 —— 洼地漫出时要用它继续往下游追。
    term_cell = np.where(tgt >= 0, tgt, ar)
    if out_edge.any():
        src = lab_b[out_edge]
        # 【坑·丢水】原来只问「漫出的那一格本身是不是洼地格」，不是就记成
        # 「直接出域」。实测 1 m 网格下 97% 的洼地漫出都落在普通坡面上，
        # 于是 2.4 Mm³（51% 的产流）在报表里变成"出域"，实际是顺着坡流进
        # 下一个洼地。现在沿 `term_cell` 追到它真正落脚的洼地。
        _tc = np.where(rr >= 0, term_cell[np.maximum(rr, 0)], -1)
        _lab = np.where(_tc >= 0, lab_f[np.maximum(_tc, 0)], 0)
        dst = np.where(_lab > 0, _lab, 0)
        # 【坑·自环】填平后的地形上，洼地最低点往外走的邻居沿 recv 可能又绕回
        # 同一个洼地（`dst == src`），水就会在同一个坑里无限叠深（实测出现
        # 255 m 的荒谬水深）。自环的一律当出域，并单独计数以便追查。
        _self = dst == src
        dst = np.where(_self, 0, dst)
        n_self = int(_self.sum())
        # 同一个洼地可能有多处漫出，取"汇到哪就去哪"的最后一条，够用
        ds_b[src] = dst
        log(f"      洼地下游关系：{len(src):,} 个出流口，其中自环 {n_self:,} 个")

    # ---- P2-c ①：断环 ----
    # 【坑·环路】填平后的地形在洼地里是平的，recv 在平地上没有方向，所以洼地
    # 之间可能成环（A→B→A）。环里的水永远出不去，逐帧叠加会把水深堆到 334 m。
    # 用指针跳跃（`_dp = _dp[_dp]`，每步把链压一半）把每条链压到终点，收敛后
    # 剩下的不动点就是环，把环判成真出域。
    _dp = ds_b.copy()
    for _ in range(64):
        _nx = _dp[np.maximum(_dp, 0)]
        if np.array_equal(_nx, _dp):
            break
        _dp = _nx
    _selflab = _dp[1:] == np.arange(1, nlab + 1)
    n_cycle = int(_selflab.sum())
    ds_b[1:][_selflab] = 0
    log(f"      断环：{n_cycle:,} 个洼地卡在环里，改判真出域")

    # ---- P2-c ②：没追到下游的洼地，转给「最近的、最低点更低的洼地」----
    # 自环的水如果留在原地会被逐帧叠加（实测 255 m 深），当出域又会凭空丢掉
    # 三成的雨（实测 1.38 Mm³）。这里转给最近的、zmin 更低的洼地 —— 因为
    # 严格下降，洼地之间构成一棵树，不可能再成环，水一直流到最低那个才出域。
    _cnt = np.bincount(lab_b, minlength=nlab + 1).astype("float64")
    _cnt[_cnt == 0] = 1.0
    _colv = np.tile(np.arange(w, dtype="float64"), h)[idx_b]
    _rowv = np.repeat(np.arange(h, dtype="float64"), w)[idx_b]
    cx_b = np.bincount(lab_b, weights=_colv, minlength=nlab + 1) / _cnt
    cy_b = np.bincount(lab_b, weights=_rowv, minlength=nlab + 1) / _cnt
    _labs = np.arange(1, nlab + 1)
    _pts = np.column_stack([cx_b[_labs], cy_b[_labs]])
    _need = np.flatnonzero(ds_b[1:] == 0)
    n_orphan = int(_need.size)
    if n_orphan and nlab > 1:
        from scipy.spatial import cKDTree
        _tree = cKDTree(_pts)
        _k = int(min(24, nlab))
        _d, _j = _tree.query(_pts[_need], k=_k)
        _d = np.atleast_2d(_d)
        _j = np.atleast_2d(_j)
        for _a, _lab_a in enumerate(_need + 1):
            for _b2 in range(_k):
                _cand = _labs[_j[_a, _b2]] if _j[_a, _b2] < nlab else -1
                if _cand > 0 and minz_b[_cand] < minz_b[_lab_a] - 1e-6:
                    ds_b[_lab_a] = _cand
                    break
    _left = int(np.count_nonzero(ds_b[1:][_need] == 0))
    log(f"      洼地去向：{n_orphan:,} 个没追到下游，按「最近的更低洼地」转走 "
        f"{n_orphan - _left:,} 个，剩 {_left:,} 个是流域最低点（真出域）")

    # ---- P2-b：河道顶托（下游水位高于洼地最低点，洼地就排不空）----
    # 【物理】河道水位 L 高于洼地最低点 zmin 时，洼地里低于 L 的那部分水没有
    # 水头差可以排出去（下游比你还高）。老口径只取 0.046 m 的常水位，等于让每条
    # 通向河道的洼地都能排到见底 —— 这是把内涝算轻的第二个大原因。
    # 这里把「通向河道」的洼地的有效容量抬到「水位 L 时能存住的体积」，
    # 于是它们必须先涨到 L 才能往外溢，这就是顶托。
    to_river = np.zeros(nlab + 1, dtype=bool)
    if river_level > 0.0 and out_edge.any():
        # 【判据用高程，不用「落点是不是水体」】第一版只看落点 `lc == 0`，
        # 结果只认出 110 个洼地，剩下大量洼地的出流口落在河边的普通地面上，
        # 依旧「免费」出域。物理上的判据是：出流口的地面不高于河水位，就顶托。
        zflat = z.ravel()
        _tz = np.where(rr >= 0, zflat[np.maximum(rr, 0)], z_b[out_edge])
        is_riv = _tz <= river_level
        np.logical_or.at(to_river, lab_b[out_edge], is_riv)
    hold_b = np.zeros(nlab + 1, dtype="float64")
    if river_level > 0.0:
        below = np.maximum(0.0, river_level - z_b)
        hold_b = np.bincount(lab_b, weights=below * cell_area,
                             minlength=nlab + 1)
    cap_eff_b = np.where(to_river, np.maximum(cap_b, hold_b), cap_b)
    n_gated = int(to_river.sum())

    # ---- P2-b：河道漫溢（陆地低于河水位就是水）----
    # 纯增水情景（一滴雨不下）全靠这一条出结果：陆地低于河水位的格直接被淹，
    # 深度 = 河水位 − 地面高程。只作用于陆域（lc_flow != 0）：河面本身不在这里
    # 画，web 的河面由 water.js 负责，重复画会叠成两层。
    river_inund = np.zeros((h, w), dtype="float64")
    if river_level > 0.0:
        _land = (lc_flow != 0) & (z < river_level)
        river_inund[_land] = river_level - z[_land]
    area_river_km2 = float((river_inund > 0.0).sum()) * cell_area / 1e6
    # ---- P2-b/c：出流口筛选（哪些水真的能出域）----
    # 【这才是「50% 的水免费流走」的真正出口】除了洼地（to_basin）之外，每格的
    # 水流最终落到 `term_cell`。老代码把 `to_basin` 之外的水一律当「本步出域」，
    # 于是：落在山脊一侧的水、落在 5 cm 以下浅坑里的水，全都凭空消失。
    # 现在按出口所在格的性质分三种：
    #   outlet[term] = True  → 河面 / 低处的域边，水确实出得去
    #   outlet[term] = False → 高处域边（Fall Line 山脊），水出不去，原地积着
    #   河道出口再叠顶托：河水位高于出口地面时，同样出不去
    out_ok = np.asarray(outlet).ravel()[term_cell].copy()
    _zflat = z.ravel()
    _lcf = lc_flow.ravel()
    if river_level > 0.0:
        out_ok &= ~(_lcf[term_cell] == 0) | (_zflat[term_cell] > river_level)
    n_no_out = int((~out_ok).sum())
    # 水积在哪：出口不通的水就积在「产生它的那一格」原地 —— 早先版本把它汇到
    # 出口格（`term_cell`），几十万格的汇水都砸在少数几个深坑里，实测把最大
    # 水深堆到 334 m（明显不可能）。改成原地留存后单格水深由本格产流决定。
    hold_cell = ar
    log(f"      出流受阻：{n_no_out:,} 格的水出不去（占 {n_no_out / max(1, n):.1%}）")
    blocked = np.zeros(n, dtype="float64")   # 受阻区累积水深（m）
    blocked2 = blocked.reshape(h, w)         # 同一块内存的二维视图（随循环更新）
    if river_level > 0.0:
        log(f"      顶托：{n_gated:,} 个洼地通向河道（水位 {river_level:.2f} m）；"
            f"低于该水位的陆域 {area_river_km2:.3f} km² 直接被淹")

    # 开场先算一次「每格落到哪个洼地」的权重，之后每步只乘体积
    w_b = np.zeros(nlab + 1, dtype="float64")   # 每个洼地当前蓄水（m3）
    min_area = 1
    del min_area

    frames = []
    curve = []
    _dbg_done = False
    total = {"rain": 0.0, "drained": 0.0, "discharged": 0.0, "receded": 0.0,
             # P2.5：真实退水的四项分账
             "infil": 0.0, "seep_pond": 0.0, "evap": 0.0,
             "inlet_pond": 0.0, "to_river": 0.0}
    infil_rate = np.zeros(lc_flow.size, dtype="float64")
    # ---- P0：分级口径 ----
    # 【为什么只报 15 cm 会把话说小】数据里 1 cm 以上就是 3.59 km²（11.7%），
    # 15 cm 只剩 1.29 km²（4.2%）—— 四倍差距全靠这一个阈值。真实内涝通报
    # 也是分级的（"路面积水 / 车辆泡水 / 房屋进水"对应 15/30/100 cm 量级），
    # 所以这里把四档全算出来，报表给的是"分布"而不是"一个数"。
    TIER_M = (0.01, 0.15, 0.30, 1.00)
    peak_depth = None            # 峰值帧的深度场（float32，供建筑/道路统计）
    peak_wet = -1.0
    # 【为什么用 lc_flow 而不是 lc】`lc_flow` 只把建筑格改判成硬化类，水体仍是 0，
    # 所以 `lc_flow != 0` 与 `lc != 0` 是同一个陆域掩膜；l2_loop 里只拿得到前者。
    land_cells = int((lc_flow != 0).sum())
    area_land_km2 = land_cells * cell_area / 1e6
    os.makedirs(os.path.join(outdir, "frames"), exist_ok=True)
    depth = np.zeros((h, w), dtype="float64")
    tau = float(getattr(args, "tau_h", 3.0)) * 3600.0
    decay = float(np.exp(-dt / tau)) if tau > 0 else 1.0
    # ---- P2.5：退水由物理过程驱动 ----
    et_mm_h = max(0.0, float(getattr(args, "et_mm_h", 0.12)))
    _cap_m3s = max(0.0, float(getattr(args, "sewer_m3s", 45.0)))
    step_h = dt / 3600.0
    _drain_b = drain_step.ravel()[idx_b].astype(bool)
    _drain_rate_b = drain_step.ravel()[idx_b].astype("float64")
    # 【P2.5】每个洼地里「有雨水口」的面积比例。积水不会只停在街上：一个洼地里
    # 只要有街道经过，水面就能横向流到雨水口，被管网搬走。按洼地级算比例，
    # 比按格算掩膜更接近真实（实测按格算只能在退水阶段搬走 494 m³，等于没有）。
    _basin_n_b = np.bincount(lab_b, minlength=nlab + 1).astype("float64")
    _is_dr_b = (DRAIN_CLASS_MM_H[lc_flow].ravel()[idx_b] > 0).astype("float64")
    _drain_frac_b = np.where(_basin_n_b > 0, np.bincount(
        lab_b, weights=_is_dr_b, minlength=nlab + 1) / np.maximum(_basin_n_b, 1e-9), 0.0)
    cur_prev = np.zeros(idx_b.size, dtype="float64")     # 上一时刻的积水深度（m）

    def levels(vol_b):
        """按洼地蓄水体积反解水位（向量化二分，和 L1 的 level_basins 同口径）。"""
        Vcells = vol_b / cell_area
        lo = minz_b.copy()
        hi = minz_b + 1.0
        for _ in range(40):
            cur = np.maximum(0.0, hi[lab_b] - z_b)
            need = np.bincount(lab_b, weights=cur, minlength=nlab + 1) < Vcells
            if not need.any():
                break
            hi = np.where(need, lo + (hi - lo) * 2.0, hi)
        for _ in range(26):
            mid = 0.5 * (lo + hi)
            cur = np.maximum(0.0, mid[lab_b] - z_b)
            up = np.bincount(lab_b, weights=cur, minlength=nlab + 1) < Vcells
            lo = np.where(up, mid, lo)
            hi = np.where(up, hi, mid)
        return np.where(vol_b > 1e-6, 0.5 * (lo + hi), minz_b)

    def snap(t_s, tag):
        """深度场降到 6 m（web 用），u8 量化：上限 --depth-scale-m（默认 4 m）。"""
        f = max(1, int(round(6.0 / args.res)))
        hh, ww = (h // f) * f, (w // f) * f
        # 【坑·可见性】原来用 mean 降采样：6×6 个 1 m 格里只有一角积 10 cm 水，
        # 平均下来 1.4 cm，再被 web 的 2 cm 阈值丢掉 —— 页面上几乎看不出涨退水。
        # 改成 max（取块内最深值），薄水膜也能显示。
        # 【坑·量程】量化上限原来是 2 m，而峰值最大水深有 9 m —— 6 m 深的水
        # 在页面上被画成 2 m，观感被系统性压扁。现在由 --depth-scale-m 控制，
        # 默认 4 m（1/255 = 1.6 cm 精度），manifest 里带 scale 让前端自己换算。
        dmax = float(getattr(args, "depth_scale_m", 4.0))
        d = depth[:hh, :ww].reshape(hh // f, f, ww // f, f).max(axis=(1, 3))
        q = np.clip(d / dmax, 0.0, 1.0) * 255.0
        name = "f%03d.u8" % len(frames)
        q.astype("uint8").tofile(os.path.join(outdir, "frames", name))
        tiers = {f"gt{int(m * 100)}cm_ha": round(float((depth > m).sum())
                                                   * cell_area / 1e4, 2)
                 for m in TIER_M}
        frames.append({"file": name, "t_min": round(t_s / 60.0, 1),
                       "cols": int(d.shape[1]), "rows": int(d.shape[0]),
                       "step_m": float(args.res * f),
                       "max_depth_m": round(float(depth.max()), 3),
                       "wet_ha": round(float((depth > 0.15).sum()) * cell_area / 1e4, 2),
                       **tiers,
                       "tag": tag})

    t = 0.0
    for k in range(n_rain + tail):
        # 【坑】不能每步把"已蓄住的水"重新当产流灌回去再扣一遍管网：那样 30 mm/h
        # 的排水能力会被乘上步数，50 mm 的雨两小时就排干。正确拆法：
        #   新雨 → 先扣管网（超能力部分才进洼地）
        #   已蓄住的水 → 只按指数退水（雨水口过载/下渗），不再当新雨扣
        if k < n_rain:
            # 【雨型】长历时均匀雨强算不出内涝：25 mm/h 的雨连 30 mm/h 的管网都
            # 打不穿，24 h 下来最大水深只有 0.15 m。真实长历时暴雨是「峰值型」：
            # 前几天小雨润湿，中间几小时 50~70 mm/h 把雨水口打爆，后面再慢慢退。
            # 所以这里乘一个时间形状函数 shape(k)：
            #   uniform  全程 1.0（等于老的均匀雨强）
            #   peak     前 55% 线性升到峰值，峰值维持 12%，后 33% 线性回落
            #   pulse    前 45% 只有 0.25，中间 20% 冲到峰值，后 35% 落回 0.25
            shape = rain_shape[k] if rain_shape is not None else 1.0
            # 逐格逐时刻：有效雨强 = max(0, 本步雨强 − 真实下渗率)，再乘 C·A
            p_now = args.p_mm_h * shape
            _sat = np.where(np.isfinite(_cap) & (_cap > 0),
                            soil_left / np.maximum(_cap, 1e-9), 0.0)
            infil_rate = _fc + (_f0 - _fc) * _sat
            infil_rate = np.minimum(infil_rate, soil_left / (dt / 3600.0))
            infil_rate = np.maximum(0.0, infil_rate)
            # 记下本步真正渗进去的深度（mm），从土壤存量里扣掉
            _seep_mm = np.minimum(p_now, infil_rate) * (dt / 3600.0)
            soil_left = np.maximum(0.0, soil_left - _seep_mm)
            total["infil"] += float(_seep_mm.sum()) / 1000.0 * cell_area
            eff_mm_h = np.maximum(0.0, p_now - infil_rate)
            rain_vol = eff_mm_h * runoff_gain * (dt / 3600.0)
            total["rain"] += float(rain_vol.sum())
            # ---- P1：管网会满 ----
            # 用「累计可接水量预算」表示管网调蓄：预算用完前按设计能力 30 mm/h
            # 接水，用完（满管）只剩 drain_residual 倍；预算按 drain_recover_h
            # 指数恢复（泵站抽排/隧道放空），所以下一场雨又能排。
            # 这比「桶里的水位」简单得多，也不会出现桶溢出要往回灌的数值麻烦。
            if bucket_cap > 0:
                used_frac = min(1.0, budget_used / bucket_cap)
                cap_now = drain_f * (residual + (1.0 - residual) * (1.0 - used_frac))
                take = np.minimum(rain_vol, cap_now)
                take = np.where(drains_f, take, 0.0)
                # 还没满管时不允许一次把预算吃穿（否则等于没有上限）
                room = max(0.0, bucket_cap - budget_used)
                tsum = float(take.sum())
                if tsum > room and tsum > 1e-9:
                    take *= room / tsum
                    tsum = room
                budget_used += tsum
                # 【坑】不能用「>= bucket_cap」当满管判据：cap_now 随 used_frac 线性
                # 衰减，越接近满管进水越少，是渐近逼近，永远到不了 100%（实测 null）。
                # 取 0.85 作判据的物理含义：此时进水能力只剩
                #   residual + (1-residual)*(1-0.85) = 0.05 + 0.95*0.15 = 19%
                # 也就是说管网已经「基本堵死」，再往下 85%→100% 对地面积水的影响
                # 不到 1%，报 0.85 这个时刻既不骗人也不误导。峰值占用率另记一项。
                used_frac2 = budget_used / bucket_cap
                if used_frac2 > peak_used_frac:
                    peak_used_frac = used_frac2
                if saturated_at_min is None and used_frac2 >= 0.85:
                    saturated_at_min = round(t / 60.0, 1)
                net = rain_vol - take
                total["drained"] += tsum
            else:
                net = np.maximum(0.0, rain_vol - drain_f)
                total["drained"] += float((rain_vol - net).sum())
            inflow = np.bincount(term[to_basin], weights=net[to_basin],
                                 minlength=nlab + 1)
            # 【P2】终点不在洼地里的水：原来一律当出域。现在把「地面不高于河水位」
            # 的那部分截下来，原地积着（这部分水排不出去才是顶托的真实后果）。
            _out = ~to_basin
            if _out.any():
                _bo = _out & ~out_ok
                if _bo.any():
                    _v = net[_bo]
                    np.add.at(blocked, hold_cell[_bo], _v / cell_area)
                    _out = _out & out_ok
                total["discharged"] += float(net[_out].sum())
                total["dir"] = total.get("dir", 0.0) + float(net[_out].sum())
        else:
            if w_b.sum() * cell_area <= 1.0:
                break
            inflow = None

        # 管网放空（雨停后 / 每步都放一点），预算随之恢复
        # 【坑】原来这里无条件放空，结果降雨期间预算一边进一边出，永远达不到满管
        # （实测 `saturated_at_min` 一直是 null，预算只用到 40%）。物理上也说不通：
        # 暴雨正猛的时候泵站在满负荷抽，但来水远大于抽排，管网水位只会涨。
        # 所以只在「雨已停」或「本步雨强低于设计能力」（小雨，管网吃得下）时才恢复。
        _light = (k >= n_rain) or (args.p_mm_h * (rain_shape[k] if rain_shape is not None else 1.0)
                                   <= args.drain_mm_h)
        if bucket_cap > 0 and budget_used > 0 and _light:
            budget_used *= rec_decay
            if budget_used < 1e-6:
                budget_used = 0.0

        # ---- P2.5：退水（下渗 / 蒸散 / 雨水口吸积水 / 进河）----
        # 【为什么不是全局指数衰减】老口径 `w_b *= decay`（tau=3 h）等于假设
        # 所有积水以同一个速度蒸发掉：不看场地（硬化面和林地一个速度）、不看
        # 河在哪、也不看土壤吸饱了没有。实测这一项就占了 60% 的账面出流，
        # 是把内涝算轻的最大一块。
        # 现在的退水按真实过程分三路，逐格算（用的是上一时刻的水面）：
        #   ① 下渗：受「土壤存量 / 本步时长」上限约束，吸满就停
        #   ② 蒸散：DC 夏季约 3 mm/d → 0.12 mm/h，暴雨当天不到 1 mm
        #   ③ 雨水口 + 截流管把地面积水搬走（受真实输送能力限制，见下）
        #   注：下渗与蒸散是从「地面积水」里扣，不是从雨水里扣 —— 雨已经停了，
        #   地上还积着水，能吸走它的只有这两样和管网。
        _loss_inf = np.zeros(cur_prev.size)
        _loss_et = np.zeros(cur_prev.size)
        _loss_in = np.zeros(cur_prev.size)
        if k > 0 and cur_prev.size:
            _pond_mm = cur_prev * 1000.0                 # m → mm
            _f_rate = np.minimum(infil_rate[idx_b], soil_left[idx_b] / step_h)
            _loss_inf = np.minimum(_pond_mm, np.maximum(0.0, _f_rate) * step_h)
            soil_left[idx_b] = np.maximum(0.0, soil_left[idx_b] - _loss_inf)
            _pond_mm = _pond_mm - _loss_inf
            _loss_et = np.minimum(_pond_mm, et_mm_h * step_h)
            _pond_mm = _pond_mm - _loss_et
            # ③ 雨水口 / 截流管把地面积水搬走（这才是真实的退水主力）
            #    【数据】DC Water 的 Blue Plains 污水处理厂旱季 370 MGD（16 m³/s），
            #    雨季可开到 700 MGD 以上（30 m³/s），另有合流制溢流口直排河道。
            #    取 45 m³/s 作「雨水口 + 截流管 + 溢流口」的合计输送能力（含溢流）。
            #    分配：每个洼地按其「有雨水口的面积比例」吞水，不按格判掩膜。
            if _cap_m3s > 0 and cur_prev.size:
                _share = _drain_frac_b[lab_b]
                _avail = (_pond_mm / 1000.0 * cell_area) * _share
                _tot = float(_avail.sum())
                if _tot > 1e-9:
                    _f = min(1.0, _cap_m3s * dt / _tot)
                    _loss_in = _pond_mm * _share * _f
            # 扣除：按洼地汇总成体积，且不能把洼地抽成负的
            _lb = np.bincount(lab_b, weights=(_loss_inf + _loss_et + _loss_in)
                              / 1000.0 * cell_area, minlength=nlab + 1)
            _lb = np.minimum(_lb, np.maximum(0.0, w_b))
            w_b -= _lb
            total["seep_pond"] += float(np.bincount(
                lab_b, weights=_loss_inf / 1000.0 * cell_area,
                minlength=nlab + 1).sum())
            total["evap"] += float(np.bincount(
                lab_b, weights=_loss_et / 1000.0 * cell_area,
                minlength=nlab + 1).sum())
            _in_v = float(np.bincount(lab_b, weights=_loss_in / 1000.0 * cell_area,
                                      minlength=nlab + 1).sum())
            total["inlet_pond"] += _in_v
        if tau > 0:
            before = float(w_b.sum())
            w_b *= decay
            total["receded"] += before - float(w_b.sum())
        if inflow is not None:
            w_b += inflow

        # 洼地满了往下游溢（在洼地图上迭代，几万节点，与格数无关）
        # 【P2】容量用 cap_eff_b：通向河道的洼地被顶托抬高，先涨到河水位才溢。
        for _ in range(1500):
            over = w_b - cap_eff_b
            over[0] = 0.0
            if over.max() <= 1e-9:
                break
            over = np.maximum(0.0, over)
            # 【P2.5】挨着河的洼地：水位一旦高过河水位，多出来的水直接排进河里，
            # 而不是像原来那样一路往下游传、最后算成「出域」。这样「河道」才是
            # 真实的出口：河水位低就排得动，被增水顶到 4 m 就排不动。
            if n_gated > 0:
                _rv = np.where(to_river, over, 0.0)
                _rv[0] = 0.0
                if _rv.any():
                    w_b -= _rv
                    total["to_river"] += float(_rv.sum())
                    over = over - _rv
                    if over.max() <= 1e-9:
                        break
            w_b -= over
            total["discharged"] += float(over[ds_b == 0].sum())
            total["ovf"] = total.get("ovf", 0.0) + float(over[ds_b == 0].sum())
            move = ds_b > 0
            if move.any():
                np.add.at(w_b, ds_b[move], over[move])
        # 【坑·跑飞】400 轮级联扫不完所有链，末尾还会剩一点「超容量的水」。
        # 不处理的话它会在一个几乎没容量的单格洼地（实测 cap=1 m³）里被
        # `levels()` 反解成 101 m 的水深，整张深度场跟着失真。
        # 收敛不完的余量按「已经流出计算域」记账，保证体积闭合。
        _ex = np.maximum(0.0, w_b - cap_eff_b)
        _ex[0] = 0.0
        if _ex.max() > 1e-6:
            w_b -= _ex
            total["discharged"] += float(_ex.sum())
            total["ovf"] = total.get("ovf", 0.0) + float(_ex.sum())
            total["spill"] = total.get("spill", 0.0) + float(_ex.sum())

        lev = levels(w_b)
        cur = np.maximum(0.0, lev[lab_b] - z_b)
        cur_prev = cur.copy()
        # 雨停后土壤靠排水/蒸散慢慢腾出孔隙（暴雨当天几乎不回补，只是让长历时
        # 工况不至于一场雨就把土永久封死）
        if k >= n_rain and np.isfinite(_cap).any():
            soil_left = _cap - (_cap - soil_left) * _soil_rec
        _mx = float(np.max(cur)) if cur.size else 0.0
        if _mx > 60.0 and _dbg_done is False:
            _dbg_done = True
            _i = int(idx_b[int(np.argmax(cur))])
            _lb = int(lab_f.ravel()[_i])
            _fl = lab_f.ravel()
            log(f"[dbg] t={t / 60:.0f}min 最深 {_mx:.1f} m 在格 {_i} "
                f"(r{_i // w},c{_i % w})；洼地#{_lb} 格数={int((_fl == _lb).sum())} "
                f"蓄水={w_b[_lb]:.0f} m³ cap={cap_b[_lb]:.0f} "
                f"cap_eff={cap_eff_b[_lb]:.0f} ds={ds_b[_lb]} "
                f"zmin={minz_b[_lb]:.2f} lev={lev[_lb]:.2f} "
                f"gated={bool(to_river[_lb])}")
        depth[:] = 0.0
        depth.ravel()[idx_b] = cur
        # 【P2】河道漫溢叠加：陆地低于河水位的地方至少有这么深的水。
        # 用 max 而不是相加 —— 洼地积水和河道漫溢是同一片水面，取深的那层。
        if river_level > 0.0:
            np.maximum(depth, river_inund, out=depth)
        # 【P2】受阻区（山脊侧、被顶托的河边）积的水叠上去
        if blocked2.any():
            np.maximum(depth, blocked2, out=depth)
        # 【坑·单位】w_b 本来就是 m³（cap_b 也按 m³ 建的），再乘 cell_area 就会
        # 在 2 m 网格上把蓄水量放大 4 倍，曲线和末态报表对不上。
        rec_basin = float(w_b.sum())

        if k % frame_every == 0 or (k == n_rain - 1) or \
                (k >= n_rain and (k - n_rain) % frame_every == 0):
            snap(t, "rain" if k < n_rain else "recede")
        # 峰值帧留存：建筑/道路的「淹没深度」要按峰值算，不能用末帧
        # 【坑】这里必须存**整张 depth**（h*w），不能存 `cur` —— `cur` 只是洼地格
        # 的一维数组（约 31 万），后面 reshape(h,w) 会炸。
        # 【P2】统计一律用 depth（= 洼地积水 max 河道漫溢），不再用 cur ——
        # 否则纯增水情景下河道漫溢的陆域在报表里是 0。
        _wet_now = float((depth > 0.01).sum()) * cell_area / 1e4
        if _wet_now > peak_wet:
            peak_wet = _wet_now
            peak_depth = depth.astype("float32")
        curve.append({"t_min": round(t / 60.0, 1),
                      "max_depth_m": round(float(depth.max()), 3),
                      "wet_ha": round(float((depth > 0.15).sum()) * cell_area / 1e4, 2),
                      **{f"gt{int(m * 100)}cm_ha":
                         round(float((depth > m).sum()) * cell_area / 1e4, 2)
                         for m in TIER_M},
                      "retained_m3": round(rec_basin)})
        t += dt
        if k % max(1, int(3600.0 / dt)) == 0 and k:
            log("      t=%4.0f min  最大 %.2f m  积水 %.1f ha" %
                (t / 60.0, cur.max(), (cur > 0.15).sum() * cell_area / 1e4))

    snap(t, "end")
    meta = {"cols": frames[0]["cols"], "rows": frames[0]["rows"],
            "step_m": frames[0]["step_m"],
            "scale_m": float(getattr(args, "depth_scale_m", 4.0)), "dt_s": dt,
            "x0": float(grid["x0"]), "y1": float(grid["y1"]),
            "rain_min": round(args.dur_h * 60.0, 1), "frames": frames}
    with open(os.path.join(outdir, "frames", "manifest.json"), "w",
              encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    return {"depth_final": depth, "frames": frames, "curve": curve,
            "total": total, "meta": meta,
            # P0：峰值帧与统计所需的辅助量
            "peak_depth": peak_depth, "peak_wet_ha": peak_wet,
            "area_land_km2": area_land_km2,
            "bucket_cap": bucket_cap, "saturated_at_min": saturated_at_min,
            "peak_used_frac": round(peak_used_frac, 4),
            "budget_used": budget_used,
            # P2：顶托与河道漫溢
            "river_level_m": river_level, "gated_basins": n_gated,
            "river_inund_km2": area_river_km2,
            "river_inund": river_inund,
            "blocked_m3": float(blocked.sum()) * cell_area,
            "blocked_km2": float((blocked > 0.01).sum()) * cell_area / 1e6,
            "basin_m3": float(w_b.sum()),
            # P2.5：排进河里的水量，以及按实测潮汐水面换算出来的水位抬升
            "to_river_m3": float(total.get("to_river", 0.0)),
            "river_area_m2": float(river_area_m2),
            "river_rise_m": round(float(total.get("to_river", 0.0))
                                  / max(1.0, river_area_m2), 4),
            "soil_left_mm": round(float(np.mean(soil_left[np.isfinite(soil_left)]))
                                  if np.isfinite(soil_left).any() else 0.0, 2)}


def main() -> int:
    ap = argparse.ArgumentParser(description="简化排水模型 L1（产流×D8汇流×雨水口×下渗）")
    ap.add_argument("--res", type=int, default=2, help="计算分辨率（米），1/2/4")
    ap.add_argument("--p-mm-h", type=float, default=50.0, help="设计暴雨强度 mm/h")
    ap.add_argument("--dur-h", type=float, default=1.0, help="历时（小时）")
    ap.add_argument("--river-level", choices=["normal", "design"], default="normal",
                    help="河道边界水位：normal=常水位 design=1%%年遇(BFE)")
    ap.add_argument("--steps", type=int, default=80, help="水面摊平迭代轮数")
    ap.add_argument("--fill", choices=["priority", "none"], default="priority",
                    help="洼地填平：priority=Priority-Flood（推荐） none=不填（会出格点噪声）")
    ap.add_argument("--drain-mm-h", type=float, default=DRAIN_CAP_MM_H,
                    help="管网设计排水强度 mm/h（默认 30，≈2 年一遇）")
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--l2", action="store_true", help="时间版：出 出水→积涝→退水 序列")
    ap.add_argument("--dt", type=float, default=60.0, help="L2 时间步长（秒）")
    ap.add_argument("--tail-h", type=float, default=2.0, help="L2 雨停后继续算多久（小时）")
    # ---- P2.5：退水改由物理过程驱动（下渗 / 蒸散 / 雨水口吸积水 / 进河）----
    # 老口径的 `--tau-h` 是一个"全局指数衰减"，等于假设所有积水都以同一个速度
    # 蒸发光：既不看场地（硬化面与林地一个速度），也不看河在哪。
    # 实测它是把内涝算轻的最后一块 —— `receded` 一项就占了 60% 的账。
    # 现在换成四项真实的出流，`--tau-h` 只作兜底（默认 0 = 关掉）。
    ap.add_argument("--tau-h", type=float, default=0.0,
                    help="L2 兜底指数退水时间常数（小时）；0=关（默认，改由下渗/蒸散/排水/进河退水）")
    ap.add_argument("--et-mm-h", type=float, default=0.12,
                    help="蒸散速率 mm/h（DC 夏季潜在蒸散约 3 mm/d，折算 0.12；暴雨当天不到 1 mm）")
    ap.add_argument("--soil-recover-h", type=float, default=24.0,
                    help="土壤蓄水恢复时间常数（小时）：雨停后靠排水/蒸散重新腾出容量")
    ap.add_argument("--sewer-m3s", type=float, default=45.0,
                    help="雨水口+截流管+溢流口合计输送能力 m³/s（DC Water Blue Plains "
                         "旱季 16、雨季 30 m³/s 以上，含 CSO 溢流口取 45）")
    # 【河流真实出入流量】Potomac 在 Little Falls 的实测基线流量（USGS 01646500，
    # 1931–2025 年度中位数约 10,600 cfs ≈ 300 m³/s）。本模型把河口当作定水位边界，
    # 所以这个数只用来做量级对照：本地 30 km² 的产流峰值跟它差两个数量级，
    # 河水位的涨落由潮汐/增水决定，不是由本地汇水决定。
    ap.add_argument("--river-q-m3s", type=float, default=300.0,
                    help="Potomac 基线流量 m³/s（实测年度中位数 300）")
    # ---- P3：建筑挡水 ----
    # 设 0 则退回老口径（楼和地面一样平，水穿楼而过）。
    ap.add_argument("--building-wall-m", type=float, default=0.0,
                    help="建筑格在流向计算里抬高的高度 m（实测 3~4 m 无影响, 12 m 会封出假院落；默认关）")
    # ---- P3：街道优先汇流 ----
    # 把真实路网栅格上的地面压低一点，让 D8 优先沿街道走水（真实城区是路缘石
    # 和路面纵坡把水组织到街道上的）。设 0 则关闭。
    ap.add_argument("--street-drop-m", type=float, default=0.0,
                    help="街道格在流向计算里压低的高度 m（0=关闭街道优先）")
    # ---- P3：微坑阈值 ----
    # 填深小于它的坑不算蓄水空间（DEM 噪声级微地形）。1 m 雷达 DEM 的路面假起伏
    # 是 ±5~10 cm，5 cm 阈值会把这些假坑全当真的，水被吃光、彼此断开。
    ap.add_argument("--min-pit-m", type=float, default=0.05,
                    help="小于该填深的坑不计蓄水（默认 0.05 = 老口径；实测调大反而更碎，别调）")
    ap.add_argument("--legacy-infil", action="store_true",
                    help="退回老口径下渗（常数速率、无土壤蓄水上限），用于复现旧结果")
    # 【为什么要有 --frame-min】帧间隔原来写死 300 s。几小时的工况没问题，
    # 但 24 h / 72 h 这种长历时会出 300~900 帧 × 0.85 MB = 几百 MB，
    # 既跑不完也传不动。改成按「总时长自动定间隔」，帧数落在 60~120 之间。
    ap.add_argument("--frame-min", type=float, default=0.0,
                    help="L2 落帧间隔（分钟）。0 = 自动（让总帧数约 90）")
    ap.add_argument("--max-frames", type=int, default=140, help="自动间隔时的帧数上限")
    # 【雨型】长历时只拉时长、雨强不变，模型算不出内涝（25 mm/h 打不穿 30 mm/h
    # 的管网）。真实长历时是峰值型的，所以给一个时间形状：
    #   uniform 均匀（默认，等于老行为）
    #   peak    单峰：缓升 → 峰 → 缓退
    #   pulse   双脉冲：下下停停（最像真实长历时）
    #   front   冷锋：先小后大，结尾陡收
    # 形状函数以「平均雨强 = --p-mm-h」归一化，整场总量仍 = p_mm_h × dur_h。
    ap.add_argument("--hyetograph", default="uniform",
                    choices=["uniform", "peak", "pulse", "front"],
                    help="降雨时间形状（default uniform）")
    # ---- P1：管网会满，满了就排不动 ----
    # 老口径把 30 mm/h 当成「恒定、永不失效」的排水能力，于是 220 mm 的雨
    # 也能一小时一小时往外搬，账面永远排得掉。真实内涝里雨水口 20~40 min
    # 就满管，之后排水量≈0，水才开始在地面涨。
    #
    # 这里用一个「漏水桶」表示管网调蓄：管子里能存的水量 = 
    # `drain_fail_after_mm` ×（接雨水口的硬化面积）。存满之后排水能力只剩
    # `drain_residual` 倍；雨停后再按 `drain_recover_h` 指数放下。
    #
    # 【默认 25 mm 怎么来的】DC Water 的合流制 + 深层隧道调蓄总量是十万立方米
    # 量级（Anacostia River Tunnel 一项 ≈ 113,000 m³），摊到本模型 11.9 km²
    # 硬化面上 ≈ 9.5 mm；再算上干管自身存水与泵站调蓄，25 mm 是同量级的保守值。
    # 设 0 则退回老口径（恒定 30 mm/h），用来复现 2026-10-26 之前的历史结果。
    ap.add_argument("--drain-fail-after-mm", type=float, default=25.0,
                    help="管网调蓄容量（mm，按接雨水口的硬化面积折算）；0=永不失效（老口径）")
    ap.add_argument("--drain-residual", type=float, default=0.05,
                    help="管网满管后残余排水能力（相对设计能力的倍数）")
    ap.add_argument("--drain-recover-h", type=float, default=6.0,
                    help="管网排空时间常数（小时，指数）")
    # ---- P0：分级口径 ----
    ap.add_argument("--depth-scale-m", type=float, default=4.0,
                    help="web 帧的深度量化上限（米）。原来 2.0 会把 9 m 深的水画成 2 m")
    ap.add_argument("--depth-stats", action="store_true",
                    help="统计淹没建筑（按轮廓采样峰值水深）与道路长度（按街道折线采样）")
    # ---- P2：河道顶托 + 出口重划 ----
    # 【为什么先做这两个而不是潮位时间序列】
    # 潮位是「水位随时间的形状」，顶托是「下游水位高于地面就排不出去」。
    # 后者才是把内涝算轻的第二个大原因：现在河道永远 0.046 m，等于给了城市
    # 一台永不停的抽水机。先把它变成可调的常数（--river-level / --surge-m），
    # 潮位随时间起伏留到下一轮再加，两者互不阻塞。
    ap.add_argument("--surge-m", type=float, default=0.0,
                    help="风暴增水（米）。叠加在河道基准水位上，0=不增水")
    ap.add_argument("--edge-open-z", type=float, default=3.0,
                    help="计算域边界可出流的最高地面高程（米）。高于它的边界当墙。"
                         "实测：DC 北/东边缘 100%% 高于 10 m（Fall Line 山脊），"
                         "南边缘 39.3%%、西边缘 19.9%% 低于 3 m")
    args = ap.parse_args()

    t0 = time.time()
    os.makedirs(args.out, exist_ok=True)
    res = max(1, int(args.res))
    cell_area = float(res * res)

    log(f"[1/6] 读栅格（{res} m 重采样）…")
    dtm1 = load_raster("terrain_dtm.tif").astype("float32")
    lc1 = load_raster("landcover.tif")
    bld1 = load_raster("building_mask.tif")
    z = bmean(dtm1, res).astype("float64")
    lc = bmode(lc1, res)
    bld = bmax(bld1, res) > 0
    h, w = z.shape
    # 【P2-c 出口重划】老口径 `edge_mask` 把计算域四条边**全部**当出口，等于给
    # 30.6 km² 的矩形加了一圈隐形排水沟 —— 实测 50.3% 的径流从这里「免费」出域，
    # 这是把内涝算轻的最大一处。
    # 实测四条边的地面高程：北边缘最小 10.71 m、东边缘最小 9.46 m（全是 Fall Line
    # 山脊，水只会从山脊往里流），南边缘 39.3%、西边缘 19.9% 低于 3 m（河漫滩）。
    # 所以只有低处的边才真的是开边界；高于 --edge-open-z 的边当墙。
    edge_mask = np.zeros((h, w), dtype=bool)
    edge_mask[0, :] = edge_mask[-1, :] = True
    edge_mask[:, 0] = edge_mask[:, -1] = True
    edge_open = edge_mask & (z <= float(getattr(args, "edge_open_z", 3.0)))
    n_edge_open = int(edge_open.sum())
    _ez = z[edge_mask]
    log(f"      边界格 {int(edge_mask.sum()):,} 个（z {_ez.min():.1f}…{_ez.max():.1f} m），"
        f"其中 {n_edge_open:,} 个低于 {getattr(args, 'edge_open_z', 3.0):.1f} m 可出流，"
        f"其余 {int(edge_mask.sum()) - n_edge_open:,} 个当墙")
    log(f"      网格 {w}×{h} = {h * w:,} 格，高程 {z.min():.2f}…{z.max():.2f} m")
    # 网格原点：L2 分支要在写 params.json / 帧清单时用到（原实现只在 L1 分支末尾
    # 从 water.json 取，L2 一路返回时就还没定义 → NameError）。这里提前取一次。
    grid = dict(json.load(open(os.path.join(DERIVED, "water.json"),
                             encoding="utf-8"))["grid"])

    # ---- P2：河道水位（基准 + 增水），L1/L2 共用一个值 ----
    # 【基准来自实测】water.json 的 MSL_m=0.046 / BFE_min_m=3.658 都是从
    # NOAA 8594900 的 datum 页与 DC 的 1%% 年遇洪水位算出来的（见 项目总览 §6.10）。
    # --surge-m 就是在此之上叠加的风暴增水：Isabel 实测 2.71 m、1942 年站点
    # 历史最高 2.94 m，所以 3~4 m 已是「超历史」的极端情景，6 m 是压力测试上限。
    _wj = json.load(open(os.path.join(DERIVED, "water.json"), encoding="utf-8"))
    _lvl = _wj["levels"]
    river_base = (float(_lvl["MSL_m"]) if args.river_level == "normal"
                  else float(_lvl["BFE_min_m"]))
    river_level = river_base + float(getattr(args, "surge_m", 0.0))
    # ---- P2.5：河流的真实水面面积（用来把「排进河里的水量」换算成水位抬升）----
    # 数值来自 water.json 的 `bodies[].area_m2`（Potomac 2.236 km² + Anacostia
    # 0.623 km²）。这是**实测水面**，不是河道过水断面，所以只能做 0 维蓄水池口径：
    #   Δh = V / A_surface
    # 有这个口径才能回答「本地 30 km² 的产流能不能把大河顶起来」——
    # Potomac 的实测基线流量是 300 m³/s（USGS 01646500 年度中位数），
    # 本地一场暴雨的峰值产流只有它的百分之一量级，所以答案几乎是不。
    _river_area_m2 = 0.0
    _bodies = _wj.get("bodies") or []
    for _b in (_bodies if isinstance(_bodies, list) else _bodies.values()):
        if bool(_b.get("tidal")) and _b.get("area_m2"):
            _river_area_m2 += float(_b["area_m2"])
    log(f"      河道水位 {river_level:.3f} m（基准 {river_base:.3f} + 增水 "
        f"{getattr(args, 'surge_m', 0.0):.3f}）；潮汐水面 {_river_area_m2 / 1e6:.3f} km²")

    # 建筑格并入硬化类（屋顶同样不透水），但保留 bld 掩膜用于后面判"淹了哪栋"
    lc_flow = np.where(bld & (lc != 0), 1, lc)

    log("[2/6] 产流 …")
    P_mm = args.p_mm_h * args.dur_h
    # 【P2.5】总量估算也要跟着新下渗口径走：下渗不但受速率限制，还受土壤可吸
    # 存量限制（吸饱就停），所以整场能渗进去的深度 = min(fc × 时长, 存量)。
    if getattr(args, "legacy_infil", False):
        f_mm = F_INFIL[lc_flow] * args.dur_h
    else:
        f_mm = np.minimum(INFIL_FC[lc_flow] * args.dur_h,
                          INFIL_CAP[lc_flow]).astype("float64")
    C = C_RUNOFF[lc_flow]
    runoff_mm = np.maximum(0.0, P_mm - f_mm) * C
    runoff_mm = np.where(lc_flow == 0, 0.0, runoff_mm)     # 水体本身不产流
    vol = (runoff_mm / 1000.0) * cell_area                   # m³
    total_runoff = float(vol.sum())
    log(f"      雨量 {P_mm:.1f} mm，产流总量 {total_runoff:,.0f} m³ "
        f"（平均 {runoff_mm.mean():.1f} mm）")

    log("[3/6] 洼地填平（只算流向/容量）+ D8 流向 …")
    tf = time.time()
    # ---- P3：建筑是墙，不是地 ----
    # 【为什么】原来 `lc_flow` 只是把建筑格算成"硬化面产流"，流向计算里楼和地面
    # 一样平 —— 水直接穿过街区，于是全市的水被摊成上千个小水洼（26 个连通块、
    # 最大块只占 4%）。真实城区里楼是障碍物：水被逼到街道上，沿街道连成整条洪水。
    # 做法：流向计算用 `z_flow = z + 楼高 × 建筑格`，把楼抬成 12 m 的台子，
    # D8 就再也不会让水穿楼而过，楼的产流则从楼边落到街上。
    # 蓄水容量仍然按真实地面 z 算（水是积在街上，不是积在楼顶）。
    _wall_m = float(getattr(args, "building_wall_m", 12.0))
    z_flow = z + (_wall_m * bld).astype(z.dtype) if _wall_m > 0 else z.astype(z.dtype)
    _drop_m = float(getattr(args, "street_drop_m", 0.0))
    if _drop_m > 0:
        _st = build_street_raster(grid, res, h, w)
        z_flow = z_flow - (_drop_m * _st).astype(z.dtype)
        log(f"       街道优先：{int(_st.sum())} 格下压 {_drop_m} m")
    zf = priority_flood(z_flow) if args.fill == "priority" else z_flow
    if args.fill == "priority":
        log(f"      Priority-Flood 完成 {time.time() - tf:.1f}s")
    # 【坑】原始 z 必须留着：水面高度、洼地容量都靠它。第一版把 z 覆盖成填平后的
    # 地形，水就再也积不起来了。
    recv, is_sink = d8_receiver(zf)

    log("[4/6] 洼地容量 + 管网排水 + 拓扑汇流 …")
    # 填深低于阈值的坑不算蓄水空间：那是栅格噪声级的微地形，留着只会让
    # 整城布满孤立小水点（第一版就这样，看着像撒了蓝芝麻），不是内涝。
    # 【P3】阈值从 0.05 提到可调：1 m DEM 是雷达反演，路面本身就有 ±5~10 cm 的
    # 假起伏，5 cm 阈值会把无数假坑当真的蓄水空间，水全被这些假坑吃掉、彼此不连。
    # 这是 DEM 水文里的标准做法（fill sinks shallower than N），也是「摊成芝麻」
    # 的直接原因之一。
    MIN_PIT_M = float(getattr(args, "min_pit_m", 0.05))
    fill_depth = np.maximum(0.0, zf - z_flow)
    storage = np.where(fill_depth >= MIN_PIT_M, fill_depth, 0.0) * cell_area
    log(f"      洼地蓄水容量合计 {storage.sum():,.0f} m³（超过它的部分才会溢流）")

    drain_cap = np.where(DRAINS[lc_flow],
                         (args.drain_mm_h / 1000.0) * args.dur_h * cell_area, 0.0)
    outlet = (lc == 0) | edge_open

    if args.l2:
        log("[4/6] L2 时间步：出水 → 积涝 → 退水")
        # 【坑·历时】这里原来直接用整场产流 runoff_mm（里面已经乘过 dur_h），
        # 再按 dt/3600 逐步灌 —— 1 h 的雨恰好对，2 h 的雨水量就成了 2 倍
        # （total['rain'] = 2 × runoff，水体凭空多出一倍）。
        # 现在产流率在 l2_loop 里逐格逐时刻算（见那里的「下渗必须逐时刻扣」），
        # 这里只把「静态地形量」传进去。
        pit_mask = storage > 0
        r = l2_loop(z, recv, storage, pit_mask, outlet, lc_flow, cell_area,
                    grid, args, args.out,
                    river_level=river_level, river_area_m2=_river_area_m2)
        depth = r['depth_final']
        # 【必须用实测产流，不能用上面那个 P_mm 口径】上面 `total_runoff` 是按
        # 「平均雨强 − 下渗」算的整场产流；峰值型雨型下 L2 逐时刻积出的水量
        # 与之不等（下渗是常率，小雨段被扣光、峰值段打穿，净效果是产流偏多）。
        # 记账口径只有一套：`runoff_m3` ≡ 逐时刻积分量，闭合差才对得上。
        rain_total = float(r['total']['rain'])
        log("[6/6] 落盘 L2 序列 …")
        # 【坑·口径】`depth` 是**退水末尾**的那一帧，不是峰值。原来把它的
        # max 和 >2 cm 格数直接写成 `max_depth_m` / `cells_gt_15cm`，于是
        # 24 h 工况明明淹了 95 ha、峰值 8.6 m，报表里却是 0.54 m / 1961 格，
        # 看的人会以为「长历时雨反而没积水」。峰值得从 curve 里取。
        _peak = max(r['curve'], key=lambda q: q['wet_ha']) if r['curve'] else {}
        curve_ha = [q['wet_ha'] for q in r['curve']] or [0]
        curve_dmax = [q['max_depth_m'] for q in r['curve']] or [0]
        # ---- P0：峰值分级口径 + 淹没建筑 + 受淹道路 ----
        # 【必须用峰值帧】末帧（退水末尾）的水只剩坑底的几厘米，拿它统计
        # 建筑/道路会得出「淹了 441 栋」这种数字，而峰值帧是 3,942 栋。
        land_cells = int((lc != 0).sum())
        area_land_km2 = land_cells * cell_area / 1e6
        pk = r.get('peak_depth')
        pk2d = pk.reshape(h, w) if pk is not None else depth
        imp = flood_impact(pk2d, grid, res, cell_area, lc)
        # ---- P3 诊断：水面的连通性 ----
        # 「摊成芝麻」的量化指标：峰值水面分成多少块、最大一块占多少。
        # 真实城市内涝应该是几条连续的街道洪水（块数少、最大块占比高）。
        from scipy import ndimage as _ndi
        _wetm = pk2d > 0.15
        _wlab, _wn = _ndi.label(_wetm, structure=np.ones((3, 3), dtype="int8"))
        _wsz = np.bincount(_wlab.ravel())[1:] if _wn else np.zeros(0)
        _wsz_m2 = _wsz.astype("float64") * cell_area
        _blocks = int((_wsz_m2 >= 1e4).sum())          # ≥1 ha 才算一块
        _big_pct = round(100.0 * float(_wsz_m2.max()) / max(1.0, float(_wsz_m2.sum())), 2) \
            if _wn else 0.0
        log(f"      水面连通块：{_blocks} 块（≥1 ha），最大一块占 {_big_pct:.1f}%")
        peak_tiers = {k: v for k, v in _peak.items() if k.startswith('gt')}
        # 【别写成 `r.get('river_inund') or 0`】ndarray 的真假值有歧义，会抛
        # "truth value of an array with more than one element is ambiguous"。
        _rin = r.get('river_inund')
        river_inflow_m3 = (float(_rin.sum()) * cell_area
                           if _rin is not None else 0.0)
        _blocked_m3 = float(r.get('blocked_m3') or 0.0)
        _basin_m3 = float(r.get('basin_m3') or 0.0)
        summary = {
            'mode': 'L2',
            'grid': f'{w}×{h} @ {res} m',
            'dt_s': args.dt, 'rain_mm': P_mm,
            'hyetograph': str(getattr(args, 'hyetograph', 'uniform')),
            'runoff_m3': round(rain_total),
            'inlet_drained_m3': round(r['total']['drained']),
            'discharged_m3': round(r['total']['discharged']),
            'retained_m3': round(float(depth.sum()) * cell_area),
            'receded_m3': round(r['total']['receded']),
            # 【P2·闭合差】增水情景下，河道漫溢会把**域外的水**灌进城市 ——
            # 这部分不在「产流」里，必须单列成一项入账，否则闭合差会凭空多出
            # 两三百万立方米（实测把 4.38 Mm³ 的账记成 6.7 Mm³）。
            'river_inflow_m3': round(river_inflow_m3),
            # 【闭合差必须按「分项体积」算，不能按 depth.sum()】河道漫溢、洼地积水、
            # 受阻积水三者在空间上重叠，depth 是取 max 的合成场，直接 sum 会把
            # 重叠部分只算一次，账面出现几百万立方米的假缺口。
            'retained_basin_m3': round(_basin_m3),
            'retained_blocked_m3': round(_blocked_m3),
            'blocked_km2': round(float(r.get('blocked_km2') or 0.0), 4),
            'budget_closed': round(_basin_m3 + _blocked_m3
                                   + r['total']['drained'] + r['total']['discharged']
                                   + r['total']['receded']
                                   + r['total'].get('to_river', 0.0)
                                   + r['total'].get('seep_pond', 0.0)
                                   + r['total'].get('evap', 0.0)
                                   + r['total'].get('inlet_pond', 0.0)
                                   - rain_total, 1),
            # ---- P2.5 真实退水分账 ----
            # `infil_m3` 是下渗量：它在产流之前就被扣掉了，**不进地表水量平衡**
            # （所以不参与上面的闭合差），单列出来是为了知道「这场雨渗进土里多少」。
            'infil_m3': round(r['total'].get('infil', 0.0)),
            'seep_pond_m3': round(r['total'].get('seep_pond', 0.0)),
            'evap_m3': round(r['total'].get('evap', 0.0)),
            'inlet_pond_m3': round(r['total'].get('inlet_pond', 0.0)),
            'to_river_m3': round(r['total'].get('to_river', 0.0)),
            'river_area_km2': round(float(r.get('river_area_m2') or 0.0) / 1e6, 4),
            'river_rise_m': r.get('river_rise_m'),
            'soil_left_mm': r.get('soil_left_mm'),
            # 峰值（全序列最大）：这两个才是给人看的「这场雨淹多大」
            'peak_wet_ha': round(max(curve_ha), 2),
            'peak_wet_m2': round(max(curve_ha) * 1e4),
            'peak_t_min': _peak.get('t_min'),
            'peak_max_depth_m': round(max(curve_dmax), 3),
            # 末态（退水末尾）：水面基本落回坑里，只说明「退干净了没有」
            'final_max_depth_m': round(float(depth.max()), 3),
            'final_wet_cells': int((depth > 0.15).sum()),
            # ---- P0 分级口径（全部是**峰值帧**，不是末帧）----
            'area_land_km2': imp['area_land_km2'],
            'peak_area_by_depth': imp['tiers'],
            'peak_area_by_depth_ha': peak_tiers,
            'buildings_total': imp['buildings']['total'],
            'buildings_touched': imp['buildings']['touched_m5cm'],
            'buildings_gt30cm': imp['buildings']['gt30cm'],
            'buildings_gt100cm': imp['buildings']['gt100cm'],
            'buildings_flooded_top': imp['buildings']['list'][:60],
            'roads_km_total': imp['roads']['road_km_total'],
            'roads_km_flooded': imp['roads']['road_km_flooded'],
            'roads_km_gt30cm': imp['roads']['road_km_gt30cm'],
            'roads_pct_flooded': imp['roads'].get('pct_flooded'),
            # ---- P1 管网失效记账 ----
            'drain_bucket_cap_m3': round(float(r.get('bucket_cap') or 0)),
            'drain_saturated_at_min': r.get('saturated_at_min'),
            'drain_peak_used_frac': r.get('peak_used_frac'),
            'drain_budget_used_m3': round(float(r.get('budget_used') or 0)),
            # ---- P2 河道顶托与漫溢记账 ----
            'river_base_m': round(river_base, 3),
            'river_surge_m': round(float(getattr(args, 'surge_m', 0.0)), 3),
            'river_level_m': round(float(r.get('river_level_m') or 0.0), 3),
            'river_gated_basins': int(r.get('gated_basins') or 0),
            # 【口径分离】河道漫溢淹掉的陆域单列一栏，不混进雨致内涝：
            # 否则「一场雨淹了多少」会把风暴增水算进来的面积记到雨的账上。
            'river_inund_km2': round(float(r.get('river_inund_km2') or 0.0), 4),
            # ---- P2.5 河流真实出入流量 ----
            # `river_q_baseline_m3s` 是 USGS 01646500 的实测基线（1931–2025 年度
            # 中位数 ≈ 10,600 cfs ≈ 300 m³/s），`river_local_ratio` 把本地产流的
            # 峰值跟它比一下 —— 用来回答「小流域的水能撼动大河吗」。
            'river_q_baseline_m3s': float(getattr(args, 'river_q_m3s', 300.0)),
            'river_local_ratio': round(
                (max(0.0, r['total']['rain']) / max(1e-9, args.dur_h * 3600.0))
                / max(1e-9, float(getattr(args, 'river_q_m3s', 300.0))), 5),
            'edge_open_cells': n_edge_open,
            'edge_wall_cells': int(edge_mask.sum()) - n_edge_open,
            # ---- P3 建筑挡水 + 水面连通性 ----
            'building_wall_m': float(getattr(args, 'building_wall_m', 0.0)),
            'wet_blocks_ge1ha': _blocks,
            'wet_largest_block_pct': _big_pct,
            'frames': len(r['frames']),
            'curve': r['curve'][::max(1, len(r['curve']) // 40)],
            'runtime_s': round(time.time() - t0, 1),
        }
        # 【坑】L2 分支一度只写 summary_l2.json，不写 params.json —— web 导出、
        # 事后复盘都拿不到网格原点和降雨设定。现在两个分支都落 params.json。
        meta = {
            'grid': {'x0': float(grid['x0']), 'y1': float(grid['y1']),
                     'step_m': float(res), 'cols': int(w), 'rows': int(h),
                     'layout': grid['layout']},
            'vertical_datum': 'NAVD88',
            'model': 'L2 时间步：产流 × D8 汇流 × 洼地蓄水 × 随步排水 + 退水',
            'rain': {'p_mm_h': float(args.p_mm_h), 'duration_h': float(args.dur_h),
                     'total_mm': float(P_mm)},
            'river_level_m': round(float(r.get('river_level_m') or 0.0), 3),
            'river_level_mode': args.river_level,
            'river_base_m': round(river_base, 3),
            'river_surge_m': round(float(getattr(args, 'surge_m', 0.0)), 3),
            'edge_open_z_m': float(getattr(args, 'edge_open_z', 3.0)),
            'edge_open_cells': n_edge_open,
            'dt_s': float(args.dt), 'tail_h': float(args.tail_h),
            'params': {'C_runoff': {str(k): float(v) for k, v in enumerate(C_RUNOFF)},
                       'f_infil_mm_h': {str(k): (None if v == float('inf') else float(v))
                                        for k, v in enumerate(INFIL_FC)},
                       # ---- P2.5 真实下渗/退水参数（来源见文件头注释）----
                       'infil': {'f0_mm_h': {str(k): float(v) for k, v in enumerate(INFIL_F0)},
                                 'fc_mm_h': {str(k): float(v) for k, v in enumerate(INFIL_FC)},
                                 'cap_mm': {str(k): float(v) for k, v in enumerate(INFIL_CAP)},
                                 'recover_h': float(args.soil_recover_h),
                                 'legacy': bool(getattr(args, 'legacy_infil', False)),
                                 'note': 'Rawls(1983) Ks + TR-55 表2-2 最小下渗率；'
                                         'cap = 控制层厚 × 有效孔隙度'},
                       'recession': {'et_mm_h': float(args.et_mm_h),
                                     'sewer_m3s': float(args.sewer_m3s),
                                     'tau_h': float(args.tau_h),
                                     'note': 'tau_h=0 时不应期指数退水（改由下渗/蒸散/管网/进河）'},
                       'river': {'q_baseline_m3s': float(args.river_q_m3s),
                                 'surface_km2': round(_river_area_m2 / 1e6, 4),
                                 'note': 'USGS 01646500 年度中位数 10,600 cfs ≈ 300 m³/s；'
                                         '本地入河量按实测潮汐水面面积换算成水位抬升'},
                       'drainage': {'cap_mm_h': float(args.drain_mm_h),
                                    'note': '管网设计排水强度，超过部分才积水',
                                    'fail_after_mm': float(args.drain_fail_after_mm),
                                    'residual': float(args.drain_residual),
                                    'recover_h': float(args.drain_recover_h),
                                    'bucket_cap_m3': round(float(r.get('bucket_cap') or 0))},
                       'hyetograph': str(getattr(args, 'hyetograph', 'uniform'))},
            # 记账口径以 L2 逐时刻积分量为准（见上面 rain_total 的注释）
            'budget_m3': {'runoff': float(rain_total),
                          'inlet_drained': float(r['total']['drained']),
                          'discharged': float(r['total']['discharged']),
                          'retained': float(depth.sum()) * cell_area,
                          'river_inflow': round(river_inflow_m3),
                          # P2.5 退水分账
                          'seep_pond': float(r['total'].get('seep_pond', 0.0)),
                          'evap': float(r['total'].get('evap', 0.0)),
                          'inlet_pond': float(r['total'].get('inlet_pond', 0.0)),
                          'to_river': float(r['total'].get('to_river', 0.0)),
                          'infiltrated': float(r['total'].get('infil', 0.0))},
        }
        with open(os.path.join(args.out, 'params.json'), 'w', encoding='utf-8') as f:
            json.dump(meta, f, ensure_ascii=False, indent=1)
        with open(os.path.join(args.out, 'summary_l2.json'), 'w', encoding='utf-8') as f:
            json.dump(summary, f, ensure_ascii=False, indent=1)
        log('完成：' + json.dumps({k: v for k, v in summary.items() if k != 'curve'},
                                  ensure_ascii=False))
        log('     出水拆分：洼地溢流出域 %.0f m³ / 直接出域 %.0f m³' %
            (r['total'].get('ovf', 0.0), r['total'].get('dir', 0.0)))
        return 0
    vol_p, held, drained, discharged, leftover = route_accum(
        vol, recv, drain_cap, outlet, storage)
    log(f"      管网排掉 {drained:,.0f} m³；出域 {discharged:,.0f} m³；"
        f"洼地蓄住 {float(held.sum()):,.0f} m³；溢流残余 {leftover:,.0f} m³")

    log("[5/6] 水面摊平（同一洼地内静水）+ 河道边界 …")
    # 【P2】河道水位与网格已在上面算好（river_level / grid），这里不再重复读
    # water.json —— 老代码在这里重读一次并覆盖 grid，两处口径容易走散。
    river_mask = lc == 0
    depth = vol_p / cell_area
    # 【P2-c】只清零**真正开边界**的格（低处边界 + 河面），不再把四条边全当出口；
    # 高处的边界是墙，水留在城市里。
    depth = np.where(river_mask | edge_open, 0.0, depth)
    # 【P2-b】河道漫溢：陆地低于河水位的格至少有这么深的水
    if river_level > 0.0:
        _land = (lc != 0) & (z < river_level)
        depth = np.maximum(depth, np.where(_land, river_level - z, 0.0))
    # 单格蓄水太"芝麻"：做 6 轮 3×3 均值平滑（水量守恒），把孤立小坑并成片。
    # 注意这是可视化/成果口径上的平滑，不是物理演进 —— 物理上的静水摊平要
    # 按洼地求解水面，L2 再做。
    for _ in range(6):
        padded = np.pad(depth, 1, mode="edge")
        acc = np.zeros_like(depth)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                acc += padded[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
        depth = acc / 9.0
    depth = np.clip(depth, 0.0, 3.0)
    wet = depth > 0.02
    sink_only = is_sink.reshape(h, w) & ~river_mask
    log(f"      积水格 {int(wet.sum()):,}（{(depth > 0.15).sum():,} 格 >15 cm），"
        f"最大 {depth.max():.2f} m（残余陆地汇 {int(sink_only.sum()):,} 格）")

    log("[6/6] 落盘 …")
    meta = {
        "grid": {"x0": grid["x0"], "y1": grid["y1"], "step_m": res,
                 "cols": w, "rows": h, "layout": grid["layout"]},
        "vertical_datum": "NAVD88",
        "model": "L1 稳态：产流 × D8 汇流 × 虚拟雨水口排水",
        "rain": {"p_mm_h": args.p_mm_h, "duration_h": args.dur_h, "total_mm": P_mm},
        "river_level_m": river_level,
        "river_level_mode": args.river_level,
        "river_base_m": river_base,
        "river_surge_m": float(getattr(args, "surge_m", 0.0)),
        "edge_open_z_m": float(getattr(args, "edge_open_z", 3.0)),
        "edge_open_cells": n_edge_open,
        "params": {
            "C_runoff": {str(i): float(v) for i, v in enumerate(C_RUNOFF)},
            "f_infil_mm_h": {str(i): (None if not np.isfinite(v) else float(v))
                             for i, v in enumerate(F_INFIL)},
                        "drainage": {"cap_mm_h": args.drain_mm_h, "note": "管网设计排水强度，超过部分才积水"},
        },
        "budget_m3": {"runoff": total_runoff, "inlet_drained": drained,
                      "retained": float(vol_p.sum())},
    }
    with open(os.path.join(args.out, "params.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    # 深度栅格（float32 GeoTIFF，PIL 能写；坐标系写在 params.json 里）
    Image.fromarray(depth.astype("float32"), mode="F").save(os.path.join(args.out, "depth_l1.tif"))
    # 预览 PNG：积水盖在灰度地形上
    zz = (z - z.min()) / max(1e-6, (z.max() - z.min()))
    rgb = np.dstack([zz, zz, zz]) * 200.0
    a = np.clip(depth / 0.6, 0, 1)[..., None]
    rgb = rgb * (1 - a) + np.array([40, 110, 220]) * a
    Image.fromarray(np.clip(rgb, 0, 255).astype("uint8")).save(os.path.join(args.out, "depth_l1.png"))

    # 淹了哪几栋：footprint 采样最大水深 / 地面高程
    csv_path = os.path.join(args.out, "buildings_flooded.csv")
    bj = json.load(open(os.path.join(DERIVED, "buildings_footprints.json"), encoding="utf-8"))
    x0, y1 = grid["x0"], grid["y1"]
    rows_out = []
    for b in bj["features"]:
        rings = b.get("rings") or []
        if not rings:
            continue
        pts = rings[0]
        if len(pts) < 3:
            continue
        col0 = int((min(p[0] for p in pts) - x0) / res)
        col1 = int((max(p[0] for p in pts) - x0) / res) + 1
        row0 = int((y1 - max(p[1] for p in pts)) / res)
        row1 = int((y1 - min(p[1] for p in pts)) / res) + 1
        col0, col1 = max(0, col0), min(w, col1)
        row0, row1 = max(0, row0), min(h, row1)
        if col1 <= col0 or row1 <= row0:
            continue
        d = float(depth[row0:row1, col0:col1].max())
        if d > 0.05:
            rows_out.append((b["id"], b.get("name") or "", b.get("building") or "",
                             float(b["footprint_area_m2"]), float(b["min_z"]), round(d, 3)))
    rows_out.sort(key=lambda r: -r[5])
    with open(csv_path, "w", encoding="utf-8") as f:
        f.write("id,name,building,footprint_area_m2,min_z_m,max_depth_m\n")
        for r in rows_out:
            f.write(",".join([str(r[0]), '"' + str(r[1]).replace('"', "'") + '"', r[2],
                              f"{r[3]:.0f}", f"{r[4]:.2f}", f"{r[5]:.3f}"]) + "\n")

    summary = {
        "grid": f"{w}×{h} @ {res} m",
        "rain_mm": P_mm,
        "runoff_m3": round(total_runoff),
        "inlet_drained_m3": round(drained),
        "retained_m3": round(float(vol_p.sum())),
        "max_depth_m": round(float(depth.max()), 3),
        "cells_gt_15cm": int((depth > 0.15).sum()),
        "area_gt_15cm_m2": int((depth > 0.15).sum()) * res * res,
        "buildings_flooded": len(rows_out),
        "runtime_s": round(time.time() - t0, 1),
    }
    with open(os.path.join(args.out, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    log("完成：" + json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())