"""megakit_inline.py — 把 gltf 的 .bin 内嵌成 base64 data URI。

【为什么必须这么做】这台机器上装了 IDM（Internet Download Manager），它的浏览器
扩展会把 `.bin` 当下载文件拦截，直接返回 204 No Content。于是 GLTFLoader 一律报
"Failed to load buffer"，一个构件都拼不出来。

不是代码错，是环境；但也不能让项目依赖"用户关掉 IDM"。所以把 buffer 内嵌进 gltf：
  · 少 10 次请求，加载更快
  · 彻底不会有 .bin 被拦
  · 代价是文件大 33%（612 B → 816 B，可忽略）

gltf 的 buffers[0].uri 支持 data URI，three.js 的 GLTFLoader 原生认。

用法：python tools/megakit_inline.py
"""
import base64
import glob
import json
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DIR = os.path.join(ROOT, "web", "assets", "megakit")


def main():
    n = 0
    saved = 0
    for p in sorted(glob.glob(os.path.join(DIR, "*.gltf"))):
        g = json.load(open(p, encoding="utf-8"))
        bufs = g.get("buffers") or []
        changed = False
        for b in bufs:
            uri = b.get("uri") or ""
            if uri.startswith("data:"):
                continue
            bp = os.path.join(DIR, os.path.basename(uri))
            if not os.path.exists(bp):
                print("[warn] 缺 buffer：", uri)
                continue
            raw = open(bp, "rb").read()
            b["uri"] = ("data:application/octet-stream;base64,"
                        + base64.b64encode(raw).decode("ascii"))
            b["byteLength"] = len(raw)
            changed = True
            saved += 1
        # 贴图也检查一下是不是外部文件（IDM 不拦 png，保持外链更好缓存）
        if changed:
            json.dump(g, open(p, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
            n += 1
    total = sum(os.path.getsize(f) for f in glob.glob(os.path.join(DIR, "*")))
    print(f"内嵌 {saved} 个 buffer / {n} 个 gltf；目录合计 {total/1e6:.2f} MB")


if __name__ == "__main__":
    main()
