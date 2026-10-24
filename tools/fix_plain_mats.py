# -*- coding: utf-8 -*-
r"""补漏：把 apply_textures.py 的 assign() 漏掉的那点东西也补上。

## 先记一个坑（这次差点把整城道路贴图改坏）

**blosm 给每个物体挂的是"物体级材质覆盖"（`slot.link == 'OBJECT'`）。**
所以：

    o.data.materials      -> ['wall', 'roof']            <- blosm 的原始材质，**不生效**
    o.material_slots[i]   -> tex_wall_brick__Bricks097   <- 真正生效的（assign() 写在这层）

`o.data.materials` 和 `o.material_slots` 在 link=OBJECT 时**是两层东西**。
第一版本脚本读的是 `o.data.materials`，于是：
  · 把 21,929 个 `tex_wall_*` 当成"名叫 wall 的纯色材质"重新分配了一遍
  · 把 26,137 个**本来已经是对的** `tex_*` 槽当成"空槽"重新填了一遍
    （道路首槽也在其中 —— 差一点把 24,673 条路从沥青改成砖墙）
判定"生效材质"**只能读 `o.material_slots`**。

顺带查清：`bpy.data.materials` 里那两个 `wall`(21,929 用户) / `roof`(21,928 用户)
是**被物体级覆盖遮住的僵尸材质**，不参与渲染、也不进 GLB，但会占着 `data.materials`。

## 本脚本实际要补的东西（实测只有这么点）

| 情形 | 实测数量 |
|---|---|
| 连材质槽都没有的物体 | 79 个 |
| 槽里挂着 OSM 颜色名材质（white/red/brown/gray/lightgray/十六进制色…） | ~37 个槽 |

**只动这两类，其余一概不碰**（判定基于 `o.material_slots`，幂等）。
贴图仍用 apply_textures.py 的 build_library()，材质做法完全一致。

用法:
    D:\blender\blender.exe --background --python tools\fix_plain_mats.py -- <输入.blend> [输出.blend]
"""
import importlib.util
import os
import sys

import bpy


def _tools_dir():
    try:
        return os.path.dirname(os.path.abspath(__file__))
    except NameError:
        return r"D:\Users\asus\Desktop\项目\tools"


def log(m):
    print("[plain] %s" % m, flush=True)


def load_apply():
    p = os.path.join(_tools_dir(), "apply_textures.py")
    spec = importlib.util.spec_from_file_location("_apply_tex_mod2", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def used_slots(o):
    """这个物体哪些槽位真的被几何引用。曲线/曲面只有槽 0。"""
    if o.type != "MESH":
        return {0}
    s = set()
    for p in o.data.polygons:
        s.add(p.material_index)
    return s


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if not argv:
        print(__doc__)
        return 1
    src = os.path.abspath(argv[0])
    dst = os.path.abspath(argv[1]) if len(argv) > 1 else None

    bpy.ops.wm.open_mainfile(filepath=src)
    log("载入 %s：物体 %d 个" % (os.path.basename(src), len(bpy.data.objects)))

    mod = load_apply()
    mod.build_library()

    # 记录一下改动前后，方便确认没误伤
    before = {}
    for k in ("asphalt", "pavement", "vegetation", "water", "grass"):
        before[k] = 0

    n_empty = n_plain = 0
    plain_names = {}
    for o in bpy.data.objects:
        if o.type not in ("MESH", "CURVE", "SURFACE"):
            continue
        slots = list(o.material_slots)

        # --- 情形 1：连材质槽都没有 ---
        if not slots:
            m = mod.pick_wall(o) or mod.pick_roof(o)
            if m is not None:
                o.data.materials.append(m)
                n_empty += 1
            continue

        used = used_slots(o)

        # --- 情形 2：槽里是纯色 / 未匹配 / 空 ---
        #     判定只读 o.material_slots（生效层），不读 o.data.materials
        for i, s in enumerate(slots):
            old = s.material
            if old is not None and old.name.startswith("tex_"):
                continue                       # 已经是贴图材质 -> 不动
            if old is None and i not in used:
                continue                       # 空槽且没有面用它 -> 不动

            # 拿网格级材质名当提示（blosm 的原名：wall / roof / white / road …）
            hint = old.name if old is not None else ""
            if not hint and i < len(o.data.materials) and o.data.materials[i] is not None:
                hint = o.data.materials[i].name
            h = hint.lower()
            if "roof" in h:
                new = mod.pick_roof(o)
            elif "road" in h or "path" in h or "rail" in h:
                new = mod.pick("asphalt", o)
            elif "area" in h:
                new = mod.pick("pavement", o)
            elif "vegetation" in h or "forest" in h:
                new = mod.pick("vegetation", o)
            elif "water" in h:
                new = mod.pick("water", o)
            elif "ground" in h:
                new = mod.pick("grass", o)
            else:
                new = mod.pick_wall(o) or mod.pick_roof(o)
            if new is None:
                continue
            s.material = new
            n_plain += 1
            plain_names[hint or "(空)"] = plain_names.get(hint or "(空)", 0) + 1

    log("补上无材质槽的物体：%d 个" % n_empty)
    log("替换纯色/未匹配/空槽：%d 个" % n_plain)
    for k, v in sorted(plain_names.items(), key=lambda kv: -kv[1])[:12]:
        log("   %-24s %d" % (k, v))

    # 复核：道路/人行道/植被/水 的贴图材质用户数应当没被误伤
    for k in ("asphalt", "pavement", "vegetation", "water", "grass"):
        tot = sum(m.users for m in bpy.data.materials
                  if m.name.startswith("tex_%s__" % k))
        log("复核 tex_%s__* 材质总用户数：%d" % (k, tot))

    if dst:
        bpy.ops.wm.save_as_mainfile(filepath=dst)
        log("已保存 %s（%.1f MB）" % (dst, os.path.getsize(dst) / 1048576))
    return 0


if __name__ == "__main__":
    sys.exit(main())
