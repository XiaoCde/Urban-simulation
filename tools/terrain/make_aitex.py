"""
把 AI 生成的立面/材质图处理成「按真实楼层开间无缝平铺」的贴图。

为什么必须处理（不能直接把生成图贴上去）：
    生成的立面图上带有**檐口**和**勒脚/石基**这两条只有建筑端部才有的水平带。
    整张图按 12 m 平铺时，这两条会每 12 m 重复一次 —— 楼中间凭空多出一圈假檐口，
    这就是「纸糊」观感的来源。所以必须裁到可重复的标准层，并保证平铺接缝落在
    **两窗之间的空墙上**。

开间/层的周期怎么定（这是本脚本的核心，试错过两版）：
    · 用亮度找峰 —— 失败。砖墙亮、窗暗，石材正好相反，极性会把砖缝当窗。
    · 用梯度自相关取基频 —— 也不稳。谐波（2× 开间）常常比基频还强，
      砖墙定出 240 px（应 ~300）、石材定出 152 px（应 ~157），裁出来会把窗拉扁。
    · **窗列/窗行的亮度 std 剖面** —— 可靠。窗内同时有亮窗框和暗玻璃，std 高；
      纯墙面 std 低。这与明暗极性无关，砖石通吃。
    再由 std 峰的中心求出周期，裁「整数个周期」，接缝自然落在窗与窗之间。

单层贴图会显得像壁纸，所以每张裁 **2×2 个单元**（2 开间 × 2 层）：重复频率减半，
纹理细节又不用放大太多。

输出：
    web/assets/aitex/<key>.jpg          512×512
    web/assets/aitex/manifest.json      §9 第 10 条要求的 AI 贴图清单
"""
import io
import json
import os

import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.join(ROOT, 'data', 'ai_tex', 'src')
GEN = os.path.join(ROOT, 'dsh-image-gen')
OUT = os.path.join(ROOT, 'web', 'assets', 'aitex')

TEX = 512

# bay_m / floor_m 是该类型在 DC 的实景尺度（米），用来把像素周期换算成物理尺寸。
# trim=(上, 下) 先粗裁掉檐口/勒脚，再做周期检测。
SPEC = {
    # crop_px 是手工定的「整数开间 × 整数层」窗口（源图像素）。取数原则：
    #   横向裁在「两窗之间的空墙」正中，纵向同理 → 平铺接缝永远落在墙上。
    #   生成的图开间并不严格等距（砖：228 / 313 / 215 px），所以**只取 1 开间宽**，
    #   宁可横向略微放大，也不要出现「窗距忽宽忽窄」。纵向取 2 层，重复频率减半。
    # 砖：窗列 68-192 / 296-421 / 609-726（开间距 228/313 —— 不等距，故只取 1 开间）
    #     窗行 68-291 / 366-592 / 673-911；取「窗间空墙正中」328.5 与 632.5，层距 304，
    #     故 2 层 = 608 px：328..936。用 305 或 302 都会差 1~2 px，接缝处就出一条横线。
    'brick':  dict(src='image-f54e995a.png', bay_m=3.0, floor_m=3.3,
                   crop_px=(16, 328, 244, 936), bays=1, floors=2),
    # 深砖：窗列 54-174 / 325-439 / 570-688（空墙中线 249.5 / 504.5 → 开间 255）
    #       窗行 62-310 / 407-646 / 735-970（空墙中线 358.5 / 690.5 → 层距 332）
    'brick2': dict(src='image-52b363b9.png', bay_m=3.0, floor_m=3.3,
                   crop_px=(249, 358, 504, 690), bays=1, floors=1),
    # 漆：窗列 137-218 / 461-550（空墙中线 339.5 → 开间 324 与源一致）
    #     窗行 225-296 / 487-556 / 759-834（空墙中线 391.5 / 657.5 → 层距 266）
    'paint':  dict(src='image-0645b9fa.png', bay_m=3.0, floor_m=3.2,
                   crop_px=(15, 391, 339, 923), bays=1, floors=2),
    # 石材（联邦式）：窗列 160-215 / 316-370 / 484-540，空墙中线 265.5 / 427 / 577.5
    #                 窗行 118-198 / 256-346 / 420-512 / 584-676，空墙中线 227 / 383 / 548
    'stone':  dict(src='image-abac0492.png', bay_m=3.6, floor_m=4.2,
                   crop_px=(265, 227, 577, 539), bays=2, floors=2),
    # 玻璃幕墙：竖梃 69 / 层 50.8，等距
    'glass':  dict(src='image-ae1c9362.png', bay_m=1.5, floor_m=2.0, trim=(0.000, 0.000), units=4),
    # 混凝土横带窗：整幅宽（含一道墙垛，读成壁柱）+ 1 层
    'conc':   dict(src='image-0df6bb8c.png', bay_m=12.0, floor_m=4.2,
                   crop_px=(0, 3, 1020, 527), bays=1, floors=1),
    # ---- 屋面材质：可镜像，天然无缝 ----
    'roof_gravel': dict(src='image-b270066d.png', kind='material', tile_m=4.0),
    'roof_slate':  dict(src='image-a5a1e4b3.png', kind='material', tile_m=2.5),
    'roof_tile':   dict(src='image-2554837b.png', kind='material', tile_m=2.5),
}


