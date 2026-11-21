# -*- coding: utf-8 -*-
"""build_velocity.py — 给八个工况补上流速场（大小 + 流向），不动水深帧。

背景：前端一直只有水深，没有流速。于是「被冲走 / 建筑倒塌 / 上屋顶」这三类
      在 LifeSim 里根本判不了（见 docs/依据台账.md 第 140/176/185 行）。
      L2 内核其实每一步都在算单位宽流量 qx/qy，只是从来没落盘。

做法（可复现、不改已有水深结果）：
  1 读 data/flood/unified/<case>/stats.json 里记的原始命令行参数（那是官方口径）；
  2 用同一套参数 + `--vel-frames` 重跑一遍到 data/flood/vel/<case>；
  3 **逐帧校验水深帧与官方帧 byte 一致**——一致才说明这次只是「多存了两张场」，
    没有偷偷改水动力；不一致就整体作废、不往下写；
  4 把 v%03d.u8（流速大小，开方量化 0..3 m/s）与 g%03d.u8（流向）复制进
    data/flood/unified/<case>/frames 与 web/assets/flood/<case>；
  5 在两边的 manifest.json 里给每帧加 "vel"/"dir"，前端按三元组取帧。

用法：
    py tools/flood/build_velocity.py                 # 八个工况全补
    py tools/flood/build_velocity.py --only u_p20_s0  # 只补一套
    py tools/flood/build_velocity.py --check-only     # 只校验已补过的
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
VEL = os.path.join(ROOT, "data", "flood", "vel")
WEB = os.path.join(ROOT, "web", "assets", "flood")

# 复用的关键参数（其余一律以 stats.json 里记录的为准）
PASSTHROUGH = [
    "res", "p_mm_h", "dur_h", "tail_h", "surge_m", "river_level", "drain_m3s",
    "bld_step_m", "h_min", "dt_max", "cfl", "s_max", "frame_min", "depth_scale",
    "max_frames", "edge_tau_s", "edge_open_z", "h_cap", "max_steps",
    "day_minutes", "rain_start_min", "hyetograph", "et_mm_h", "soil_recover_h",
    # sewer_m3s 已删（2026-11-21）：shallow2d.py 从未读它，旧 stats.json 里还留着这个键，
    # 这里不再带它，避免用旧参数拼出一条内核会直接报错的命令行。
    "drain_fail_after_mm", "drain_residual", "drain_recover_h",
    "surge_recede_h",
]
FLAG = {"frames": "--frames", "vel_frames": "--vel-frames", "dbg": "--dbg"}


def cli_of(args):
    """stats.json 的 args → 命令行。只带 passthrough 的键，保证口径不变。"""
    cmd = [sys.executable, KERNEL]
    for k in PASSTHROUGH:
        if k not in args:
            continue
        flag = "--" + k.replace("_", "-")
        v = args[k]
        if isinstance(v, bool):
            if v:
                cmd.append(flag)
        else:
            cmd += [flag, str(v)]
    # 布尔开关（--frames 就是靠这个传的；漏了它只会重算一遍却没有帧落盘）
    for k, flag in FLAG.items():
        if args.get(k) and flag != "--vel-frames":
            cmd.append(flag)
    return cmd


def md5(path):
    import hashlib
    h = hashlib.md5()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def merge_manifest(man_path, src_man):
    """给目标 manifest 的每帧补 vel/dir（按 t_min + 顺序对齐，不靠文件名）。"""
    man = json.load(open(man_path, encoding="utf-8"))
    src = src_man["frames"]
    if len(man["frames"]) != len(src):
        raise SystemExit("[FAIL] 帧数对不上：%s vs %s" % (len(man["frames"]), len(src)))
    for i, (a, b) in enumerate(zip(man["frames"], src)):
        if abs(float(a["t_min"]) - float(b["t_min"])) > 1e-6:
            raise SystemExit("[FAIL] 第 %d 帧 t_min 不一致 %s vs %s"
                             % (i, a["t_min"], b["t_min"]))
        a["vel"] = b["vel"]
        a["dir"] = b["dir"]
    man["velocity"] = {"speed_scale_mps": 3.0, "speed_quant": "sqrt",
                       "dir_quant": "0..255 = -pi..pi",
                       "note": "深度平均流速 = 单位宽流量/水深；<1cm 不记"}
    json.dump(man, open(man_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


def do_case(name, check_only=False):
    st_path = os.path.join(DATA, name, "stats.json")
    if not os.path.exists(st_path):
        print("[skip]", name, "没有 stats.json")
        return False
    args = json.load(open(st_path, encoding="utf-8"))["args"]
    srcdir = os.path.join(VEL, name, "frames")
    if not check_only:
        cmd = cli_of(args) + ["--vel-frames", "--out", os.path.join(VEL, name)]
        t0 = time.time()
        print("[run ]", name, "p=%g dur=%gh surge=%g ..." % (
            args["p_mm_h"], args["dur_h"], args["surge_m"]), flush=True)
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        if r.returncode != 0:
            print("[FAIL]", name, (r.stdout + r.stderr)[-1500:])
            return False
        print("[ok  ]", name, "%.1fs" % (time.time() - t0))
    if not os.path.exists(os.path.join(srcdir, "manifest.json")):
        print("[FAIL]", name, "没产出流速帧")
        return False

    off_man_path = os.path.join(DATA, name, "frames", "manifest.json")
    vel_man = json.load(open(os.path.join(srcdir, "manifest.json"), encoding="utf-8"))
    off_man = json.load(open(off_man_path, encoding="utf-8"))
    if len(off_man["frames"]) != len(vel_man["frames"]):
        print("[FAIL]", name, "帧数差", len(off_man["frames"]), len(vel_man["frames"]))
        return False
    bad = 0
    for a, b in zip(off_man["frames"], vel_man["frames"]):
        if abs(float(a["t_min"]) - float(b["t_min"])) > 1e-6:
            print("[FAIL]", name, "帧序错位", a["t_min"], b["t_min"])
            return False
        if md5(os.path.join(DATA, name, "frames", a["file"])) != \
                md5(os.path.join(srcdir, b["file"])):
            bad += 1
    if bad:
        print("[FAIL]", name, "水深帧 %d/%d 不一致 —— 水动力被改过，拒绝写入"
              % (bad, len(off_man["frames"])))
        return False
    print("[same]", name, "水深帧 %d/%d 与官方逐帧一致" % (len(off_man["frames"]),
                                                          len(off_man["frames"])))
    if check_only:
        return True

    # 数据侧：把 v/g 搬进统一目录并补 manifest
    for b in vel_man["frames"]:
        for key in ("vel", "dir"):
            shutil.copyfile(os.path.join(srcdir, b[key]),
                            os.path.join(DATA, name, "frames", b[key]))
    merge_manifest(off_man_path, vel_man)

    # 前端侧：web 目录的帧名可能和 data 不同（f/k），按 manifest 对齐后复制
    webdir = os.path.join(WEB, name)
    web_man_path = os.path.join(webdir, "manifest.json")
    if os.path.exists(web_man_path):
        web_man = json.load(open(web_man_path, encoding="utf-8"))
        if len(web_man["frames"]) == len(vel_man["frames"]):
            for i, wf in enumerate(web_man["frames"]):
                for key in ("vel", "dir"):
                    shutil.copyfile(os.path.join(srcdir, vel_man["frames"][i][key]),
                                    os.path.join(webdir, vel_man["frames"][i][key]))
                wf["vel"] = vel_man["frames"][i]["vel"]
                wf["dir"] = vel_man["frames"][i]["dir"]
            web_man["velocity"] = json.load(
                open(off_man_path, encoding="utf-8")).get("velocity")
            json.dump(web_man, open(web_man_path, "w", encoding="utf-8"),
                      ensure_ascii=False, indent=1)
            print("[web ]", name, "前端 %d 帧已带流速" % len(web_man["frames"]))
        else:
            print("[warn]", name, "前端帧数 %d ≠ %d，前端未写入"
                  % (len(web_man["frames"]), len(vel_man["frames"])))
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--check-only", action="store_true")
    a = ap.parse_args()
    names = ([a.only] if a.only else
             ["u_p%g_s0" % p for p in (8, 16, 24, 32)] +
             ["u_p%g_s0" % p for p in (20, 40, 80, 120)])
    ok = 0
    for n in names:
        if do_case(n, a.check_only):
            ok += 1
    print("[done] %d/%d" % (ok, len(names)))
    return 0 if ok == len(names) else 1


if __name__ == "__main__":
    sys.exit(main())