#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
export_ldt.py —— 从积水帧 + 步行网(walknet) 导出「最晚出发时刻」LDT 图层。

为什么需要这一层（背景，别删）：
    原来的困死判定 `web/src/trapped.js` 是「此刻你脚下这一格通不通」的**静止快照**，
    隐含假设人站着不动。真实疏散里人一直在走，能不能活下来取决于
    「水什么时候淹掉这条路」和「你走到干地要多久」谁更快。
    这一层把这件事预先算成一张表：

        margin(x, z, t) = LDT(x, z) - t        (单位：分钟，t 是当前情景时刻)

    margin > 0 → 还有富余（就是还能跑掉，剩这么多分钟）；
    margin <= 0 → 这条路已经来不及了，人会困死在原地。
    因为 LDT 是**时间无关**的一张表，网页端只要查格、减当前时刻，O(1)。

算法（三件套）：
    1) tau：逐帧读 u8 水深，记下每个步行网节点**第一次**不可通行
       （depth > WADE_MAX）的情景时刻。tau = INF 表示整个情景都不会淹。
    2) 目的地 = tau = INF 的节点 —— 站在那儿本身就是安全，不需要再走。
    3) 在步行网上跑一次 max-min Dijkstra（"最晚出发时刻"是单调的，优先队列贪心可解）：
           LDT[v] = min( tau[v],  max_{v→u}( LDT[u] - 走这条边的分钟数 ) )
       直观理解：你在 v，往 u 走要花 t 分钟，而 u 那边最晚在 LDT[u] 就得站好，
       所以你最晚只能 LDT[u] - t 从 v 出发；取所有下游里最宽松的那个，
       再被自己的 tau 卡住（水到 v 之前必须走掉）。
    4) 把节点 LDT 落到 6 m 栅格（同格取最大、3×3 最大值膨胀补洞），存 uint16 分钟。

用法：
    D:/citysim/venv/Scripts/python.exe tools/ped/export_ldt.py --case p25_s4
    # 网页工况名 → 自动从 web/assets/flood/<case>/manifest.json 的 source 找到跑批目录
    # 用整场全部帧（p25_1m_s4 是 121 帧 / 5 min），不用网页抽稀后的 26 帧。
