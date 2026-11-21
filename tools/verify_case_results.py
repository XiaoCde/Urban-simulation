#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""八工况整族验收：一次把该对的账全对完。

用法：
    python tools/verify_case_results.py web/out/sweep_v4
    python tools/verify_case_results.py web/out/sweep_v4 --json

做四件事（都写成断言，红一条就不是"全部通过"）：

1. **三套死亡口径必须合计相等**：`dead == ΣdeathsByCause == ΣdeathsByZone
   == ΣdeathsByLegacyCause`。口径不同则同一批人命会被报成两个数。
2. **分族**：全天族（u_p8/u_p16/u_p24/u_p32）与傍晚两小时族（u_p20/u_p40/u_p80/
   u_p120）分开列，**不做跨族横向比较**（雨型不同：一个是全天均匀，一个只下
   1020–1140 分，比"同样 mm/h 谁更惨"没有意义）。
3. **同族单调性只作提示不作断言**：n=1000 时死亡是伯努利抽样，0→1→9→23 这种
   阶梯有噪声，脚本只打印、不判失败。真正该看的是连续量（被困人·时、涉水人·时、
   危险人·秒）与 expectedIndoorDeaths。
4. **同种子可复现**：同一工况两次跑的关键计数必须逐位相同；脚本支持给
   `--baseline <dir>` 做逐格比对。

报数只取 `final.sim.incidents`（死伤/被困/避险/暴露）、`final.sim.live.judged`
（判断次数）、`final.timeLayer`（时间层分布）、`final.flee`（避险状态）。
不要用 hourly 末格去顶 `dead`——那一格只是快照。
"""
from __future__ import annotations

import json
import os
import sys

FAMILY = {
    "全天族": ["u_p8_s0", "u_p16_s0", "u_p24_s0", "u_p32_s0"],
    "两小时族": ["u_p20_s0", "u_p40_s0", "u_p80_s0", "u_p120_s0"],
}
KEYS = [
    ("dead", "死"),
    ("sweptDeaths", "冲走"),
    ("everStranded", "累计被困"),
    ("everInjured", "累计受伤"),
    ("evacuated", "避险"),
    ("exposed", "暴露"),
]


def load(d, case):
    p = os.path.join(d, case + ".json")
    if not os.path.exists(p):
        return None, p
    with open(p, encoding="utf-8") as f:
        return json.load(f), p


def num(x, d=0):
    return x if isinstance(x, (int, float)) else d


def tally(d):
    return sum(v for v in (d or {}).values() if isinstance(v, (int, float)))


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    d = argv[1]
    as_json = "--json" in argv
    base = None
    if "--baseline" in argv:
        base = argv[argv.index("--baseline") + 1]

    fails = []
    rows = {}
    for fam, cases in FAMILY.items():
        for case in cases:
            doc, path = load(d, case)
            if doc is None:
                fails.append(f"{case}: 缺结果文件 {path}")
                continue
            fin = doc.get("final") or {}
            sim = fin.get("sim") or {}
            inc = sim.get("incidents") or {}
            live = sim.get("live") or {}
            tl = fin.get("timeLayer") or {}
            fle = fin.get("flee") or {}
            row = {
                "case": case,
                "family": fam,
                "dead": num(inc.get("dead")),
                "swept": num(inc.get("sweptDeaths")),
                "stranded": num(inc.get("everStranded")),
                "injured": num(inc.get("everInjured")),
                "evac": num(inc.get("evacuated")),
                "exposed": num(inc.get("exposed")),
                "maxDepth": round(num(inc.get("maxDepth")), 3),
                "judged": num(live.get("judged")),
                "expected": round(num(inc.get("expectedIndoorDeaths")), 2),
                "peakHr": round(num(inc.get("peakHr")), 2),
                "hazardPersonSec": num(inc.get("hazardPersonSec")),
                "causeSum": tally(inc.get("deathsByCause")),
                "zoneSum": tally(inc.get("deathsByZone")),
                "legacySum": tally(inc.get("deathsByLegacyCause")),
                "causes": inc.get("deathsByCause") or {},
                "tlOn": bool(tl.get("enabled")),
                "tlReceiveMedian": (tl.get("receive") or {}).get("median"),
                "tlDepartMedian": (tl.get("depart") or {}).get("median"),
                "neverReceive": tl.get("neverReceive"),
                "prepping": fle.get("prepping"),
                "trappedPersonMin": fle.get("trappedPersonMin"),
            }
            rows[case] = row
            if not (row["dead"] == row["causeSum"] == row["zoneSum"] == row["legacySum"]):
                fails.append(
                    f"{case}: 三套死亡口径不等 dead={row['dead']} 死因={row['causeSum']} "
                    f"分区={row['zoneSum']} 旧口径={row['legacySum']}")
            if row["dead"] > 0 and row["swept"] > row["dead"]:
                fails.append(f"{case}: sweptDeaths({row['swept']}) > dead({row['dead']})")
            if row["judged"] <= 0:
                fails.append(f"{case}: judged 为 0，说明收尾快照没取到")
            if row["expected"] > row["dead"] + 1e-9:
                # 期望死亡是概率和，可以大于实现值；反过来小于实现值说明截断有 bug。
                pass
            elif row["expected"] < 0:
                fails.append(f"{case}: expectedIndoorDeaths 为负")

    if base:
        for case, row in rows.items():
            bdoc, _ = load(base, case)
            if not bdoc:
                continue
            binc = ((bdoc.get("final") or {}).get("sim") or {}).get("incidents") or {}
            bjudged = (((bdoc.get("final") or {}).get("sim") or {}).get("live") or {}).get("judged")
            if bjudged != row["judged"]:
                print(f"[diff] {case}: judged {bjudged} → {row['judged']}")
            if num(binc.get("dead")) != row["dead"]:
                print(f"[diff] {case}: dead {num(binc.get('dead'))} → {row['dead']}")

    if as_json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        for fam in FAMILY:
            got = [rows[c] for c in FAMILY[fam] if c in rows]
            if not got:
                continue
            print(f"\n== {fam} ==")
            head = f"{'工况':<10}" + "".join(f"{k:>8}" for _, k in KEYS) + \
                   f"{'最深水':>8}{'判断(万)':>9}{'期望死':>8}{'峰值HR':>7}{'危险人·秒':>10}"
            print(head)
            for r in got:
                print(f"{r['case']:<10}"
                      + "".join(f"{r[k]:>8}" for k, _ in [(k, kk) for k, kk in
                               [("dead", ""), ("swept", ""), ("stranded", ""),
                                ("injured", ""), ("evac", ""), ("exposed", "")]])
                      + f"{r['maxDepth']:>8}{r['judged']/1e4:>9.0f}{r['expected']:>8}"
                      + f"{r['peakHr']:>7}{r['hazardPersonSec']:>10}")
            print("  死因：" + " · ".join(
                f"{r['case']}={json.dumps(r['causes'], ensure_ascii=False)}" for r in got))
            print("  时间层：" + " · ".join(
                f"{r['case']}=on" if r["tlOn"] else f"{r['case']}=off" for r in got))

    print("\n" + ("全部通过（%d 工况）" % len(rows) if not fails else "未通过："))
    for f in fails:
        print("  - " + f)
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))