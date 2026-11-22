"""
build_surge_only.py — 纯增水（雨强 = 0）对照工况生成器。

【为什么要这个文件，2026-11-22，创新点 #4「跨驱动」】
`build_unified.py` 的工况矩阵是 RAIN_TIERS=[8,16,24,32] × SURGE_TIERS=[0,2,4]，
最小雨强就是 8 mm/h —— 也就是说，那个矩阵里**没有一套是「不下雨、只靠河道增水」**。
于是「同一套决策模型换一种灾害输入」这句话在现有数据上没法证：两套工况都带雨，
换的只是强度，不是驱动机制。

降雨型内涝和风暴增水的差别不只是「水多水少」：
  · 涨水快慢不同：暴雨是分钟级陡涨（本项目 u_p* 的 45 分钟一帧里能差半米），
    增水是小时级慢涨（Isabel 实测 12 h 涨落）；
  · 来水位置不同：暴雨在城市上空均匀下，增水从河道/岸线向内推，低洼和地下室先中招；
  · 时间窗不同：暴雨的「走不走」窗口只有几十分钟，增水的窗口是好几个小时。
这三条都会改决策结果（动员曲线吃时间、门5 吃"我现在走不走得动"），所以必须真跑。

用法：
    py tools/flood/build_surge_only.py                    # 跑默认三档 1.0 / 2.0 / 2.71 m
    py tools/flood/build_surge_only.py --only u_p0_s20     # 只跑一套
    py tools/flood/build_surge_only.py --smoke             # 冒烟：res 40 / 60 分一套，跑完即删

档位依据：
  · 2.71 m = 飓风 Isabel（2003）在本区的实测增水峰值，shallow2d.py 的 --surge-m 注释里就写的这个数；
  · 2.0 m = 常见一级飓风近岸增水量级，用作中档；
  · 1.0 m = 低档，用来分辨「只淹地下室」与「淹到地面」两种死因结构。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_unified import COMMON, KERNEL, ROOT, DATA, WEB, build_index  # noqa: E402

# 名字沿用 u_p<雨强>_s<增水>，方便 sim-day.mjs 的 caseMeta 解析与 sweep-report 的正则。
# 档位说明见文件头：2.71 = Isabel 实测峰值（低于堤顶 3.658，应**不淹**，作对照），
# 4.0 / 6.0 = 超堤顶情景（漫堤入城，慢涨），这才是「河道型淹没」的实验组。
SURGE_ONLY = [2.71, 4.0, 6.0]
OVERPOP_CW = 1.7          # 宽顶堰系数 Cw（m^0.5/s），出处见 param-registry 的 riv.overtopCw


def name_of(surge):
    return "u_p0_s%g" % surge


def run(surge, smoke=False, keep=True):
    name = name_of(surge)
    outdir = os.path.join(DATA, name if not smoke else "_smoke_p0")
    webdir = os.path.join(WEB, name if not smoke else "_smoke_p0")
    man = os.path.join(outdir, "frames", "manifest.json")
    if keep and not smoke and os.path.exists(man) \
            and os.path.exists(os.path.join(webdir, "manifest.json")):
        print("[skip]", name, "已有")
        return True
    os.makedirs(outdir, exist_ok=True)
    common = list(COMMON)
    if smoke:
        # 冒烟只验证「p=0 能不能被内核接受、会不会除零」，用粗网格与短时段，
        # 结果不进任何统计，跑完就删。
        def setflag(flag, val):
            i = common.index(flag)
            common[i + 1] = val
        setflag("--res", "40")
        setflag("--day-minutes", "120")
        setflag("--dur-h", "2")
        setflag("--frame-min", "60")
        setflag("--max-frames", "2")
    cmd = [sys.executable, KERNEL] + common + [
        "--p-mm-h", "0", "--surge-m", str(surge),
        "--river-overtop-cw", str(OVERPOP_CW), "--out", outdir]
    t0 = time.time()
    print("[run ]", name, "p=0 mm/h surge=%g m ..." % surge, flush=True)
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        print("[FAIL]", name, "\n", (r.stdout + r.stderr)[-2000:], flush=True)
        return False
    if not os.path.exists(man):
        print("[FAIL]", name, "没有产出 manifest")
        return False
    os.makedirs(webdir, exist_ok=True)
    for f in os.listdir(os.path.join(outdir, "frames")):
        shutil.copy2(os.path.join(outdir, "frames", f), os.path.join(webdir, f))
    st = json.load(open(os.path.join(outdir, "stats.json"), encoding="utf-8"))
    peak = max((f.get("wet_ha", 0.0) for f in st.get("frames", [])), default=0.0)
    peak_h = max((f.get("max_h", 0.0) for f in st.get("frames", [])), default=0.0)
    print("[ok  ]", name, "%.1fs" % (time.time() - t0),
          "峰值湿区 %.1f ha · 最深 %.2f m · 闭合差 %.4f%%" % (
              peak, peak_h, st.get("volume", {}).get("closure_pct", 0.0)), flush=True)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--smoke", action="store_true")
    args = ap.parse_args()
    if args.smoke:
        ok = run(1.0, smoke=True, keep=False)
        for d in (os.path.join(DATA, "_smoke_p0"), os.path.join(WEB, "_smoke_p0")):
            shutil.rmtree(d, ignore_errors=True)
        print("[smoke]", "通过" if ok else "失败")
        sys.exit(0 if ok else 1)
    ok = 0
    for s in SURGE_ONLY:
        if args.only and args.only != name_of(s):
            continue
        if run(s):
            ok += 1
    print("[done]", ok, "套成功")
    # 索引里没有 p=0 档，这里不重建 unified_index（前端滑条不列它）；
    # 仿真入口 sim-day.mjs 直接按目录名 F.load(name) 取帧，不需要索引。
    _ = build_index  # 保持 import 以便将来把纯增水档并入面板


if __name__ == "__main__":
    main()