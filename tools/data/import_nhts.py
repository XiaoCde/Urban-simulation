#!/usr/bin/env python3
"""从 2022 NextGen NHTS V2.1 原始表生成日常出行的加权基线。

输入 from muse/csv/ 下三张官方原表：
  tripv2pub.csv（出行）、perv2pub.csv（人员）、hhv2pub.csv（住户）
输出 data/real/nhts_day.json。

口径与 Muse 实算的 946 行加权交叉表一致，脚本会逐格对拍并打印差异。
注意：这是**全国日常出行**的加权调查口径，不是特区灾害时的行为数据。
运行：python tools/data/import_nhts.py
"""
import collections
import csv
import datetime
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "from muse" / "csv"
CROSSTAB = ROOT / "from muse" / "nhts2022_crosstab_whyto_minor_age_time.csv"
OUT = ROOT / "data" / "real" / "nhts_day.json"

TRIP = SRC / "tripv2pub.csv"
PER = SRC / "perv2pub.csv"
HH = SRC / "hhv2pub.csv"

EXPECTED_WEIGHT_SUM = 253754536507.0
# 回件印刷值：对照交叉表 946 个格子每个都印成整数，累计舍入差约 23。
EXPECTED_CROSSTAB_SUM = 253553097887.0

WHYTO_LABEL = {
    "01": "居家常规活动", "03": "去非居家工作", "04": "工作性接送某人／某物",
    "06": "以学生身份上学", "07": "照护儿童或成人", "10": "私人接送",
    "11": "就医", "13": "购物／取退货", "97": "其他",
    "08": "用餐", "20": "社交／娱乐", "30": "医疗牙科", "40": "购物杂事",
    "50": "社交休闲", "70": "交通接送", "80": "餐饮",
}

MODE_LABEL = {
    "01": "自驾（私人车司机）", "02": "私人车乘客", "03": "公共交通",
    "04": "校车", "05": "步行", "06": "自行车", "07": "其他",
}

AGE_BANDS = [(5, 17), (18, 34), (35, 49), (50, 64), (65, 200)]
TIME_BANDS = [(0, 5), (6, 8), (9, 11), (12, 13), (14, 16), (17, 19), (20, 23)]


def sha12(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:12]


def band_of(value, bands):
    for lo, hi in bands:
        if lo <= value <= hi:
            return f"{lo:02d}-{hi:02d}" if hi < 200 else f"{lo:02d}+"
    return "NA"


def trip_mode(row):
    """TRIPMODE 派生规则：权威出处是 2022 NextGen NHTS V2.1 Release Notes（2025-04）第 1 页与 Codebook V2.1。
    第四轮 QC4 更正：Derived Variables V2.1 第 17 页讲的是 TRIPPURP，不是 TRIPMODE。"""
    t = (row.get("TRPTRANS") or "").strip().zfill(2)
    drv = (row.get("DRVR_FLG") or "").strip().lstrip("0") or "0"
    psg = (row.get("PSGR_FLG") or "").strip().lstrip("0") or "0"
    if t in ("01", "02", "03", "04", "05", "06", "07") and drv == "1":
        return "01"
    if t in ("01", "02", "03", "04", "05", "06", "07") and psg == "1":
        return "02"
    if t in ("08", "10", "11", "12"):
        return "03"
    if t == "09":
        return "04"
    if t == "20":
        return "05"
    if t == "18":
        return "06"
    return "07"


def read_csv(path, needed, label):
    with open(path, encoding="utf-8-sig", newline="") as f:
        r = csv.DictReader(f)
        missing = [n for n in needed if n not in (r.fieldnames or [])]
        if missing:
            raise SystemExit(f"{label} 缺字段 {missing}")
        return list(r)


