#!/usr/bin/env python3
"""从 ACS 2020-2024 5-Year PUMS 华盛顿特区原始表生成人群分布。

输入是 from muse/ 里的官方原件，不做任何抽样或补全：
  csv_pdc (2)/psam_p11.csv   人表
  csv_hdc/psam_h11.csv       户表
输出 data/real/acs_dc.json，每项写明来源与性质。

运行：python tools/data/import_acs.py
"""
import collections
import csv
import datetime
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PERSON = ROOT / "from muse" / "csv_pdc (2)" / "psam_p11.csv"
HOUSING = ROOT / "from muse" / "csv_hdc" / "psam_h11.csv"
OUT = ROOT / "data" / "real" / "acs_dc.json"

EXPECTED_PERSON_WEIGHT = 681294.0
EXPECTED_HOUSING_WEIGHT = 361014.0

# 2018 Standard Occupational Classification 两位数大类。
# PUMS 字典注明 OCCP / SOCP 基于 2018 OCC / SOC 码，这里只做大类归并，不改动码值。
SOC_MAJOR = {
    "11": "管理", "13": "商业与金融", "15": "计算机与数学", "17": "建筑与工程",
    "19": "生命、物理与社会科学", "21": "社区与社会服务", "23": "法律",
    "25": "教育与图书馆", "27": "艺术、娱乐与媒体", "29": "医疗执业与技术人员",
    "31": "医疗辅助", "33": "安保服务", "35": "餐饮制备与服务",
    "37": "建筑清洁与场地维护", "39": "个人护理与服务", "41": "销售",
    "43": "办公室与行政支持", "45": "农林渔", "47": "施工与开采",
    "49": "安装、维护与修理", "51": "生产", "53": "运输与物料搬运",
    "55": "军职",
}

JWTRNS_LABEL = {
    "bb": "不适用／未工作", "01": "小汽车、卡车或厢式车", "02": "公交",
    "03": "地铁或高架铁路", "04": "通勤铁路", "05": "渡轮",
    "06": "出租车", "07": "摩托车或自行车", "08": "步行",
    "09": "在家工作", "10": "其他", "11": "轻轨／有轨电车",
    "12": "长途巴士",
}


def age_band(age):
    """标准 5 岁年龄带，85 岁以上合并。不是旧代码里那 9 档自设年龄带。"""
    if age < 0:
        return "NA"
    if age >= 85:
        return "85+"
    return f"{age // 5 * 5:02d}-{age // 5 * 5 + 4:02d}"


def soc_major(socp, occp):
    """取 SOC 前两位；无效时用 OCCP 前两位兜底并标记为未细分。"""
    for raw in (socp, occp):
        s = (raw or "").strip()
        if s and s.lower() != "bb" and s.isdigit():
            code = s[:2].zfill(2)
            if code in SOC_MAJOR:
                return code
    return "NA"


def sha12(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:12]


def require_fields(reader, needed, label):
    fields = set(reader.fieldnames or [])
    missing = [n for n in needed if n not in fields]
    if missing:
        raise SystemExit(f"{label} 缺字段 {missing}；实际前 20 列 {list(reader.fieldnames)[:20]}")


