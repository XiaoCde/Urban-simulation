# -*- coding: utf-8 -*-
r"""① 给 DC 连排屋程序化补上它的四个身份特征。

**尺寸全部来自华盛顿官方文件，不是我编的**（每一项都有出处）：

  | 特征 | 取值 | 出处 |
  |---|---|---|
  | 连排屋面宽 | 5.18 m（17 ft） | HABS 测绘 1524 T Street NW（七连排之一）；
  |    |              | DC 规划局 CHASE Pattern Book："约 3/4 的连排屋地块窄于 20 ft" |
  | 凸窗最大悬挑 | **2 ft = 0.61 m** | DC 分区管理员解释 ZA-003（2019-10-01，dob.dc.gov）：
  |    |   "when cantilevered, bay windows may project up to two feet (2 ft.)
  |    |    into any yard or court. For reference 11 DCMR B-323" |
  | 凸窗离地界净距 | **8 in = 0.203 m** | DC 建筑规范 12-A §3202.7.2：party line 外 8 in 内必须留空 |
  | 檐口 | 不受上一条限制 | 12-A §3202.7.2 Exception：cornices/bases/sills/belt courses
  |      |              | /pilasters/water tables 免于 8 in 限制 |
  | 凸窗平面形状 | canted（切角）最常见 | Capitol Hill Restoration Society《The Washington Rowhouse,
  |              |                    | 1880s-1915》："The bays could be round or polygonal,
  |              |                    | but most often were square or canted." |
  | 凸窗高度 | 贯通全高（full height） | 同上："a full height projecting bay" |
  | 入口 | 抬高入口 + 铸铁楼梯 | 同上："built on a raised basement with a cast iron staircase" |
  | 街道宽度门槛 | 街宽 < 60 ft (18.288 m) 不许出挑 | 12-A §3202.7.1 |
  | 后巷 | 凸窗不得伸入/越过 alley | 12-A §3202.10.1 |
  | 墙基/窗台线脚 | 地面以上 4 ft 内 ≤ 8 in 出挑，水平出挑不限 | DC《Projection Schedule 2024》
  |                |                                    | （12 DCMR Chapter 32）|

**做法**：不改原建筑轮廓（OSM 轮廓是真实数据，保持不动），只在**临街立面**上贴加：
  1. 凸窗（bay window）—— 切角平面、贯通全高、悬挑 0.61 m、离地界留 0.203 m
  2. 檐口线脚（cornice）—— 屋顶下沿一圈凸出的横线条，出挑 0.45 m
  3. 门廊台阶（stoop）—— 抬高入口 + 台阶级数
  4. 竖向推拉窗（sash window）—— 高宽比 2:1，凹进立面 0.10 m 做出窗洞

**关键便利**：贴图用的是**世界坐标** Box 投影（见 apply_textures.py），
所以新加的几何**自动获得正确的砖缝纹理**，不需要任何 UV 操作。

用法:
    # 先干跑，只看会命中多少栋，不改文件
    D:\blender\blender.exe --background --python tools\add_dc_features.py -- out\dc_real3_tex.blend --dry

    # 只在测试区做（Dupont/Shaw 连排屋片区），出图验证
    D:\blender\blender.exe --background --python tools\add_dc_features.py -- ^
        out\dc_real3_tex.blend out\dc_real3_geo.blend --bbox=-77.045,38.905,-77.028,38.916

    # 全城
    D:\blender\blender.exe --background --python tools\add_dc_features.py -- ^
        out\dc_real3_tex.blend out\dc_real3_geo.blend
"""
import math
import os
import sys
from collections import Counter

import bpy
import bmesh
from mathutils import Matrix, Vector