def main():
    for p in (TRIP, PER, HH, CROSSTAB):
        if not p.exists():
            raise SystemExit(f"找不到原件：{p}")

    # ---- 户内是否有未成年人：人员表 + 住户名册取并集 ----
    minor_households = set()
    for row in read_csv(PER, ["HOUSEID", "R_AGE"], "人员表"):
        try:
            if int(row["R_AGE"] or -1) < 18:
                minor_households.add(row["HOUSEID"].strip())
        except ValueError:
            pass
    for row in read_csv(HH, ["HOUSEID", "PPT517", "YOUNGCHILD"], "住户表"):
        try:
            n517 = int(row["PPT517"] or -1)
            nyoung = int(row["YOUNGCHILD"] or -1)
        except ValueError:
            continue
        if n517 >= 1 or nyoung >= 1:
            minor_households.add(row["HOUSEID"].strip())

    # ---- 出行表逐条加权 ----
    raw_rows = 0
    trip_rows = 0
    weight_sum = 0.0
    excluded_time = 0
    excluded_neg_duration = 0
    weighted_all = 0.0

    purpose = collections.defaultdict(float)
    purpose_minor = collections.defaultdict(float)
    purpose_age = collections.defaultdict(float)
    purpose_time = collections.defaultdict(float)
    mode = collections.defaultdict(float)
    crosstab_cells = collections.defaultdict(float)
    crosstab_sum = 0.0
    duration_weighted = 0.0
    duration_weight_sum = 0.0
    mode_counts = collections.Counter()
    timeband_counts = collections.Counter()

    with open(TRIP, encoding="utf-8-sig", newline="") as f:
        r = csv.DictReader(f)
        for row in r:
            raw_rows += 1
            w = float(row["WTTRDFIN"] or 0)
            weighted_all += w
            whyto = (row["WHYTO"] or "").strip().zfill(2) or "NA"
            start = (row["STRTTIME"] or "").strip()
            try:
                start_i = int(start)
            except ValueError:
                start_i = -9
            if start_i < 0:
                excluded_time += 1
                continue
            weight_sum += w
            trip_rows += 1
            purpose[whyto] += w

            hid = row["HOUSEID"].strip()
            minor = "with_minor_child" if hid in minor_households else "no_minor_child"
            purpose_minor[f"{whyto}|{minor}"] += w

            try:
                age = int(row["R_AGE"] or -1)
            except ValueError:
                age = -1
            age_key = band_of(age, AGE_BANDS)
            purpose_age[f"{whyto}|{age_key}"] += w

            # STRTTIME 是 HHMM，小时取前两位（0000-2359 范围内直接整除 100）。
            hour = start_i // 100
            time_key = band_of(hour, TIME_BANDS)
            purpose_time[f"{whyto}|{time_key}"] += w
            timeband_counts[time_key] += 1

            md = trip_mode(row)
            mode[md] += w
            mode_counts[md] += 1

            try:
                dur = float(row["TRVLCMIN"] or -1)
            except ValueError:
                dur = -1.0
            if dur < 0:
                excluded_neg_duration += 1
            else:
                duration_weighted += w * dur
                duration_weight_sum += w

            cell = f"{whyto}|{minor}|{age_key}|{time_key}"
            crosstab_cells[cell] += w
            crosstab_sum += w


    # ---- 与 Muse 实算的 946 行交叉表逐格对拍 ----
    with open(CROSSTAB, encoding="utf-8-sig", newline="") as f:
        ref = list(csv.DictReader(f))
    ref_sum = 0.0
    ref_cells = {}
    for row in ref:
        key = "|".join([
            (row["WHYTO"] or "").strip().zfill(2),
            row["HOUSEHOLD_MINOR"],
            row["AGE_BAND"],
            row["START_TIME_BAND"],
        ])
        v = float(row["WEIGHTED_TRIPS"] or 0)
        ref_cells[key] = ref_cells.get(key, 0.0) + v
        ref_sum += v

    common = set(crosstab_cells) & set(ref_cells)
    # 对照表每个格子的值印成整数，逐格会有小于 1 的舍入差；
    # 用相对容差，真正的口径不一致（差成千上万）依然会被抓出来。
    diffs = [(k, crosstab_cells[k], ref_cells[k]) for k in common
             if abs(crosstab_cells[k] - ref_cells[k]) > max(1.0, abs(ref_cells[k]) * 1e-9)]
    only_me = set(crosstab_cells) - set(ref_cells)
    only_ref = set(ref_cells) - set(crosstab_cells)
    if diffs:
        print("  对拍差异样本（格子, 我这边, 对照表, 差值）:")
        for k, a, b in diffs[:3]:
            print("   ", k, round(a, 3), round(b, 3), round(a - b, 3))

    checks = {
        "原始出行表行数": raw_rows,
        "有效出行条数（剔除出发时间缺失）": trip_rows,
        "全部出行加权合计": round(weighted_all, 3),
        "剔除出发时间缺失后的加权合计": round(weight_sum, 3),
        "剔除出发时间缺失的条数": excluded_time,
        "时长为负剔除的条数": excluded_neg_duration,
        "交叉表加权合计": round(crosstab_sum, 3),
        "交叉表格子数": len(crosstab_cells),
        "对照交叉表加权合计": round(ref_sum, 3),
        "对照交叉表格子数": len(ref_cells),
        "两表共同格子数": len(common),
        "加权数值不一致的格子数": len(diffs),
        "只在我这边出现的格子数": len(only_me),
        "只在对照表出现的格子数": len(only_ref),
        "出行方式未加权频数": dict(mode_counts),
    }
    # 不输出「每人每天出行条数」：公开 trip 表没有可核对的人日权重，
    # 拿 TRAVDAY 近似会变成自造口径，这里只保留能与官方编码手册对上的加权分布。

    # 回件文档印的是四舍五入到个位的整数，浮点累加尾差小于 1。
    assert abs(weighted_all - EXPECTED_WEIGHT_SUM) < 1.0, (
        f"出行表加权合计 {weighted_all}，预期 {EXPECTED_WEIGHT_SUM}")
    # 对照表每格四舍五入成整数，946 格累计约 23 的舍入差，允许 50 以内；
    # 真正的一致性由下面「逐格 diffs == 0」保证。
    assert abs(crosstab_sum - EXPECTED_CROSSTAB_SUM) < 50.0, (
        f"交叉表加权合计 {crosstab_sum}，回件印刷值 {EXPECTED_CROSSTAB_SUM}")
    assert raw_rows == 31074, f"原始出行表行数 {raw_rows}，预期 31074"
    assert excluded_time == 21, f"出发时间缺失条数 {excluded_time}，预期 21"
    assert sum(mode_counts.values()) == trip_rows, "出行方式条数对不上"
    assert len(diffs) == 0, f"{len(diffs)} 个格子数值与对照交叉表不一致"
    assert not only_me and not only_ref, (
        f"格子集合不一致：我这边多 {len(only_me)} 个，对照多 {len(only_ref)} 个")

    def pack(d):
        return {k: round(v, 3) for k, v in sorted(d.items(), key=lambda kv: -kv[1])}

    out = {
        "_meta": {
            "生成日期": datetime.date.today().isoformat(),
            "生成脚本": "tools/data/import_nhts.py",
            "地理范围": "美国全国公开样本，公开文件没有特区子样本标识",
            "性质": "真实数据集的加权派生结果（不是官方发布的汇总表，也不是模型输出）",
            "用途限制": "只能定日常日程基线；不能用来证明灾害时的决策合理",
            "权重": "WTTRDFIN（三套里唯一对全部 31,074 条出行都非零）；交叉表剔除出发时间缺失 21 条",
            "户内有无未成年人": "人员表任一成员 R_AGE<18，或住户名册 PPT517+YOUNGCHILD>=1，取并集；不直接用 LIF_CYC",
            "出行方式": "公开 CSV 没有 TRIPMODE 列；派生规则见 V2.1 Release Notes（2025-04）第 1 页与 Codebook V2.1（第四轮 QC4 更正：Derived Variables 第 17 页是 TRIPPURP）",
            "source": {
                "dataset": "2022 National Household Travel Survey (NextGen NHTS), Survey Data V2.1",
                "publisher": "Federal Highway Administration, U.S. Department of Transportation",
                "host": "Oak Ridge National Laboratory",
                "survey_period": "2022-01 至 2023-01",
                "codebook": "FHWA / ORNL, 2022 NextGen NHTS Codebook V2.1 (April 2025)",
                "official_download": "https://nhts.ornl.gov/assets/2022/download/csv.zip",
                "derived_variables": "https://nhts.ornl.gov/media/2022/doc/2022%20NextGen%20NHTS%20Derived%20Variables-PubUseV2.1.pdf",
                "local_files": ["from muse/csv/tripv2pub.csv", "from muse/csv/perv2pub.csv",
                                "from muse/csv/hhv2pub.csv"],
                "crosscheck_file": "from muse/nhts2022_crosstab_whyto_minor_age_time.csv",
                "checksums": {p.name: sha12(p) for p in (TRIP, PER, HH, CROSSTAB)},
                "per_file_detail": "from muse/数据来源.md 第 5、7 条",
            },
        },
        "validation": checks,
        "distributions": {
            "purpose_whyto": {"unit": "加权出行量", "note": "按出行目的", "values": pack(purpose)},
            "purpose_by_household_minor": {"unit": "加权出行量", "values": pack(purpose_minor)},
            "purpose_by_age_band": {"unit": "加权出行量", "values": pack(purpose_age)},
            "purpose_by_start_time": {"unit": "加权出行量", "values": pack(purpose_time)},
            "trip_mode": {"unit": "加权出行量", "values": pack(mode), "labels": MODE_LABEL},
            "whyto_labels": WHYTO_LABEL,
            "mean_travel_minutes": {
                "unit": "分钟",
                "value": round(duration_weighted / duration_weight_sum, 4) if duration_weight_sum else None,
                "note": "按 WTTRDFIN 加权，剔除 TRVLCMIN 负值",
            },
        },
        "joint": {
            "dimensions": ["WHYTO 出行目的", "户内有无未成年人", "年龄段", "出发时段"],
            "unit": "加权出行量（WTTRDFIN）",
            "cell_count": len(crosstab_cells),
            "total_weight": round(crosstab_sum, 3),
            "note": "与 Muse 实算的 946 行交叉表逐格一致；小格未加权条数只有 1 到 3 条，不能直接当比例用。",
            "cells": pack(crosstab_cells),
        },
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"写出 {OUT.relative_to(ROOT)}")
    for k, v in checks.items():
        print(f"  {k}: {v}")
    print(f"  与对照交叉表不一致格子数: {len(diffs)}")


if __name__ == "__main__":
    main()
