# -*- coding: utf-8 -*-
r"""从 tools\textures.json 生成材质库清单文档（含每张贴图的实测平均色）。

为什么要实测平均色：
    光看贴图 ID（Bricks005 / Facade003）根本看不出它是红砖还是灰泥。
    把一张图标配的平均 RGB 算出来，才能确认"低层给红砖"这套分配确实落在了暖色上。

产出:
    D:\Users\asus\Desktop\项目\材质库.md          人看的清单
    D:\Users\asus\Desktop\项目\tools\textures_measured.json   机器读的实测值

用法:
    python tools\make_tex_manifest.py
"""
import json
import os
import sys

from PIL import Image

WS = r"D:\Users\asus\Desktop\项目"
HERE = os.path.join(WS, "tools")
MANIFEST = os.path.join(HERE, "textures.json")


def color_file(root, asset):
    d = os.path.join(root, asset)
    if not os.path.isdir(d):
        return None
    for r, _dirs, files in os.walk(d):
        for f in sorted(files):
            if "Color" in f and f.lower().endswith((".jpg", ".jpeg", ".png")):
                return os.path.join(r, f)
    return None


def mean_rgb(path):
    """整幅平均色。缩到 64x64 再算，够准且快。"""
    im = Image.open(path).convert("RGB")
    im = im.resize((64, 64), Image.LANCZOS)
    px = list(im.getdata())
    n = float(len(px))
    return tuple(int(round(sum(p[i] for p in px) / n)) for i in range(3))


def main():
    with open(MANIFEST, "r", encoding="utf-8") as f:
        man = json.load(f)
    root = man["root"]

    measured = {}
    rows = []
    for cls, spec in man["lib"].items():
        for a in spec["assets"]:
            if a in measured:
                continue
            p = color_file(root, a)
            if not p:
                measured[a] = None
                continue
            rgb = mean_rgb(p)
            measured[a] = {"rgb": list(rgb),
                           "hex": "#%02x%02x%02x" % rgb,
                           "file": p,
                           "kb": os.path.getsize(p) // 1024}
            # 给一个"这个颜色像什么"的人话标签
            r, g, b = rgb
            if r > g + 25 and r > b + 35:
                tone = "暖红/砖红"
            elif r > 175 and g > 175 and b > 175:
                tone = "白/浅灰"
            elif abs(r - g) < 14 and abs(g - b) < 14:
                tone = "中性灰"
            elif b > r + 8:
                tone = "冷色/偏蓝"
            else:
                tone = "土黄/棕"
            measured[a]["tone"] = tone
            rows.append((cls, spec["label"], spec["tile_m"], a, rgb, tone))

    missing = [a for a, v in measured.items() if v is None]

    out_json = os.path.join(HERE, "textures_measured.json")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump({"schema": man["schema"], "root": root,
                   "measured": measured, "missing": missing},
                  f, ensure_ascii=False, indent=2)

    md = []
    md.append("# 城市仿真基座 · 材质库清单\n")
    md.append("给 `out\\dc_real3.blend`（22,009 栋建筑 + 24,835 条道路）贴现成纹理用的。")
    md.append("**不用大模型渲染，直接贴现成贴图。**\n")
    md.append("| 项 | 值 |")
    md.append("|---|---|")
    md.append("| 来源 | [ambientCG](%s) |" % man["source_url"])
    md.append("| **许可** | **%s** |" % man["license"])
    md.append("| 落盘位置 | `%s` |" % root)
    md.append("| 下载地址 | `%s` |" % man["download_url"])
    md.append("| 投影方式 | %s |" % man["projection"])
    md.append("| 类别数 / 贴图包数 | %d / %d |" % (len(man["lib"]), len(measured)))
    md.append("")
    md.append("> **CC0 意味着这套材质库可以随项目一起发、可以商用、可以改，不需要署名。**")
    md.append("> 这一点很重要 —— 它是这份资产能干净发布的全部理由。\n")
    md.append("## 关键：`tile_m` 是怎么定出来的\n")
    md.append("`tile_m` = 一张 1K 贴图在世界坐标里覆盖多少米。**必须打开贴图数清里面画了几个东西再反推，不能拍脑袋。**\n")
    md.append("| 例子 | 贴图里有什么 | 反推 | 第一版的错误 |")
    md.append("|---|---|---|---|")
    md.append("| `Facade003` | 一张 1K 图里有 **10×11 个窗格** | 按真实窗距 3.0 m → **一张 30 m** | 按 4 m 铺 = 每 0.4 m 一个窗，整面墙糊成噪点 |")
    md.append("| `Bricks051` | 一张 1K 图里有 **14 行砖** | 一行约 0.22 m → **一张 3.0 m** | 按 2.4 m 铺，偏小但接近 |")
    md.append("")
    md.append("## 材质分配表（实测平均色）\n")
    md.append("| 类别 | 用途 | 一张铺 | 贴图包 | 实测平均 RGB | 观感 |")
    md.append("|---|---|---|---|---|---|")
    for cls, label, tile, a, rgb, tone in rows:
        md.append("| `%s` | %s | %.1f m | `%s` | %s  `#%02x%02x%02x` | %s |"
                  % (cls, label, tile, a, rgb, rgb[0], rgb[1], rgb[2], tone))
    md.append("")
    md.append("## 按建筑高度自动分配\n")
    md.append("| 高度 | 外墙 | 屋顶 |")
    md.append("|---|---|---|")
    wbh = man.get("wall_by_height", {})
    for k in ("lt_16m", "16m_35m", "gte_35m"):
        md.append("| %s | %s | %s |" % (k, wbh.get(k, ""), wbh.get("roof_" + k, "")))
    md.append("")
    md.append("分配用 FNV-1a 名字哈希，**同一栋楼每次跑都得到同一个材质**，结果可复现。\n")
    md.append("## 没用上的包\n")
    for a, why in man.get("unused", {}).items():
        md.append("- `%s` —— %s" % (a, why))
    md.append("")
    md.append("## 已知限制（必须说清）\n")
    md.append("1. **贴图是按高度猜的，不是实测的。** DCGIS 和 OSM 里都没有每栋楼真实的墙面材质，")
    md.append("   现在这套是「低层红砖、高层玻璃」的常识分布，看起来对，但**具体某一栋是什么颜色我们不知道**。")
    md.append("2. **窗户是贴图印上去的，不是几何里的。** 贴着墙面走，但不对应真实开窗位置，贴近看会露。")
    md.append("3. 整个 CC0 生态里**没有「华盛顿连排屋：红砖 + 推拉窗 + 檐口」那种外墙贴图**，")
    md.append("   现成的幕墙贴图都是办公楼/公寓长相。这是硬结论。")
    if missing:
        md.append("")
        md.append("## 缺的贴图\n")
        md.append("跑 `python tools\\fetch_textures.py` 补下：" + "、".join("`%s`" % m for m in missing))
    md.append("")

    out_md = os.path.join(WS, "材质库.md")
    with open(out_md, "w", encoding="utf-8") as f:
        f.write("\n".join(md))

    print("写出 %s  (%d KB)" % (out_md, os.path.getsize(out_md) // 1024))
    print("写出 %s" % out_json)
    print("实测 %d 个贴图包；缺 %d 个" % (len(measured) - len(missing), len(missing)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
