# -*- coding: utf-8 -*-
"""把 FEMA 校正后的逐栋首层高导出成前端可直接 fetch 的 sidecar。

为什么要这个脚本
----------------
`tools/calibrate_foundation_fema.py` 已经算出了逐栋首层高
（`data/derived/building_foundation_fema.json`），但**只在 Python 侧用过**：
前端 `web/src/kernel/floors.js` 至今仍是全城统一 `foundationHeightM = 0.457`
（DC 旧规 1.5 ft）。后果是室内一层进水判据错 3–4 倍
（见 `docs/首层标高校正_2026-11-18.md`：同一场 50 mm/h 雨，
「轮廓任意点>5cm」163 栋 → 「DC 规范 0.457」540 栋 → 「无首层高」3358 栋）。

这个脚本不改任何模型逻辑，只做**数据搬运 + 压缩**：
把 21k 栋 × 3 组假设的浮点表压成「id 列表 + 每假设一条数字串」。
三组假设只有 4 个取值（0.30 / 0.70 / 1.07 / 1.22 m，FEMA 2015 的四档台基），
所以每栋只要 1 位数字就够，21,213 栋 × 3 组 ≈ 64 KB，加 id 列表共约 280 KB。
不压的话原始 JSON 是 1.0 MB 左右，页面启动时多等一秒不值得。

输出
----
web/assets/city/foundation_fema.json

格式
----
{
  "note": "...",
  "source": "data/derived/building_foundation_fema.json",
  "defaultM": 0.457,                       # 缺值时的回退（DC 旧规，保留原行为）
  "codes": [0.30, 0.70, 1.07, 1.22],       # 数字串里 '0'..'3' 的含义
  "scenarios": { "A_全国河岸": "0123...", ... },
  "ids": ["48037324", ...],                # 与数字串同序
  "coverage": { "web_buildings": 21943, "matched": 21147, "missing": 796 }
}

前端读法见 `web/src/kernel/floors.js` 的 `setFoundationTable()`。

用法
----
    python tools/export_web_foundation.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "derived", "building_foundation_fema.json")
WEB_BLD = os.path.join(ROOT, "web", "assets", "city", "buildings.json")
OUT = os.path.join(ROOT, "web", "assets", "city", "foundation_fema.json")


def main():
    if not os.path.exists(SRC):
        sys.exit("缺少 %s，先跑 tools/calibrate_foundation_fema.py" % SRC)
    src = json.load(open(SRC, encoding="utf-8"))
    per = src.get("per_scenario") or {}
    if not per:
        sys.exit("%s 里没有 per_scenario" % SRC)

    # 取值集合必须正好是 FEMA 四档，否则说明上游脚本口径变了，直接报错而不是硬编。
    vals = sorted({round(float(v), 3) for d in per.values() for v in d.values()})
    codes = vals
    idx = {v: i for i, v in enumerate(codes)}
    print("取值档位: %s" % ", ".join("%.2f" % v for v in codes))

    # 只导出前端真实存在的建筑（web/assets/city/buildings.json 的 id 集合），
    # 免得带一堆页面里根本没有的 id。
    bld = json.load(open(WEB_BLD, encoding="utf-8"))
    arr = bld if isinstance(bld, list) else (bld.get("buildings") or [])
    web_ids = [str(b.get("id")) for b in arr]
    print("前端建筑: %d 栋" % len(web_ids))

    any_scn = next(iter(per.values()))
    ids, keep = [], []
    for bid in web_ids:
        if bid in any_scn:
            ids.append(bid)
            keep.append(bid)

    scenarios = {}
    for name, table in per.items():
        s = "".join(str(idx[round(float(table[bid]), 3)]) for bid in keep)
        assert len(s) == len(ids), (name, len(s), len(ids))
        scenarios[name] = s

    out = {
        "note": ("逐栋首层高（一楼地面高于相邻地坪，m）的三组假设，"
                 "由 tools/calibrate_foundation_fema.py 用 FEMA 2015 默认台基值"
                 "做分位数映射得到；三组基础的**占比**是假设，不是 DC 实测。"
                 "取值只有 4 档，故用数字串压缩，见 codes。"),
        "source": "data/derived/building_foundation_fema.json",
        "defaultM": 0.457,
        "codes": codes,
        "scenarios": scenarios,
        "ids": ids,
        "coverage": {
            "web_buildings": len(web_ids),
            "matched": len(ids),
            "missing": len(web_ids) - len(ids),
        },
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    kb = os.path.getsize(OUT) / 1024.0
    print("输出: %s  (%.0f KB)" % (OUT, kb))
    print("覆盖: %d / %d 栋（缺 %d 栋回退 %.3f m）" %
          (len(ids), len(web_ids), len(web_ids) - len(ids), out["defaultM"]))
    for name, s in scenarios.items():
        hist = {codes[int(c)]: s.count(c) for c in set(s)}
        print("  %-12s %s" % (name,
              "  ".join("%.2fm:%d" % (k, hist[k]) for k in sorted(hist))))


if __name__ == "__main__":
    main()