# -*- coding: utf-8 -*-
r"""给城市基座套上现成的纹理贴图（ambientCG，CC0 公有领域）。

为什么这么做（导师这周的要求）：
    不做实时渲染、不走大模型，直接找现成的纹理贴图贴上去。
    贴图全部来自 ambientCG（CC0，可商用、可再分发），已下到 D:\citysim\textures。

三个关键技术决定：
  1. **用 Box（三平面）投影，不做 UV 展开。**
     scene 里有 22,009 个建筑物体，逐个 UV 展开不现实；Box 投影让每张图直接
     按世界坐标贴在任意几何上，墙面、屋顶同时成立。
  2. **贴图坐标用世界坐标（ShaderNodeNewGeometry 的 Position），不用物体坐标。**
     这样整个城市共用一套连续的砖缝网格，而且砖的水平缝天然对齐地面（z=0）。
  3. **按"建筑高度 + 名字哈希"分配材质，做出多样性。**
     低层 → 红砖/白漆（华盛顿连排屋的实情）；中层 → 石材/灰泥/砖混；
     高层 → 玻璃幕墙。同一个类别里再按哈希挑不同贴图，避免全城一模一样。

用法:
    D:\blender\blender.exe --background --python tools\apply_textures.py -- ^
        out\dc_real3.blend out\dc_real3_tex.blend [mall2]
"""
import json
import math
import os
import sys

import bpy

TEX_ROOT = r"D:\citysim\textures"

# 贴图库：类别 -> (候选材质 ID 列表, 一张贴图覆盖多少米)
#
# tile_m 怎么定的：**不能拍脑袋，要按贴图里画了几个东西反推。** 实测：
#   * Bricks051 一张 1K 图里 14 行砖 -> 一行约 0.22 m -> 一张 ≈ 3.0 m
#   * Facade003 一张 1K 图里 **10x11 个窗格** -> 按真实窗距 3.0 m -> 一张 ≈ 30 m
#     （第一版按 4 m 铺，等于每 0.4 m 一个窗，整面墙糊成噪点 —— 这是最要命的错误）
#   * RoofingTiles / Asphalt / Grass 都是细骨料，2.5~6 m 都成立
LIB = {
    "wall_brick":    (["Bricks051", "Bricks097", "Bricks005", "Bricks042"], 3.0),
    "wall_paint":    (["PaintedPlaster017", "Plaster001", "Plaster007"], 3.0),
    "wall_stone":    (["Granite002A", "Granite001A", "Concrete034"], 3.5),
    "wall_concrete": (["Concrete046", "Concrete012"], 3.5),
    "wall_glass":    (["Facade001", "Facade005"], 30.0),
    # 带窗格的幕墙：补"窗户"最省事的一招 —— 贴图里自带规律排布的窗洞。
    "wall_windowed": (["Facade003", "Facade017", "Facade002", "Facade012", "Facade013", "Facade018A"], 30.0),
    "roof_slate":    (["RoofingTiles001"], 2.5),
    "roof_tile":     (["RoofingTiles012A", "RoofingTiles013A", "RoofingTiles011A"], 2.5),
    "roof_metal":    (["CorrugatedSteel009", "CorrugatedSteel005"], 1.6),
    "roof_gravel":   (["Gravel043", "Ground108"], 4.0),
    "asphalt":       (["Asphalt033", "Road012A"], 6.0),
    "pavement":      (["Concrete047A"], 3.0),
    "grass":         (["Grass005", "Grass001"], 6.0),
    "dirt":          (["Ground037"], 8.0),
    "wood":          (["WoodSiding013"], 2.0),
}

# 单个类别的"观感"微调（贴图本身不动，只调色）：
# 草地贴图直出太艳，整片城市看着像高尔夫球场，必须压饱和、压亮度。
LOOK = {
    "grass": dict(saturation=0.42, value=0.55),
    "dirt":  dict(saturation=0.75, value=0.85),
}

MATS = {}
MISSING = []

# 材质库的唯一真源是 tools\textures.json —— 它同时记录了"哪个类用哪些贴图"
# "一张铺多少米""是 CC0 还是别的许可"。下面这份内置 LIB 只是 json 缺失时的兜底。
_LIB_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "textures.json")
if os.path.isfile(_LIB_JSON):
    with open(_LIB_JSON, "r", encoding="utf-8") as _f:
        _d = json.load(_f)
    LIB = {k: (v["assets"], float(v["tile_m"])) for k, v in _d["lib"].items()}
    LOOK = _d.get("look", LOOK)
    print("[tex] 材质库清单已载入 %s（%d 个类别）" % (_LIB_JSON, len(LIB)), flush=True)