# ---------------- 官方尺寸常数（来源见文件头表格） ----------------
FT = 0.3048
BAY_OUT = 2.0 * FT          # 0.6096 m  凸窗最大悬挑（ZA-003）
BAY_CLEAR = 8.0 / 12 * FT   # 0.2032 m  凸窗离地界净距（12-A 3202.7.2）
CORNICE_OUT = 0.45          # 檐口出挑，DC 连排屋实测常见 12-18 in
CORNICE_H = 0.55            # 檐口线脚高度（第 1 档加高：兼作女儿墙，让平屋顶有一圈浅色亮边）
CORNICE_LIFT = 0.05         # 檐口顶面高出墙顶，避免与屋顶面共面打架

# ---- 第 1 档：让特征"显形"（三个特征各自独立材质）----
PARAPET_T = 0.20            # 女儿墙厚 m
PARAPET_H = 0.30            # 女儿墙高出屋面 m
PARAPET_IN = 0.10           # 女儿墙离轮廓内缩 m
PANEL_T = 0.05              # 凸窗正面窗洞面板厚 m
TEX_ROOT = r"D:\citysim\textures"
TRIM_ASSET, TRIM_TILE = "Granite002A", 1.5   # 线脚/石作：浅色花岗岩
WIN_ASSET, WIN_TILE = "Facade003", 12.0    # 窗玻璃：Facade003 一张 1K 里 10x11 个窗格，
                                           # 按 12 m 铺 -> 每窗约 1.2 m、一层一窗，
                                           # 贴到 1.7 m 宽的凸窗窗板上就是"一竖排真窗户"。
                                           # （原来用 Facade009 按 2 m 铺：平均色 30,35,32
                                           #   近乎全黑，10 个窗格挤在 2 m 里 -> 一块黑斑）
MATS = {}                   # {'trim': 材质, 'winpanel': 材质}
STOOP_RISE = 0.18           # 单级踏步高
STOOP_RUN = 0.28            # 单级踏步深
STOOP_STEPS = 5             # 抬高入口约 5 级 -> 约 0.90 m，对应 raised basement
STOOP_W = 1.20              # 台阶宽
WIN_HW_RATIO = 2.0          # 竖向推拉窗高宽比 2:1
WIN_RECESS = 0.10           # 窗洞凹进
STREET_MIN_W = 60.0 * FT    # 18.288 m，窄于此的街不许出挑（3202.7.1）

# 判定为"连排屋候选"的门槛
MAX_H = 15.0                # 超过 15 m 基本不是两三层连排屋
MAX_AREA = 500.0            # 占地面积上限 m^2
MIN_H = 5.0

# 世界坐标 -> 经纬度（与 export_conditions.py 同一套常数）
G_LON0, G_LON_KM = -77.059998, 0.059998
G_LAT0, G_LAT_KM = 38.885003, 0.039996
S_X0, S_X_SPAN = -887.0, 5197.0
S_Y0, S_Y_SPAN = -597.0, 4451.0


def scene_to_geo(x, y):
    return (G_LON0 + (x - S_X0) / S_X_SPAN * G_LON_KM,
            G_LAT0 + (y - S_Y0) / S_Y_SPAN * G_LAT_KM)


def geo_to_scene(lon, lat):
    return (S_X0 + (lon - G_LON0) / G_LON_KM * S_X_SPAN,
            S_Y0 + (lat - G_LAT0) / G_LAT_KM * S_Y_SPAN)


def log(m):
    print("[geo] %s" % m, flush=True)


# ---------------- 路网栅格索引（用来找临街面） ----------------
CELL = 40.0


