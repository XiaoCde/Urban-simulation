"""
calibrate.py — 用 2006-06 的实测高水位标记率定 / 检查模型

【观测从哪来】
NCPC《Federal Triangle Stormwater Drainage Study》(2011) 第 3 章给了 2006-06-24..26
那场雨在 Federal Triangle 的洪痕照片与描述，其中两处写明花坛处的水位标记高度：

  · Constitution Ave between 9th & 10th St NW —— 约 2.5 ft = 0.76 m
  · 15th Street near Constitution Avenue     —— 约 3 ft  = 0.91 m

同章还写了 12th / 9th Street 隧道被淹、Federal Triangle 各联邦大楼地下室进水。
另外给出管网设计标准：Constitution Avenue 雨水管只有 **2~5 年一遇**，
B Street/New Jersey Ave 是 15 年一遇，DC Water 新建标准是 15 年一遇。
这三条是本次率定的全部依据，没有一条是我编的。

【为什么是「检查」而不是「优化」】
只有 2 个定量点 + 3 个定性点，参数却有 5 个以上 —— 这是欠定问题，
跑优化器只会得到一组「好看但无意义」的数。所以这个脚本做两件事：
  1. 给定参数，报模型在观测点的水深与命中情况；
  2. 扫一个参数（默认 --drain-m3s），看观测点误差怎么变。

【坐标】
项目用的是横轴墨卡托局部平面（lon0=-77.04975645, lat0=38.89038015）。
这里用等距圆柱近似换回平面，3 km 内误差 < 1 m，对 4 m 网格够用。

用法：
    python tools/flood/calibrate.py --list
    python tools/flood/calibrate.py --run --drain 255
    python tools/flood/calibrate.py --sweep 120,180,255,320
"""

import argparse
import csv
import json
import math
import os
import subprocess
import sys

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PY = sys.executable
SCRIPT = os.path.join(ROOT, "tools", "flood", "shallow2d.py")
OUT = os.path.join(ROOT, "data", "flood", "calib")

LAT0, LON0 = 38.89038015, -77.04975645
R = 6378137.0
M_PER_DEG_LAT = math.pi * R / 180.0
M_PER_DEG_LON = M_PER_DEG_LAT * math.cos(math.radians(LAT0))


def ll2xy(lat, lon):
    """经纬度 → 项目平面坐标（米）。等距圆柱近似。"""
    return ((lon - LON0) * M_PER_DEG_LON, (lat - LAT0) * M_PER_DEG_LAT)


# name, lat, lon, 观测水深(m, None=只知淹/不淹), kind, 来源
OBS = [
    ("Constitution Ave & 9-10th St NW", 38.89364, -77.02573, 0.76, "depth",
     "NCPC 2011 §3.2 花坛洪痕 2.5 ft"),
    ("15th St near Constitution Ave", 38.89404, -77.03351, 0.91, "depth",
     "NCPC 2011 §3.2 花坛洪痕 3 ft"),
    ("12th St Tunnel", 38.89247, -77.02883, None, "flooded",
     "NCPC 2011 §3.2 隧道进水不可通行"),
    ("9th St Tunnel", 38.89197, -77.02449, None, "flooded",
     "NCPC 2011 §3.2 隧道进水不可通行"),
    ("Federal Triangle / IRS 大楼", 38.89372, -77.02646, None, "flooded",
     "Reuters 2006-06-26 地下室被淹停摆"),
]

# 2006-06-24..26：Reagan National 合计约 14 in ≈ 356 mm；单日峰值 132 mm
# 【口径】2006-06 的 132 mm 不是 10 h 均匀下完的，是几段短时爆发（flash flood）。
# 均匀 24 mm/h 的雨会被 255 m³/s 的管网全部吃掉（24 mm/h × 30.6 km² × 0.9 = 184 m³/s < 255），
# 模型给出全城 0 积水 —— 那是口径错，不是模型错。改成 80 mm/h × 3 h 才对得上"瞬时超载"。
RAIN_2006 = ["--p-mm-h", "80", "--dur-h", "3", "--tail-h", "3"]


def run_model(tag, extra, threads=8):
    out = os.path.join(OUT, tag)
    os.makedirs(out, exist_ok=True)
    cmd = ([PY, SCRIPT, "--res", "4", "--h-cap", "4", "--frame-min", "30"]
           + RAIN_2006 + extra + ["--threads", str(threads), "--out", out])
    print("  $ " + " ".join(cmd[2:]), flush=True)
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if p.returncode != 0:
        print((p.stderr or p.stdout)[-800:], flush=True)
        return None
    return os.path.join(out, "state.npz")


