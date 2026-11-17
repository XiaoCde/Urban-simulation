"""web/ 开发脚本归组 + kebab-case 改名 + 相对路径同步修正。

一次性脚本，可从 git 检查点 a7c98ae 完整回滚。
规则：
  web/tests/                 验收/回归脚本（含 smoke 与 trapped）
  web/devtools/probes/       一次性探针
  web/devtools/shots/        截图脚本
  web/devtools/diag/         诊断脚本
  web/devtools/misc/         其他开发工具
  web/sim/                   仿真与汇总

改名：去掉开头下划线，其余下划线换连字符（_check_floors.mjs → check-floors.mjs）。
路径：按目标深度把 ./src/, ./assets/, ../data/ 补上正确的 ../../ 前缀。
"""
from pathlib import Path
import shutil

WEB = Path(__file__).resolve().parent.parent / "web"
MAP = {}  # 旧名 -> 新相对路径

# ---------- 分组 ----------
groups = {
    "tests":            [p.name for p in WEB.glob("_check_*.mjs")] + ["_smoke_new.mjs", "test_trapped.mjs", "_audit_timeline.mjs"],
    "devtools/probes":  [p.name for p in WEB.glob("_probe_*.mjs")],
    "devtools/shots":   [p.name for p in WEB.glob("_shot*.mjs")] + ["shot_flood.mjs", "shot_page.mjs"],
    "devtools/diag":    [p.name for p in WEB.glob("_diag*.mjs")],
    "devtools/misc":    ["_console.mjs", "_draw_routes.mjs", "_make_city_map.mjs"],
    "sim":              ["_sim_day.mjs", "_sim_sweep.mjs", "_sweep_report.mjs"],
}

# 深度：web/ 子目录层数
DEPTH = {g: len(g.split("/")) for g in groups}

def new_name(old):
    n = old.lstrip("_")
    # 开头无下划线的（shot_flood.mjs / test_trapped.mjs）也把下划线换连字符
    return n.replace("_", "-")

# 校验无遗漏、无重名
all_old = [x for v in groups.values() for x in v]
assert len(all_old) == len(set(all_old)), "有文件被分到两组"
assert len(all_old) == 104, f"预期 104 个脚本，实际 {len(all_old)}"
assert set(all_old) == {p.name for p in WEB.glob("*.mjs")}, "分组未覆盖全部 .mjs"
new_all = [new_name(x) for x in all_old]
assert len(new_all) == len(set(new_all)), "改名后有重名"

# ---------- 路径修正 ----------
def fix_paths(text, depth, name):
    # 先处理更长的 '../data/'，避免被 './' 规则误伤
    if depth == 1:
        text = text.replace("'../data/", "'../../data/")
        text = text.replace('"../data/', '"../../data/')
        text = text.replace("'./src/", "'../src/")
        text = text.replace('"./src/', '"../src/')
        text = text.replace("'./assets/", "'../assets/")
        text = text.replace('"./assets/', '"../assets/')
    elif depth == 2:
        text = text.replace("'../data/", "'../../../data/")
        text = text.replace('"../data/', '"../../../data/')
        text = text.replace("'./src/", "'../../src/")
        text = text.replace('"./src/', '"../../src/')
        text = text.replace("'./assets/", "'../../assets/")
        text = text.replace('"./assets/', '"../../assets/')

    # _audit_timeline：ROOT = dirname(...) + '..' → 要再多退两级到项目根
    if name == "_audit_timeline.mjs":
        text = text.replace("import.meta.url)), '..');", "import.meta.url)), '..', '..', '..');")

    # _sim_sweep：HERE 从 web/ 变成 web/sim/，补一个 WEB 指向 web/
    if name == "_sim_sweep.mjs":
        text = text.replace("import { join, resolve } from 'node:path';",
                            "import { join, resolve, dirname } from 'node:path';")
        text = text.replace("const HERE = dirname(fileURLToPath(import.meta.url));",
                            "const HERE = dirname(fileURLToPath(import.meta.url));\n"
                            "const WEB = resolve(HERE, '..');   // 脚本已移到 web/sim/，web/ 根目录在上一级")
        # 所有 join(HERE,...) 里的资产/脚本/输出路径，以及 cwd，都改用 WEB
        text = text.replace("join(HERE, 'assets/flood'", "join(WEB, 'assets/flood'")
        text = text.replace("join(HERE, '_sim_day.mjs')", "join(WEB, 'sim/sim-day.mjs')")
        text = text.replace("const ROOT = HERE;", "const ROOT = WEB;")
        text = text.replace("{ cwd: HERE,", "{ cwd: WEB,")
        # OUTDIR 默认 resolve(HERE, 'out/sweep') 已经因 depth=2 的替换变成 resolve(HERE,'out/sweep') 保持不变，
        # 但 HERE 语义变了，显式指向 WEB
        text = text.replace("resolve(HERE, process.argv[6] || 'out/sweep')",
                            "resolve(WEB, process.argv[6] || 'out/sweep')")
        text = text.replace("resolve(HERE, 'out/sweep')", "resolve(WEB, 'out/sweep')")
    return text

# ---------- 执行 ----------
for group, names in groups.items():
    dst_dir = WEB / group
    dst_dir.mkdir(parents=True, exist_ok=True)
    for old in names:
        src = WEB / old
        assert src.exists(), f"缺少 {src}"
        text = src.read_text(encoding="utf-8")
        text = fix_paths(text, DEPTH[group], old)
        new = new_name(old)
        dst = dst_dir / new
        assert not dst.exists(), f"目标已存在 {dst}"
        dst.write_text(text, encoding="utf-8")
        MAP[old] = f"web/{group}/{new}"

for old in all_old:
    (WEB / old).unlink()

# ---------- 生成映射表供文档引用同步使用 ----------
doc = ["# web/ 脚本归组映射（2026-11-17）", "",
       "旧名 → 新路径。全部 104 个脚本，无删除。原文件备份在 `项目备份_整理前_20261117/`。", "",
       "| 旧文件名 | 新路径 |", "| --- | --- |"]
for old in sorted(all_old):
    doc.append(f"| `{old}` | `{MAP[old]}` |")
(WEB.parent / "docs" / "脚本归组映射.md").write_text("\n".join(doc) + "\n", encoding="utf-8")

print(f"归组完成：{len(MAP)} 个脚本")
for g in groups:
    print(f"  {g:20s} {len(groups[g]):3d}")