def main():
    for p in (PERSON, HOUSING):
        if not p.exists():
            raise SystemExit(f"找不到原件：{p}")

    # ---- 户表：按 SERIALNO 建索引 ----
    housing = {}
    housing_weight_sum = 0.0
    veh_dist = collections.defaultdict(float)
    np_dist = collections.defaultdict(float)
    state_h = collections.Counter()
    with open(HOUSING, encoding="utf-8-sig", newline="") as f:
        r = csv.DictReader(f)
        require_fields(r, ["SERIALNO", "STATE", "WGTP", "VEH", "NP"], "户表")
        for row in r:
            serial = row["SERIALNO"].strip()
            w = float(row["WGTP"] or 0)
            housing_weight_sum += w
            state_h[row["STATE"].strip()] += 1
            housing[serial] = {
                "veh": row["VEH"].strip() or "NA",
                "np": row["NP"].strip() or "NA",
                "wgtp": w,
            }
            veh_dist[row["VEH"].strip() or "NA"] += w
            np_dist[row["NP"].strip() or "NA"] += w

    # ---- 人表：逐人加权 ----
    person_weight_sum = 0.0
    state_p = collections.Counter()
    serial_seen = set()
    serial_missing = set()
    minor_by_household = collections.defaultdict(bool)

    age_dist = collections.defaultdict(float)
    sex_dist = collections.defaultdict(float)
    occ_dist = collections.defaultdict(float)
    occ_raw = collections.defaultdict(float)
    commute_dist = collections.defaultdict(float)
    paoc_dist = collections.defaultdict(float)
    relshipp_dist = collections.defaultdict(float)
    has_minor_dist = collections.defaultdict(float)
    vehicles_person_dist = collections.defaultdict(float)
    joint = collections.defaultdict(float)
    joint_total = 0.0
    # 真实个体微观样本：按 PWGTP 加权抽一行就得到一个真人，
    # 年龄 / 性别 / 职业 / 通勤 / 户内未成年 / 户车数 / 户规模天然联合一致。
    microsample = []

    with open(PERSON, encoding="utf-8-sig", newline="") as f:
        r = csv.DictReader(f)
        require_fields(
            r,
            ["SERIALNO", "STATE", "AGEP", "SEX", "PWGTP", "OCCP", "SOCP",
             "JWTRNS", "PAOC", "RELSHIPP"],
            "人表",
        )
        for row in r:
            serial = row["SERIALNO"].strip()
            w = float(row["PWGTP"] or 0)
            person_weight_sum += w
            state_p[row["STATE"].strip()] += 1
            serial_seen.add(serial)
            h = housing.get(serial)
            if h is None:
                serial_missing.add(serial)
                h = {"veh": "NA", "np": "NA", "wgtp": 0.0}

            try:
                age = int(row["AGEP"] or -1)
            except ValueError:
                age = -1
            band = age_band(age)
            soc = soc_major(row.get("SOCP", ""), row.get("OCCP", ""))
            commute = row["JWTRNS"].strip() or "NA"
            paoc = row["PAOC"].strip() or "NA"
            rel = row["RELSHIPP"].strip() or "NA"

            if 0 <= age < 18:
                minor_by_household[serial] = True

            age_dist[band] += w
            sex_dist[row["SEX"].strip() or "NA"] += w
            soc_label = SOC_MAJOR.get(soc, "未细分／不适用")
            occ_dist[f"{soc}|{soc_label}"] += w
            occ_raw[row["OCCP"].strip() or "NA"] += w
            commute_dist[f"{commute}|{JWTRNS_LABEL.get(commute, '其他或未列码值')}"] += w
            paoc_dist[paoc] += w
            relshipp_dist[rel] += w
            vehicles_person_dist[h["veh"]] += w

            # 户内是否有未成年人，要在第二遍回填，这里先按人存键
            joint[(band, soc, serial, commute)] += w
            # 紧凑数组，省掉每行重复 10 个键名；列顺序写在 microsample.columns 里。
            microsample.append([
                age, band, row["SEX"].strip() or "NA", soc, commute, serial,
                h["veh"], h["np"], rel, w,
            ])

    # ---- 回填户内未成年人标志，生成四维联合分布 ----
    for (band, soc, serial, commute), w in joint.items():
        key = f"{band}|{soc}|{'有未成年' if minor_by_household[serial] else '无未成年'}|{commute}"
        joint_out[key] = joint_out.get(key, 0.0) + w
        joint_total += w
        has_minor_dist["有未成年" if minor_by_household[serial] else "无未成年"] += w
    for row in microsample:
        # 列 5 原是户号，回填后就地换成「户内有无未成年人」，不额外增列。
        row[5] = 1 if minor_by_household[row[5]] else 0

    # ---- 验算 ----
    checks = {
        "人表行数": sum(state_p.values()),
        "人表加权合计": round(person_weight_sum, 3),
        "户表加权合计": round(housing_weight_sum, 3),
        "人表州代码": dict(state_p),
        "户表州代码": dict(state_h),
        "人表能匹配到户表的编号数": len(serial_seen) - len(serial_missing),
        "人表编号总数": len(serial_seen),
        "联合分布加权合计": round(joint_total, 3),
    }
    assert abs(person_weight_sum - EXPECTED_PERSON_WEIGHT) < 1e-6, (
        f"人表加权合计 {person_weight_sum}，预期 {EXPECTED_PERSON_WEIGHT}")
    assert abs(housing_weight_sum - EXPECTED_HOUSING_WEIGHT) < 1e-6, (
        f"户表加权合计 {housing_weight_sum}，预期 {EXPECTED_HOUSING_WEIGHT}")
    assert set(state_p) == {"11"}, f"人表州代码异常：{dict(state_p)}"
    assert set(state_h) == {"11"}, f"户表州代码异常：{dict(state_h)}"
    assert not serial_missing, f"{len(serial_missing)} 个编号在户表里找不到"
    assert abs(joint_total - person_weight_sum) < 1e-6, "联合分布权重与人表不一致"

    def top(d, n=None):
        items = sorted(d.items(), key=lambda kv: -kv[1])
        return {k: round(v, 3) for k, v in (items[:n] if n else items)}

    out = {
        "_meta": {
            "生成日期": datetime.date.today().isoformat(),
            "生成脚本": "tools/data/import_acs.py",
            "地理范围": "District of Columbia（STATE=11）",
            "性质": "真实数据集的加权派生结果（不是官方直接发布的汇总表，也不是模型输出）",
            "权重": "人表用 PWGTP，户表用 WGTP；户级变量按 SERIALNO 关联到人，不按人重复抽车",
            "source": {
                "dataset": "American Community Survey 2020-2024 5-Year Public Use Microdata Sample",
                "publisher": "U.S. Census Bureau",
                "release_date": "2026-03-05",
                "official_directory": "https://www2.census.gov/programs-surveys/acs/data/pums/2024/5-Year/",
                "dictionary": "https://www2.census.gov/programs-surveys/acs/tech_docs/pums/data_dict/PUMS_Data_Dictionary_2020-2024.csv",
                "local_files": [
                    f"from muse/{PERSON.relative_to(ROOT / 'from muse').as_posix()}",
                    f"from muse/{HOUSING.relative_to(ROOT / 'from muse').as_posix()}",
                ],
                "checksums": {"person_csv": sha12(PERSON), "housing_csv": sha12(HOUSING)},
                "per_file_detail": "from muse/数据来源.md 第 1、2 条",
            },
        },
        "validation": checks,
        "distributions": {
            "age_band_5y": {"unit": "加权人数", "note": "标准 5 岁档，替代旧代码自设的 9 档", "values": top(age_dist)},
            "sex": {"unit": "加权人数", "values": top(sex_dist)},
            "occupation_soc_major": {
                "unit": "加权人数",
                "note": "按 2018 SOC 两位数大类归并；NA 表示不适用或未细分，不是缺失值被删掉",
                "values": top(occ_dist),
            },
            "occupation_occp_raw": {"unit": "加权人数", "note": "原始 OCCP 码，只列前 60 个", "values": top(occ_raw, 60)},
            "commute_jwtrns": {"unit": "加权人数", "values": top(commute_dist)},
            "presence_of_own_children_paoc": {"unit": "加权人数", "values": top(paoc_dist)},
            "relationship_relshipp": {"unit": "加权人数", "values": top(relshipp_dist)},
            "household_has_minor": {"unit": "加权人数", "values": top(has_minor_dist)},
            "household_vehicles_veh": {"unit": "加权户数（按 WGTP）", "values": top(veh_dist)},
            "household_size_np": {"unit": "加权户数（按 WGTP）", "values": top(np_dist)},
            "vehicles_shared_to_person": {"unit": "加权人数（户车数关联到人）", "values": top(vehicles_person_dist)},
        },
        "microsample": {
            "unit": "真实个体记录，每行的权重是该人的 PWGTP",
            "note": "按权重抽一行即得到一个真实特区居民；年龄／性别／职业／通勤／户内未成年／户车数／户规模全部来自同一条记录，天然保留联合分布，不是把几个边际比例拼起来。",
            "columns": ["年龄", "五岁带", "性别", "SOC两位数大类", "JWTRNS通勤码",
                        "户内有未成年(1/0)", "户车数", "户规模", "与户主关系码", "PWGTP权重"],
            "row_count": len(microsample),
            "weight_sum": round(sum(r[9] for r in microsample), 3),
            "rows": microsample,
        },
        "joint": {
            "dimensions": ["标准 5 岁年龄带", "SOC 两位数大类", "户内有无未成年人", "JWTRNS 通勤方式"],
            "unit": "加权人数（PWGTP）",
            "total_weight": round(joint_total, 3),
            "cell_count": len(joint_out),
            "note": "稀疏格子很多，直接当概率用会不稳；运行时要按边际抽样并设小格合并阈值。此表用于核对联合结构，不是逐格硬编码概率。",
            "cells": {k: round(v, 3) for k, v in sorted(joint_out.items(), key=lambda kv: -kv[1])},
        },
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"写出 {OUT.relative_to(ROOT)}")
    for k, v in checks.items():
        print(f"  {k}: {v}")
    print(f"  联合分布格子数: {len(joint_out)}")


# 联合分布累加用的临时字典（放在模块层，便于上面循环内直接写）
joint_out = {}

if __name__ == "__main__":
    main()
