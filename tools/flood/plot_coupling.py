"""plot_coupling.py — 画「河水位（增水/退水）vs 城区积水（涨/退）」的耦合曲线。

输入是 shallow2d 的 stats.json（每帧记了 t_min / wet_ha / river）。
三条线：河水位、湿面积、淹没道路。两个 y 轴。
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def font(sz):
    for f in ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf",
              "C:/Windows/Fonts/simsun.ttc"):
        if os.path.exists(f):
            try:
                return ImageFont.truetype(f, sz)
            except Exception:
                pass
    return ImageFont.load_default()


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "data/flood/sw2d_isabel/stats.json")
    dst = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "out/flood/coupling.png")
    os.makedirs(os.path.dirname(dst), exist_ok=True)

    st = json.load(open(src, encoding="utf-8"))
    fr = [f for f in st["frames"] if "river" in f]
    t = [f["t_min"] for f in fr]
    wet = [f["wet_ha"] for f in fr]
    riv = [f["river"] for f in fr]
    road = [f.get("street_km", 0) for f in fr]
    rain_min = float(st["args"]["dur_h"]) * 60

    W, H = 980, 470
    L, R, T, B = 78, 92, 56, 62
    pw, ph = W - L - R, H - T - B
    im = Image.new("RGB", (W, H), (252, 252, 250))
    dr = ImageDraw.Draw(im)
    f14, f13, f12 = font(15), font(13), font(12)

    tmax = max(t) or 1
    wmax = max(wet) or 1
    rmax = max(riv) or 1
    wtop = 1.0
    while wtop < wmax * 1.08:
        wtop *= 1.2
    rtop = 1.0
    while rtop < rmax * 1.08:
        rtop *= 1.2

    def X(v): return L + pw * v / tmax
    def Y1(v): return T + ph * (1 - v / wtop)
    def Y2(v): return T + ph * (1 - v / rtop)

    # 网格 + 左轴（湿面积）
    for k in range(6):
        v = wtop * k / 5
        y = Y1(v)
        dr.line([L, y, L + pw, y], fill=(232, 232, 228))
        dr.text((L - 8, y - 8), f"{v:.0f}", font=f12, fill=(90, 90, 90), anchor="ra")
    for k in range(7):
        v = tmax * k / 6
        x = X(v)
        dr.line([x, T, x, T + ph], fill=(240, 240, 236))
        dr.text((x, T + ph + 8), f"{v:.0f}", font=f12, fill=(90, 90, 90), anchor="ma")
    # 右轴（河水位）
    for k in range(6):
        v = rtop * k / 5
        y = Y2(v)
        dr.text((L + pw + 8, y - 8), f"{v:.1f}", font=f12, fill=(40, 90, 140), anchor="la")

    # 降雨段底色
    dr.rectangle([L, T, X(rain_min), T + ph], fill=(238, 244, 250))
    dr.text((X(rain_min) - 6, T + 6), "降雨结束", font=f12, fill=(110, 130, 150), anchor="ra")

    # 曲线
    dr.line([(X(a), Y1(b)) for a, b in zip(t, wet)], fill=(178, 60, 42), width=3)
    dr.line([(X(a), Y2(b)) for a, b in zip(t, riv)], fill=(40, 100, 160), width=3)
    dr.line([(X(a), Y1(b * wtop / max(max(road), 1e-9) * 0.0 + 0)) for a, b in zip(t, road)]
            if False else [(X(a), Y1(b)) for a, b in zip(t, road)],
            fill=(120, 120, 120), width=2)

    # 峰值标注
    iw = max(range(len(wet)), key=lambda i: wet[i])
    ir = max(range(len(riv)), key=lambda i: riv[i])
    dr.ellipse([X(t[iw]) - 5, Y1(wet[iw]) - 5, X(t[iw]) + 5, Y1(wet[iw]) + 5],
               fill=(178, 60, 42), outline=(255, 255, 255))
    dr.text((X(t[iw]) + 10, Y1(wet[iw]) - 26), f"积水峰值 {wet[iw]:.0f} ha @ {t[iw]:.0f} min",
            font=f13, fill=(178, 60, 42))
    dr.ellipse([X(t[ir]) - 5, Y2(riv[ir]) - 5, X(t[ir]) + 5, Y2(riv[ir]) + 5],
               fill=(40, 100, 160), outline=(255, 255, 255))
    dr.text((X(t[ir]) - 12, Y2(riv[ir]) - 30), f"潮位峰值 {riv[ir]:.2f} m @ {t[ir]:.0f} min",
            font=f13, fill=(40, 100, 160), anchor="ra")

    # 错峰区间
    if t[ir] > t[iw]:
        dr.line([X(t[iw]), Y1(wet[iw]), X(t[ir]), Y1(wet[iw])], fill=(150, 150, 150))
        dr.text(((X(t[iw]) + X(t[ir])) / 2, Y1(wet[iw]) + 8),
                f"错峰 {(t[ir]-t[iw])/60:.1f} h", font=f13, fill=(110, 110, 110), anchor="ma")

    # 标题与图例
    dr.text((L, 16), "河道水位（增水/退水）与城区积水（涨/退）的耦合", font=f14, fill=(30, 30, 30))
    lx = L + pw - 250
    dr.line([lx, 30, lx + 22, 30], fill=(178, 60, 42), width=3)
    dr.text((lx + 28, 22), "城区湿面积 (ha)", font=f12, fill=(178, 60, 42))
    dr.line([lx + 130, 30, lx + 152, 30], fill=(40, 100, 160), width=3)
    dr.text((lx + 158, 22), "河水位 (m)", font=f12, fill=(40, 100, 160))
    dr.text((L + pw / 2, H - 22), "时间 (min)", font=f13, fill=(70, 70, 70), anchor="ma")
    dr.text((14, T + ph / 2), "湿面积 ha", font=f12, fill=(178, 60, 42), anchor="lm")
    dr.text((W - 14, T + ph / 2), "河水位 m", font=f12, fill=(40, 100, 160), anchor="rm")

    im.save(dst)
    print(dst, f"{W}x{H}", f"积水峰 {wet[iw]:.0f} ha @ {t[iw]:.0f} min，"
          f"潮位峰 {riv[ir]:.2f} m @ {t[ir]:.0f} min，错峰 {(t[ir]-t[iw])/60:.1f} h")


if __name__ == "__main__":
    main()
