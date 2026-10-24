# -*- coding: utf-8 -*-
"""从超大 .osm / .osm.gz 里流式抽出一个小范围（省内存）。

为什么不能用 clip_osm.py: 那个脚本用 ElementTree 一次性载入整个文件。
整城文件解压后可能上 GB（华盛顿整城约 1.3 GB、上千万节点），
一次性载入会直接把内存吃光。本脚本**流式扫描**：
  遇到 node，只留下落在 bbox 里的（其余当场丢弃，不进内存）
  遇到 way，只有它的节点全在 bbox 里才保留
所以内存占用只和"目标范围大小"有关，和源文件多大无关。

用法:
    python extract_bbox.py <输入.osm|.osm.gz> <输出.osm> <south> <west> <north> <east>
    python extract_bbox.py <输入> --scan              # 只统计，不输出
"""
import gzip
import os
import sys
import time
import xml.etree.ElementTree as ET


def _open(src):
    if src.lower().endswith(".gz"):
        return gzip.open(src, "rb")
    return open(src, "rb")


def extract(src, dst=None, bbox=None, scan_only=False, progress=True):
    """bbox = (south, west, north, east)。返回统计字典。"""
    s, w, n, e = bbox if bbox else (-90, -180, 90, 180)
    nodes = {}          # 只装 bbox 内的节点
    ways = []
    rels = []
    seen_ids = set()    # 只装 bbox 内 way 的节点 id，用于最后挑 relation

    t0 = time.time()
    n_all_node = n_all_way = n_all_rel = 0
    min_lat = min_lon = 90.0
    max_lat = max_lon = -90.0
    all_min_lat = all_min_lon = 90.0
    all_max_lat = all_max_lon = -90.0
    src_bounds = None

    fh = _open(src)
    ctx = ET.iterparse(fh, events=("end",))
    for i, (_, el) in enumerate(ctx):
        tag = el.tag
        if tag == "node":
            n_all_node += 1
            la, lo = el.get("lat"), el.get("lon")
            if la and lo:
                la_f, lo_f = float(la), float(lo)
                if la_f < all_min_lat: all_min_lat = la_f
                if la_f > all_max_lat: all_max_lat = la_f
                if lo_f < all_min_lon: all_min_lon = lo_f
                if lo_f > all_max_lon: all_max_lon = lo_f
                if s <= la_f <= n and w <= lo_f <= e:
                    nodes[el.get("id")] = (la, lo, el.attrib)
            el.clear()
        elif tag == "way":
            n_all_way += 1
            refs = [c.get("ref") for c in el if c.tag == "nd"]
            if refs and all(r in nodes for r in refs):
                ways.append(el)          # 注意：这里故意不 clear，后面要写出去
                seen_ids.update(refs)
            else:
                el.clear()
        elif tag == "relation":
            n_all_rel += 1
            rels.append(el)
        elif tag == "bounds":
            src_bounds = el.attrib
            el.clear()
        # 注意：<nd> / <tag> / <member> 这些子元素**绝不能在这里 clear**！
        # iterparse 的 end 事件对每个元素都触发，若在子元素上 clear，
        # 父 <way> 的 end 事件到来时它的 <nd> 已经被清空 → 所有 way 都被当成空 way 丢掉。
        if progress and i % 2000000 == 0 and i:
            print("  ...已扫 %d 个元素（%.0f s）" % (i, time.time() - t0))

    # relation 只保留成员 way 全在的
    keep_rels = []
    for r in rels:
        mrefs = [c.get("ref") for c in r if c.tag == "member" and c.get("type") == "way"]
        if mrefs and all(any(x.get("id") == ref for x in ways) for ref in mrefs):
            keep_rels.append(r)

    # 节点按源文件顺序输出：iterparse 顺序天然就是源顺序，但 dict 无序，
    # 这里按 way 引用顺序重排（blosm 只要求 node 在 way 之前，不要求原始顺序）
    order = []
    seen = set()
    for way in ways:
        for c in way:
            if c.tag == "nd":
                r = c.get("ref")
                if r not in seen:
                    seen.add(r)
                    order.append(r)
    kept_nodes = [nodes[i] for i in order if i in nodes]

    stats = dict(all_node=n_all_node, all_way=n_all_way, all_rel=n_all_rel,
                 node=len(kept_nodes), way=len(ways), rel=len(keep_rels),
                 src_bounds=src_bounds,
                 all_extent=(all_min_lat, all_min_lon, all_max_lat, all_max_lon),
                 seconds=time.time() - t0)

    if scan_only or dst is None:
        print("扫描完成（未输出）")
        print("  全文件: node=%d way=%d relation=%d  用时 %.0f s"
              % (n_all_node, n_all_way, n_all_rel, time.time() - t0))
        print("  全文件范围: 南%.5f 西%.5f 北%.5f 东%.5f" % (all_min_lat, all_min_lon, all_max_lat, all_max_lon))
        if src_bounds:
            print("  文件自带 <bounds>: %s" % src_bounds)
        return stats

    if not ways:
        print("!! bbox 内没有任何 way，检查范围是否写错")
        return stats

    lats = [float(v[0]) for v in kept_nodes]
    lons = [float(v[1]) for v in kept_nodes]
    out_bounds = (min(lats), min(lons), max(lats), max(lons))

    root = ET.Element("osm", {"version": "0.6", "generator": "extract_bbox.py"})
    ET.SubElement(root, "bounds", {
        "minlat": "%.7f" % out_bounds[0], "minlon": "%.7f" % out_bounds[1],
        "maxlat": "%.7f" % out_bounds[2], "maxlon": "%.7f" % out_bounds[3]})
    for v in kept_nodes:
        ET.SubElement(root, "node", dict(v[2]))
    for way in ways:
        we = ET.SubElement(root, "way", {"id": way.get("id")})
        for c in way:
            if c.tag == "nd":
                ET.SubElement(we, "nd", {"ref": c.get("ref")})
            elif c.tag == "tag":
                ET.SubElement(we, "tag", {"k": c.get("k"), "v": c.get("v")})
    for r in keep_rels:
        re_ = ET.SubElement(root, "relation", {"id": r.get("id")})
        for c in r:
            if c.tag == "member":
                ET.SubElement(re_, "member", {"type": c.get("type"),
                                              "ref": c.get("ref"),
                                              "role": c.get("role", "")})
            elif c.tag == "tag":
                ET.SubElement(re_, "tag", {"k": c.get("k"), "v": c.get("v")})
    ET.ElementTree(root).write(dst, encoding="utf-8", xml_declaration=True)
    with open(dst, "a", encoding="utf-8") as f:
        f.write("\n")

    size = os.path.getsize(dst)
    print("输出: %s" % dst)
    print("  范围: 南%.5f 西%.5f 北%.5f 东%.5f" % out_bounds)
    print("  尺寸: 南北 %.0f m  x  东西 %.0f m"
          % ((out_bounds[2] - out_bounds[0]) * 111000,
             (out_bounds[3] - out_bounds[1]) * 111000 * 0.778))
    print("  内容: node=%d way=%d relation=%d  %d 字节（%.1f MB）"
          % (len(kept_nodes), len(ways), len(keep_rels), size, size / 1048576))
    # 自检
    tags = [x.tag for x in ET.parse(dst).getroot()]
    ok = ("node" not in tags) or (tags.index("node") < (tags.index("way") if "way" in tags else len(tags)))
    print("  顺序自检:", "OK" if ok else "!! node 不在 way 之前 !!")
    print("  全文件: node=%d way=%d relation=%d  扫描用时 %.0f s" % (n_all_node, n_all_way, n_all_rel, time.time() - t0))
    stats["out_size"] = size
    stats["out_bounds"] = out_bounds
    return stats


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    src = sys.argv[1]
    if sys.argv[2] == "--scan":
        extract(src, None, None, scan_only=True)
    else:
        dst = sys.argv[2]
        bbox = tuple(float(x) for x in sys.argv[3:7])
        extract(src, dst, bbox)
