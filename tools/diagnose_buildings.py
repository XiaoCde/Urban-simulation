# -*- coding: utf-8 -*-
"""诊断 OSM 建筑的属性完整度 —— 用来解释"为什么渲染出来不像真实城市"。

用法:
    python diagnose_buildings.py <xxx.osm>

输出:
    * 建筑总数（way 形态 / relation 形态）
    * 有 height / building:levels 的比例、两者都没有的比例
    * 真实高度分布（分位数）
    * roof:shape / roof:height 覆盖
    * building=* 类型分布 Top 15

原理: blosm 生成建筑高度时，优先用 height，其次 building:levels；
      两者都没有时，退回"Default number of levels"权重表（默认 4/5/6 层 × 3.0 m），
      → 也就是**随机高度**。所以"没有高度的建筑占比"直接决定模型像不像。
"""
import collections
import sys
import xml.etree.ElementTree as ET


def tags_of(el):
    return {t.get("k"): t.get("v") for t in el.findall("tag")}


def pct(n, total):
    return "%.1f%%" % (n / total * 100) if total else "-"


def dist(vals, label):
    if not vals:
        print("  %s: 无" % label)
        return
    s = sorted(vals)

    def q(p):
        return s[min(len(s) - 1, int(len(s) * p))]
    print("  %s: n=%d  最小=%.1f  25%%=%.1f  中位=%.1f  75%%=%.1f  最大=%.1f"
          % (label, len(s), s[0], q(.25), q(.5), q(.75), s[-1]))
    for th in (10, 20, 30, 50, 100):
        n = sum(1 for v in s if v > th)
        print("      > %3d m: %6d (%.1f%%)" % (th, n, n / len(s) * 100))


def main():
    path = sys.argv[1]
    cnt = collections.Counter()
    types = collections.Counter()
    hs, ls = [], []

    for _ev, el in ET.iterparse(path, events=("end",)):
        if el.tag == "node":
            el.clear()
            continue
        if el.tag not in ("way", "relation"):
            continue
        tg = tags_of(el)
        if "building" in tg:
            cnt["rel" if el.tag == "relation" else "way"] += 1
            types[tg.get("building")] += 1
            h = tg.get("height") or tg.get("building:height")
            lv = tg.get("building:levels") or tg.get("levels")
            if h:
                cnt["has_height"] += 1
                try:
                    hs.append(float(str(h).split()[0]))
                except ValueError:
                    cnt["height_unparsable"] += 1
            if lv:
                cnt["has_levels"] += 1
                try:
                    ls.append(float(str(lv).split()[0]))
                except ValueError:
                    pass
            if h and lv:
                cnt["both"] += 1
            if not h and not lv:
                cnt["neither"] += 1
            if tg.get("roof:shape"):
                cnt["roof_shape"] += 1
            if tg.get("roof:height"):
                cnt["roof_height"] += 1
            if tg.get("name"):
                cnt["named"] += 1
            for k in ("dcgis:height", "height:roof", "est_height", "building:height:levels"):
                if k in tg:
                    cnt["tag_" + k] += 1
        el.clear()

    total = cnt["way"] + cnt["rel"]
    print("=" * 78)
    print("文件:", path)
    print("=" * 78)
    print("建筑总数: %d  （way 形态 %d + relation 形态 %d）" % (total, cnt["way"], cnt["rel"]))
    print()
    print("--- 高度信息来源 ---")
    print("  有 height          : %6d  %s" % (cnt["has_height"], pct(cnt["has_height"], total)))
    print("  有 building:levels : %6d  %s" % (cnt["has_levels"], pct(cnt["has_levels"], total)))
    print("  两者都有           : %6d  %s" % (cnt["both"], pct(cnt["both"], total)))
    print("  ★ 两者都没有       : %6d  %s   ← 这些只能用随机层数" % (cnt["neither"], pct(cnt["neither"], total)))
    print("  height 无法解析    : %6d" % cnt["height_unparsable"])
    if cnt["height_unparsable"]:
        print("     （含单位如 '12 m' / 英尺等写法）")
    print()
    print("--- 其他属性 ---")
    print("  有 roof:shape : %6d  %s   ← 没有就全是平顶" % (cnt["roof_shape"], pct(cnt["roof_shape"], total)))
    print("  有 roof:height: %6d  %s" % (cnt["roof_height"], pct(cnt["roof_height"], total)))
    print("  有 name       : %6d  %s" % (cnt["named"], pct(cnt["named"], total)))
    for k in ("tag_dcgis:height", "tag_height:roof", "tag_est_height", "tag_building:height:levels"):
        if cnt[k]:
            print("  有 %s : %d" % (k[4:], cnt[k]))
    print()
    print("--- 高度分布（米）---")
    dist(hs, "height")
    dist([v * 3.0 for v in ls], "building:levels × 3.0 m（推算）")
    print()
    print("--- building=* 类型 Top 15 ---")
    for k, v in types.most_common(15):
        print("  %-22s %6d" % (k or "(空)", v))


main()
