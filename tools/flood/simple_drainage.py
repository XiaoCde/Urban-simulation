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
OUT = os.path.join(ROOT, "data", "flood")

# 参数表（文献初值，见 §5.8；跑出来再校）
# landcover: 0 水体 / 1 建筑 / 2 硬化 / 3 草地 / 4 林地 / 5 裸土
C_RUNOFF = np.array([0.00, 0.95, 0.90, 0.15, 0.10, 0.35], dtype="float32")
F_INFIL = np.array([np.inf, 0.0, 2.0, 12.0, 20.0, 6.0], dtype="float32")  # mm/h
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
                 min_area: int = 3) -> np.ndarray:
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
        V = float(sumv[bi])
        lo, hi = float(zs.min()), float(zs.min()) + 10.0
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
    edge_mask = np.zeros((h, w), dtype=bool)
    edge_mask[0, :] = edge_mask[-1, :] = True
    edge_mask[:, 0] = edge_mask[:, -1] = True
    log(f"      网格 {w}×{h} = {h * w:,} 格，高程 {z.min():.2f}…{z.max():.2f} m")

    # 建筑格并入硬化类（屋顶同样不透水），但保留 bld 掩膜用于后面判"淹了哪栋"
    lc_flow = np.where(bld & (lc != 0), 1, lc)

    log("[2/6] 产流 …")
    P_mm = args.p_mm_h * args.dur_h
    f_mm = F_INFIL[lc_flow] * args.dur_h
    C = C_RUNOFF[lc_flow]
    runoff_mm = np.maximum(0.0, P_mm - f_mm) * C
    runoff_mm = np.where(lc_flow == 0, 0.0, runoff_mm)     # 水体本身不产流
    vol = (runoff_mm / 1000.0) * cell_area                   # m³
    total_runoff = float(vol.sum())
    log(f"      雨量 {P_mm:.1f} mm，产流总量 {total_runoff:,.0f} m³ "
        f"（平均 {runoff_mm.mean():.1f} mm）")

    log("[3/6] 洼地填平（只算流向/容量）+ D8 流向 …")
    tf = time.time()
    zf = priority_flood(z) if args.fill == "priority" else z
    if args.fill == "priority":
        log(f"      Priority-Flood 完成 {time.time() - tf:.1f}s")
    # 【坑】原始 z 必须留着：水面高度、洼地容量都靠它。第一版把 z 覆盖成填平后的
    # 地形，水就再也积不起来了。
    recv, is_sink = d8_receiver(zf)

    log("[4/6] 洼地容量 + 管网排水 + 拓扑汇流 …")
    # 填深 < 5 cm 的坑不算蓄水空间：那是栅格噪声级的微地形，留着只会让
    # 整城布满孤立小水点（第一版就这样，看着像撒了蓝芝麻），不是内涝。
    MIN_PIT_M = 0.05
    fill_depth = np.maximum(0.0, zf - z)
    storage = np.where(fill_depth >= MIN_PIT_M, fill_depth, 0.0) * cell_area
    log(f"      洼地蓄水容量合计 {storage.sum():,.0f} m³（超过它的部分才会溢流）")

    drain_cap = np.where(DRAINS[lc_flow],
                         (args.drain_mm_h / 1000.0) * args.dur_h * cell_area, 0.0)
    outlet = (lc == 0) | edge_mask
    vol_p, held, drained, discharged, leftover = route_accum(
        vol, recv, drain_cap, outlet, storage)
    log(f"      管网排掉 {drained:,.0f} m³；出域 {discharged:,.0f} m³；"
        f"洼地蓄住 {float(held.sum()):,.0f} m³；溢流残余 {leftover:,.0f} m³")

    log("[5/6] 水面摊平（同一洼地内静水）+ 河道边界 …")
    wj = json.load(open(os.path.join(DERIVED, "water.json"), encoding="utf-8"))
    lvl = wj["levels"]
    river_level = float(lvl["MSL_m"]) if args.river_level == "normal" else float(lvl["BFE_min_m"])
    river_mask = lc == 0
    depth = vol_p / cell_area
    depth = np.where(river_mask | edge_mask, 0.0, depth)
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
    grid = wj["grid"]
    meta = {
        "grid": {"x0": grid["x0"], "y1": grid["y1"], "step_m": res,
                 "cols": w, "rows": h, "layout": grid["layout"]},
        "vertical_datum": "NAVD88",
        "model": "L1 稳态：产流 × D8 汇流 × 虚拟雨水口排水",
        "rain": {"p_mm_h": args.p_mm_h, "duration_h": args.dur_h, "total_mm": P_mm},
        "river_level_m": river_level,
        "river_level_mode": args.river_level,
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