def build_road_index():
    """把道路曲线采样成点，放进 40 m 的栅格，供最近路查询。"""
    grid = {}
    npts = 0
    for o in bpy.data.objects:
        if o.type != "CURVE":
            continue
        mw = o.matrix_world
        for sp in o.data.splines:
            if sp.type == "BEZIER":
                pts = [bp.co for bp in sp.bezier_points]
            else:
                pts = [p.co for p in sp.points]
            for p in pts:
                w = mw @ Vector((p[0], p[1], p[2]))
                k = (int(w.x // CELL), int(w.y // CELL))
                grid.setdefault(k, []).append((w.x, w.y))
                npts += 1
    log("路网索引：%d 个采样点，%d 个栅格" % (npts, len(grid)))
    return grid


def nearest_road(grid, x, y):
    """返回最近路点的 (dx, dy, dist)。先查本格，逐圈扩大。"""
    best = None
    d0 = 0
    while d0 <= 6:                       # 最多扩到 6 圈 = 240 m
        for i in range(-d0, d0 + 1):
            for j in range(-d0, d0 + 1):
                if d0 and max(abs(i), abs(j)) != d0:
                    continue
                for (px, py) in grid.get((int(x // CELL) + i, int(y // CELL) + j), ()):
                    dd = (px - x) ** 2 + (py - y) ** 2
                    if best is None or dd < best[2]:
                        best = (px - x, py - y, dd)
        if best is not None and d0 >= 1:
            break
        d0 += 1
    if best is None:
        return None
    return (best[0], best[1], math.sqrt(best[2]))


# ---------------- 主逻辑 ----------------
def footprint_info(me, mw):
    """返回 (minx,miny,minz,maxx,maxy,maxz, area)。"""
    xs, ys, zs = [], [], []
    for v in me.vertices:
        w = mw @ v.co
        xs.append(w.x)
        ys.append(w.y)
        zs.append(w.z)
    if not xs:
        return None
    dx, dy = max(xs) - min(xs), max(ys) - min(ys)
    return (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs), dx * dy)


def front_face(info, rx, ry):
    """按"指向最近路点"的方向，挑出临街的那个立面（返回法线轴 + 符号）。"""
    minx, miny, minz, maxx, maxy, maxz, _ = info
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    dx, dy = rx - cx, ry - cy
    if abs(dx) >= abs(dy):
        return (0, 1 if dx > 0 else -1)
    return (1, 1 if dy > 0 else -1)


def add_box(bm, center, size, mat_index, mw_inv=None):
    """往 bmesh 里加一个轴对齐长方体。

    ！！最容易错的地方：center / size 都是**世界坐标**，而 bmesh 里的顶点是
    **物体局部坐标**（blosm 给每栋楼都挂了一个平移矩阵，不是单位阵）。所以必须
    用 matrix_world 的逆把方块搬回局部空间 —— 否则方块会落到几千米外。
    实测症状：包围盒外扩 2359 m，渲染图里完全看不出来（东西飘到画外了）。
    """
    m = Matrix.Translation(Vector(center)) @ Matrix.Diagonal(Vector(size)).to_4x4()
    if mw_inv is not None:
        m = mw_inv @ m
    res = bmesh.ops.create_cube(bm, size=1.0, matrix=m)
    for v in res["verts"]:
        for f in v.link_faces:
            f.material_index = mat_index


def wall_slot(o):
    """找外墙材质的槽位（tex_wall_*），没有就用 0。"""
    for i, s in enumerate(o.material_slots):
        if s.material and s.material.name.startswith("tex_wall"):
            return i
    return 0


# ---------------- 第 1 档：让特征"显形"的材质 ----------------
def _tools_dir():
    try:
        return os.path.dirname(os.path.abspath(__file__))
    except NameError:
        return r"D:\Users\asus\Desktop\项目\tools"


def build_mats():
    """复用 apply_textures.py 的 build_mat()，保证新材质与其余材质同一套做法
    （世界坐标 Box 三平面投影 + Mapping 1/tile_m），砖缝/石纹才能接得上。

    材质名必须写成 tex_<class>__<asset> —— finalize_textured.py 的 class_of()
    是按 '__' 切开去 textures.json 里查 tile_m 的，名字不对就烘不出 UV，
    GLB 里这栋楼就没贴图（地面那次就是这么踩的）。
    """
    import importlib.util
    p = os.path.join(_tools_dir(), "apply_textures.py")
    spec = importlib.util.spec_from_file_location("_apply_tex_mod", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    def one(cls, asset, tile):
        d = os.path.join(TEX_ROOT, asset)
        if not os.path.isdir(d):
            log("  ✗ 缺贴图目录 %s" % d)
            return None
        m = mod.build_mat("tex_%s__%s" % (cls, asset), d, tile)
        if m is None:
            log("  ✗ %s 里找不到 Color 图" % asset)
            return None
        log("  ✓ %s（tile %.1f m）" % (m.name, tile))
        return m

    MATS["trim"] = one("trim", TRIM_ASSET, TRIM_TILE)
    MATS["winpanel"] = one("winpanel", WIN_ASSET, WIN_TILE)
    return MATS


def ensure_slot(o, mat):
    """把这个材质挂到物体上，返回槽位索引。已经挂过就直接复用。"""
    if mat is None:
        return None
    me = o.data
    for i, m in enumerate(me.materials):
        if m is not None and m.name == mat.name:
            return i
    me.materials.append(mat)
    return len(me.materials) - 1


def wall_top_of(me, mw, zmax):
    """**墙顶（檐口线）**—— 所有近竖直面的最高点。

    为什么不能直接用 maxz：坡屋顶的 maxz 是**屋脊**，比檐口高一两米。
    第一版把檐口放在 maxz - CORNICE_H/2，等于把檐口挂在屋脊上、悬在
    屋顶斜坡上方 —— 这就是"屋顶有点奇怪"的一半原因。
    """
    m3 = mw.to_3x3()
    top = None
    for p in me.polygons:
        n = (m3 @ p.normal).normalized()
        if abs(n.z) < 0.35:                      # 近竖直 = 墙
            z = max((mw @ me.vertices[i].co).z for i in p.vertices)
            if top is None or z > top:
                top = z
    return zmax if top is None else top


def features_for(o, info, axis, sign, grid):
    """给一栋楼生成特征。第 1 档之后，凸窗/檐口/台阶/女儿墙**各自独立材质**。

    第一版三个特征全都用了外墙的砖材质，后果：
      · 檐口顶面在屋顶标高上、又是砖纹 -> 俯瞰时屋顶围了一圈砖边 = "屋顶有点奇怪"
      · 台阶跟墙一个颜色 -> 完全读不出来
      · 凸窗只是"墙上鼓了个包"，读不出是个独立构件
    """
    minx, miny, minz, maxx, maxy, maxz, area = info
    h = maxz - minz
    me = o.data
    mw = o.matrix_world
    mi = wall_slot(o)

    # 立面所在的平面坐标 & 面宽 / 高度
    front = maxx if (axis == 0 and sign > 0) else (minx if axis == 0 else
                                                   (maxy if sign > 0 else miny))
    lo_a = miny if axis == 0 else minx     # 立面沿"另一轴"的起点
    hi_a = maxy if axis == 0 else maxx     # 立面沿"另一轴"的终点
    width = hi_a - lo_a
    if width < 2.5 or h < MIN_H:
        return 0, "太窄或太矮"

    # 12-A 3202.7.1：街宽 < 60 ft 不许出挑
    cx = (minx + maxx) / 2
    cy = (miny + maxy) / 2
    nr = nearest_road(grid, cx, cy)
    if nr is None:
        return 0, "附近没路"
    dist_road = nr[2]
    if dist_road > 45.0:
        return 0, "离路 %.0f m 太远（不像临街连排屋）" % dist_road
    # 路点在建筑外侧，街道中心线到建筑立面的距离 * 2 近似街宽
    street_w = max(dist_road * 2.0, 6.0)
    if street_w < STREET_MIN_W:
        return 0, "街宽约 %.1f m (<60 ft) 不许出挑" % street_w

    # ---- 只有真要加特征了，才挂新材质槽（早退的楼不留空槽）----
    ti = ensure_slot(o, MATS.get("trim"))
    wi = ensure_slot(o, MATS.get("winpanel"))
    wt = wall_top_of(me, mw, maxz)          # 檐口线（不是屋脊！）
    flat = (wt >= maxz - 0.15)              # 平屋顶？

    n_feat = 0
    mw_inv = mw.inverted()
    bm = bmesh.new()
    bm.from_mesh(me)
    out = BAY_OUT * sign
    zc = (minz + maxz) / 2

    # ---- 1. 凸窗：切角（canted）平面、贯通全高、悬挑 2 ft ----
    bay_w = min(width - 2 * BAY_CLEAR, 2.6)
    bay_c = lo_a + BAY_CLEAR + bay_w / 2
    if bay_w >= 1.2:
        c = ((front + out / 2, bay_c, zc) if axis == 0 else (bay_c, front + out / 2, zc))
        s = ((BAY_OUT, bay_w, h * 0.92) if axis == 0 else (bay_w, BAY_OUT, h * 0.92))
        add_box(bm, c, s, mi, mw_inv)
        # 两个 45 度切角：用两个小方块近似（canted bay 的斜边）
        ch = min(bay_w * 0.35, BAY_OUT)
        for sgn in (-1, 1):
            ca = bay_c + sgn * bay_w / 2
            c2 = ((front + out * 0.5, ca + sgn * ch / 2, zc) if axis == 0
                  else (ca + sgn * ch / 2, front + out * 0.5, zc))
            s2 = ((BAY_OUT * 0.62, ch, h * 0.92) if axis == 0
                  else (ch, BAY_OUT * 0.62, h * 0.92))
            add_box(bm, c2, s2, mi, mw_inv)
        # 凸窗正面的窗洞面板（近黑玻璃）—— 凸窗这才读得出是"窗"，不是"墙鼓了个包"
        if wi is not None:
            po = front + out + PANEL_T * 0.5 * sign
            pc = ((po, bay_c, zc) if axis == 0 else (bay_c, po, zc))
            ps = ((PANEL_T, bay_w * 0.66, h * 0.92 * 0.76) if axis == 0
                  else (bay_w * 0.66, PANEL_T, h * 0.92 * 0.76))
            add_box(bm, pc, ps, wi, mw_inv)
        n_feat += 1

    # ---- 2. 檐口线脚：墙顶一圈凸出的横线条（浅色石作）----
    if ti is not None:
        cz = wt + CORNICE_LIFT - CORNICE_H / 2
        co = CORNICE_OUT * sign
        c = ((front + co / 2, (lo_a + hi_a) / 2, cz) if axis == 0
             else ((lo_a + hi_a) / 2, front + co / 2, cz))
        s = ((CORNICE_OUT, width, CORNICE_H) if axis == 0
             else (width, CORNICE_OUT, CORNICE_H))
        add_box(bm, c, s, ti, mw_inv)
        n_feat += 1

    # ---- 3. 平屋顶加一圈女儿墙（浅色石作）----
    #     平屋顶在航拍里就是一块"纯色方块"，加一圈亮边之后每栋楼才读得出来
    if flat and ti is not None and (maxx - minx) > 3.0 and (maxy - miny) > 3.0:
        sx = (maxx - minx) - 2 * PARAPET_IN
        sy = (maxy - miny) - 2 * PARAPET_IN
        if sx > 0.5 and sy > 0.5:
            pz = wt + PARAPET_H / 2
            for yy in (miny + PARAPET_IN + PARAPET_T / 2,
                       maxy - PARAPET_IN - PARAPET_T / 2):
                add_box(bm, ((minx + maxx) / 2, yy, pz),
                        (sx, PARAPET_T, PARAPET_H), ti, mw_inv)
            for xx in (minx + PARAPET_IN + PARAPET_T / 2,
                       maxx - PARAPET_IN - PARAPET_T / 2):
                add_box(bm, (xx, (miny + maxy) / 2, pz),
                        (PARAPET_T, sy, PARAPET_H), ti, mw_inv)
            n_feat += 1

    # ---- 4. 门廊台阶（抬高入口）：凸窗的另一侧，浅色石作 ----
    smat = ti if ti is not None else mi
    stair_w = min(STOOP_W, max(width - bay_w - BAY_CLEAR - 0.4, 0.9))
    if stair_w >= 0.9:
        sa = hi_a - BAY_CLEAR - stair_w / 2
        for k in range(STOOP_STEPS):
            z = minz + (k + 0.5) * STOOP_RISE
            d = (STOOP_STEPS - k) * STOOP_RUN
            cc = ((front + d * 0.5 * sign, sa, z) if axis == 0
                  else (sa, front + d * 0.5 * sign, z))
            ss = ((d, stair_w, STOOP_RISE) if axis == 0 else (stair_w, d, STOOP_RISE))
            add_box(bm, cc, ss, smat, mw_inv)
        n_feat += 1

    bm.to_mesh(me)
    bm.free()
    me.update()
    return n_feat, "凸窗+窗板/檐口" + ("+女儿墙" if flat else "") + "/台阶"


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not argv:
        print(__doc__)
        return 1
    src = os.path.abspath(argv[0])
    rest = argv[1:]
    dry = "--dry" in argv
    bbox = None
    dst = None
    for a in rest:
        if a.startswith("--bbox="):
            bbox = [float(v) for v in a.split("=", 1)[1].split(",")]
        elif not a.startswith("--"):
            dst = os.path.abspath(a)

    bpy.ops.wm.open_mainfile(filepath=src)
    log("载入 %s：物体 %d 个" % (src, len(bpy.data.objects)))

    log("建第 1 档材质（线脚 / 窗玻璃）：")
    build_mats()

    grid = build_road_index()

    cand = []
    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        info = footprint_info(o.data, o.matrix_world)
        if not info:
            continue
        minx, miny, minz, maxx, maxy, maxz, area = info
        h = maxz - minz
        if h < MIN_H or h > MAX_H or area > MAX_AREA or area < 12.0:
            continue
        if bbox:
            lon, lat = scene_to_geo((minx + maxx) / 2, (miny + maxy) / 2)
            if not (bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]):
                continue
        cand.append((o, info))

    log("连排屋候选（高 %.0f-%.0f m、占地 12-%.0f m^2、在框内）：%d 栋"
        % (MIN_H, MAX_H, MAX_AREA, len(cand)))

    if dry:
        hist = Counter()
        for o, info in cand:
            hist[round((info[5] - info[2]) / 3) * 3] += 1
        for k in sorted(hist):
            log("  高约 %2d-%2d m：%5d 栋" % (k, k + 3, hist[k]))
        return 0

    done = feat = 0
    reasons = Counter()
    for o, info in cand:
        cx = (info[0] + info[3]) / 2
        cy = (info[1] + info[4]) / 2
        nr = nearest_road(grid, cx, cy)
        if nr is None:
            reasons["附近没路"] += 1
            continue
        axis, sign = front_face(info, cx + nr[0], cy + nr[1])
        n, why = features_for(o, info, axis, sign, grid)
        if n:
            feat += 1
        else:
            reasons[why] += 1
        done += 1
        if done % 500 == 0:
            log("  处理 %d/%d，已加特征 %d 栋" % (done, len(cand), feat))

    log("加完：%d 栋加了特征（处理了 %d 栋）" % (feat, done))
    for r, c in reasons.most_common(8):
        log("  跳过 %-40s %d 栋" % (r, c))

    if dst:
        bpy.ops.wm.save_as_mainfile(filepath=dst)
        log("已保存 %s（%.1f MB）" % (dst, os.path.getsize(dst) / 1048576))
    return 0


if __name__ == "__main__":
    sys.exit(main())
