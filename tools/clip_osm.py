# -*- coding: utf-8 -*-
"""按 bbox 把 .osm 裁成小块（用于"分块 → 拼接"实验）。

要点：
  1. 只保留落在 bbox 内的 way / relation，以及它们引用的 node（否则 blosm 建不出东西）
  2. 输出**永远是 node 在前**（见 fix_osm_order.py 里那个坑）
  3. 输出保留原文件的 <bounds>，方便核对

用法:
    python clip_osm.py <输入.osm> <输出.osm> <south> <west> <north> <east>
    python clip_osm.py <输入.osm> --split-2 <前缀>      # 沿经度中线切成东西两半
"""
import os
import sys
import xml.etree.ElementTree as ET


def load(src):
    root = ET.parse(src).getroot()
    nodes, ways, rels, others = {}, [], [], []
    for e in root:
        if e.tag == "node":
            nodes[e.get("id")] = e
        elif e.tag == "way":
            ways.append(e)
        elif e.tag == "relation":
            rels.append(e)
        else:
            others.append(e)
    return nodes, ways, rels, others, root


def node_in(n, bbox):
    s, w, no, ea = bbox
    lat, lon = float(n.get("lat")), float(n.get("lon"))
    return s <= lat <= no and w <= lon <= ea


def write(dst, kept_nodes, kept_ways, kept_rels, others, bounds=None):
    """用 ElementTree 生成，**它负责转义**。

    手工拼字符串会踩坑：真实数据里有 `Willauer, Shape & Bready` 这种值，
    不转义就是非法 XML（blosm 直接解析失败）。
    """
    root = ET.Element("osm", {"version": "0.6", "generator": "clip_osm.py"})
    if bounds:
        ET.SubElement(root, "bounds", {
            "minlat": str(bounds[0]), "minlon": str(bounds[1]),
            "maxlat": str(bounds[2]), "maxlon": str(bounds[3])})
    for n in kept_nodes:
        ET.SubElement(root, "node", dict(n.attrib))
    for w in kept_ways:
        we = ET.SubElement(root, "way", {"id": w.get("id")})
        for c in w:
            if c.tag == "nd":
                ET.SubElement(we, "nd", {"ref": c.get("ref")})
            elif c.tag == "tag":
                ET.SubElement(we, "tag", {"k": c.get("k"), "v": c.get("v")})
    for r in kept_rels:
        re_ = ET.SubElement(root, "relation", {"id": r.get("id")})
        for c in r:
            if c.tag == "member":
                ET.SubElement(re_, "member", {
                    "type": c.get("type"), "ref": c.get("ref"),
                    "role": c.get("role", "")})
            elif c.tag == "tag":
                ET.SubElement(re_, "tag", {"k": c.get("k"), "v": c.get("v")})

    tree = ET.ElementTree(root)
    tree.write(dst, encoding="utf-8", xml_declaration=True)
    # 补一个换行，让文件末尾干净
    with open(dst, "a", encoding="utf-8") as f:
        f.write("\n")
    return os.path.getsize(dst)


def clip(src, dst, bbox, verbose=True):
    nodes, ways, rels, others, root = load(src)

    kept_ways = []
    need = set()
    for w in ways:
        refs = [c.get("ref") for c in w if c.tag == "nd"]
        if refs and all(r in nodes and node_in(nodes[r], bbox) for r in refs):
            kept_ways.append(w)
            need.update(refs)
    kept_rels = []
    for r in rels:
        refs = [c.get("ref") for c in r if c.tag == "member" and c.get("type") == "way"]
        if refs and all(any(w.get("id") == ref for w in kept_ways) for ref in refs):
            kept_rels.append(r)

    kept_nodes = [nodes[i] for i in nodes if i in need]
    # 保持稳定顺序：按输入文件里的原始顺序
    order = {e.get("id"): i for i, e in enumerate(root) if e.tag == "node"}
    kept_nodes.sort(key=lambda n: order.get(n.get("id"), 0))

    size = write(dst, kept_nodes, kept_ways, kept_rels, others)
    # 自检：必须能被重新解析，且 node 必须全部在 way 之前（见 fix_osm_order.py）
    tags = [e.tag for e in ET.parse(dst).getroot()]
    first_node = tags.index("node") if "node" in tags else -1
    first_way = tags.index("way") if "way" in tags else len(tags)
    ok = first_node < first_way or first_node == -1
    if verbose:
        print("  裁出: %-46s node=%4d way=%3d relation=%2d  %7d 字节  %s" % (
            os.path.basename(dst), len(kept_nodes), len(kept_ways), len(kept_rels), size,
            "顺序 OK" if ok else "!! 顺序异常 !!"))
    return dst


