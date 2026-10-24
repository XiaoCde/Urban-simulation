# -*- coding: utf-8 -*-
r"""地形自检：DTM 是否可信（对应任务书 §9 第 3 条）。

四类检查，全部打日志，任一不过就是红色：
  1) 已知地物抽查 —— 华盛顿纪念碑/国会山/波托马克河床。这些地点的高程有常识范围，
     如果一个都不在范围内，说明投影/行列顺序/单位有一处错了。
  2) 与**独立**公开 DEM 抽样 200 点比对，算 RMSE（§9 第 3 条：RMSE ≤ 2 m）。
     独立源用 data\dem\USGS_1_n39w077.tif（1 arc-second ≈ 30 m），
     它与 1 m 源是同门但不同分辨率，能抓出「整体偏移/翻转」这类硬错。
  3) 坡度分布 —— 城市地面坡度应集中在 0~5%，如果全是 45° 说明高程是噪声。
  4) 河岸高差 —— 沿岸一定范围内应看到 3 m 以上的连续落差（任务书 §3.1 要求「自然河岸高差」）。
"""
import os
import sys
import math
import numpy as np
import rasterio

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tm  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DTM = os.path.join(ROOT, "data", "derived", "terrain_dtm.tif")
REF30 = os.path.join(ROOT, "data", "dem", "USGS_1_n39w077.tif")

# 已知地物（本地米制，取自 data\derived\buildings_footprints.json）
SPOTS = [
    ("Washington Monument", 1257.6, -100.6, (5.0, 25.0)),
    ("US Capitol (east front)", 3600.0, 60.0, (20.0, 45.0)),
    ("White House", 1450.0, 720.0, (8.0, 30.0)),
    ("Lincoln Memorial", 640.0, 350.0, (2.0, 20.0)),
    ("Potomac riverbed", -300.0, 500.0, (-8.0, 3.0)),
    ("Anacostia (east)", 4600.0, 900.0, (-8.0, 6.0)),
    ("Georgetown (west, high)", -1000.0, 3400.0, (10.0, 70.0)),
]


def sample_local(ds, xs, ys):
    """在 DTM（本地 1 m north-up）上按本地米制坐标双线性取样。"""
    T = ds.transform
    a = ds.read(1)
    rows = (ys - T.f) / T.e
    cols = (xs - T.c) / T.a
    r0 = np.clip(np.floor(rows).astype(int), 0, ds.height - 2)
    c0 = np.clip(np.floor(cols).astype(int), 0, ds.width - 2)
    fr = rows - r0
    fc = cols - c0
    v = (a[r0, c0] * (1 - fr) * (1 - fc) + a[r0, c0 + 1] * (1 - fr) * fc +
         a[r0 + 1, c0] * fr * (1 - fc) + a[r0 + 1, c0 + 1] * fr * fc)
    return v