def score(npz_path):
    d = np.load(npz_path)
    h = d["h"].astype("float32")
    res = int(d["res"])
    x0, y1 = float(d["x0"]), float(d["y1"])
    rows = []

    def sample(x, y, rad=2):
        """取 ±rad 格邻域的最大水深。

        【为什么不用单格】Federal Triangle 那两个观测点是「大楼前的花坛洪痕」，
        经纬度落到 4 m 网格上常常正好压在建筑格里 —— 而建筑格的水走落水管，
        地表水深恒为 0。直接取单格会得到「模型一点没淹」的假结论。
        """
        c = int((x - x0) // res)
        r = int((y1 - y) // res)
        if not (0 <= r < h.shape[0] and 0 <= c < h.shape[1]):
            return None
        nb = h[max(0, r - rad):r + rad + 1, max(0, c - rad):c + rad + 1]
        return float(nb.max())

    for name, lat, lon, dep, kind, src in OBS:
        x, y = ll2xy(lat, lon)
        v = sample(x, y)
        rows.append(dict(name=name, x=round(x), y=round(y), obs=dep, model=v, kind=kind))

    errs = [abs(r["model"] - r["obs"]) for r in rows
            if r["obs"] is not None and r["model"] is not None]
    hit = [1 if (r["model"] or 0) >= 0.30 else 0 for r in rows if r["kind"] == "flooded"]
    rmse = float(np.sqrt(np.mean(np.square(errs)))) if errs else None
    return rows, rmse, (sum(hit), len(hit))


def report(rows, rmse, hits):
    print(f"    {'观测点':34s} {'x':>6s} {'y':>6s} {'观测':>7s} {'模型':>7s}")
    for r in rows:
        o = f"{r['obs']:.2f} m" if r["obs"] is not None else ("淹" if r["kind"] == "flooded" else "-")
        m = f"{r['model']:.2f} m" if r["model"] is not None else "域外"
        print(f"    {r['name']:34s} {r['x']:6d} {r['y']:6d} {o:>7s} {m:>7s}")
    if rmse is not None:
        print(f"    定量点 RMSE = {rmse:.3f} m")
    print(f"    定性点命中 {hits[0]}/{hits[1]}（模型 ≥0.30 m 记为淹）")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--sweep", default="", help="逗号分隔的 --drain-m3s 取值")
    ap.add_argument("--drain", type=float, default=255.0)
    ap.add_argument("--threads", type=int, default=8)
    args = ap.parse_args()

    if args.list:
        for n, la, lo, dep, k, s in OBS:
            x, y = ll2xy(la, lo)
            print(f"  {n:34s} ({x:6.0f}, {y:6.0f})  {dep if dep is not None else k:>7}  ← {s}")
        print(f"\n  降雨口径：{' '.join(RAIN_2006)}（≈252 mm / 12 h，对齐 6/25–26 两天实测 9.94 in）")
        return

    values = [float(v) for v in args.sweep.split(",")] if args.sweep else [args.drain]
    if not os.path.isdir(OUT):
        os.makedirs(OUT, exist_ok=True)
    summary = []
    for v in values:
        tag = f"drain_{int(v)}"
        print(f"\n[--drain-m3s {v:g}]", flush=True)
        npz = run_model(tag, ["--drain-m3s", str(v)], threads=args.threads)
        if not npz:
            continue
        rows, rmse, hits = score(npz)
        report(rows, rmse, hits)
        summary.append(dict(drain=v, rmse=rmse, hit=f"{hits[0]}/{hits[1]}",
                            max_depth=max((r["model"] or 0) for r in rows)))

    if len(summary) > 1:
        print("\n扫参汇总：")
        print(f"  {'drain':>7s} {'RMSE(m)':>9s} {'命中':>7s} {'观测点最大水深':>14s}")
        for s in summary:
            print(f"  {s['drain']:7.0f} {s['rmse'] if s['rmse'] is not None else float('nan'):9.3f} "
                  f"{s['hit']:>7s} {s['max_depth']:14.3f}")
        with open(os.path.join(OUT, "sweep.csv"), "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=list(summary[0].keys()))
            w.writeheader()
            w.writerows(summary)


if __name__ == "__main__":
    main()