def log(m):
    print("[tex] %s" % m, flush=True)


# ------------------------------------------------------------------ 工具
def h1(s, mod):
    """确定性的名字哈希 —— 同一个建筑每次跑都得到同一个材质。"""
    h = 2166136261
    for ch in s:
        h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return h % mod


def find_tex(asset_dir, kind):
    for root, _dirs, files in os.walk(asset_dir):
        for f in sorted(files):
            if kind in f and f.lower().endswith((".jpg", ".jpeg", ".png", ".tif")):
                return os.path.join(root, f)
    return None


# ------------------------------------------------------------------ 造材质
def build_mat(name, asset_dir, tile_m, saturation=1.0, value=1.0):
    col = find_tex(asset_dir, "Color")
    if not col:
        return None
    m = bpy.data.materials.get(name)
    if m is not None:
        # 【重要】已经挂在场景上的材质一律复用，绝不 remove+new。
        # 原因：blosm 的槽位是"物体级覆盖"（slot.link == 'OBJECT'），
        # bpy.data.materials.remove() 会把这些物体级槽位**静默清空成 None**。
        # 本脚本在"给纯灰基座贴图"时（文件里还没有 tex_*）不受影响，
        # 但任何**二次运行**（文件里已有 tex_*）都会把 7 万个槽位全部打空。
        if m.users > 0:
            return m
        bpy.data.materials.remove(m)
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    # 世界坐标 -> 缩放 -> 三平面投影
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    mp = nt.nodes.new("ShaderNodeMapping")
    s = 1.0 / float(tile_m)
    mp.inputs["Scale"].default_value = (s, s, s)
    nt.links.new(geo.outputs["Position"], mp.inputs["Vector"])

    def img_node(path, non_color):
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = bpy.data.images.load(path, check_existing=True)
        if non_color:
            try:
                n.image.colorspace_settings.name = "Non-Color"
            except Exception:
                pass
        try:
            n.projection = "BOX"
            n.projection_blend = 0.15
        except Exception:
            pass
        nt.links.new(mp.outputs["Vector"], n.inputs["Vector"])
        return n

    tc = img_node(col, False)
    if saturation != 1.0 or value != 1.0:
        hs = nt.nodes.new("ShaderNodeHueSaturation")
        hs.inputs["Saturation"].default_value = saturation
        hs.inputs["Value"].default_value = value
        nt.links.new(tc.outputs["Color"], hs.inputs["Color"])
        nt.links.new(hs.outputs["Color"], bsdf.inputs["Base Color"])
    else:
        nt.links.new(tc.outputs["Color"], bsdf.inputs["Base Color"])

    rgh = find_tex(asset_dir, "Roughness")
    if rgh:
        tr = img_node(rgh, True)
        nt.links.new(tr.outputs["Color"], bsdf.inputs["Roughness"])
    else:
        bsdf.inputs["Roughness"].default_value = 0.85

    nrm = find_tex(asset_dir, "NormalGL")
    if nrm:
        tn = img_node(nrm, True)
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = 1.0
        nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])

    # 玻璃幕墙给一点镜面感，不然像贴纸
    if "Facade" in asset_dir:
        bsdf.inputs["Metallic"].default_value = 0.25
    return m


def flat_mat(name, rgba, rough=0.9, metal=0.0):
    m = bpy.data.materials.get(name)
    if m is not None:
        # 同 build_mat：已挂上的材质复用，别 remove（会把物体级槽位清空）
        if m.users > 0:
            return m
        bpy.data.materials.remove(m)
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    b.inputs["Base Color"].default_value = rgba
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    nt.links.new(b.outputs["BSDF"], out.inputs["Surface"])
    return m


def build_library():
    log("从 %s 建材质库" % TEX_ROOT)
    for key, (ids, tile) in LIB.items():
        mats = []
        look = LOOK.get(key, {})
        for aid in ids:
            d = os.path.join(TEX_ROOT, aid)
            if not os.path.isdir(d):
                continue
            m = build_mat("tex_%s__%s" % (key, aid), d, tile, **look)
            if m:
                mats.append(m)
        if mats:
            MATS[key] = mats
            log("  %-14s %d 个：%s" % (key, len(mats), ", ".join(x.name.split("__")[-1] for x in mats)))
        else:
            MISSING.append(key)
            log("  %-14s ✗ 缺贴图" % key)
    MATS["vegetation"] = [flat_mat("tex_vegetation", (0.055, 0.16, 0.035, 1.0), rough=0.95)]
    MATS["water"] = [flat_mat("tex_water", (0.045, 0.075, 0.115, 1.0), rough=0.06, metal=0.35)]


