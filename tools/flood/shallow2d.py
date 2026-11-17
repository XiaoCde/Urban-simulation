"""
shallow2d.py — 二维浅水（inertial formulation）城区内涝内核

【为什么要有这个文件】
`simple_drainage.py` 的 `fill-and-spill` 内核只把水放进「它最终落到的那个洼地」，
洼地之间只在灌满那一刻溢流。它**没有速度场、没有水力坡度、没有在途水**，
所以路面上永远只有「停住的水」，出不了「正在流的水」。
P3 三个旋钮（建筑挡水 / 街道压低 / 微坑阈值）全部无效，就是这条的证明。

这里换成 Bates, Horritt & Fewtrell (2010) 的 inertial formulation ——
LISFLOOD-FP 8.x 的默认内核，也是目前城市内涝模拟最通行的低维近似：

    q_{t+Δt} = (q_t + g·h_flow·Δt·S) / (1 + g·Δt·n²·|q_t| / h_flow^{7/3})
    h_{t+Δt} = h_t + Δt·(∂q/∂x + ∂q/∂y + R - D)

它丢掉的是动量方程里的对流项与局地加速度项，保留重力项与摩阻项。
对「水往哪儿漫、漫多深、什么时候退」够用；对急变流（溃坝、激波）不够。

【换了内核之后，哪些补丁可以删掉】
1. 不需要 `priority_flood` 填洼 —— 水自己会流。
2. 不需要「陆地低于河水位的格直接淹掉」—— 河道是 Dirichlet 边界，
   水面高于岸就自然漫出来。
3. 不需要 `--street-drop-m` 制造「街道优先」—— 街道本来就低。
4. 不需要 `spread_ponding` 摊平迭代 —— 水面是解出来的，不是摊出来的。

【三处必须做对的地方（坑都在这）】
A. 干湿判断：`h_flow = max(h_L, h_R)`，低于 `--h-min` 的通量置零。
   用单侧 h 会让干格把湿格的水「抽」过来，越算越负。
B. 建筑不能当高墙：4 m 网格里楼占整格，抬 8 m 会封出假院落把雨全吸走
   （P3 的 12 m 墙已经踩过）。这里只抬 `--bld-step-m`（默认 0.30 m，
   代表首层地面 + 基座台阶），水漫过它就等于「楼进水」，物理上正是这个意思。
C. 排水不是「面平均抽走」：真实是管网按需服务、超载才溢。
   这里给一个全局容量 `Q_cap`（默认 255 m³/s ≈ 30 mm/h × 30.6 km²），
   屋顶/路面进来的水按 `min(1, Q_cap/需求)` 得到服务率，剩下的留在地面。
   —— 这才是「雨强超过设计标准才积水」的正确机制。

用法：
    python tools/flood/shallow2d.py --res 4 --p-mm-h 110 --dur-h 2 --tail-h 4 \
        --surge-m 4 --out data/flood/sw2d_p4
"""

import argparse
import json
import os
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    from swe_numba import SweCore          # 编译版内核（快一个量级）
    HAVE_NUMBA = True
except Exception as _e:                     # 没装 numba 就退回 numpy，速度慢但结果一致
    HAVE_NUMBA = False
    _NUMBA_ERR = repr(_e)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DERIVED = os.path.join(ROOT, "data", "derived")
G = 9.81

# 下垫面：0 水体 / 1 建筑 / 2 硬化 / 3 草地 / 4 林地 / 5 裸土
C_RUNOFF = np.array([0.00, 0.95, 0.90, 0.15, 0.10, 0.35], dtype="float32")
# 【统一退水】下渗不再是「开场扣一个常数」，而是逐格 f0→fc 动态衰退 + 蓄水库。
# 这三条表和旧 simple_drainage.py 完全一致，是四条退水去路里「进土」那一条的参数。
INFIL_F0 = np.array([0.0, 3.0, 6.0, 45.0, 60.0, 12.0], dtype="float32")  # mm/h 干土初渗
INFIL_FC = np.array([0.0, 1.0, 1.5, 13.0, 26.0, 4.0], dtype="float32")   # mm/h 饱和稳渗
INFIL_CAP = np.array([0.0, 5.0, 5.0, 45.0, 90.0, 30.0], dtype="float32")  # mm 可吸存量

# 曼宁 n。硬化面用柏油 0.015；建筑给大值，让水绕着走而不是穿楼
N_MANNING = np.array([0.025, 0.120, 0.015, 0.035, 0.100, 0.030], dtype="float32")


def log(msg):
    print(msg, flush=True)


# ----------------------------------------------------------------------------
# 栅格准备
# ----------------------------------------------------------------------------
def load_raster(name):
    path = os.path.join(DERIVED, name)
    if not os.path.exists(path):
        raise SystemExit(f"缺输入：{path}")
    return np.array(Image.open(path))