"""
import argparse
import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WALKNET = os.path.join(ROOT, "web", "assets", "ped", "walknet.json")
FLOOD_WEB = os.path.join(ROOT, "web", "assets", "flood")
LDT_OUT = os.path.join(ROOT, "web", "assets", "ldt")

WADE_MAX = 0.30          # m，超过这个水深不可通行（和 trapped.js 同一口径）
WALK_SPEED = 1.4         # m/s，人行道自由行走速度（成年人日常步速 1.3~1.5）
INF = 1.0e9
NEVER = 65535            # u16 里的「永不淹」标记


def log(*a):
    print(*a)
    sys.stdout.flush()


# ------------------------------------------------------------------ 读数据
def load_case(case):
    """返回 (run_dir, man)。man 只要有几何：cols/rows/step_m/x0/z0 或 y1。

    两种入口：
      · `--case p25_s4`    网页工况名 → web/assets/flood/p25_s4/manifest.json 的 source
      · 没有网页清单时     把 --case 当成跑批目录名 → data/flood/<case>/frames/manifest.json
    """
    wp = os.path.join(FLOOD_WEB, case, "manifest.json")
    if os.path.isfile(wp):
        web_man = json.load(open(wp, encoding="utf-8"))
        src = web_man.get("source") or ""
        run = os.path.basename(src)
        if not run:
            raise SystemExit(f"{wp} 里没有 source 字段，无法定位跑批目录")
        run_dir = os.path.join(ROOT, "data", "flood", run)
        if not os.path.isdir(run_dir):
            raise SystemExit(f"跑批目录不存在：{run_dir}")
        return run_dir, web_man, case

    run_dir = os.path.join(ROOT, "data", "flood", case)
    fm = os.path.join(run_dir, "frames", "manifest.json")
    if not os.path.isfile(fm):
        raise SystemExit(f"既没有网页清单 {wp}，也没有跑批清单 {fm}")
    man = json.load(open(fm, encoding="utf-8"))
    man = dict(man)
    man.pop("frames", None)
    # 跑批清单只有 y1（+4189），补一个 z0 方便统一处理
    man["z0"] = -float(man["y1"])
    return run_dir, man, case


def load_walknet():
    net = json.load(open(WALKNET, encoding="utf-8"))
    nodes = np.asarray(net["nodes"], dtype=np.float64)      # [[planX, planY]]
    chains = net["chains"]
    return nodes, chains, net.get("meta") or {}


def node_cells(nodes, man):
    """plan 坐标 → 栅格 (c, r)。z = -planY；r = (z - z0)/step。

    网页 manifest 用 `z0`（=-4189），跑批 manifest 用 `y1`（=+4189），两种都认。
    """
    x0 = float(man["x0"])
    if "z0" in man:
        z0 = float(man["z0"])
    else:
        z0 = -float(man["y1"])
    step = float(man["step_m"])
    cols, rows = int(man["cols"]), int(man["rows"])
    x = nodes[:, 0]
    z = -nodes[:, 1]
    c = np.floor((x - x0) / step).astype(np.int64)
    r = np.floor((z - z0) / step).astype(np.int64)
    ok = (c >= 0) & (c < cols) & (r >= 0) & (r < rows)
    c = np.clip(c, 0, cols - 1)
    r = np.clip(r, 0, rows - 1)
    return c, r, ok


def compute_tau(run_dir, man, idx, cols, rows):
    """逐帧扫，得到每个节点的「第一次不可通行时刻」。返回分钟数组（INF=永不淹）。"""
    fdir = os.path.join(run_dir, "frames")
    mf = json.load(open(os.path.join(fdir, "manifest.json"), encoding="utf-8"))
    frames = mf["frames"]
    scale = float(mf.get("scale_m") or man.get("scale_m") or 4.0)
    thr = int(round(WADE_MAX / scale * 255))          # u8 阈值
    n = idx.size
    tau = np.full(n, INF, dtype=np.float64)
    alive = np.ones(n, dtype=bool)
    log(f"  帧数 {len(frames)}，dt {mf.get('dt_s')} s，量程 {scale} m，u8 阈值 {thr}")
    for k, fr in enumerate(frames):
        p = os.path.join(fdir, fr["file"])
        a = np.fromfile(p, dtype=np.uint8)
        if a.size != cols * rows:
            raise SystemExit(f"{p} 尺寸 {a.size} != {cols*rows}")
        v = a[idx]                                    # 每节点所在格的 u8
        hit = alive & (v > thr)
        if hit.any():
            tau[hit] = float(fr["t_min"])
            alive &= ~hit
        if not alive.any():
            log(f"  第 {k} 帧全部节点已淹（t={fr['t_min']} min），后续跳过")
            break
    return tau


def build_edges(nodes, chains):
    """链上相邻节点成边。返回 (U, V, L)，双向各存一次。"""
    eu, ev, el = [], [], []
    for ids in chains:
        if len(ids) < 2:
            continue
        ids = np.asarray(ids, dtype=np.int64)
        a = nodes[ids[:-1]]
        b = nodes[ids[1:]]
        d = np.hypot(b[:, 0] - a[:, 0], b[:, 1] - a[:, 1])
        keep = d > 0.5
        if not keep.any():
            continue
        eu.append(ids[:-1][keep])
        ev.append(ids[1:][keep])
        el.append(d[keep])
    if not eu:
        raise SystemExit("步行网没有有效边")
    eu = np.concatenate(eu)
    ev = np.concatenate(ev)
    el = np.concatenate(el)
    U = np.concatenate([eu, ev])
    V = np.concatenate([ev, eu])
    L = np.concatenate([el, el])
    return U, V, L


def maxmin_dijkstra(n, U, V, L, tau, speed):
    """LDT[v] = min(tau[v], max_{v→u}(LDT[u] - L[v,u]/speed))，目的地 tau=INF。"""
    import heapq
    tm = L / speed / 60.0                     # 边旅行时间（分钟）
    order = np.argsort(U, kind="stable")
    U = U[order]
    V = V[order]
    tm = tm[order]
    deg = np.bincount(U, minlength=n)
    start = np.concatenate([[0], np.cumsum(deg)])
    ldt = np.full(n, -INF)
    heap = []
    for u in np.nonzero(tau >= INF)[0]:
        ldt[u] = INF
        heap.append((-INF, int(u)))
    heapq.heapify(heap)
    pops = 0
    while heap:
        nk, u = heapq.heappop(heap)
        cur = -nk
        if cur < ldt[u] - 1e-9:
            continue                          # 过期条目
        pops += 1
        for e in range(start[u], start[u + 1]):
            v = int(V[e])
            cand = ldt[u] - tm[e]
            if cand > tau[v]:
                cand = tau[v]
            if cand > ldt[v] + 1e-9:
                ldt[v] = cand
                heapq.heappush(heap, (-cand, v))
    log(f"  Dijkstra 出队 {pops} 次（节点 {n}，边 {U.size}）")
    return ldt


def rasterize(c, r, ok, ldt, tau, nodes, chains, cols, rows, step, x0, z0, dilate=1):
    """节点 LDT → 栅格 uint16 的编码约定：

        0     没有步行网覆盖（没人会站这儿）
        65534 开局（t=0）就已经是不可通行的深水 —— 不能作为出生点，也没有余量
        65535 永不淹（无截止时刻）
        其它  最晚出发时刻（分钟）

    【为什么要沿链插值，不只写节点格】
      walknet 是 21,820 条**短链**（平均 1.4 个节点），一条链常常是一整段直街。
      只写两端节点格的话，中间几十米的格子全是 0，网页端就查不到余量
      （第一次实测 21,820 条链里有 10,780 条因为踩到 0 格被判「不能出生」）。
      所以这里沿每条边按 step/2 加密采样，把两端 LDT 线性插值写进每一格。
    """
    grid = np.zeros((rows, cols), dtype=np.float32)
    flat = (r * cols + c)[ok]
    vals = np.minimum(ldt[ok], 60000.0).astype(np.float32)
    np.maximum.at(grid.reshape(-1), flat, vals)

    # ---- 沿链插值采样
    ea, eb = [], []
    for ids in chains:
        if len(ids) < 2:
            continue
        for a, b in zip(ids[:-1], ids[1:]):
            ea.append(a)
            eb.append(b)
    wet0 = np.zeros((rows, cols), dtype=bool)
    if ea:
        A = np.asarray(ea, dtype=np.int64)
        B = np.asarray(eb, dtype=np.int64)
        P0 = nodes[A]
        P1 = nodes[B]
        seg = np.hypot(P1[:, 0] - P0[:, 0], P1[:, 1] - P0[:, 1])
        nper = np.maximum(1, np.ceil(seg / (step * 0.5)).astype(np.int64))
        tot = int(nper.sum())
        segi = np.repeat(np.arange(A.size), nper)
        # 每个采样点在它那条边上的归一化位置
        starts = np.concatenate([[0], np.cumsum(nper)[:-1]])
        frac = (np.arange(tot) - starts[segi]) / nper[segi]
        px = P0[segi, 0] + (P1[segi, 0] - P0[segi, 0]) * frac
        py = P0[segi, 1] + (P1[segi, 1] - P0[segi, 1]) * frac
        cc = np.floor((px - x0) / step).astype(np.int64)
        rr = np.floor((-py - z0) / step).astype(np.int64)
        inb = (cc >= 0) & (cc < cols) & (rr >= 0) & (rr < rows)
        cc = np.clip(cc, 0, cols - 1)
        rr = np.clip(rr, 0, rows - 1)
        la, lb = ldt[A][segi], ldt[B][segi]
        with np.errstate(invalid="ignore"):
            lv = np.where(np.isinf(la) & np.isinf(lb), np.inf,
                          np.where(np.isinf(la), lb, np.where(np.isinf(lb), la, la + (lb - la) * frac)))
        lv = np.where(lv <= -INF / 2, -INF, lv)      # 一端不可达就整段按不可达
        v = np.minimum(lv, 60000.0).astype(np.float32)
        np.maximum.at(grid.reshape(-1), (rr * cols + cc)[inb], v[inb])
        # 这一段挨着「开局已淹」的端点 → 整段不许当出生点（宁可少一个出生点）
        ta, tb = tau[A][segi], tau[B][segi]
        w0 = inb & ((np.minimum(ta, tb) <= 0.0 + 1e-9))
        if w0.any():
            wet0[rr[w0], cc[w0]] = True

    if dilate > 0:
        from scipy.ndimage import maximum_filter
        grid = np.maximum(grid, maximum_filter(grid, size=2 * dilate + 1))
    out = np.zeros((rows, cols), dtype=np.uint16)
    big = grid >= 60000.0
    out[:] = np.minimum(grid, 65534.0).astype(np.uint16)
    out[big] = NEVER
    out[wet0] = 65534
    return out


def main():
    global WADE_MAX, WALK_SPEED
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", required=True, help="网页工况名，如 p25_s4")
    ap.add_argument("--wade", type=float, default=WADE_MAX)
    ap.add_argument("--speed", type=float, default=WALK_SPEED)
    ap.add_argument("--out", default=LDT_OUT)
    ap.add_argument("--no-dilate", action="store_true")
    args = ap.parse_args()

    WADE_MAX = float(args.wade)
    WALK_SPEED = float(args.speed)

    run_dir, man, out_name = load_case(args.case)
    cols, rows = int(man["cols"]), int(man["rows"])
    step = float(man["step_m"])
    x0 = float(man["x0"])
    z0 = float(man["z0"]) if "z0" in man else -float(man["y1"])
    y1 = -z0
    log(f"[1/5] 工况 {args.case} → 跑批 {os.path.basename(run_dir)}")
    log(f"      栅格 {cols}×{rows} @ {step} m，x0 {x0}，z0 {z0}")

    nodes, chains, _ = load_walknet()
    log(f"[2/5] 步行网：{len(nodes)} 节点 / {len(chains)} 链")
    c, r, ok = node_cells(nodes, man)
    idx = (r * cols + c).astype(np.int64)
    if not ok.all():
        log(f"      警告：{int((~ok).sum())} 个节点落在栅格外，已夹到边缘")

    log("[3/5] 逐帧扫水深，求每个节点第一次不可通行时刻 tau")
    tau = compute_tau(run_dir, man, idx, cols, rows)
    ndest = int((tau >= INF).sum())
    n_ = int(tau.size)
    flooded = int((tau < INF).sum())
    log(f"      永不淹节点 {ndest} / {n_}（{ndest / max(1, n_) * 100:.1f}%），会被淹 {flooded}")
    if ndest == 0:
        raise SystemExit("没有任何永不淹节点，无法定义目的地（先调小 surge/雨量或延长退水）")

    log("[4/5] 在步行网上跑 max-min Dijkstra 求 LDT")
    U, V, L = build_edges(nodes, chains)
    ldt = maxmin_dijkstra(nodes.shape[0], U, V, L, tau, WALK_SPEED)
    reach = np.isfinite(ldt) & (ldt > -INF / 2) & (ldt < INF - 1)
    dead = ldt <= -INF / 2
    unreach = flooded - int(reach.sum())
    log(f"      会被淹的节点里：{int(reach.sum())} 个来得及走到安全区，{unreach} 个来不及")
    fin = ldt[reach]
    if fin.size:
        log(f"      最晚出发时刻：中位 {np.median(fin):.0f} min / 最小 {fin.min():.0f} / 最大 {fin.max():.0f}")
    wet0 = int((tau <= 0.0 + 1e-9).sum())
    log(f"      开局（t=0）就已不可通行的节点 {wet0} 个（4 m 增水直接淹掉的那片）")

    log("[5/5] 落到栅格并写盘")
    grid = rasterize(c, r, ok, ldt, tau, nodes, chains, cols, rows, step, x0, z0,
                     0 if args.no_dilate else 1)
    os.makedirs(args.out, exist_ok=True)
    up = os.path.join(args.out, args.case + ".u16")
    grid.tofile(up)
    nonz = int((grid > 0).sum())
    meta = {
        "case": args.case,
        "run": os.path.basename(run_dir),
        "cols": cols, "rows": rows, "step_m": step,
        "x0": x0, "z0": -y1, "y1": y1,
        "wade_max_m": WADE_MAX,
        "walk_speed_mps": WALK_SPEED,
        "nodes": int(nodes.shape[0]),
        "chains": len(chains),
        "dest_nodes": ndest,
        "flooded_nodes": flooded,
        "wet_at_t0_nodes": wet0,
        "reachable_nodes": int(reach.sum()),
        "unreachable_nodes": int(unreach),
        "cells_with_ldt": nonz,
        "ldt_median_min": float(np.median(fin)) if fin.size else None,
        "ldt_min_min": float(fin.min()) if fin.size else None,
        "u16_never": NEVER,
        "u16_wet_at_t0": 65534,
        "note": "uint16 分钟，行主序；65535=永不淹；65534=开局已淹不可作为出生点；0=无步行网覆盖",
    }
    mp = os.path.join(args.out, args.case + ".json")
    json.dump(meta, open(mp, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    log(f"      写入 {up}（{os.path.getsize(up) / 1e6:.2f} MB，有值的格 {nonz}）")
    log(f"      写入 {mp}")
    log("完成。")


if __name__ == "__main__":
    main()