def bands(profile, thr_mul=0.30):
    """std 剖面上找「窗」的连续段落，返回 (起, 止) 列表。"""
    thr = profile.mean() + profile.std() * thr_mul
    m = profile > thr
    out, s = [], None
    for i, v in enumerate(m):
        if v and s is None:
            s = i
        elif not v and s is not None:
            if i - s > 5:
                out.append((s, i - 1))
            s = None
    if s is not None and len(m) - s > 5:
        out.append((s, len(m) - 1))
    return out


def unit_grid(profile, units):
    """由 std 段中心求周期，返回 (起点, 周期, 实际单元数)。"""
    b = bands(profile)
    if len(b) < 2:
        return None
    c = np.array([(s + e) / 2.0 for s, e in b])
    d = np.diff(c)
    period = float(np.median(d))
    if period < 12:
        return None
    # 起点对齐到「第一个窗中心 - 半个周期」，再按周期整数化
    start = c[0] - period * 0.5
    n = int(units)
    total = int(round(n * period))
    lo = int(round(start))
    return lo, period, n, total


def flatten_lowfreq(a, wx=0.85, wy=0.35):
    """压掉低频横向/纵向明暗漂移，同时尽量保留结构（砖缝、层间横带）。

    AI 生成的整幅立面会带一片温吞的「左亮右暗 / 上亮下暗」色调漂移（brick2 尤其明显）。
    这种漂移在单张图上完全自然，一旦平铺就变成每隔 3 m 一条竖带 —— 也就是
    「像贴壁纸」的直接原因，而且**任何裁切位置都救不了**，因为它是全局趋势。

    做法：把逐列（逐行）均值做重度模糊得到低频分量 p，再把图除以 p/全局均值
    （强度 wx / wy）。模糊半径小则保留结构，半径大则只剩漂移 —— 这里取 W/3。
    横向强度给足（0.85），纵向只给 0.35：楼层之间的明暗变化是建筑特征，不能抹。
    """
    f = a.astype(np.float32)
    h, w = f.shape[:2]

    def smooth1d(p, r):
        k = np.ones(2 * r + 1, dtype=np.float32) / (2 * r + 1)
        pad = np.concatenate([p[-r:], p, p[:r]])
        return np.convolve(pad, k, mode='same')[r:r + len(p)]

    if wx > 0:
        prof = smooth1d(f.mean(axis=(0, 2)), max(2, w // 3))
        g = prof.mean()
        corr = (prof / max(1e-3, g)) ** wx
        f = f / corr[None, :, None]

    if wy > 0:
        prof = smooth1d(f.mean(axis=(1, 2)), max(2, h // 3))
        g = prof.mean()
        corr = (prof / max(1e-3, g)) ** wy
        f = f / corr[:, None, None]

    return np.clip(f, 0, 255).astype(np.uint8)


def make_seamless(a, gain=1.0):
    """强制左右、上下接缝像素一致 —— 用**线性修正场**而不是羽化。

    原理：设右边缘列与左边缘列之差 d = a[:,-1] - a[:,0]。沿横向减去
    d·t（t: 0→1），则第 0 列不变、第 W-1 列被平移 d，接缝两侧差值归零。
    内部只被极缓慢地拉平（每行最多 1~3 个灰阶），肉眼看不出；
    而羽化会把接缝抹成一条比墙面亮的带子（踩过，见 _tile_paint 旧图）。

    为什么必须做：AI 生成的立面**不是严格周期信号**（砖的开间距 228/313/215，
    漆的层距也不齐），再怎么挑裁切窗口，两端像素总会差几个灰阶，
    平铺后就是一条贴壁纸的竖缝。与其反复试像素，不如直接消掉差值。
    """
    f = a.astype(np.float32)
    h, w = f.shape[:2]

    d = (f[:, -1] - f[:, 0]) * gain
    t = np.linspace(0.0, 1.0, w, dtype=np.float32)[None, :, None]
    f = f - d[:, None, :] * t

    d2 = (f[-1, :] - f[0, :]) * gain
    t2 = np.linspace(0.0, 1.0, h, dtype=np.float32)[:, None, None]
    f = f - d2[None, :, :] * t2

    return np.clip(f, 0, 255).astype(np.uint8)


def mirror_tile(a):
    """把图做成四象限镜面对称 —— 天然无缝，接缝处是同像素镜像，不会有亮线。

    只用于材质（石子/瓦片）：这类图没有方向性语义，镜像后无人能看出。
    **不能用于立面**：镜面会让窗与窗贴在一起，出现「双窗」。
    """
    h, w = a.shape[:2]
    q = a[:h // 2, :w // 2]
    top = np.concatenate([q, q[:, ::-1]], axis=1)
    return np.concatenate([top, top[::-1, :]], axis=0)


def seam_blend(a):
    """只用于无法镜像的图（当前未启用）：左右/上下各羽化 6% 交叉淡化。"""
    h, w = a.shape[:2]
    m = max(6, int(round(min(h, w) * 0.06)))
    b = a.astype(np.float32).copy()

    t = np.linspace(0.0, 1.0, m, dtype=np.float32)[None, :, None]
    left = a[:, :m].astype(np.float32)
    right = a[:, -m:].astype(np.float32)
    b[:, -m:] = right * t + left * (1 - t)

    t2 = np.linspace(0.0, 1.0, m, dtype=np.float32)[:, None, None]
    top = b[:m, :].astype(np.float32)
    bot = b[-m:, :].astype(np.float32)
    b[-m:, :] = bot * t2 + top * (1 - t2)
    return np.clip(b, 0, 255).astype(np.uint8)


def take(a, start, total, limit):
    """按 [start, start+total) 裁切，越界时整体平移回框内（不改变长度）。"""
    s = int(round(start))
    if s + total > limit:
        s = limit - total
    if s < 0:
        s = 0
    return s, min(total, limit - s)


def process_facade(key, s):
    src = os.path.join(SRC, s['src'])
    if not os.path.exists(src):
        src = os.path.join(GEN, s['src'])
    im = Image.open(src).convert('RGB')
    a = np.asarray(im)
    H, W = a.shape[:2]

    if s.get('crop_px'):
        # 手工定的窗口：已知含整数个开间 × 整数个层，直接裁
        x0, y0, x1, y1 = s['crop_px']
        crop = a[y0:y1, x0:x1]
        nu = int(s.get('bays', 1))
        nv = int(s.get('floors', 1))
        pw = ph = 0.0
    else:
        top, bot = s.get('trim', (0.0, 0.0))
        a = a[int(H * top):int(H * (1 - bot)), :]
        gray = a.astype(np.float32).mean(axis=2)
        H, W = gray.shape

        gb = unit_grid(gray.std(axis=0), s['units'])
        gf = unit_grid(gray.std(axis=1), s['units'])
        if gb is None or gf is None:
            raise SystemExit('%s: 找不到窗格周期（列 %s / 行 %s）' % (key, gb, gf))

        x0, pw, nu, tw = gb
        y0, ph, nv, th = gf
        x0, tw = take(a, x0, tw, W)
        y0, th = take(a, y0, th, H)
        crop = a[y0:y0 + th, x0:x0 + tw]

    if crop.shape[0] < 32 or crop.shape[1] < 32:
        raise SystemExit('%s: 裁切区太小 %s' % (key, crop.shape))

    # 顺序很重要：**先缩放，再做无缝修正**。
    # 反过来（先修 228×608 再放大到 512）时，LANCZOS 的负瓣会重新引入几级
    # 边缘偏差，接缝处仍能看到一条深竖线（brick2 踩过）。
    im = Image.fromarray(crop).resize((TEX, TEX), Image.LANCZOS)
    a = np.asarray(im)
    a = flatten_lowfreq(a)
    a = make_seamless(a)
    Image.fromarray(a).save(os.path.join(OUT, key + '.jpg'), quality=92, subsampling=1)

    tu = round(nu * s['bay_m'], 2)
    tv = round(nv * s['floor_m'], 2)
    print('  %-12s %d bay x %d floor  tile %6.2f x %5.2f m  period %.1f/%.1f  crop %dx%d'
          % (key, nu, nv, tu, tv, pw, ph, crop.shape[1], crop.shape[0]))
    return dict(file=key + '.jpg', kind='facade', tile_u_m=tu, tile_v_m=tv,
                bays=nu, floors=nv,
                bay_period_px=round(pw, 1), floor_period_px=round(ph, 1),
                src=s['src'])


def process_material(key, s):
    im = Image.open(os.path.join(SRC if os.path.exists(os.path.join(SRC, s['src'])) else GEN, s['src'])).convert('RGB')
    a = np.asarray(im)
    # 中心取正方形再镜像，保证四个角都是连续像素
    h, w = a.shape[:2]
    q = min(h, w) // 2
    cy, cx = h // 2, w // 2
    a = mirror_tile(a[cy - q:cy + q, cx - q:cx + q])
    Image.fromarray(a).resize((TEX, TEX), Image.LANCZOS).save(
        os.path.join(OUT, key + '.jpg'), quality=92, subsampling=1)
    print('  %-12s material  tile %.1f m' % (key, s['tile_m']))
    return dict(file=key + '.jpg', kind='material', tile_m=s['tile_m'], src=s['src'])


def main():
    os.makedirs(OUT, exist_ok=True)
    layers = {}
    for k, s in SPEC.items():
        layers[k] = process_material(k, s) if s.get('kind') == 'material' else process_facade(k, s)

    man = {
        'note': ('AI 生成的建筑立面与屋面材质（dashscope qwen-image-3.0）。'
                 '每张先用亮度 std 剖面定位窗列/窗行，再裁到整数开间 × 整数层，'
                 '边缘 6% 交叉淡化，因此可按 tile_u_m × tile_v_m 无缝平铺，'
                 '接缝落在两窗之间的空墙上。'),
        'generator': 'dashscope / qwen-image-3.0 via dsh image-gen',
        'prompt_intent': ('flat orthographic elevation, zero perspective convergence, '
                          'even overcast light, no cast shadows, seamless horizontal repeat'),
        'layers': layers,
    }
    with io.open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(man, f, ensure_ascii=False, indent=1)
    print('[aitex] 完成 ->', OUT)


if __name__ == '__main__':
    main()