def _blk(a, res):
    r = (a.shape[0] // res) * res
    c = (a.shape[1] // res) * res
    x = a[:r, :c]
    return x.reshape(r // res, res, c // res, res)


def bmean(a, res):
    return _blk(a, res).mean(axis=(1, 3))


def bmin(a, res):
    return _blk(a, res).min(axis=(1, 3))


def bmax(a, res):
    return _blk(a, res).max(axis=(1, 3))


def bmode(a, res, ncls=6):
    """块内众数。少数派草地被建筑吃掉，比均值更接近真实不透水面。"""
    x = _blk(a, res).transpose(0, 2, 1, 3).reshape(a.shape[0] // res, a.shape[1] // res, res * res)
    best = np.zeros(x.shape[:2], dtype="int32")
    bestc = np.zeros(x.shape[:2], dtype="uint8")
    for c in range(ncls):
        cnt = (x == c).sum(axis=2)
        m = cnt > best
        best = np.where(m, cnt, best)
        bestc = np.where(m, c, bestc)
    return bestc


def build_street_raster(grid, res, h, w):
    """把 dc_streets.json 的 way 烧成栅格（与 simple_drainage 同口径），带缓存。"""
    cache = os.path.join(DERIVED, f"street_mask_{res}.npz")
    if os.path.exists(cache):
        d = np.load(cache)
        if int(d["h"]) == h and int(d["w"]) == w and d["m"].shape == (h, w):
            return d["m"]
    fp = os.path.join(ROOT, "data", "streets", "dc_streets.json")
    if not os.path.exists(fp):
        return np.zeros((h, w), dtype=bool)
    sj = json.load(open(fp, encoding="utf-8"))
    prof = {}
    for k, v in (sj.get("profiles") or {}).items():
        try:
            prof[k] = max(abs(float(p[0])) for p in v[:2]) if len(v) >= 2 else 3.0
        except Exception:
            prof[k] = 3.0
    x0, y1 = float(grid["x0"]), float(grid["y1"])
    step = max(res * 0.5, 0.5)
    acc = np.zeros((h, w), dtype=np.float32)
    npt = 0
    for wy in sj.get("ways") or []:
        pts = wy.get("pts") or []
        if len(pts) < 2:
            continue
        hw = prof.get(wy.get("prof") or "", 3.0) or 3.0
        for i in range(len(pts) - 1):
            ax, ay = float(pts[i][0]), float(pts[i][1])
            bx, by = float(pts[i + 1][0]), float(pts[i + 1][1])
            L = ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5
            n = max(2, int(L / step) + 1)
            for t in range(n):
                f = t / (n - 1.0)
                px, py = ax + (bx - ax) * f, ay + (by - ay) * f
                cc = int((px - x0) / res)
                rr = int((y1 - py) / res)
                if 0 <= rr < h and 0 <= cc < w:
                    if hw > acc[rr, cc]:
                        acc[rr, cc] = hw
                    npt += 1
    m = acc > 0
    # 按半宽膨胀成带（与老脚本一致的 5 m 半径）
    rad = max(1, int(round(5.0 / res)))
    try:
        from scipy import ndimage as ndi
        m = ndi.binary_dilation(m, iterations=rad)
    except Exception:
        # 无 scipy 时用 numpy 方形膨胀
        for _ in range(rad):
            mm = m.copy()
            mm[1:, :] |= m[:-1, :]
            mm[:-1, :] |= m[1:, :]
            mm[:, 1:] |= m[:, :-1]
            mm[:, :-1] |= m[:, 1:]
            m = mm
    np.savez_compressed(cache, m=m, h=np.int32(h), w=np.int32(w))
    log(f"      街道栅格：{npt} 采样点 → {int(m.sum())} 格（{m.sum() * res * res / 1e6:.2f} km²）")
    return m


# ----------------------------------------------------------------------------
# 连通块（无 scipy 版，只对湿格做 BFS）
# ----------------------------------------------------------------------------
def wet_blocks(mask, cell_area, min_cells):
    """8 邻域连通块，返回 (≥min_cells 的块数, 最大块占总湿面积比, 最大块格数)。"""
    h, w = mask.shape
    flat = mask.ravel().tolist()          # tolist 比 numpy 标量索引快一个量级
    seen_flat = bytearray(len(flat))
    best = 0
    nbig = 0
    total = int(mask.sum())
    if total == 0:
        return 0, 0.0, 0
    idx_all = np.flatnonzero(mask.ravel()).tolist()
    for start in idx_all:
        if seen_flat[start]:
            continue
        stack = [int(start)]
        seen_flat[start] = 1
        cnt = 0
        while stack:
            k = stack.pop()
            cnt += 1
            r, c = divmod(k, w)
            for dr in (-1, 0, 1):
                rr = r + dr
                if rr < 0 or rr >= h:
                    continue
                base = rr * w
                for dc in (-1, 0, 1):
                    cc = c + dc
                    if cc < 0 or cc >= w:
                        continue
                    kk = base + cc
                    if flat[kk] and not seen_flat[kk]:
                        seen_flat[kk] = 1
                        stack.append(kk)
        if cnt >= min_cells:
            nbig += 1
        if cnt > best:
            best = cnt
    return nbig, best / total, best


# ----------------------------------------------------------------------------
# 主程序
# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="二维浅水（inertial）城区内涝内核")
    ap.add_argument("--res", type=int, default=4, help="计算分辨率（米），建议 4；2 会更细但慢 4 倍")
    ap.add_argument("--p-mm-h", type=float, default=110.0, help="雨强 mm/h")
    ap.add_argument("--dur-h", type=float, default=2.0, help="降雨历时 h")
    ap.add_argument("--tail-h", type=float, default=4.0,
                    help="（已弃用）统一 24h 时间轴由 --day-minutes 决定退水段长度")
    ap.add_argument("--surge-m", type=float, default=4.0, help="河道增水 m（Isabel 2.71 / 历史最高 2.94）")
    ap.add_argument("--river-level", choices=["normal", "design"], default="normal")
    ap.add_argument("--drain-m3s", type=float, default=255.0,
                    help="雨水管网总服务能力 m³/s（255 ≈ 30 mm/h × 30.6 km²）")
    ap.add_argument("--bld-step-m", type=float, default=0.30, help="建筑格抬高的台阶（首层地面 + 基座）")
    ap.add_argument("--h-min", type=float, default=1e-4, help="参与通量计算的最小水深 m")
    ap.add_argument("--dt-max", type=float, default=20.0, help="时间步上限 s")
    ap.add_argument("--cfl", type=float, default=0.5, help="CFL 系数")
    ap.add_argument("--s-max", type=float, default=0.10,
                    help="水面坡降上限（城市地表很少超过 10%%；"
                         "不限制的话河岸/台阶的假陡坡会让通量爆炸）")
    ap.add_argument("--frame-min", type=float, default=10.0, help="输出帧间隔 min（0 = 只存峰值）")
    ap.add_argument("--frames", action="store_true",
                    help="输出 web 可读的帧序列（frames/fNNN.u8 + manifest.json）")
    ap.add_argument("--depth-scale", type=float, default=4.0,
                    help="u8 量化上限 m（与 --h-cap 对齐，超出截断）")
    ap.add_argument("--max-frames", type=int, default=28, help="帧数上限，超出自动抽稀")
    ap.add_argument("--edge-tau-s", type=float, default=180.0, help="开边界自由出流时间常数 s")
    ap.add_argument("--edge-open-z", type=float, default=3.0, help="边界可出流的最高地面高程 m")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "flood", "sw2d"))
    ap.add_argument("--dbg", action="store_true", help="打印每 5 步的数值诊断")
    ap.add_argument("--surge-series", default="",
                    help="时变河道水位序列（NOAA CO-OPS JSON，datum=MSL）。给了就不用 --surge-m")
    ap.add_argument("--surge-t0-h", type=float, default=0.0,
                    help="模拟 t=0 对应潮位序列的第几小时。用来把降雨窗口对齐到潮位峰值附近")
    ap.add_argument("--h-cap", type=float, default=4.0,
                    help="单元水深上限 m。DEM 里的铁路堑/地下通道在粗网格上会变成封闭深坑，"
                         "不设上限会把水吸到十几米深（实测 16.7 m）")
    ap.add_argument("--no-numba", action="store_true", help="（已弃用）统一内核只有 numba 一条口径")
    ap.add_argument("--threads", type=int, default=0, help="numba 线程数，0 = 用满")
    ap.add_argument("--max-steps", type=int, default=200000, help="步数保护上限")

    # ---- 统一模型：24 小时一天时间轴 + 四条退水去路 + 雨型 ----
    ap.add_argument("--day-minutes", type=float, default=1440.0,
                    help="整场时间轴长度（分钟）；1440 = 一整天 0:00→24:00")
    ap.add_argument("--rain-start-min", type=float, default=1020.0,
                    help="降雨窗口起点（一天中的分钟）；1020 = 17:00")
    ap.add_argument("--hyetograph", default="pulse",
                    choices=["uniform", "peak", "pulse", "front", "day"],
                    help="雨型：雨强在降雨窗口内的时间形状（整场平均雨强恒为 --p-mm-h）")
    ap.add_argument("--et-mm-h", type=float, default=0.12,
                    help="蒸散速率 mm/h（只作用于积水表面）")
    ap.add_argument("--soil-recover-h", type=float, default=24.0,
                    help="雨停后土壤蓄水库恢复时间常数 h")
    ap.add_argument("--sewer-m3s", type=float, default=45.0,
                    help="雨水口+截流管合计输送能力 m³/s（管网满管桶上限基准）")
    ap.add_argument("--drain-fail-after-mm", type=float, default=25.0,
                    help="管网调蓄桶容量折算雨量 mm；超过后能力衰减到 residual")
    ap.add_argument("--drain-residual", type=float, default=0.05,
                    help="管网满管后剩余能力比例")
    ap.add_argument("--drain-recover-h", type=float, default=6.0,
                    help="雨停后管网调蓄桶放空时间常数 h")
    ap.add_argument("--surge-recede-h", type=float, default=3.0,
                    help="河道增水在雨停后回落到基准水位的时间常数 h；"
                         "0 = 常数增水（旧口径，河一直顶在峰值，退水被顶住）")
    args = ap.parse_args()

    t_all = time.time()
    os.makedirs(args.out, exist_ok=True)
    res = max(1, int(args.res))
    dx = dy = float(res)
    cell_area = dx * dy

    log(f"[1/6] 读栅格（{res} m 重采样）…")
    z1 = load_raster("terrain_dtm.tif").astype("float32")
    lc1 = load_raster("landcover.tif")
    b1 = load_raster("building_mask.tif")
    z = bmean(z1, res).astype("float32")
    zlo = bmin(z1, res).astype("float32")     # 块内最低点：街道/沟槽的真实排水底
    lc = bmode(lc1, res)
    bld_frac = bmean((b1 > 0).astype("float32"), res)
    bld = bld_frac > 0.5
    pct = lambda v: (float(np.percentile(v, [2, 50, 98])[0]),
                     float(np.percentile(v, [2, 50, 98])[1]),
                     float(np.percentile(v, [2, 50, 98])[2]))
    log(f"      网格 {z.shape[1]}×{z.shape[0]} = {z.size:,} 格；高程 {z.min():.2f}…{z.max():.2f} m")
    log(f"      建筑格 {bld.sum():,}（{bld.sum() / z.size * 100:.1f}%），"
        f"硬化 {int((lc == 2).sum()):,}，水体 {int((lc == 0).sum()):,}")

    grid = dict(json.load(open(os.path.join(DERIVED, "water.json"), encoding="utf-8"))["grid"])
    wj = json.load(open(os.path.join(DERIVED, "water.json"), encoding="utf-8"))
    lvl = wj["levels"]
    river_level = (float(lvl["MSL_m"]) if args.river_level == "normal" else float(lvl["BFE_min_m"]))
    river_level += float(args.surge_m)
    log(f"      河道水位 {river_level:.3f} m")

    # ---- 时变河道水位（真实潮位/风暴增水过程线）----
    # 常数增水的模型里，河一直顶在峰值，退水阶段被严重高估：
    # 真实风暴是「涨潮顶托 → 峰值 → 退潮」，河退下去城里才排得动。
    surf_ts = surf_vs = None
    surf_t0 = float(args.surge_t0_h) * 3600.0
    if args.surge_series:
        from datetime import datetime
        sp = args.surge_series
        if not os.path.isabs(sp):
            sp = os.path.join(ROOT, sp)
        if not os.path.exists(sp):
            raise SystemExit(f"缺潮位序列：{sp}")
        _d = json.load(open(sp, encoding="utf-8"))
        _rows = _d.get("data") or []
        if len(_rows) < 10:
            raise SystemExit(f"潮位序列太短：{sp}")
        _t0 = datetime.strptime(_rows[0]["t"], "%Y-%m-%d %H:%M")
        surf_ts = np.array([(datetime.strptime(r["t"], "%Y-%m-%d %H:%M") - _t0).total_seconds()
                            for r in _rows], dtype="float64")
        surf_vs = np.array([float(r["v"]) for r in _rows], dtype="float64")
        river_level = float(np.interp(surf_t0, surf_ts, surf_vs))
        log(f"      时变边界：{os.path.basename(sp)}，{len(_rows)} 点 "
            f"({_rows[0]['t']} → {_rows[-1]['t']})，序列峰值 {float(surf_vs.max()):.3f} m，"
            f"模拟起点 = 序列 {args.surge_t0_h:.1f} h，t=0 水位 {river_level:.3f} m"
            f"（泵站 8594900，datum=MSL）")

    # ---- 街道栅格：只用来统计「淹了多少路」和给雨水口定位 ----
    street = build_street_raster(grid, res, z.shape[0], z.shape[1])

    # ---- 地形修正：建筑抬一个台阶 ----
    # z 用块内均值（体积对），但街道的窄沟在 4 m 均值里会被抹平。
    # 用「块内最低点 + 0.15 m」给街道格一个略低的底，恢复边沟的集水作用，
    # 幅度克制在 15 cm，不动整体高程。
    zmod = z.copy()
    zsw = np.where(street & ~bld, np.maximum(zlo + 0.15, z - 0.35), zmod)
    zmod = np.minimum(zmod, zsw)
    zmod = np.where(bld, zmod + float(args.bld_step_m), zmod)
    log(f"      地形修正：街道格下压 {float((z - zmod)[street & ~bld].mean()):.2f} m（均值）")

    # ---- 水力参数场 ----
    n = N_MANNING[lc].astype("float32")
    n = np.where(bld, np.float32(0.120), n)
    # 面糙率：两侧取大（阻水侧主导）
    n_x = np.maximum(n[:, :-1], n[:, 1:])
    n_y = np.maximum(n[:-1, :], n[1:, :])

    # ---- 产流（空间分布，m/s）----
    # 【单位坑】p_mm_h 是 mm/h，必须先 /1000 变 m/s。第一版漏了这一下，
    # 雨量被放大 1000 倍，30 步就灌进 89 Mm³，整个域溢出成 nan。
    rain_mps = args.p_mm_h / 1000.0 / 3600.0
    # 【统一】产流只按径流系数分下垫面；下渗不再在开场扣一个常数，
    # 改由内核逐格按 f0→fc + 土壤蓄水库动态扣（四条退水去路的第一条）。
    runoff_rate = (rain_mps * C_RUNOFF[lc]).astype("float32")
    runoff_rate = np.where(lc == 0, 0.0, runoff_rate)
    f0_mps = (INFIL_F0[lc] / 1000.0 / 3600.0).astype("float32")
    fc_mps = (INFIL_FC[lc] / 1000.0 / 3600.0).astype("float32")
    soil_cap_mm = INFIL_CAP[lc].astype("float32")
    soil_left = soil_cap_mm.copy()               # 开局土壤是干的，蓄水库满
    et_mps = float(args.et_mm_h) / 1000.0 / 3600.0
    log(f"      雨强 {args.p_mm_h:.0f} mm/h = {rain_mps*1000:.4f} mm/s；"
        f"雨型 {args.hyetograph}；下渗 f0→fc + 蓄水库（{float(soil_cap_mm.max()):.0f} mm）")

    # ---- 初始状态 ----
    # 【河道怎么处理：这是全篇最要紧的一处】
    # 天真做法是让河格 h = river_level - z（河底 -7 m 就存 11 m 水）。
    # 但 inertial 格式的 h_flow 进通量分母，11 m 水深配陡岸坡降会一步给出
    # 300 m²/s 的单宽流量，dt 一拍就把整格排空 → nan。
    # 正确做法：Dirichlet 边界不存"真实水深"，而是把河格的**地形抬到水面高程**
    # （z = river_level，h = 0）。这样：
    #   · 河格之间水面差恒为 0，内部不流动；
    #   · 与陆地格之间水面差 = (h_land + z_land) - river_level，天然就是"堰流"；
    #   · 水位高于岸边地面时坡降自动变负，河水倒灌 —— 不需要任何补丁；
    #   · h=0 不进 dt 的 CFL，不拖累全局时间步。
    h = np.zeros_like(z, dtype="float32")
    river = (lc == 0)
    if river.any():
        zmod = np.where(river, np.float32(river_level), zmod)
    h[river] = 0.0
    log(f"      河道 {int(river.sum()):,} 格按 Dirichlet 处理（地形抬到水面 {river_level:.3f} m）")

    # 河格掩膜不参与降雨/产流/排水
    runoff_rate = np.where(river, 0.0, runoff_rate)

    qx = np.zeros_like(z, dtype="float32")   # qx[i,j] = 从 (i,j-1) 流向 (i,j) 的单宽流量
    qy = np.zeros_like(z, dtype="float32")   # qy[i,j] = 从 (i-1,j) 流向 (i,j)

    # ---- 边界 ----
    edge = np.zeros_like(z, dtype=bool)
    edge[0, :] = edge[-1, :] = True
    edge[:, 0] = edge[:, -1] = True
    edge_out = edge & (z <= float(args.edge_open_z)) & ~river
    log(f"      开边界 {int(edge_out.sum()):,} 格（≤{args.edge_open_z:.1f} m 才算出口）")

    # ---- 账本（统一四本账：进土 / 进空气 / 管道 / 入河，加边界与削平）----
    V_rain = 0.0
    V_drain = 0.0      # 管道输送
    V_seep = 0.0        # 下渗进土
    V_evap = 0.0        # 蒸散进空气
    V_edge = 0.0        # 开边界出域
    V_river = 0.0      # 正 = 河水倒灌，负 = 排进河
    V_clip = 0.0        # 超深削平（溢流进涵洞）

    # ---- 预计算（主循环里绝不再新建 190 万格的大数组）----
    # 这一步决定了能不能跑：numpy 每步多一次全域运算就是 4 ms，
    # 而 6 h 要上万步。所有不随 t 变的量全在这里算完。
    dz_x = (zmod[:, :-1] - zmod[:, 1:]).astype("float32")   # 正 = 左边地面高
    dz_y = (zmod[:-1, :] - zmod[1:, :]).astype("float32")
    n_x2 = (n_x * n_x).astype("float32")
    n_y2 = (n_y * n_y).astype("float32")
    inv_dx = np.float32(1.0 / dx)
    inv_dy = np.float32(1.0 / dy)

    land_f32 = (~river).astype("float32")
    edge_f32 = edge_out.astype("float32")
    inlet_f32 = (street & ~bld & ~river).astype("float32")
    roof_f32 = bld.astype("float32")
    ground_f32 = (~bld & ~river).astype("float32")
    drain_cap = (inlet_f32 * (30.0 / 1000.0 / 3600.0)).astype("float32")   # m/s

    # 管网服务率：雨强恒定 → 需求恒定 → 整个降雨期只有这一个数
    roof_need = float((runoff_rate * roof_f32).sum()) * cell_area
    street_need = float(drain_cap.sum()) * cell_area
    _need = roof_need + street_need
    served = min(1.0, float(args.drain_m3s) / _need) if _need > 1e-9 else 1.0
    log(f"      管网：屋顶落水管需求 {roof_need:6.1f} + 街面雨水口 {street_need:6.1f} "
        f"= {_need:6.1f} m³/s，能力 {args.drain_m3s:.0f} → 服务率 {served*100:.1f}%")
    # 屋顶被接走 served，剩下的溢流到地面；地面产流全部留在地表
    mix = (ground_f32 + roof_f32 * np.float32(1.0 - served)).astype("float32")
    runoff_add = (runoff_rate * mix).astype("float32")        # m/s，每步乘 dt
    # 收入侧必须记「全部产流」，包含被落水管直接接走的那部分，
    # 否则 in 少算 served 那一块，闭合差会出现 −served 量级的假缺口（实测 −47.9%）。
    runoff_total_sum = float((runoff_rate * land_f32).sum())

    # ---- 管网满管桶（统一退水的第三条去路，能力随降雨逐步衰减 / 雨停恢复）----
    drain_area = float((inlet_f32 > 0).sum()) * cell_area
    bucket_cap = max(0.0, float(args.drain_fail_after_mm) / 1000.0 * drain_area)
    residual = float(np.clip(args.drain_residual, 0.0, 1.0))
    tau_rec = max(1.0, float(args.drain_recover_h) * 3600.0)
    tau_soil = max(1.0, float(args.soil_recover_h) * 3600.0)
    budget_used = 0.0
    log(f"      管网调蓄桶 {bucket_cap/1e3:.1f} 千 m³（{args.drain_fail_after_mm:g} mm）× "
        f"residual {residual:g}，放空 τ={args.drain_recover_h:g} h；土壤回补 τ={args.soil_recover_h:g} h")

    # ---- 统一时间轴：一天 0:00→24:00，降雨窗口落在 17:00（可配）----
    t_end = float(args.day_minutes) * 60.0
    rain_start = float(args.rain_start_min) * 60.0
    rain_end = rain_start + float(args.dur_h) * 3600.0
    if rain_end > t_end:
        raise SystemExit(f"降雨窗口 {rain_end/60:.0f} min 超出时间轴 {t_end/60:.0f} min")
    # 雨型：形状函数按「整场平均雨强 = p_mm_h」归一化，∫shape = 1（窗口内）
    SHAPE_NODES = {
        "uniform": ([0.0, 1.0], [1.0, 1.0]),
        "peak": ([0.0, 0.55, 0.67, 1.0], [0.08, 2.6, 2.6, 0.06]),
        "pulse": ([0.0, 0.10, 0.22, 0.34, 0.46, 0.55, 0.62, 0.78, 1.0],
                  [0.06, 0.50, 2.80, 0.12, 0.08, 2.20, 3.80, 0.10, 0.03]),
        "front": ([0.0, 0.30, 0.62, 0.85, 1.0], [0.05, 0.25, 1.20, 3.60, 0.90]),
        # 【全天雨型】配 --rain-start-min 0 --dur-h 24 用：0:00→24:00 一直在下，
        # 夜里弱、午后转强、18:00 达到峰值，之后再缓落。**最低不为 0** ——
        # 用户要的是「从头到尾都在下雨」，所以整条曲线没有一段是干的。
        # 峰值 ≈ 2.9 × 平均雨强（归一化后），18:00 左右落峰，正好压在
        # 17:52–18:35 那段人物故事上。
        "day": ([0.00, 0.08, 0.17, 0.29, 0.42, 0.54, 0.63, 0.71, 0.75, 0.79, 0.85, 0.92, 1.00],
                [0.55, 0.40, 0.35, 0.35, 0.45, 0.70, 1.10, 2.20, 3.20, 2.60, 1.40, 0.80, 0.60]),
    }
    _nx, _nv = SHAPE_NODES[args.hyetograph]
    _us = np.linspace(0.0, 1.0, 401)
    _sn = np.interp(_us, _nx, _nv)
    shape_norm = max(1e-9, float(_sn.mean()))

    def rain_scale_at(tt):
        if tt < rain_start or tt >= rain_end:
            return 0.0
        u = (tt - rain_start) / (rain_end - rain_start)
        return float(np.interp(u, _nx, _nv)) / shape_norm

    # 降雨前全城是干的：不浪费上万步去算空场，直接从降雨窗口起点起算。
    # 时间轴 0..rain_start 由一张 t=0 的全干帧代表（showMinute 会选中它）。
    t = rain_start
    step = 0
    frames = []
    stats = []
    peak = np.zeros_like(h)
    peak_t = 0.0
    next_frame = rain_start
    frame_dir = os.path.join(args.out, "frames")
    frame_list = []
    if args.frames:
        os.makedirs(frame_dir, exist_ok=True)

    def _save_frame(fi, arr):
        """u8 量化落盘（开方量化）。

        【为什么要开方】线性量化到 4 m 量程时，1 cm 的水只占 1 个灰度级，
        在 shader 里要么被 discard、要么 alpha 极低 —— 城市尺度上整层水看不见。
        开方后 t = sqrt(d/scale)：1 cm → 13 级、10 cm → 40 级、50 cm → 90 级，
        浅水段的对比度被拉开，深水段仍然够用（1 m → 127 级）。
        shader 侧用 pow(t, 2.0) 还原，depthAt 同步。
        """
        q = np.clip(arr / float(args.depth_scale), 0.0, 1.0) ** 0.5 * 255.0
        u8 = np.clip(q, 0, 255).astype("uint8")
        fn = "f%03d.u8" % fi
        u8.tofile(os.path.join(frame_dir, fn))
        return fn

    # 【统一内核】只保留一条口径：numba inertial + 四条退水去路。
    # 旧的 numpy 对照分支已删除 —— 两套实现口径必然漂移（雨停后 served 语义
    # 就曾不一致），留着只会再出一个「哪个才是对的」问题。
    if not HAVE_NUMBA:
        raise SystemExit(f"统一内核需要 numba：{_NUMBA_ERR}")
    log("      内核：统一 inertial（numba，首次调用要编译 10~30 s）")
    core = SweCore(h, zmod, dz_x, dz_y, n_x2, n_y2, runoff_add,
                   inlet_f32, drain_cap, river.astype("float32"),
                   land_f32, edge_f32, dx, dy,
                   args.s_max, args.h_min, 1.0, served,
                   h_cap=args.h_cap, threads=(args.threads or None),
                   f0_mps=f0_mps, fc_mps=fc_mps,
                   soil_cap_mm=soil_cap_mm, soil_left=soil_left,
                   et_mps=et_mps)

    log("[2/6] 时间推进（统一 inertial + 四条退水去路）…")
    # 时间轴 0..rain_start 全城是干的，不浪费上万步算空场：用一张 t=0 的
    # 全干帧代表。前端 showMinute 会把这段里任意时刻都选到它（水深恒 0，正确）。
    if args.frames:
        zero = np.zeros_like(h)
        frame_list.append({"file": _save_frame(0, zero),
                           "t_min": 0.0, "river": round(river_level, 3),
                           "wet_ha": 0.0, "max_h": 0.0})
        stats.append(dict(t_min=0.0, dt=0.0, river=round(river_level, 3),
                         wet_ha=0.0, max_h=0.0, street_km=0.0, bld_hit=0))
    dt_base = 1.0
    river_any = bool(river.any())
    edge_any = bool(edge_out.any())
    inlet_any = bool(inlet_f32.any())
    take = np.zeros_like(h)          # 复用缓冲，避免每步 malloc 7.6 MB
    tot = np.zeros_like(h)
    sc_buf = np.ones_like(h)
    sdt = np.float32(1.0)
    while t < t_end - 1e-6 and step < args.max_steps:
        # --- dt：每 5 步重估；用 1/16 稀疏采样的 P99.5 ---
        # 单格深坑（井盖、河道边）不该把全局步长卡死；
        # 采样 12 万点算 percentile 只要 2 ms，比全域 max 还便宜。
        if step % 5 == 0:
            hs = h.ravel()[::16]
            hm = min(float(np.percentile(hs, 99.5)), 2.0)
            dt_base = min(float(args.dt_max), float(args.cfl) * res / np.sqrt(G * max(hm, 0.05)))
        dt = min(dt_base, t_end - t)
        dtf = np.float32(dt)
        gdt = np.float32(G) * dtf
        cx = np.float32(dx / dt)
        cy = np.float32(dy / dt)

        # ================= 推进（统一内核，四条退水去路同一步算完）=================
        raining = rain_start <= t < rain_end
        x_first = (step % 2 == 0)
        # 当前时刻的河道水位相对 t=0 的涨落量。
        # 【统一增水/退水】常数增水会让河 24 h 一直顶在峰值，城里的水排不进河，
        # 退水被严重高估（实测残留 42%）。真实风暴是「涨潮顶托 → 峰 → 退潮」，
        # 所以给增水也做一条过程线：降雨窗口内一个小峰，雨停后按 τ 指数回落。
        dl = 0.0
        if surf_ts is not None:
            # t 是「一天中的绝对秒」，潮位序列按「降雨开始后的相对秒」取，
            # 否则 17:00 起算会把序列直接推到 65 h 之外。
            dl = float(np.interp(surf_t0 + (t - rain_start), surf_ts, surf_vs)) - river_level
        elif args.surge_recede_h > 0 and args.surge_m > 0:
            if t <= rain_end:
                u = (t - rain_start) / max(1.0, rain_end - rain_start)
                dl = args.surge_m * 0.18 * float(np.sin(np.pi * u))
            else:
                dl = -args.surge_m * (1.0 - float(np.exp(-(t - rain_end) / (args.surge_recede_h * 3600.0))))
        rscale = rain_scale_at(t)

        # 管网满管桶：降雨期按已占用调蓄预算逐步降低能力，雨停后按 τ 放空。
        # 这一步把「恒定 30 mm/h 永不失效」的旧 bug 换掉，也让退水速率真实地
        # 依赖雨停了多久（旧内核 drain_recover_h 的语义）。
        if bucket_cap > 0.0:
            bfrac = min(1.0, max(0.0, budget_used) / bucket_cap)
            served_now = residual + (1.0 - residual) * (1.0 - bfrac)
        else:
            served_now = served
        if raining:
            V_rain += runoff_total_sum * rscale * cell_area * dt
            # 屋顶被落水管直接接走的那部分不进地表，但它是管网的收入，必须记账
            V_drain += roof_need * served * rscale * dt
        soil_rec = 0.0 if raining else float(1.0 - np.exp(-dt / tau_soil))

        core.edge_rel = min(1.0, dt / float(args.edge_tau_s))
        dvd, dve, dvr, dcp, dsp, dev = core.step(
            dt, raining, x_first, cell_area, dl=dl,
            rain_scale=rscale, served_now=served_now, soil_rec_step=soil_rec)
        V_drain += dvd                    # 管道输送
        V_seep += dsp                     # 下渗进土
        V_evap += dev                     # 蒸散进空气
        V_edge += dve                      # 开边界
        V_river -= dvr                     # dvr>0 = 排进河；<0 = 河水倒灌
        V_clip += dcp                      # 超深削平（溢流进涵洞）
        if raining and bucket_cap > 0.0:
            budget_used += roof_need * served * rscale * dt + dvd
        elif not raining and budget_used > 0.0:
            budget_used *= float(np.exp(-dt / tau_rec))
            if budget_used < 1e-6:
                budget_used = 0.0

        # 【已删除】旧 numpy 对照分支：统一内核只保留 numba 一条口径，
        # 留着两套实现必然口径漂移（雨停后 served 语义就曾不一致）。

        t += dt
        step += 1
        if step % 10 == 0:
            np.maximum(peak, h, out=peak)
        if args.dbg:
            if not np.isfinite(h).all():
                bad = ~np.isfinite(h)
                r, c = np.unravel_index(np.argmax(bad), h.shape)
                log(f"        [!!] step {step} t={t:.1f} 出现 NaN/Inf，首格 ({r},{c}) "
                    f"zmod={float(zmod[r, c]):.2f} dt={dt} h={h[r, c]}")
                break
        if args.dbg and step % 10 == 0:
            r, c = np.unravel_index(np.argmax(h), h.shape)
            nb = []
            for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                rr, cc = r + dr, c + dc
                if 0 <= rr < h.shape[0] and 0 <= cc < h.shape[1]:
                    nb.append(f"h{dr:+d}{dc:+d}={h[rr, cc]:.3f}/z={zmod[rr, cc]:.2f}")
            log(f"        [dbg] step {step} t={t:6.1f} dt={dt:5.2f} hmax={float(h[r, c]):10.3f} "
                f"@({r},{c}) z={zmod[r, c]:.2f} lc={lc[r, c]} bld={bool(bld[r, c])} "
                f"str={bool(street[r, c])} | " + "  ".join(nb))

        while t >= next_frame and next_frame <= t_end + 1e-6:
            peak = np.maximum(peak, h)
            if float(h.max()) > peak_t:
                peak_t = float(h.max())
            ft = round(next_frame / 60.0, 1)
            wet = (h > 0.01)
            stat = dict(t_min=ft, dt=round(dt, 2),
                        river=round(river_level + dl, 3),
                        wet_ha=round(float(wet.sum()) * cell_area / 1e4, 2),
                        max_h=round(float(h.max()), 3),
                        street_km=round(float((wet & street).sum()) * res / 1000.0, 2),
                        bld_hit=int((wet & bld).sum()))
            stats.append(stat)
            if args.frames:
                frame_list.append({"file": _save_frame(len(frame_list), h),
                                   "t_min": ft,
                                   "river": round(river_level + dl, 3),
                                   "wet_ha": stat["wet_ha"], "max_h": stat["max_h"]})
            if step % 200 == 0 or t >= t_end - 1e-6:
                log(f"      t={ft:7.1f} min  dt={dt:5.2f}s  wet={stat['wet_ha']:8.2f} ha  "
                    f"hmax={stat['max_h']:5.2f} m  淹路 {stat['street_km']:6.2f} km")
            next_frame += max(args.frame_min, 1.0) * 60.0

    # 补一张时间轴终点帧（拖到 24:00 时不会停在倒数第二帧）
    if args.frames and frame_list and frame_list[-1]["t_min"] < args.day_minutes - 0.5:
        wet = (h > 0.01)
        frame_list.append({"file": _save_frame(len(frame_list), h),
                           "t_min": float(args.day_minutes),
                           "river": round(river_level, 3),
                           "wet_ha": round(float(wet.sum()) * cell_area / 1e4, 2),
                           "max_h": round(float(h.max()), 3)})
        stats.append(dict(t_min=float(args.day_minutes), dt=0.0,
                          river=round(river_level, 3),
                          wet_ha=frame_list[-1]["wet_ha"],
                          max_h=frame_list[-1]["max_h"], street_km=0.0, bld_hit=0))
    log(f"[3/6] 推进结束：{step:,} 步，到 {t/60:.0f} min（一天 {args.day_minutes:.0f} min）"
        f"，墙钟 {time.time() - t_all:.1f}s")

    # ---- 体积闭合 ----
    # V_river 正 = 河水倒灌进来，负 = 水排进河
    V_now = float(h.sum()) * cell_area
    V_in = V_rain + max(0.0, V_river)
    V_out = (V_drain + V_seep + V_evap + V_edge + max(0.0, -V_river) + V_clip)
    log("[4/6] 体积账（统一四本账）")
    log(f"      降雨   {V_rain/1e6:9.3f} Mm³")
    log(f"      ① 下渗 {V_seep/1e6:9.3f}   ② 蒸散 {V_evap/1e6:9.3f}   "
        f"③ 管道 {V_drain/1e6:9.3f}   ④ 入河 {-V_river/1e6:9.3f}")
    log(f"      边界出流 {V_edge/1e6:8.3f}   倒灌 {max(0.0, V_river)/1e6:7.4f}   "
        f"削平 {V_clip/1e6:8.4f}")
    log(f"      剩余 {V_now/1e6:9.3f} Mm³   闭合差 {(V_in - V_out - V_now)/1e6:+.6f} Mm³ "
        f"（{100*(V_in - V_out - V_now)/max(V_in,1e-9):+.4f}%）")

    # ---- 形态诊断 ----
    log("[5/6] 形态诊断（峰值场）")
    min_cells = int(1e4 // cell_area)
    for thr in (0.01, 0.05, 0.15, 0.30):
        m = peak > thr
        nb, frac, big = wet_blocks(m, cell_area, min_cells)
        log(f"      >{thr*100:4.1f} cm：湿 {m.sum()*cell_area/1e4:8.1f} ha，"
            f"≥1 ha 块 {nb:4d}，最大块占 {frac*100:5.1f}%")

    # ---- 出图 ----
    log("[6/6] 出图")
    def _png(path, arr, lo, hi, cmap):
        a = np.clip((arr - lo) / max(hi - lo, 1e-9), 0, 1)
        idx = (a * (len(cmap) - 1)).astype("uint8")
        rgb = np.zeros(arr.shape + (3,), dtype="uint8")
        cm = np.array(cmap, dtype="uint8")
        for k in range(3):
            rgb[..., k] = cm[idx, k]
        Image.fromarray(rgb).save(path)

    _png(os.path.join(args.out, "peak.png"), peak, 0.0, 1.5,
         [(240, 244, 246), (150, 190, 230), (60, 120, 200), (20, 50, 140), (10, 10, 80)])
    nz = peak > 0.01
    log(f"      {os.path.join(args.out, 'peak.png')}  湿格 {int(nz.sum()):,}")

    if args.frames and frame_list:
        # 帧太多就等间隔抽稀（保留首尾）
        if len(frame_list) > args.max_frames:
            keep = np.unique(np.linspace(0, len(frame_list) - 1, args.max_frames).round().astype(int))
            kept = [frame_list[i] for i in keep]
            for k, fr in enumerate(kept):
                old = os.path.join(frame_dir, fr["file"])
                new = "k%03d.u8" % k
                os.replace(old, os.path.join(frame_dir, new))
                fr["file"] = new
            for f in os.listdir(frame_dir):
                if f.startswith("f") and os.path.join(frame_dir, f) not in \
                        [os.path.join(frame_dir, x["file"]) for x in kept]:
                    os.remove(os.path.join(frame_dir, f))
            frame_list = kept
        man = dict(step_m=int(res), x0=float(grid["x0"]), z0=float(-grid["y1"]),
                   cols=int(z.shape[1]), rows=int(z.shape[0]),
                   scale=float(args.depth_scale), quant_pow=2.0,
                   # 【统一时间轴】一天中的分钟，0:00→24:00；降雨窗口单独给
                   day_minutes=float(args.day_minutes),
                   rain_start_min=float(args.rain_start_min),
                   rain_end_min=float(rain_end / 60.0),
                   p_mm_h=float(args.p_mm_h),
                   surge_m=float(args.surge_m),
                   hyetograph=str(args.hyetograph),
                   source="unified/" + os.path.basename(args.out.rstrip("\\/")),
                   kernel="unified",
                   surge=(os.path.basename(args.surge_series) if args.surge_series
                          else f"{args.surge_m:g}m peak / recede {args.surge_recede_h:g}h"),
                   frames=frame_list)
        json.dump(man, open(os.path.join(frame_dir, "manifest.json"), "w", encoding="utf-8"),
                  ensure_ascii=False)
        mb = sum(os.path.getsize(os.path.join(frame_dir, f["file"])) for f in frame_list) / 1e6
        log(f"      帧序列 {len(frame_list)} 帧 / {mb:.1f} MB → {frame_dir}")
    np.savez_compressed(os.path.join(args.out, "state.npz"),
                        h=peak.astype("float16"), z=z, zmod=zmod,
                        street=street, bld=bld, lc=lc, res=np.int32(res),
                        x0=np.float32(grid["x0"]), y1=np.float32(grid["y1"]),
                        river_level=np.float32(river_level))
    with open(os.path.join(args.out, "stats.json"), "w", encoding="utf-8") as f:
        json.dump(dict(args=vars(args), frames=stats,
                       volume=dict(rain=V_rain, seep=V_seep, evap=V_evap,
                                   drain=V_drain, edge=V_edge, river=V_river,
                                   clip=V_clip, now=V_now,
                                   closure_pct=100 * (V_in - V_out - V_now) / max(V_in, 1e-9))),
                  f, ensure_ascii=False, indent=1)
    log(f"      完成，总耗时 {time.time() - t_all:.1f}s → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
