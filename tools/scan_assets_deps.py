# -*- coding: utf-8 -*-
"""扫描 blosm 安装目录，找出它真正依赖的 assets 文件名（不一定有默认值）。

打印：所有 BlosmPreferences / BlenderApp 里 *FileName / *Filepath / *Path 常量，
以及 realistic 模式下会去 load 的具体文件名。
"""
import inspect
import os
import re
import sys

ADDON = r"C:\Users\asus\AppData\Roaming\Blender Foundation\Blender\5.2\scripts\addons\blosm"
sys.path.insert(0, ADDON)

# 静态扫描：找 app/blender.py 里的类属性
p = os.path.join(ADDON, "app", "blender.py")
src = open(p, encoding="utf-8").read()

print("== class-level FileName/Path constants in app/blender.py ==")
for m in re.finditer(r"^\s{4}(\w+)\s*=\s*(\"[^\"]*\"|'[^']*')", src, re.M):
    name, val = m.group(1), m.group(2).strip("\"'")
    if any(k in name.lower() for k in ("file", "path", "dir", "asset")):
        print("  %-28s = %r" % (name, val))

print()
print("== dynamic scan of realistic/material/renderer.py for asset loads ==")
p2 = os.path.join(ADDON, "realistic", "material", "renderer.py")
src2 = open(p2, encoding="utf-8").read()
for i, line in enumerate(src2.splitlines(), 1):
    if "loadMaterialsFromFile" in line or "Filepath" in line or "asset" in line.lower():
        print("  %4d: %s" % (i, line.rstrip()))

print()
print("== realistic/renderer.py (area/forest/terrain) asset loads ==")
p3 = os.path.join(ADDON, "realistic", "renderer.py")
src3 = open(p3, encoding="utf-8").read()
for i, line in enumerate(src3.splitlines(), 1):
    if "Filepath" in line or "baseAssetPath" in line or "loadParticlesFromFile" in line:
        print("  %4d: %s" % (i, line.rstrip()))

print()
print("== setup/premium.py 用到的 Filepath ==")
p4 = os.path.join(ADDON, "setup", "premium.py")
src4 = open(p4, encoding="utf-8").read()
for i, line in enumerate(src4.splitlines(), 1):
    if "Filepath" in line:
        print("  %4d: %s" % (i, line.rstrip()))

print()
print("== validateAssetsDirContent 检查的文件名 ==")
for m in re.finditer(r"bldgMaterialsFileName|vegetationFileName", src):
    print("  app/blender.py:%d %s" % (src[:m.start()].count("\n") + 1, m.group(0)))
