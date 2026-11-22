#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""外部验证：把「命中率 2.1%」升级成「能过审稿的判别能力」。

原来的 `tools/validate_dc311.py` 只报一个数：311 报修点里有多少落在我们算的积水里
（2.1%，因为 311 跨多年多场雨、我们只有一场 50 mm/h 稳态，且「有积水」这个词
两边定义不同）。审稿人会说：这个数既低又没比较对象。一个点命中率不是判别能力。

本脚本改做三件事：

  1. 以 **DC 官方 Integrated Flood Model（1-yr 情景，4567 个多边形）** 当第三方真值，
     在 2 m 网格上算我们 50 mm/h 稳态图的 ROC / AUC（全城、逐格），并给阈值扫描
     （POD / FAR / CSI / F1）。这是「我们的空间格局有没有判别力」；
  2. 以 **311 报修点（10 m 去重）** 当稀疏真值，算「报修点 vs 随机格」的 AUC；
  3. 两个 AUC 都给按 500 m 分块的 bootstrap 置信区间（空间自相关会让朴素 CI 过窄）。

必须写在结论里的口径限制（脚本会一并打印、写进 JSON）：
  · 与 DC 官方模型不是同一场雨、也不是同一定义（官方 1-yr 情景 vs 我们 50 mm/h 稳态）；
    AUC 只说明「空间上更像被淹的地方得分更高」，不是事件强度校验；
  · 官方 DEPTH 字段单位未确认（原值 0.5 起），本脚本只用其**多边形覆盖**做二值真值；
  · 311 有报告偏差（人口密、住户多的街区报得多），所以报修点 AUC 只能当弱证据；
  · 我们的深度图上限 3.0 m（h-cap），高分被截平会让 AUC 略被低估（同分按 0.5 计）。
