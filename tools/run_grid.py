# -*- coding: utf-8 -*-
"""放大规模测试驱动器：把一批 .osm 块逐块丢给 Blender，记录耗时/内存/建筑数。

每块一个**干净 Blender 进程**，所以测出的内存是"单块成本"而不是累积成本。

用法:
    python run_grid.py <块目录> [输出csv] [--limit N]
例:
    python run_grid.py data/osm/tiles_mall out/grid_test.csv
"""
import csv
import glob
import os
import subprocess
import sys
import time

BLENDER = r"D:\blender\blender.exe"
TOOLS = os.path.dirname(os.path.abspath(__file__))


def _num(field):
    """从 'import=12.3s' / 'blend=0.2MB' 这类字段里取出数字。"""
    s = field.split("=", 1)[1] if "=" in field else field
    out = ""
    for ch in s:
        if ch.isdigit() or ch in ".-":
            out += ch
        else:
            break
    return float(out)


def run_one(tile, outdir, blend=True):
    out = os.path.join(outdir, os.path.basename(tile).replace(".osm", ".blend")) if blend else ""
    cmd = [BLENDER, "--background", "--python", os.path.join(TOOLS, "import_tile.py"),
           "--", tile, out]
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    line = ""
    for l in (p.stdout or "").splitlines():
        if l.startswith("RESULT|"):
            line = l
    if not line:
        tail = ((p.stdout or "") + (p.stderr or ""))[-800:]
        return dict(tile=os.path.basename(tile), error="no RESULT", wall=time.time() - t0,
                    log=tail, size_kb=os.path.getsize(tile) / 1024)
    f = line.split("|")
    d = dict(tile=f[1], import_s=_num(f[2]), total_s=_num(f[3]),
             mesh=int(_num(f[4])), curve=int(_num(f[5])),
             buildings=int(_num(f[6])), faces=int(_num(f[7])),
             maxZ=_num(f[8]), mem0=_num(f[9]),
             mem1=_num(f[10]), peak=_num(f[11]),
             blend_mb=_num(f[12]), wall=time.time() - t0,
             size_kb=os.path.getsize(tile) / 1024, error="")
    return d


def main():
    tiles_dir = sys.argv[1]
    csv_out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(tiles_dir))), "out", "grid_test.csv")
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    tiles = sorted(glob.glob(os.path.join(tiles_dir, "*.osm")))
    if limit:
        tiles = tiles[:limit]
    outdir = os.path.join(os.path.dirname(csv_out), "grid_blends")
    os.makedirs(outdir, exist_ok=True)
    os.makedirs(os.path.dirname(csv_out), exist_ok=True)

    print("待测 %d 块，结果写入 %s" % (len(tiles), csv_out))
    rows = []
    t_all = time.time()
    for i, t in enumerate(tiles, 1):
        d = run_one(t, outdir)
        rows.append(d)
        if d["error"]:
            print("[%d/%d] %-18s !! %s  %s" % (i, len(tiles), d["tile"], d["error"], d.get("log", "")[-200:]))
        else:
            print("[%d/%d] %-18s %6.1f KB  import %5.1fs  wall %5.1fs  mesh %4d  建筑 %4d  "
                  "面 %5d  maxZ %6.1f  peakRAM %5.0f MB"
                  % (i, len(tiles), d["tile"], d["size_kb"], d["import_s"], d["wall"],
                     d["mesh"], d["buildings"], d["faces"], d["maxZ"], d["peak"]))
        with open(csv_out, "w", newline="", encoding="utf-8-sig") as f:
            wr = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            wr.writeheader()
            wr.writerows(rows)

    ok = [r for r in rows if not r["error"]]
    print("=" * 96)
    print("完成 %d 块（成功 %d），总耗时 %.1f 分钟" % (len(rows), len(ok), (time.time() - t_all) / 60))
    if ok:
        print("  单块 import 中位数 %.1f s，最大 %.1f s"
              % (sorted(r["import_s"] for r in ok)[len(ok) // 2], max(r["import_s"] for r in ok)))
        print("  单块峰值内存 中位数 %.0f MB，最大 %.0f MB"
              % (sorted(r["peak"] for r in ok)[len(ok) // 2], max(r["peak"] for r in ok)))
        print("  建筑合计 %d，面合计 %d，maxZ 最大 %.1f"
              % (sum(r["buildings"] for r in ok), sum(r["faces"] for r in ok), max(r["maxZ"] for r in ok)))
        print("  .blend 合计 %.1f MB" % sum(r["blend_mb"] for r in ok))
    print("CSV:", csv_out)


main()
