#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 from muse 下所有唯一文献的正文提取成纯文本，供逐篇通读。
已提取过的不重复提取（按文件名判断）。失败逐条记录，不静默跳过。"""
import json, os, subprocess, sys, time

ROOT = r"D:/Users/asus/Desktop/项目/from muse"
OUT = os.path.join(ROOT, "_text_all")
SK = r"C:/Users/asus/AppData/Local/Programs/WorkBuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin/skills/workbuddy-pdf/scripts/run.sh"
os.makedirs(OUT, exist_ok=True)

items = json.load(open(os.path.join(ROOT, "_清单_唯一文献.json"), encoding="utf-8"))
ok, skip, fail = [], [], []
for i, it in enumerate(items, 1):
    src = os.path.join(ROOT, it["path"].lstrip("./").replace("/", os.sep))
    dst = os.path.join(OUT, os.path.basename(src) + ".txt")
    if os.path.exists(dst) and os.path.getsize(dst) > 2000:
        skip.append(it["path"]); continue
    t0 = time.time()
    try:
        r = subprocess.run(["sh", SK, src, dst, "-f", "txt", "-q"],
                           capture_output=True, timeout=180)
        sz = os.path.getsize(dst) if os.path.exists(dst) else 0
        if sz > 2000:
            ok.append((it["path"], sz, time.time() - t0))
            print("[%3d/%3d] OK   %7d B  %4.1fs  %s" % (i, len(items), sz, time.time()-t0, os.path.basename(src)), flush=True)
        else:
            fail.append((it["path"], "文本过短 %d B" % sz))
            print("[%3d/%3d] SHORT %6d B  %s" % (i, len(items), sz, os.path.basename(src)), flush=True)
    except Exception as e:
        fail.append((it["path"], str(e)[:80]))
        print("[%3d/%3d] FAIL  %s  %s" % (i, len(items), os.path.basename(src), str(e)[:60]), flush=True)

print("\n=== 汇总：新增 %d，已存 %d，失败 %d ===" % (len(ok), len(skip), len(fail)), flush=True)
for p, why in fail:
    print("  失败:", p, "|", why, flush=True)
json.dump({"ok": [a[0] for a in ok], "skip": skip, "fail": fail},
          open(os.path.join(ROOT, "_提取记录.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
