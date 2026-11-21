"""
build_unified.py — 用**唯一**的统一内核批量生成 24 小时参数矩阵。

用户要「一个栏目里左边调雨强档位、右边调直接加水多少米、中间拖 24h 时间轴」。
网页端不可能实时重算 191 万格 × 24 h，所以离线把「雨强 × 增水」的离散组合
全部用同一个内核跑成帧序列，前端切档位 = 立刻换一套帧（几十 ms）。

产出的每套工况都是同一条 0:00→24:00 时间轴、同一套四条退水去路、同一条
增水/退潮过程线，只是雨强 p_mm_h 和增水 surge_m 不同 —— 这就是「全部统一」。

用法：
    py tools/flood/build_unified.py                 # 全跑
    py tools/flood/build_unified.py --only u_p40_s2 # 只跑一套（调试）
    py tools/flood/build_unified.py --index-only    # 只重建 index.json
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
KERNEL = os.path.join(ROOT, "tools", "flood", "shallow2d.py")
DATA = os.path.join(ROOT, "data", "flood", "unified")
WEB = os.path.join(ROOT, "web", "assets", "flood")

# 面板上的两个维度。档位名直接给前端当标签用。
# 【2026-11-06 改】用户要求「从头到尾都要下雨」：降雨窗口从 17:00–19:00 的 2 h
# 改成 0:00–24:00 的整日。窗口拉长 12 倍，如果平均雨强仍按 20/40/80/120 走，
# 一天就是 480/960/1920/2880 mm —— 全城会变成一个 4 m 深的湖，什么也看不见。
# 所以档位按「24 h 平均雨强」重定：8/16/24/32 mm/h = 192/384/576/768 mm/日，
# 最低档≈一年一遇的日雨量，最高档≈极端事件。峰值由 day 雨型给出，约 2.9 倍。
RAIN_TIERS = [8.0, 16.0, 24.0, 32.0]        # mm/h，24 h 平均（day 雨型峰值 ~2.9 倍）
SURGE_TIERS = [0.0, 2.0, 4.0]               # m，河道增水峰值（右侧「直接加水」）

COMMON = [
    "--res", "8",
    "--day-minutes", "1440",
    "--rain-start-min", "0",             # 0:00 起雨
    "--dur-h", "24",                     # 0:00–24:00，一整天都在下
    "--hyetograph", "day",
    "--et-mm-h", "0.12",
    "--soil-recover-h", "24",
    # 【2026-11-21】旧参数 sewer-m3s 45 已删：shallow2d.py 从解算到出帧从未读过它，
    # 管道能力由 drain-m3s（design_drain_m3s()≈228 m³/s）与满管桶容量决定。
    "--drain-fail-after-mm", "25",
    "--drain-residual", "0.05",
    "--drain-recover-h", "6",
    "--surge-recede-h", "3",
    "--frames",
    "--frame-min", "45",                # 1440 / 45 = 32 帧，正好铺满一天
    "--max-frames", "32",
    "--depth-scale", "4",
    "--h-cap", "4",
]


def case_name(p, s):
    return "u_p%g_s%g" % (p, s)


def build_index():
    cases = []
    for p in RAIN_TIERS:
        for s in SURGE_TIERS:
            name = case_name(p, s)
            man_path = os.path.join(WEB, name, "manifest.json")
            st_path = os.path.join(DATA, name, "stats.json")
            if not os.path.exists(man_path):
                print("[index] 缺帧，跳过", name)
                continue
            man = json.load(open(man_path, encoding="utf-8"))
            curve = []
            peak_wet = 0.0
            if os.path.exists(st_path):
                for f in json.load(open(st_path, encoding="utf-8"))["frames"]:
                    curve.append([f["t_min"], f["wet_ha"], f.get("river", 0.0)])
                    peak_wet = max(peak_wet, f["wet_ha"])
            cases.append(dict(name=name, p_mm_h=p, surge_m=s,
                               frames=len(man.get("frames", [])),
                               peak_wet_ha=round(peak_wet, 1),
                               curve=curve))
    idx = dict(
        kernel="unified",
        day_minutes=1440.0,
        rain_start_min=0.0,
        rain_end_min=1440.0,
        rain_tiers=RAIN_TIERS,
        surge_tiers=SURGE_TIERS,
        cases=cases,
    )
    out = os.path.join(WEB, "unified_index.json")
    json.dump(idx, open(out, "w", encoding="utf-8"), ensure_ascii=False)
    print("[index]", out, "共", len(cases), "套")
    return idx


def run_case(p, s):
    name = case_name(p, s)
    outdir = os.path.join(DATA, name)
    webdir = os.path.join(WEB, name)
    man = os.path.join(outdir, "frames", "manifest.json")
    if os.path.exists(man) and os.path.exists(os.path.join(webdir, "manifest.json")):
        print("[skip]", name, "已有")
        return True
    os.makedirs(outdir, exist_ok=True)
    cmd = [sys.executable, KERNEL] + COMMON + [
        "--p-mm-h", str(p), "--surge-m", str(s), "--out", outdir]
    t0 = time.time()
    print("[run ]", name, "p=%g mm/h surge=%g m ..." % (p, s), flush=True)
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        print("[FAIL]", name, "\n", (r.stdout + r.stderr)[-2000:], flush=True)
        return False
    if not os.path.exists(man):
        print("[FAIL]", name, "没有产出 manifest")
        return False
    # 前端按 <dir>/manifest.json 取，所以把 frames/ 整层提到工况根
    os.makedirs(webdir, exist_ok=True)
    for f in os.listdir(os.path.join(outdir, "frames")):
        shutil.copy2(os.path.join(outdir, "frames", f), os.path.join(webdir, f))
    # 记录闭合差，方便验收
    st = json.load(open(os.path.join(outdir, "stats.json"), encoding="utf-8"))
    vol = st.get("volume", {})
    tail = (r.stdout.strip().splitlines() or [""])[-1]
    print("[ok  ]", name, "%.1fs" % (time.time() - t0),
          "闭合差 %.4f%%" % vol.get("closure_pct", 0.0), "|", tail[:80], flush=True)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="只跑某一套，例如 u_p40_s2")
    ap.add_argument("--index-only", action="store_true")
    args = ap.parse_args()
    if not args.index_only:
        ok = 0
        for p in RAIN_TIERS:
            for s in SURGE_TIERS:
                name = case_name(p, s)
                if args.only and args.only != name:
                    continue
                if run_case(p, s):
                    ok += 1
        print("[done]", ok, "套成功")
    build_index()


if __name__ == "__main__":
    main()