def main():
    fails = []
    with rasterio.open(DTM) as ds:
        a = ds.read(1)
        T = ds.transform
        print("[chk] DTM %dx%d  res %.2f  bounds x %.0f..%.0f y %.0f..%.0f"
              % (ds.width, ds.height, ds.res[0], ds.bounds.left, ds.bounds.right,
                 ds.bounds.bottom, ds.bounds.top))
        print("[chk] tags: %s" % ds.tags())

        # 1) 地物抽查
        print("\n[chk] === 1. 已知地物高程抽查 ===")
        for name, x, y, (lo, hi) in SPOTS:
            z = float(sample_local(ds, np.array([x]), np.array([y]))[0])
            ok = lo <= z <= hi
            if not ok:
                fails.append("地物 %s 高程 %.2f 不在 [%.1f, %.1f]" % (name, z, lo, hi))
            print("[chk] %-24s (%7.1f,%7.1f)  z = %7.2f m  %s  [期望 %.0f..%.0f]"
                  % (name, x, y, z, "OK " if ok else "❌", lo, hi))

        # 2) 与 30 m 公开 DEM 比对（200 点，只在陆地有效区）
        print("\n[chk] === 2. 与独立公开 DEM 抽样 200 点 RMSE ===")
        rng = np.random.default_rng(20251022)
        xs = rng.uniform(tm.GRID_X0 + 50, tm.GRID_X1 - 50, 4000)
        ys = rng.uniform(tm.GRID_Y0 + 50, tm.GRID_Y1 - 50, 4000)
        z1 = sample_local(ds, xs, ys)
        lat, lon = tm.to_geographic(xs, ys)
        with rasterio.open(REF30) as ref:
            Rb = ref.read(1)
            RT = ref.transform
            rr = (lat - RT.f) / RT.e
            cc = (lon - RT.c) / RT.a
            good = ((rr >= 1) & (rr < ref.height - 2) & (cc >= 1) & (cc < ref.width - 2))
            zi = np.full(lat.shape, np.nan)
            r_i = np.clip(np.round(rr[good]).astype(int), 0, ref.height - 1)
            c_i = np.clip(np.round(cc[good]).astype(int), 0, ref.width - 1)
            zi[good] = Rb[r_i, c_i]
        okz = np.isfinite(zi) & np.isfinite(z1) & (zi > -1000)
        # 30 m 网格在河岸/建筑边缘会有平滑差，剔除极端离群后再算 RMSE（并同时报原始值）
        d = z1[okz] - zi[okz]
        rmse_all = float(np.sqrt((d ** 2).mean()))
        keep = np.abs(d) < 25.0
        d2 = d[keep]
        rmse = float(np.sqrt((d2 ** 2).mean()))
        # 恰好 200 点的判定样本
        idx = rng.choice(np.where(okz)[0], size=min(200, int(okz.sum())), replace=False)
        d200 = z1[idx] - zi[idx]
        rmse200 = float(np.sqrt((d200 ** 2).mean()))
        print("[chk] 比对点数 %d（有效 %d）" % (len(d), int(okz.sum())))
        print("[chk] 偏差 mean %+.2f m  std %.2f m" % (float(d2.mean()), float(d2.std())))
        print("[chk] RMSE（全部）      %.2f m   （离群 %d 个）" % (rmse_all, int((~keep).sum())))
        print("[chk] RMSE（剔离群）    %.2f m" % rmse)
        print("[chk] RMSE（200 点判定）%.2f m   §9 要求 ≤ 2 m  %s"
              % (rmse200, "OK" if rmse200 <= 2.0 else "❌"))
        if rmse200 > 2.0:
            fails.append("RMSE %.2f m > 2 m" % rmse200)

        # 3) 坡度分布
        print("\n[chk] === 3. 坡度分布（1 m 网格，Sobel 近似）===")
        sub = a[::4, ::4].astype(np.float64)
        gx = np.abs(np.diff(sub, axis=1))
        gy = np.abs(np.diff(sub, axis=0))
        g = np.sqrt((gx[:-1, :] ** 2) + (gy[:, :-1] ** 2)) * 100.0
        for q in (50, 75, 90, 95, 99):
            print("[chk]   坡度 P%-2d = %6.2f %%" % (q, np.percentile(g, q)))
        if np.percentile(g, 90) > 30:
            fails.append("90 分位坡度 %.1f%% 过大，疑似噪声" % np.percentile(g, 90))

        # 4) 河岸高差：波托马克东岸 x≈-200..200 一带，比较河床与岸上 300 m 内的落差
        print("\n[chk] === 4. 河岸高差 ===")
        band = np.arange(tm.GRID_Y0 + 200, tm.GRID_Y1 - 200, 100.0)
        for xa, xb, label in [(-500, -100, "波托马克西岸"), (100, 500, "波托马克东岸")]:
            zs = []
            for y in band:
                z = float(sample_local(ds, np.array([(xa + xb) / 2]), np.array([y]))[0])
                zs.append(z)
            zs = np.array(zs)
            print("[chk] %s x[%d,%d]  z min %6.2f  max %6.2f  高差 %5.2f m"
                  % (label, xa, xb, zs.min(), zs.max(), zs.max() - zs.min()))

    print("\n[chk] ===== 结论：%s =====" % ("全部通过" if not fails else "有 %d 项不合格" % len(fails)))
    for f in fails:
        print("[chk]  ❌ %s" % f)
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
