#!/usr/bin/env python3
"""把 data/real/ 里的两份派生数据导出成浏览器和纯 Node 都能直接 import 的 JS 模块。

浏览器项目用的是原生 ES modules，没有打包器，不能直接 import JSON；
所以生成 web/src/kernel/real-data.js（纯数据，不含任何页面或 3D 依赖）。
运行：python tools/data/export_kernel_data.py
"""
import datetime
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ACS = ROOT / "data" / "real" / "acs_dc.json"
NHTS = ROOT / "data" / "real" / "nhts_day.json"
OUT = ROOT / "web" / "src" / "kernel" / "real-data.js"


def main():
    for p in (ACS, NHTS):
        if not p.exists():
            raise SystemExit(f"找不到数据文件 {p}，请先运行 import_acs.py / import_nhts.py")
    acs = json.loads(ACS.read_text(encoding="utf-8"))
    nhts = json.loads(NHTS.read_text(encoding="utf-8"))

    acs_s = json.dumps(acs, ensure_ascii=False, indent=2)
    nhts_s = json.dumps(nhts, ensure_ascii=False, indent=2)
    meta = {
        "生成日期": datetime.date.today().isoformat(),
        "生成脚本": "tools/data/export_kernel_data.py",
        "来源文件": ["data/real/acs_dc.json", "data/real/nhts_day.json"],
        "性质": "真实数据集的加权派生结果，不是模型输出，也不是官方直接发布的汇总表",
        "逐文件来源": "from muse/数据来源.md",
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("// 自动生成，不要手改；由 tools/data/export_kernel_data.py 重新生成。\n")
        f.write("// 纯数据模块：不含页面对象、不含 3D 对象，浏览器与纯 Node 都能直接 import。\n")
        f.write(f"export const KERNEL_DATA_META = {json.dumps(meta, ensure_ascii=False, indent=2)};\n\n")
        f.write(f"export const ACS_DC = {acs_s};\n\n")
        f.write(f"export const NHTS_DAY = {nhts_s};\n")

    print(f"写出 {OUT.relative_to(ROOT)}  ({OUT.stat().st_size:,} B)")
    print(f"  ACS 联合分布格子数 {len(acs['joint']['cells'])}，NHTS 交叉表格子数 {len(nhts['joint']['cells'])}")


if __name__ == "__main__":
    main()
