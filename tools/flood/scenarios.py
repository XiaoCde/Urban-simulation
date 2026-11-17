"""
scenarios.py — 情景库批量跑

一条命令跑完「雨强 × 历时 × 边界条件」的组合，每个情景一个目录 + 一行 CSV。

用法：
    python tools/flood/scenarios.py --list                 # 只打印会跑哪些
    python tools/flood/scenarios.py --jobs 2 --threads 4   # 真跑
    python tools/flood/scenarios.py --only rain            # 只跑雨强轴

【为什么要限制 jobs × threads】
numba 默认吃满所有核。两个进程各开 8 线程会互相抢，反而比串行慢。
8 核机器上 jobs=2 × threads=4 是实测最稳的组合。

【口径】
所有情景共用：4 m 网格、dt 自适应、--h-cap 4 m、--drain-m3s 255。
变的只有雨强、历时、边界条件——这样差异全部来自气候与边界，不受数值设置干扰。
"""

import argparse
import csv
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PY = sys.executable
SCRIPT = os.path.join(ROOT, "tools", "flood", "shallow2d.py")
OUT = os.path.join(ROOT, "data", "flood", "scenarios")
TIDE = "data/flood/tide/isabel_2003.json"
TIDE06 = "data/flood/tide/jun2006.json"

COMMON = ["--res", "4", "--h-cap", "4", "--frame-min", "30"]   # 不传 --frames，只留 stats


def build_cases():
    """返回 [(name, [额外参数...], 说明)]"""
    cases = []

    def add(name, p, dur, tail, extra, note):
        cases.append((name, ["--p-mm-h", str(p), "--dur-h", str(dur), "--tail-h", str(tail)] + extra, note))

    # ---- 基线：中雨 + 中等增水 ----
    add("base_110_2h_c2", 110, 2, 6, ["--surge-m", "2"], "基线：110 mm/h × 2 h，常数增水 2 m")

    # ---- 雨强轴（固定 2 h、增水 2 m）----
    for p in (50, 80, 140, 180):
        add(f"rain_{p}", p, 2, 6, ["--surge-m", "2"], f"雨强轴：{p} mm/h × 2 h")

    # ---- 历时轴（固定 110 mm/h、增水 2 m）----
    for dur, tail in ((1, 6), (4, 8)):
        add(f"dur_{dur}h", 110, dur, tail, ["--surge-m", "2"], f"历时轴：{dur} h")

    # ---- 边界轴（固定 110 mm/h × 2 h）----
    add("surge_0", 110, 2, 6, ["--surge-m", "0"], "边界轴：无增水（天文潮基准）")
    add("surge_4", 110, 2, 6, ["--surge-m", "4"], "边界轴：增水 4 m（超历史压力测试）")
    add("surge_isabel", 110, 2, 10,
        ["--surge-series", TIDE, "--surge-t0-h", "48"], "边界轴：Isabel 2003 实测潮位过程线")
    add("surge_jun2006", 110, 2, 10,
        ["--surge-series", TIDE06, "--surge-t0-h", "36"], "边界轴：2006-06 实测水位过程线")

    return cases


def run_one(job):
    name, extra, note, threads = job
    out = os.path.join(OUT, name)
    os.makedirs(out, exist_ok=True)
    cmd = [PY, SCRIPT] + extra + COMMON + ["--threads", str(threads), "--out", out]
    t0 = time.time()
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                       errors="replace")
    dt = time.time() - t0
    ok = p.returncode == 0 and os.path.exists(os.path.join(out, "stats.json"))
    rec = dict(name=name, note=note, ok=ok, runtime_s=round(dt, 1))
    if ok:
        st = json.load(open(os.path.join(out, "stats.json"), encoding="utf-8"))
        vol = st.get("volume") or {}
        frames = st.get("frames") or []
        peak = max(frames, key=lambda f: f.get("wet_ha", 0)) if frames else {}
        last = frames[-1] if frames else {}
        v_in = float(vol.get("rain", 0)) + max(0.0, float(vol.get("river", 0)))
        v_out = (float(vol.get("drain", 0)) + float(vol.get("edge", 0))
                 + max(0.0, -float(vol.get("river", 0))) + float(vol.get("clip", 0)))
        rec.update(
            p_mm_h=st["args"]["p_mm_h"], dur_h=st["args"]["dur_h"],
            surge=(st["args"].get("surge_series") or f"const{st['args']['surge_m']:g}"),
            peak_t=peak.get("t_min"), peak_wet_ha=peak.get("wet_ha"),
            peak_street_km=peak.get("street_km"), peak_max_h=peak.get("max_h"),
            end_t=last.get("t_min"), end_wet_ha=last.get("wet_ha"),
            end_river=last.get("river"),
            vol_rain=round(float(vol.get("rain", 0)) / 1e6, 3),
            closure_pct=round(100.0 * (v_in - v_out - float(vol.get("now", 0))) / max(v_in, 1e-9), 4),
        )
    else:
        rec["err"] = (p.stderr or p.stdout or "")[-400:]
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", type=int, default=2, help="并行进程数（8 核建议 2）")
    ap.add_argument("--threads", type=int, default=4, help="每进程 numba 线程数")
    ap.add_argument("--list", action="store_true", help="只列出情景")
    ap.add_argument("--only", default="", help="只跑名字里含该串的情景")
    ap.add_argument("--resume", action="store_true", help="跳过已完成的目录")
    args = ap.parse_args()

    cases = build_cases()
    if args.only:
        cases = [c for c in cases if args.only in c[0]]
    if args.resume:
        cases = [c for c in cases if not os.path.exists(os.path.join(OUT, c[0], "stats.json"))]

    if args.list:
        for n, ex, note in cases:
            print(f"  {n:20s} {' '.join(ex)}")
            print(f"  {'':20s} {note}")
        print(f"\n共 {len(cases)} 个，按每工况 ~5 min、{args.jobs} 进程并行，预计 "
              f"{len(cases) * 5 / max(args.jobs, 1):.0f} min")
        return

    os.makedirs(OUT, exist_ok=True)
    print(f"跑 {len(cases)} 个情景：{args.jobs} 进程 × {args.threads} 线程", flush=True)
    rows, t_all = [], time.time()
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        futs = {ex.submit(run_one, (n, ex_args, note, args.threads)): n
                for n, ex_args, note in cases}
        for k, fu in enumerate(as_completed(futs), 1):
            rec = fu.result()
            rows.append(rec)
            flag = "OK " if rec["ok"] else "ERR"
            print(f"[{k}/{len(cases)}] {flag} {rec['name']:20s} "
                  f"{rec.get('runtime_s', 0):6.0f}s  "
                  f"峰值湿 {rec.get('peak_wet_ha', '-')} ha  "
                  f"淹路 {rec.get('peak_street_km', '-')} km  "
                  f"闭合 {rec.get('closure_pct', '-')}%", flush=True)
            if not rec["ok"]:
                print("       " + (rec.get("err") or "")[-200:], flush=True)

    # 汇总 CSV（按固定列序）
    cols = ["name", "note", "p_mm_h", "dur_h", "surge", "peak_t", "peak_wet_ha",
            "peak_street_km", "peak_max_h", "end_t", "end_wet_ha", "end_river",
            "vol_rain", "closure_pct", "runtime_s", "ok"]
    csv_path = os.path.join(OUT, "summary.csv")
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in sorted(rows, key=lambda x: x["name"]):
            w.writerow(r)
    print(f"\n汇总 {csv_path}（{len(rows)} 行，总耗时 {(time.time()-t_all)/60:.1f} min）")


if __name__ == "__main__":
    main()