# ------------------------------------------------------------------ 分配
def pick(key, o, salt=""):
    pool = MATS.get(key)
    if not pool:
        return None
    return pool[h1(o.name + salt, len(pool))]


def pick_wall(o):
    z = o.dimensions.z
    r = h1(o.name, 100)
    if z < 16.0:                      # 连排屋 / 低层住宅：华盛顿的实情是红砖为主
        if r < 70:
            return pick("wall_brick", o, "w")
        if r < 98:
            return pick("wall_paint", o, "w")
        return pick("wall_windowed", o, "w")     # 极少数沿街商住楼
    if z < 35.0:                      # 中层办公 / 公寓：带窗幕墙 + 石材 + 灰泥
        if r < 42:
            return pick("wall_windowed", o, "w")
        if r < 66:
            return pick("wall_stone", o, "w")
        if r < 82:
            return pick("wall_paint", o, "w")
        if r < 94:
            return pick("wall_brick", o, "w")
        return pick("wall_concrete", o, "w")
    if r < 58:                        # 高层：优先带窗幕墙，少量纯玻璃
        return pick("wall_windowed", o, "w")
    if r < 82:
        return pick("wall_glass", o, "w")
    return pick("wall_concrete", o, "w")


def pick_roof(o):
    z = o.dimensions.z
    r = h1(o.name + "roof", 100)
    if z < 16.0:
        # 华盛顿连排屋的屋面以深色石板/沥青瓦为主，红陶瓦只是少数
        return pick("roof_slate" if r < 80 else "roof_tile", o, "r")
    if z < 35.0:
        return pick("roof_gravel" if r < 72 else "roof_metal", o, "r")
    return pick("roof_gravel", o, "r")


def assign(scene):
    stats = {}
    for o in bpy.data.objects:
        if o.type not in ("MESH", "CURVE", "SURFACE"):
            continue
        if not o.material_slots:
            continue
        for slot in o.material_slots:
            old = slot.material
            nm = (old.name if old else "").lower()
            new = None
            tag = None
            if "roof" in nm:
                new, tag = pick_roof(o), "roof"
            elif "stone" in nm or "wall" in nm or "facade" in nm:
                new, tag = pick_wall(o), "wall"
            elif "road" in nm or "path" in nm or "rail" in nm:
                new, tag = pick("asphalt", o), "asphalt"
            elif "area" in nm:
                new, tag = pick("pavement", o), "pavement"
            elif "vegetation" in nm or "forest" in nm:
                new, tag = pick("vegetation", o), "vegetation"
            elif "water" in nm:
                new, tag = pick("water", o), "water"
            elif "ground" in nm:
                new, tag = pick("grass", o), "grass"
            if new is not None:
                slot.material = new
                stats[tag] = stats.get(tag, 0) + 1
            elif old is not None:
                stats["未匹配:" + old.name] = stats.get("未匹配:" + old.name, 0) + 1
    log("材质分配统计：")
    for k in sorted(stats, key=lambda x: -stats[x]):
        log("  %-30s %d" % (k, stats[k]))


# ------------------------------------------------------------------ 渲染
def render(scene, shot, out_png):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import export_conditions as ec
    ec.setup_render(scene, 1600, 1000)
    cfg = ec.SHOTS[shot]
    lon, lat, z = cfg["loc_geo"]
    x, y = ec.geo_to_scene(lon, lat)
    tlon, tlat, tz = cfg["tgt_geo"]
    tx, ty = ec.geo_to_scene(tlon, tlat)
    ec.make_camera(scene, (x, y, z), (tx, ty, tz), cfg["lens"])
    ec.render_beauty(scene, out_png)


def main():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    if len(argv) < 2:
        print(__doc__)
        return 1
    src, dst = argv[0], argv[1]
    shot = argv[2] if len(argv) > 2 else None

    bpy.ops.wm.open_mainfile(filepath=os.path.abspath(src))
    scene = bpy.context.scene
    log("载入 %s：物体 %d 个" % (src, len(bpy.data.objects)))

    build_library()
    if MISSING:
        log("缺这些贴图：%s" % ", ".join(MISSING))
    assign(scene)

    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(dst))
    log("已保存 %s" % dst)

    if shot:
        png = os.path.splitext(os.path.abspath(dst))[0] + "_" + shot + ".png"
        render(scene, shot, png)
        log("渲染 %s" % png)
    return 0


if __name__ == "__main__":
    sys.exit(main())
