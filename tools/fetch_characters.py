# -*- coding: utf-8 -*-
r"""Day 1.1 —— 把可用的「带骨骼 + 自带行走动画」的角色模型拿到本地。

为什么先用这几条而不是 Mixamo：
    Mixamo 要登录 Adobe 账号，脚本拿不到。而下面这几个是**已经配好骨骼和动画**
    的公开模型，托管在 GitHub / CDN 上，不用登录：
      - Soldier.glb   three.js 官方示例，真人比例士兵，带 Idle / Walk / Run 三段动画
      - Xbot.glb      three.js 官方示例（Mixamo 的 X Bot 导出），带 idle / walk / run
      - CesiumMan.glb Khronos 官方示例，带 walk 动画
    三选一能跑通 Day 1 就够；Mixamo 那批留给后面做角色多样性。

注意：这些是**示例模型**，许可各不相同（three.js 里 Soldier/Xbot 来自 Mixamo，
Adobe 免费给用但不是 CC0）。真要对外发布前要逐个核许可，脚本会把来源 URL 打出来。

用法:
    python tools\fetch_characters.py            # 探测 + 下载缺的
    python tools\fetch_characters.py --probe    # 只探测，不下载
"""
import os
import sys
import urllib.request

DEST = r"D:\Users\asus\Desktop\项目\data\characters"

# jsdelivr 在国内通常比 raw.githubusercontent.com 通得快，放前面当镜像。
CANDIDATES = [
    dict(
        name="Soldier.glb",
        note="真人比例士兵，带 Idle / Walk / Run 三段动画（首选）",
        urls=[
            "https://cdn.jsdelivr.net/gh/mrdoob/three.js@dev/examples/models/gltf/Soldier.glb",
            "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/Soldier.glb",
            "https://fastly.jsdelivr.net/gh/mrdoob/three.js@dev/examples/models/gltf/Soldier.glb",
        ],
    ),
    dict(
        name="Xbot.glb",
        note="Mixamo X Bot 导出版，带 idle / walk / run（最干净的人形）",
        urls=[
            "https://cdn.jsdelivr.net/gh/mrdoob/three.js@dev/examples/models/gltf/Xbot.glb",
            "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/Xbot.glb",
            "https://fastly.jsdelivr.net/gh/mrdoob/three.js@dev/examples/models/gltf/Xbot.glb",
        ],
    ),
    dict(
        name="CesiumMan.glb",
        note="Khronos 官方示例，带 walk 动画（兜底）",
        urls=[
            "https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets@main/Models/CesiumMan/glTF-Binary/CesiumMan.glb",
            "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/CesiumMan/glTF-Binary/CesiumMan.glb",
        ],
    ),
]

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-day1/1.0"}


def probe(url, timeout=20):
    """返回 (ok, 说明)。只读响应头/前若干字节，不下整包。"""
    try:
        req = urllib.request.Request(url, headers=UA, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            head = r.read(2048)
            cl = r.headers.get("Content-Length")
            total = int(cl) if cl and cl.isdigit() else None
            return True, "HTTP %s  已读 %d 字节  总长 %s" % (
                r.status, len(head), ("%.1f MB" % (total / 1048576.0)) if total else "未知")
    except Exception as e:
        return False, "%s: %s" % (type(e).__name__, e)


def download(url, path, timeout=60):
    """分段读，边下边报进度（大文件在慢链路上能看出是在动还是卡死）。"""
    req = urllib.request.Request(url, headers=UA)
    got = 0
    with urllib.request.urlopen(req, timeout=timeout) as r, open(path, "wb") as f:
        total = r.headers.get("Content-Length")
        total = int(total) if total and total.isdigit() else None
        while True:
            chunk = r.read(262144)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if total and got % (4 * 262144) < 262144:
                pct = 100.0 * got / total
                print("      %5.1f%%  %6.1f / %.1f MB" % (pct, got / 1048576.0, total / 1048576.0))
    return got


def main():
    only_probe = "--probe" in sys.argv
    os.makedirs(DEST, exist_ok=True)
    print("[char] 目标目录 %s" % DEST)
    print("[char] 目录里已有的文件：")
    for fn in sorted(os.listdir(DEST)):
        p = os.path.join(DEST, fn)
        print("        %-40s %8.2f MB" % (fn, os.path.getsize(p) / 1048576.0))
    print("")

    ok_any = False
    for c in CANDIDATES:
        dst = os.path.join(DEST, c["name"])
        if os.path.exists(dst) and os.path.getsize(dst) > 10240:
            print("[char] %-16s 已存在，跳过（%s）" % (c["name"], c["note"]))
            ok_any = True
            continue

        print("[char] %-16s %s" % (c["name"], c["note"]))
        picked = None
        for u in c["urls"]:
            ok, msg = probe(u)
            print("        探测 %-95s %s" % (u[:95], msg))
            if ok and picked is None:
                picked = u
        if only_probe or picked is None:
            print("        -> %s\n" % ("只探测模式" if only_probe else "没有可用地址"))
            continue

        print("        下载源 %s" % picked)
        try:
            n = download(picked, dst)
            print("        -> 已保存 %s（%.2f MB）\n" % (dst, n / 1048576.0))
            ok_any = True
        except Exception as e:
            print("        -> 下载失败 %s: %s\n" % (type(e).__name__, e))
            if os.path.exists(dst):
                os.remove(dst)

    print("[char] 结果：%s" % ("至少拿到一个可用角色" if ok_any else "一个都没拿到，需要人工介入"))


if __name__ == "__main__":
    main()