"""
import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 与 tools/add_dc_features.py / tools/validate_dc311.py 同一套线性投影
G_LON0, G_LON_KM = -77.059998, 0.059998
G_LAT0, G_LAT_KM = 38.885003, 0.039996
S_X0, S_X_SPAN = -887.0, 5197.0
S_Y0, S_Y_SPAN = -597.0, 4451.0

CELL = 2.0                      # 分析网格 2 m（1 m 原图 5100 万格太多，2 m 足够算 AUC）
BOOT_BLOCKS = 500.0             # bootstrap 分块边长（m）
BOOT_REPS = 200

GRID = {"x0": -1277.0, "y1": 4189.0, "step": 1.0, "cols": 5978, "rows": 5120}


def geo_to_scene(lon, lat):
    return (S_X0 + (lon - G_LON0) / G_LON_KM * S_X_SPAN,
            S_Y0 + (lat - G_LAT0) / G_LAT_KM * S_Y_SPAN)


def load_depth(step):
    """读 1 m 深度图，按 step 取块内最大值降到粗网格。"""
    from PIL import Image
    d = np.asarray(Image.open(os.path.join(ROOT, "data/flood/l1_1m/depth_l1.tif")), dtype=np.float32)
    assert d.shape == (GRID["rows"], GRID["cols"]), d.shape
    k = int(step / GRID["step"])
    if k == 1:
        return d
    r, c = d.shape
    d = d[: (r // k) * k, : (c // k) * k]
    return d.reshape(r // k, k, c // k, k).max(axis=(1, 3))


def rasterize_dc_model(step, rows, cols):
    """把 DC 官方模型多边形烧到同一网格（外环填 1，内环挖 0）。"""
    from PIL import Image, ImageDraw
    gj = json.load(open(os.path.join(ROOT, "data/real/dc311/dc_flood_model_1yr.geojson"), encoding="utf-8"))
    img = Image.new("L", (cols, rows), 0)
    draw = ImageDraw.Draw(img)
    x0, y1 = GRID["x0"], GRID["y1"]
    depths = []

    def to_px(ring):
        pts = []
        for lon, lat in ring:
            x, z = geo_to_scene(lon, lat)
            pts.append(((x - x0) / step, (y1 - z) / step))
        return pts

    for f in gj["features"]:
        depths.append(f["properties"].get("DEPTH"))
        g = f.get("geometry") or {}
        if g.get("type") == "Polygon":
            polys = [g["coordinates"]]
        elif g.get("type") == "MultiPolygon":
            polys = g["coordinates"]
        else:
            continue
        for poly in polys:
            if not poly:
                continue
            draw.polygon(to_px(poly[0]), fill=1)
            for hole in poly[1:]:
                draw.polygon(to_px(hole), fill=0)
    return np.asarray(img, dtype=np.uint8), depths


def auc_rank(pos, neg):
    """Mann-Whitney AUC；同分按 0.5 计（等价于平均秩）。"""
    n1, n2 = len(pos), len(neg)
    if n1 == 0 or n2 == 0:
        return float("nan")
    allv = np.concatenate([pos, neg])
    order = np.argsort(allv, kind="mergesort")
    ranks = np.empty(len(allv), dtype=np.float64)
    ranks[order] = np.arange(1, len(allv) + 1)
    # 同分取平均秩
    s = allv[order]
    i = 0
    while i < len(s):
        j = i
        while j + 1 < len(s) and s[j + 1] == s[i]:
            j += 1
        if j > i:
            ranks[order[i: j + 1]] = 0.5 * (i + 1 + j + 1)
        i = j + 1
    r1 = ranks[:n1].sum()
    return float((r1 - n1 * (n1 + 1) / 2.0) / (n1 * n2))


def metrics(score, truth, ths):
    out = []
    for t in ths:
        pred = score > t
        tp = int((pred & truth).sum())
        fp = int((pred & ~truth).sum())
        fn = int((~pred & truth).sum())
        pod = tp / (tp + fn) if (tp + fn) else float("nan")
        far = fp / (tp + fp) if (tp + fp) else float("nan")
        csi = tp / (tp + fp + fn) if (tp + fp + fn) else float("nan")
        f1 = (2 * tp) / (2 * tp + fp + fn) if (2 * tp + fp + fn) else float("nan")
        out.append({"th_m": t, "tp": tp, "fp": fp, "fn": fn,
                    "POD": round(pod, 4), "FAR": round(far, 4),
                    "CSI": round(csi, 4), "F1": round(f1, 4)})
    return out


def block_bootstrap(score, truth, block_px, reps, rng):
    """按 block_px 分块的 bootstrap（重采样块，保住空间自相关）。"""
    rows, cols = score.shape
    rb, cb = int(np.ceil(rows / block_px)), int(np.ceil(cols / block_px))
    out = []
    for _ in range(reps):
        bi = rng.integers(0, rb, rb)
        bj = rng.integers(0, cb, cb)
        idx_r = (bi[:, None] * block_px + np.arange(block_px)[None, :]).ravel()
        idx_c = (bj[:, None] * block_px + np.arange(block_px)[None, :]).ravel()
        idx_r = idx_r[(idx_r >= 0) & (idx_r < rows)]
        idx_c = idx_c[(idx_c >= 0) & (idx_c < cols)]
        s = score[np.ix_(idx_r, idx_c)].ravel()
        t = truth[np.ix_(idx_r, idx_c)].ravel()
        a = auc_rank(s[t], s[~t])
        if np.isfinite(a):
            out.append(a)
    if not out:
        return {"lo": float("nan"), "hi": float("nan"), "n": 0}
    out = np.asarray(out)
    return {"lo": round(float(np.percentile(out, 2.5)), 4),
            "hi": round(float(np.percentile(out, 97.5)), 4),
            "n": int(len(out))}


def main():
    from PIL import Image
    step = CELL
    score = load_depth(step)
    rows, cols = score.shape
    truth, dc_depths = rasterize_dc_model(step, rows, cols)
    truth = truth.astype(bool)

    print("网格 %d×%d（%.0f m）· DC 官方多边形 %d 个 · DEPTH 取值各 %d 种"
          % (rows, cols, step, len(dc_depths), len(set(dc_depths))))
    print("官方模型覆盖 %.2f%% 的格子；我们 >5cm 的格子 %.2f%%、>30cm %.2f%%"
          % (100 * truth.mean(), 100 * (score > 0.05).mean(), 100 * (score > 0.3).mean()))

    auc_cell = auc_rank(score[truth], score[~truth])
    print("\n【对 DC 官方模型】逐格 AUC = %.4f（正格 %d、负格 %d）"
          % (auc_cell, int(truth.sum()), int((~truth).sum())))

    ths = [0.05, 0.15, 0.30, 0.50]
    rows_m = metrics(score, truth, ths)
    best = max(rows_m, key=lambda r: (r["CSI"] if np.isfinite(r["CSI"]) else -1))
    print("阈值扫描（相对官方多边形）：")
    for r in rows_m:
        print("  >%.2f m | POD %.3f | FAR %.3f | CSI %.3f | F1 %.3f"
              % (r["th_m"], r["POD"], r["FAR"], r["CSI"], r["F1"]))
    print("  最佳 CSI 阈值 = %.2f m（CSI %.3f）" % (best["th_m"], best["CSI"]))

    # 同面积口径：把我们的阈值定在「湿格占比 = 官方覆盖率」处，再算一次 P/FA/CSI。
    # 理由：原始 0.05 m 阈值下我们湿格比官方多 40%，POD/FAR 天生吃亏；审稿人会问这个。
    t_eq = float(np.quantile(score, 1.0 - float(truth.mean())))
    eq = metrics(score, truth, [t_eq])[0]
    print("  同面积口径：阈值 %.3f m（使湿格占比 = 官方 %.2f%%）→ POD %.3f / FAR %.3f / CSI %.3f"
          % (t_eq, 100 * float(truth.mean()), eq["POD"], eq["FAR"], eq["CSI"]))

    rng = np.random.default_rng(20261123)
    ci_cell = block_bootstrap(score, truth, int(BOOT_BLOCKS / step), BOOT_REPS, rng)
    print("  分块 bootstrap 95%% CI：[%.4f, %.4f]（%d 次重采样）"
          % (ci_cell["lo"], ci_cell["hi"], ci_cell["n"]))

    # ---- 311 报修点：报修点 vs 随机格 ----
    raw = json.load(open(os.path.join(ROOT, "data/real/dc311/flood_requests_raw.json"), encoding="utf-8"))
    x0, y1 = GRID["x0"], GRID["y1"]
    pts, seen = [], set()
    for year, rows_ in raw.items():
        for r in rows_:
            lat, lon = r.get("LATITUDE"), r.get("LONGITUDE")
            if not (isinstance(lat, (int, float)) and isinstance(lon, (int, float))):
                continue
            if not (38.80 < lat < 38.99 and -77.12 < lon < -76.90):
                continue
            x, z = geo_to_scene(lon, lat)
            c, ri = int((x - x0) / step), int((y1 - z) / step)
            if not (0 <= c < cols and 0 <= ri < rows):
                continue
            k = (round(x / 10), round(z / 10))
            if k in seen:
                continue
            seen.add(k)
            pts.append((ri, c, year))
    pos311 = np.array([score[r, c] for r, c, _ in pts], dtype=np.float32)

    n_rand = 20000
    rr = rng.integers(0, rows, n_rand)
    cc = rng.integers(0, cols, n_rand)
    neg311 = score[rr, cc]
    auc311 = auc_rank(pos311, neg311)
    print("\n【对 311 报修点】10 m 去重后 %d 点 · 对 %d 个随机格 AUC = %.4f"
          % (len(pos311), n_rand, auc311))
    print("  报修点处模拟水深：中位 %.3f m、75%% %.3f、90%% %.3f"
          % (float(np.median(pos311)), float(np.percentile(pos311, 75)), float(np.percentile(pos311, 90))))
    print("  报修点里模拟 0 水（≤1cm）的：%d（%.1f%%）"
          % (int((pos311 <= 0.01).sum()), 100 * float((pos311 <= 0.01).mean())))

    # ---- 同一批 311 点去撞「官方模型」：这是判定「是我们的问题还是 311 的问题」的关键对照 ----
    off_hit = np.array([bool(truth[r, c]) for r, c, _ in pts], dtype=bool)
    ours_hit = pos311 > 0.05
    off_base = float(truth.mean())
    ours_base = float((score > 0.05).mean())
    print("\n【同一批 311 点 × 两张图】（基准率：官方 %.2f%%、我们 %.2f%%）"
          % (100 * off_base, 100 * ours_base))
    print("  落在官方模型内：%d / %d = %.1f%%（提升 %.2f×）"
          % (int(off_hit.sum()), len(pts), 100 * off_hit.mean(),
             (off_hit.mean() / off_base) if off_base else float("nan")))
    print("  落在我们 >5cm 内：%d / %d = %.1f%%（提升 %.2f×）"
          % (int(ours_hit.sum()), len(pts), 100 * ours_hit.mean(),
             (ours_hit.mean() / ours_base) if ours_base else float("nan")))
    print("  两张图在这个点集上的一致率：%.1f%%（都判淹 %d、都判干 %d）"
          % (100 * float((off_hit == ours_hit).mean()),
             int((off_hit & ours_hit).sum()), int((~off_hit & ~ours_hit).sum())))

    inter = float((truth & (score > 0.05)).sum())
    uni = float((truth | (score > 0.05)).sum())
    print("  全城两图交并比 IoU = %.4f；我们的湿格有 %.1f%% 落在官方湿格内"
          % (inter / uni if uni else float("nan"), 100 * inter / max(1.0, float((score > 0.05).sum()))))

    # 311 的 bootstrap（对点重采样，点本身已去重）
    boots = []
    for _ in range(1000):
        ii = rng.integers(0, len(pos311), len(pos311))
        jj = rng.integers(0, n_rand, n_rand)
        a = auc_rank(pos311[ii], neg311[jj])
        if np.isfinite(a):
            boots.append(a)
    ci311 = {"lo": round(float(np.percentile(boots, 2.5)), 4),
             "hi": round(float(np.percentile(boots, 97.5)), 4), "n": len(boots)}
    print("  点 bootstrap 95%% CI：[%.4f, %.4f]" % (ci311["lo"], ci311["hi"]))

    out = {
        "generated": "2026-11-23",
        "grid": {"cell_m": step, "rows": rows, "cols": cols},
        "against_dc_official_model": {
            "auc_cell": round(auc_cell, 4),
            "auc_ci_block_bootstrap": ci_cell,
            "pos_cells": int(truth.sum()),
            "neg_cells": int((~truth).sum()),
            "truth_coverage_pct": round(100 * float(truth.mean()), 3),
            "thresholds": rows_m,
            "equal_area_threshold_m": round(t_eq, 3),
            "equal_area_metrics": eq,
            "best_csi_threshold_m": best["th_m"],
            "best_csi": best["CSI"],
        },
        "against_311_reports": {
            "report_point_hit_official_pct": round(100 * float(off_hit.mean()), 1),
            "report_point_hit_official_lift": round(float(off_hit.mean() / off_base), 2),
            "report_point_hit_ours_pct": round(100 * float(ours_hit.mean()), 1),
            "report_point_hit_ours_lift": round(float(ours_hit.mean() / ours_base), 2),
            "two_maps_agreement_pct": round(100 * float((off_hit == ours_hit).mean()), 1),
            "iou_ours_vs_official": round(inter / uni, 4) if uni else None,
            "ours_wet_inside_official_pct": round(100 * inter / max(1.0, float((score > 0.05).sum())), 1),
            "auc": round(auc311, 4),
            "auc_ci_point_bootstrap": ci311,
            "points_dedup_10m": len(pos311),
            "median_depth_at_reports_m": round(float(np.median(pos311)), 3),
            "share_zero_depth_pct": round(100 * float((pos311 <= 0.01).mean()), 1),
        },
        "caveats": [
            "官方模型是 1-yr 情景、我们是 50 mm/h 稳态，不是同一场雨；AUC 只说明空间判别力。",
            "官方 DEPTH 单位未确认，只用多边形覆盖做二值真值。",
            "311 有报告偏差，报修点 AUC 只作弱证据。",
            "我们的深度图 h-cap 3 m，高分截平会使 AUC 略低估（同分按 0.5 计）。",
        ],
    }
    dst = os.path.join(ROOT, "data/real/dc311/auc_validation.json")
    json.dump(out, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("\n已写 %s" % dst)


if __name__ == "__main__":
    main()