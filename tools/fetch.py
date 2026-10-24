# -*- coding: utf-8 -*-
"""断点续传下载器（Python / OpenSSL）。

为什么要自己写：沙箱下 Windows 自带 curl 走 Schannel，取证书被拒
    curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS
Python 自带 OpenSSL 不受影响；实测比 curl 快得多（3~26 MB/s）。
为什么要循环重试：hf-mirror 每个连接大约下 100 MB 就会 stall，
必须断开重连、从断点接着下（服务器支持 Range，返回 206）。
用法: python fetch.py <url> <输出文件>
"""
import os, sys, time, urllib.request

CHUNK = 1024 * 256

def size(p):
    return os.path.getsize(p) if os.path.isfile(p) else 0

def download(url, out, attempts=60, timeout=45):
    out = os.path.abspath(out)
    d = os.path.dirname(out)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    total = None
    t0 = time.time()
    for k in range(1, attempts + 1):
        have = size(out)
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        if have:
            req.add_header("Range", "bytes=%d-" % have)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                if total is None:
                    cr = r.headers.get("Content-Range")
                    if cr and "/" in cr:
                        total = int(cr.split("/")[-1])
                    elif r.headers.get("Content-Length"):
                        total = have + int(r.headers.get("Content-Length"))
                if have and r.status != 206:
                    print("    服务器不支持续传，从 0 重来", flush=True)
                    have = 0
                with open(out, "ab" if have else "wb") as f:
                    while True:
                        b = r.read(CHUNK)
                        if not b:
                            break
                        f.write(b)
                        have += len(b)
        except Exception as e:
            print("    中断: %s" % type(e).__name__, flush=True)
        now = size(out)
        rate = (now) / 1048576.0 / max(time.time() - t0, 0.001)
        print("  第 %2d 次: %.1f MB%s   平均 %.2f MB/s   已用 %.0fs" % (
            k, now / 1048576.0,
            (" / %.1f MB (%.1f%%)" % (total / 1048576.0, now * 100.0 / total)) if total else "",
            rate, time.time() - t0), flush=True)
        if total and now >= total:
            print("  === 下载完成 ===", flush=True)
            return True
    return False

if __name__ == "__main__":
    ok = download(sys.argv[1], sys.argv[2])
    sys.exit(0 if ok else 2)