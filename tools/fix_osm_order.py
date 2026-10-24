# -*- coding: utf-8 -*-
"""把 Overpass 导出的 .osm 元素顺序修好：<node> 必须排在 <way>/<relation> 之前。

背景（本项目实测确认的根因，详见 城市仿真基座-第一步操作流程.md 的 0.7 节）：
    Overpass 的 `out body; >; out skel qt;` 会先输出 <way> 再输出 <node>。
    blosm 在这种顺序下会静默丢弃所有 way 形式的建筑，只留下 relation，
    表现为"导入后只有一坨盖住整块地的平板"，且不报任何错误。

用法:
    python fix_osm_order.py <输入.osm> [输出.osm]
    省略输出路径时，默认写成 <输入名>.ordered.osm
"""
import os
import sys
import xml.etree.ElementTree as ET


def is_ordered(root):
    """检查是否已经 node 在前。"""
    first_node = first_way = None
    for i, e in enumerate(root):
        if e.tag == "node" and first_node is None:
            first_node = i
        elif e.tag == "way" and first_way is None:
            first_way = i
    if first_node is None:
        return True
    if first_way is None:
        return True
    return first_node < first_way


def fix(src, dst=None):
    if dst is None:
        base, ext = os.path.splitext(src)
        dst = base + ".ordered" + (ext or ".osm")

    tree = ET.parse(src)
    root = tree.getroot()

    counts = {}
    for e in root:
        counts[e.tag] = counts.get(e.tag, 0) + 1
    already_ok = is_ordered(root)

    buckets = {}
    for e in list(root):
        root.remove(e)
        buckets.setdefault(e.tag, []).append(e)

    # 顺序：note/meta（注释） → node → way → relation → 其它
    for tag in ("note", "meta"):
        for e in buckets.pop(tag, []):
            root.append(e)
    for tag in ("node", "way", "relation"):
        for e in buckets.pop(tag, []):
            root.append(e)
    for items in buckets.values():
        for e in items:
            root.append(e)

    tree.write(dst, encoding="utf-8", xml_declaration=True)

    print("输入 : %s" % src)
    print("输出 : %s" % dst)
    print("统计 : node=%d way=%d relation=%d"
          % (counts.get("node", 0), counts.get("way", 0), counts.get("relation", 0)))
    print("顺序 : %s" % ("本来就是 node 在前，内容未变" if already_ok else "way 在 node 之前 —— 已修正"))
    print("大小 : %d -> %d 字节" % (os.path.getsize(src), os.path.getsize(dst)))
    return dst


def fix_dir(folder):
    """批量修一个目录下所有 .osm（跳过已经修好的和临时文件）。"""
    done = []
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".osm") or name.startswith("_") or name.endswith(".ordered.osm"):
            continue
        src = os.path.join(folder, name)
        if is_ordered(ET.parse(src).getroot()):
            print("[跳过] %s 已经 node 在前" % name)
            continue
        done.append(fix(src))
    return done


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    fix(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
