# -*- coding: utf-8 -*-
r"""从只读基底 out\dc_real3_clean.blend 导出每栋建筑的底面轮廓（世界 XY）、檐高与属性。

为什么这样做：
    数据契约 §5.4 要求 buildings.geojson 的 id / height_m / footprint 与基底模型一致；
    下垫面栅格（landcover 的 class 1 与 building_mask）也必须按**基底模型本身**的轮廓
    栅格化，而不是按另一套 DCGIS 数据 —— 否则仿真用的掩膜和场景里的楼对不上。

输出：data\derived\buildings_footprints.json
    {"crs": "...", "count": N,
     "features": [{"id","name","building","height_m","min_z","footprint_area_m2",
                   "rings": [[[x,y],...], ...]}]}
只读 blend，不保存。
"""
import bpy, json, os
from mathutils import Vector

SRC = r"D:/Users/asus/Desktop/项目/out/dc_real3_clean.blend"
OUT = r"D:/Users/asus/Desktop/项目/data/derived/buildings_footprints.json"

bpy.ops.wm.open_mainfile(filepath=SRC)
objs = [o for o in bpy.data.objects if o.type == "MESH"]

feats = []
skipped = 0
for o in objs:
    me = o.data
    if me is None or len(me.polygons) == 0 or len(me.vertices) == 0:
        skipped += 1
        continue
    mw = o.matrix_world
    ws = [mw @ v.co for v in me.vertices]
    zmin = min(v.z for v in ws)
    zmax = max(v.z for v in ws)
    rings = []
    faces = 0
    for p in me.polygons:
        vs = [ws[i] for i in p.vertices]
        # 底面：所有顶点都在最低处（2 cm 容差）且法线朝下
        if max(v.z for v in vs) - zmin > 0.02:
            continue
        if p.normal.z > -0.2:
            continue
        ring = [[round(v.x, 3), round(v.y, 3)] for v in vs]
        if len(ring) >= 3:
            rings.append(ring)
            faces += 1
    if not rings:
        # 兜底：把所有顶点投影成凸包近似（极少见）
        pts = sorted(set((round(v.x, 2), round(v.y, 2)) for v in ws))
        if len(pts) >= 3:
            xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
            rings = [[[min(xs), min(ys)], [max(xs), min(ys)],
                      [max(xs), max(ys)], [min(xs), max(ys)]]]
        else:
            skipped += 1
            continue

    # 面积（鞋带公式，所有环相加）
    area = 0.0
    for r in rings:
        s = 0.0
        for i in range(len(r)):
            x1, y1 = r[i]; x2, y2 = r[(i + 1) % len(r)]
            s += x1 * y2 - x2 * y1
        area += abs(s) * 0.5

    rec = {
        "id": str(o.get("id") or o.name),
        "name": o.get("name") or "",
        "building": str(o.get("building") or ""),
        "height_m": round(zmax - zmin, 3),
        "min_z": round(zmin, 3),
        "footprint_area_m2": round(area, 2),
        "rings": rings,
    }
    feats.append(rec)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
blob = {
    "crs": "local metric, blosm transverse mercator, origin lat 38.89038015 lon -77.04975645, +X east +Y north, meters",
    "count": len(feats),
    "features": feats,
}
with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(blob, fh, ensure_ascii=False, separators=(",", ":"))

print("[bld] 导出 %d 栋，跳过 %d 栋，文件 %.1f MB"
      % (len(feats), skipped, os.path.getsize(OUT) / 1048576.0))
print("[bld] 高度 min %.2f max %.2f 中位 %.2f"
      % (min(f["height_m"] for f in feats),
         max(f["height_m"] for f in feats),
         sorted(f["height_m"] for f in feats)[len(feats)//2]))
print("[bld] 总建筑占地 %.3f km2" % (sum(f["footprint_area_m2"] for f in feats)/1e6))
print("[bld] building 标签 top: %s"
      % sorted(((f["building"], 1) for f in feats))[:0])
from collections import Counter
print("[bld] building 值 top: %s" % Counter(f["building"] for f in feats).most_common(12))
