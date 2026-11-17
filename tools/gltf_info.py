"""gltf_info.py — 纯 Python 读 glTF / GLB 的技术参数（不依赖 Blender、不依赖任何第三方库）。

用法：
    python tools/gltf_info.py <文件或目录> [...]

输出每个文件的：三角面数、顶点数、网格数、骨骼数、动画段数与名字、材质数、贴图数、包围盒。
GLB 直接读第 0 个 chunk 的 JSON；.gltf 直接当 JSON 读；纹理路径不解析（只数数量）。
"""
import json
import os
import struct
import sys


def load_json(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".glb":
        with open(path, "rb") as f:
            magic, ver, total = struct.unpack("<III", f.read(12))
            if magic != 0x46546C67:
                raise ValueError("not a glb")
            ln, typ = struct.unpack("<II", f.read(8))
            if typ != 0x4E4F534A:
                raise ValueError("first chunk is not JSON")
            return json.loads(f.read(ln).decode("utf-8"))
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def info(path):
    g = load_json(path)
    acc = g.get("accessors") or []
    tris = verts = prim_n = 0
    for m in g.get("meshes") or []:
        for p in m.get("primitives") or []:
            prim_n += 1
            if "indices" in p and p["indices"] < len(acc):
                tris += acc[p["indices"]].get("count", 0) // 3
            elif "POSITION" in (p.get("attributes") or {}):
                tris += acc[p["attributes"]["POSITION"]].get("count", 0) // 3
            if "POSITION" in (p.get("attributes") or {}):
                verts += acc[p["attributes"]["POSITION"]].get("count", 0)
    skins = g.get("skins") or []
    bones = max([len(s.get("joints") or []) for s in skins], default=0)
    anims = g.get("animations") or []
    # 包围盒：取所有 POSITION accessor 的 min/max 并集
    lo = [1e9, 1e9, 1e9]
    hi = [-1e9, -1e9, -1e9]
    for m in g.get("meshes") or []:
        for p in m.get("primitives") or []:
            i = (p.get("attributes") or {}).get("POSITION")
            if i is None or i >= len(acc):
                continue
            a = acc[i]
            if "min" in a and "max" in a:
                for k in range(3):
                    lo[k] = min(lo[k], a["min"][k])
                    hi[k] = max(hi[k], a["max"][k])
    size = [round(hi[k] - lo[k], 2) for k in range(3)] if hi[0] > lo[0] else [0, 0, 0]
    return {
        "file": os.path.basename(path),
        "kb": round(os.path.getsize(path) / 1024),
        "tris": tris, "verts": verts, "prims": prim_n,
        "nodes": len(g.get("nodes") or []),
        "bones": bones, "skins": len(skins),
        "n_anim": len(anims),
        "anims": [a.get("name", "?") for a in anims][:30],
        "mats": len(g.get("materials") or []),
        "tex": len(g.get("textures") or []),
        "size_m": size,
    }


def targets(arg):
    if os.path.isdir(arg):
        out = []
        for r, _, fs in os.walk(arg):
            for f in fs:
                if f.lower().endswith((".gltf", ".glb")):
                    out.append(os.path.join(r, f))
        return sorted(out)
    return [arg]


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return
    rows = []
    for a in args:
        for p in targets(a):
            try:
                rows.append(info(p))
            except Exception as e:
                rows.append({"file": os.path.basename(p), "error": repr(e)[:120]})
    for r in rows:
        if "error" in r:
            print(f"{r['file']:34s} ERR {r['error']}")
            continue
        head = (f"{r['file']:34s} {r['kb']:7d}KB  tri={r['tris']:7d} vert={r['verts']:7d} "
                f"prim={r['prims']:3d} bones={r['bones']:3d} anim={r['n_anim']:2d} "
                f"mat={r['mats']:2d} tex={r['tex']:2d} size={r['size_m']}")
        print(head)
        if r["anims"]:
            print(f"{'':34s}   动画: {', '.join(r['anims'][:12])}")


if __name__ == "__main__":
    main()
