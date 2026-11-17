"""megakit_prep.py — 从 MegaKit 里只取拼装要用的构件，贴图压到 512。

【为什么只取一部分】全包 153 个构件、29 张 2K 贴图。拼一栋楼只需要
墙段/窗/转角/檐口/屋顶这几类，其余是砖装饰、室内墙、路面板。按需取，首屏才动得起来。

【为什么要压贴图】构件是 2×3 m 的小块，2K 贴图在屏幕上永远用不到那个分辨率；
512 无损 PNG 已经绰绰有余，体积差 10 倍。

用法：
  python tools/megakit_prep.py            # 只取拼楼的最小集（线上用）
  python tools/megakit_prep.py --extra    # 追加变体/门/台阶/人行道/标线（图鉴与 Batch 2-3 用）
"""
import json
import os
import shutil
import sys

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "data", "characters", "Downtown City MegaKit[Standard]",
                   "Exports", "glTF (Godot)")
DST = os.path.join(ROOT, "web", "assets", "megakit")

# 拼一栋楼所需的最小集合
PARTS = [
    "Brick_Plain_3",          # 2×3 m 素墙段
    "Brick_Window_Square_Single",  # 2×3 m 带窗墙段（190 面，比 4 m 版的 488 面便宜 2.5 倍）
    "Brick_90Angle_L",        # 转角（左）
    "Brick_90Angle_R",        # 转角（右）
    "Cornice_Trim_Center",    # 檐口中段 2×1 m
    "Cornice_Trim_L",         # 檐口左端
    "Cornice_Trim_R",         # 檐口右端
    "Roof_4x4",               # 平屋顶 4×4
    "Roof_2x2",               # 平屋顶 2×2（补边）
    "Roof_Slate_Center",      # 坡屋顶 2×3×2
]

# 第二批：做同质化变体（1.3a）+ 街道细节（Batch 2）+ 可进入的入口（Batch 3）要用的
EXTRA = [
    # 墙材/窗型变体（同质化靠这些，不靠调色）
    "Brick_Plain_4",              # 另一种素墙段
    "Brick_Plain_3_noWear",       # 无磨损版，颜色更亮
    "Brick_Inset",                # 内凹墙面
    "Brick_Window_Trim_Single",   # 带窗套管
    "Brick_RedWhite_DoubleWindow",# 红白双窗（变化最大的一件）
    "Brick_Column_TrimBricks",    # 砖柱
    "Brick_TopTrim",              # 顶部砖带
    # 坡屋顶全套
    "Roof_Slate_Corner",
    "Roof_Slate_InnerCorner",
    "Roof_Slate_Window_1",
    "Roof_SlateCornice_Center",
    "Roof_SlateCornice_Corner",
    "Roof_2x2_90Angle_L",
    "Roof_2x2_90Angle_R",
    "Roof_2x2_90Angle_Center",
    # 门 / 台阶 / 入口
    "Door_1", "Door_2", "Door_3",
    "DoorFrame_Wooden", "DoorFrame_Trim", "DoorFrame_Metal_Single",
    "Stairs_Entrance_Concrete", "Entrance_Concrete_2x1", "Entrance_Concrete_2x2",
    "Stairs_Rails_Metal_Straight_1",
    # 人行道 / 标线 / 街道道具
    "Sidewalk_Straight_3m", "Sidewalk_Corner_Round_3m", "Sidewalk_NoCurb_3m",
    "Sidewalk_Planter",
    "Decal_Crosswalk", "Decal_Stop", "Decal_DoubleYellow_Straight",
    "Decal_ArrowStraight",
    "Prop_Drain", "Prop_ManholeCover", "Prop_Bollard", "Prop_ACUnit",
]
TEX_MAX = 512


def main():
    if not os.path.isdir(SRC):
        raise SystemExit("找不到 MegaKit 源目录：" + SRC)
    os.makedirs(DST, exist_ok=True)
    parts = PARTS + (EXTRA if "--extra" in sys.argv else [])

    # 1) 先扫出这些 gltf 实际引用哪些贴图
    need_tex = set()
    missing = []
    for name in parts:
        p = os.path.join(SRC, name + ".gltf")
        if not os.path.exists(p):
            missing.append(name)
            continue
        g = json.load(open(p, encoding="utf-8"))
        for im in g.get("images") or []:
            u = im.get("uri")
            if u:
                need_tex.add(os.path.basename(u))
    if missing:
        print("[warn] 缺构件：", missing)

    # 2) 拷 gltf + bin
    n_gltf = 0
    for name in parts:
        for ext in (".gltf", ".bin"):
            s = os.path.join(SRC, name + ext)
            if os.path.exists(s):
                shutil.copyfile(s, os.path.join(DST, name + ext))
                if ext == ".gltf":
                    n_gltf += 1

    # 3) 压贴图
    tot_in = tot_out = 0
    n_tex = 0
    for t in sorted(need_tex):
        s = os.path.join(SRC, t)
        if not os.path.exists(s):
            print("[warn] 缺贴图：", t)
            continue
        sz = os.path.getsize(s)
        tot_in += sz
        try:
            im = Image.open(s)
            if max(im.size) > TEX_MAX:
                im = im.resize((TEX_MAX, TEX_MAX), Image.LANCZOS)
            out = os.path.join(DST, t)
            # ORM / Normal 是数据图，必须无损
            im.save(out, optimize=True)
            tot_out += os.path.getsize(out)
            n_tex += 1
        except Exception as e:
            print("[err]", t, e)
            shutil.copyfile(s, os.path.join(DST, t))

    total = sum(os.path.getsize(os.path.join(DST, f)) for f in os.listdir(DST))
    print(f"构件 {n_gltf} 个 gltf / 贴图 {n_tex} 张")
    print(f"贴图 {tot_in/1e6:.1f} MB → {tot_out/1e6:.1f} MB")
    print(f"目录合计 {total/1e6:.1f} MB")


if __name__ == "__main__":
    main()
