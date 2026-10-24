# -*- coding: utf-8 -*-
"""从 BBBike 下载整城 OSM 数据（断点续传）。

用法:
    python fetch_city.py speed <url>              # 测速：下 8 MB 报速度
    python fetch_city.py get   <url> <输出文件>    # 断点续传下载（可反复重跑）

为什么用它: Overpass 命令行被中间设备拦（HTTP 406），Geofabrik 超时，
BBBike 是实测唯一可达的大文件源，且提供 NewYork / WashingtonDC 整城包。
"""
import os
import sys
import time
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"


def _req(url, start=0, length=None):
    h = {"User-Agent": UA, "Accept": "*/*"}
    if start or length:
        end = "" if length is None else str(start + length - 1)
        h["Range"] = "bytes=%d-%s" % (start, end)
    return urllib.request.Request(url, headers=h)


def speed(url, mb=8):
    """下 mb 兆，返回 (速度 MB/s, 服务器是否支持 Range)。"""
    n = mb * 1024 * 1024
    t0 = time.time()
    got = 0
    with urllib.request.urlopen(_req(url, 0, n), timeout=60) as r:
        code = r.status
        ranges = r.headers.get("Accept-Ranges", "-")
        total = r.headers.get("Content-Range") or r.headers.get("Content-Length") or "?"
        while got < n:
            b = r.read(262144)
            if not b:
                break
            got += len(b)
    dt = time.time() - t0
    mbs = got / 1048576 / dt if dt else 0
    print("HTTP %s  Accept-Ranges=%s  总长=%s" % (code, ranges, total))
    print("下载 %.2f MB 用时 %.1f s  →  %.3f MB/s" % (got / 1048576, dt, mbs))
    return mbs, ranges == "bytes"


def get(url, out, chunk=262144):
    """断点续传下载。中断后重跑本命令会接着下。"""
    part = out + ".part"
    have = os.path.getsize(part) if os.path.exists(part) else 0
    if have:
        print("发现断点，从 %.1f MB 处继续" % (have / 1048576))
    t0 = time.time()
    with urllib.request.urlopen(_req(url, have), timeout=120) as r:
        total = None
        cr = r.headers.get("Content-Range")  # bytes start-end/total
        if cr and "/" in cr:
            total = int(cr.split("/")[1])
        elif r.headers.get("Content-Length") and not have:
            total = int(r.headers["Content-Length"])
        mode = "ab" if have else "wb"
        done = have
        last = time.time()
        with open(part, mode) as f:
            while True:
                b = r.read(chunk)
                if not b:
                    break
                f.write(b)
                done += len(b)
                if time.time() - last >= 10:
                    last = time.time()
                    el = time.time() - t0
                    sp = (done - have) / 1048576 / el if el else 0
                    if total:
                        pct = done * 100.0 / total
                        eta = (total - done) / 1048576 / sp if sp > 0.001 else -1
                        print("  %.1f%%  %.1f/%.1f MB  %.3f MB/s  剩余约 %.0f 分钟"
                              % (pct, done / 1048576, total / 1048576, sp, eta / 60))
                    else:
                        print("  %.1f MB  %.3f MB/s" % (done / 1048576, sp))
    if total and done < total:
        print("!! 未下完（%d/%d 字节），重跑本命令继续" % (done, total))
        return False
    os.replace(part, out)
    print("完成: %s  %.1f MB  用时 %.1f 分钟"
          % (out, os.path.getsize(out) / 1048576, (time.time() - t0) / 60))
    return True


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    if sys.argv[1] == "speed":
        speed(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 8)
    elif sys.argv[1] == "get":
        sys.exit(0 if get(sys.argv[2], sys.argv[3]) else 1)
    else:
        print(__doc__)
        sys.exit(1)