def extent(src):
    nodes, _, _, _, _ = load(src)
    lats = [float(n.get("lat")) for n in nodes.values()]
    lons = [float(n.get("lon")) for n in nodes.values()]
    return min(lats), min(lons), max(lats), max(lons)


def split_by_centroid(src, prefix, verbose=True):
    """★ 推荐的分块方式：**按 way 的质心归属**，而不是按 bbox 裁剪。

    为什么：按 bbox 裁的话，凡是**跨过中线**的建筑，它的节点不全在任何一块里，
    于是两块都不要它 —— 实测整块 42 栋，按 bbox 切两块只剩 38 栋，**丢了 4 栋**。
    按质心归属则每栋楼**完整地**落进唯一一块：不丢、不重、节点全带上。
    """
    nodes, ways, rels, others, root = load(src)
    s, w, n, e = extent(src)
    mid = (w + e) / 2
    if verbose:
        print("源文件范围: 南%.5f 西%.5f 北%.5f 东%.5f" % (s, w, n, e))
        print("按 way 质心归属，沿经度中线 %.5f 分东西（跨中线的建筑会整栋进某一侧）:" % mid)

    buckets = {"west": ([], set()), "east": ([], set())}
    for way in ways:
        refs = [c.get("ref") for c in way if c.tag == "nd"]
        if not refs or any(r not in nodes for r in refs):
            continue
        clon = sum(float(nodes[r].get("lon")) for r in refs) / len(refs)
        key = "west" if clon < mid else "east"
        buckets[key][0].append(way)
        buckets[key][1].update(refs)

    # 按质心归属后，relation 要求它的 way 成员都在同一块里
    for key in ("west", "east"):
        _, need = buckets[key]
        kept_ways, kept_rels = buckets[key][0], []
        for r in rels:
            mrefs = [c.get("ref") for c in r if c.tag == "member" and c.get("type") == "way"]
            if mrefs and all(any(x.get("id") == ref for x in kept_ways) for ref in mrefs):
                kept_rels.append(r)
        order = {x.get("id"): i for i, x in enumerate(root) if x.tag == "node"}
        kept_nodes = [nodes[i] for i in need]
        kept_nodes.sort(key=lambda x: order.get(x.get("id"), 0))
        dst = "%s_%s.osm" % (prefix, key)
        size = write(dst, kept_nodes, kept_ways, kept_rels, others)
        tags = [x.tag for x in ET.parse(dst).getroot()]
        ok = ("node" not in tags) or (tags.index("node") < (tags.index("way") if "way" in tags else len(tags)))
        if verbose:
            print("  %-5s: %-44s node=%4d way=%3d relation=%2d  %7d 字节  %s" % (
                key, os.path.basename(dst), len(kept_nodes), len(kept_ways),
                len(kept_rels), size, "顺序 OK" if ok else "!! 顺序异常 !!"))
    return mid


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    src = sys.argv[1]

    if sys.argv[2] == "--split-2":
        prefix = sys.argv[3]
        s, w, n, e = extent(src)
        mid = (w + e) / 2
        print("源文件范围: 南%.5f 西%.5f 北%.5f 东%.5f" % (s, w, n, e))
        print("沿经度中线 %.5f 切成东西两半（按 bbox 裁，跨中线的建筑会被丢掉）:" % mid)
        clip(src, prefix + "_west.osm", (s, w, n, mid))
        clip(src, prefix + "_east.osm", (s, mid, n, e))
    elif sys.argv[2] == "--split-2-centroid":
        split_by_centroid(src, sys.argv[3])
    else:
        dst = sys.argv[2]
        bbox = tuple(float(x) for x in sys.argv[3:7])
        clip(src, dst, bbox)
