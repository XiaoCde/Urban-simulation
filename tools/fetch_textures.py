# -*- coding: utf-8 -*-
r"""按 tools\textures.json 把材质库需要的贴图从 ambientCG 下下来（可复现）。

为什么用 Python 而不是 curl：
    沙箱下 Windows 自带 curl 走 Schannel，取证书直接被拒：
        curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS
    Python 自带 OpenSSL 和证书，不受影响。

许可：ambientCG 全部是 CC0 1.0 Universal（公有领域）——
      可商用、可修改、可再分发，无需署名。所以这一整套材质库可以随项目一起发。

用法:
    python tools\fetch_textures.py          # 只补缺的（默认，秒级返回）
    python tools\fetch_textures.py --all    # 不管有没有，全部重下
"""
import json
import os
import sys
import time
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "textures.json")
GET = "https://ambientcg.com/get?file=%s_1K-JPG.zip"


def wanted(manifest):
    """清单里用到的所有贴图 ID（按出现顺序去重）。"""
    ids = []
    for cls in manifest["lib"].values():
        for a in cls["assets"]:
            if a not in ids:
                ids.append(a)
    return ids


def have(root, asset):
    d = os.path.join(root, asset)
    if not os.path.isdir(d):
        return False
    for _r, _dirs, files in os.walk(d):
        for f in files:
            if "Color" in f and f.lower().endswith((".jpg", ".jpeg", ".png")):
                return True
    return False


def fetch(url, dst):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=90) as r, open(dst, "wb") as f:
        while True:
            b = r.read(1024 * 256)
            if not b:
                break
            f.write(b)
    return os.path.getsize(dst)


def main():
    only_missing = "--all" not in sys.argv
    with open(MANIFEST, "r", encoding="utf-8") as f:
        man = json.load(f)
    root = man["root"]
    zdir = os.path.join(root, "_zips")
    os.makedirs(zdir, exist_ok=True)

    ids = wanted(man)
    print("材质库 %s：共 %d 个类别、%d 个贴图包" % (man["schema"], len(man["lib"]), len(ids)))
    print("目标目录 %s（%s）" % (root, man["license"]))
    print("")

    done = skipped = failed = 0
    t0 = time.time()
    for i, a in enumerate(ids, 1):
        if only_missing and have(root, a):
            skipped += 1
            print("  [%2d/%2d] %-20s 已有，跳过" % (i, len(ids), a), flush=True)
            continue
        zp = os.path.join(zdir, "%s_1K-JPG.zip" % a)
        url = GET % a
        try:
            if not os.path.isfile(zp) or os.path.getsize(zp) == 0:
                n = fetch(url, zp)
            else:
                n = os.path.getsize(zp)
            with zipfile.ZipFile(zp) as z:
                z.extractall(os.path.join(root, a))
            done += 1
            print("  [%2d/%2d] %-20s OK  %.1f KB" % (i, len(ids), a, n / 1024.0), flush=True)
        except Exception as e:
            failed += 1
            print("  [%2d/%2d] %-20s 失败: %s: %s" % (i, len(ids), a, type(e).__name__, e), flush=True)

    print("")
    print("完成：新下 %d，已存在 %d，失败 %d，用时 %.0f 秒" % (done, skipped, failed, time.time() - t0))
    if failed:
        print("有失败的包，重跑本脚本即可断点补下。")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
