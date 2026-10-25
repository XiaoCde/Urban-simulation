# -*- coding: utf-8 -*-
"""把 L2 帧序列导出成 web 能吃的深度叠层（u8，6 m 一格）。

frames/*.u8 是 0..255 量化（深度 0..scale 米）；web 端 flood.js 用 DataTexture 解码。
时间抽稀：降雨段每 5 min、退水段每 30 min，压到 ~26 帧（约 22 MB）。

坐标系：frames/manifest.json 记的是「栅格原点 x0/y1（y 向北）」，而 three.js 场景里
z = -y，所以导出清单里写 x0 和 z0=-y1 —— 这一步错了整层积水会平移 4 km。
"""
import argparse, json, os, shutil
import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="data/flood/l2（有 params.json + frames/）")
    ap.add_argument("--dst", required=True, help="web/assets/flood")
    ap.add_argument("--max-frames", type=int, default=26)
    ap.add_argument("--rain-min-step", type=float, default=5.0)
    ap.add_argument("--tail-min-step", type=float, default=30.0)
    args = ap.parse_args()

    src, dst = args.src, args.dst
    fam = json.load(open(os.path.join(src, "frames", "manifest.json"), encoding="utf-8"))
    par = json.load(open(os.path.join(src, "params.json"), encoding="utf-8"))
    grid = par["grid"]
    x0 = float(fam.get("x0", grid["x0"]))
    y1 = float(fam.get("y1", grid["y1"]))
    rain_min = float(fam.get("rain_min", par["rain"]["duration_h"] * 60.0))

    chosen, last = [], -1e9
    for f in fam["frames"]:
        step = args.rain_min_step if f["t_min"] <= rain_min + 1e-6 else args.tail_min_step
        if f["t_min"] - last >= step - 1e-6:
            chosen.append(f)
            last = f["t_min"]
    if len(chosen) > args.max_frames:
        idx = np.linspace(0, len(chosen) - 1, args.max_frames).round().astype(int)
        chosen = [chosen[i] for i in idx]

    os.makedirs(dst, exist_ok=True)
    out = {"step_m": float(fam["step_m"]), "x0": x0, "z0": -y1,
           "cols": int(fam["cols"]), "rows": int(fam["rows"]),
           "scale": float(fam.get("scale_m", 5.0)), "rain_min": rain_min,
           "source": os.path.basename(os.path.dirname(src.rstrip("\\/"))) + "/" + os.path.basename(src),
           "frames": []}
    for k, f in enumerate(chosen):
        name = "f%02d.u8" % k
        shutil.copyfile(os.path.join(src, "frames", f["file"]), os.path.join(dst, name))
        out["frames"].append({"file": name, "t_min": f["t_min"]})
    json.dump(out, open(os.path.join(dst, "manifest.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    total = sum(os.path.getsize(os.path.join(dst, f["file"])) for f in out["frames"])
    print(json.dumps({"frames": len(out["frames"]), "MB": round(total / 1e6, 1),
                      "t": [out["frames"][0]["t_min"], out["frames"][-1]["t_min"]],
                      "x0": out["x0"], "z0": out["z0"], "step": out["step_m"]},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
