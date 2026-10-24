# -*- coding: utf-8 -*-
"""一次扫描，查两件事：
  1) 华盛顿的 .osm 里到底有没有"真高度"可用（dcgis:height 等州政府标签）
  2) 纽约小块里的 height 覆盖情况
用法: python scan_heights.py <a.osm> [b.osm ...]
"""
import collections
import sys
import xml.etree.ElementTree as ET

# 官方 OSM 高度标签 + 各城市自己导入的本地标签
HEIGHT_TAGS = ["height", "building:height", "dcgis:height", "height:roof",
               "est_height", "building:levels", "levels", "roof:height",
               "roof:levels", "seamark:building:height", "building:max_level",
               "nycdoitt:bin", "dcgis:bin", "addr:housenumber"]
# 任何看起来像高度的键
FUNNY = ("height", "elevation", "altitude", "height_ft", "ft", "est_")


def tags_of(el):
    return {t.get("k"): t.get("v") for t in el.findall("tag")}


def main():
    for path in sys.argv[1:]:
        cnt = collections.Counter()
        for _ev, el in ET.iterparse(path, events=("end",)):
            if el.tag == "node":
                el.clear()
                continue
            if el.tag not in ("way", "relation"):
                continue
            tg = tags_of(el)
            if "building" in tg:
                cnt["total"] += 1
                for k in HEIGHT_TAGS:
                    if k in tg:
                        cnt[k] += 1
                for k in tg:
                    if any(s in k.lower() for s in FUNNY) and k not in HEIGHT_TAGS:
                        cnt["EXOTIC:" + k] += 1
            el.clear()
        t = cnt["total"]
        print("=" * 78)
        print("%s   建筑 %d" % (path, t))
        print("=" * 78)
        for k in HEIGHT_TAGS:
            if cnt[k]:
                print("   %-24s %7d  %5.1f%%" % (k, cnt[k], cnt[k] / t * 100))
        ex = [k for k in cnt if k.startswith("EXOTIC:")]
        if ex:
            print("   --- 其他像高度的标签 ---")
            for k in sorted(ex):
                print("   %-24s %7d  %5.1f%%" % (k[7:], cnt[k], cnt[k] / t * 100))
        print()


main()
