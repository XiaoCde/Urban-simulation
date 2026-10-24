"""极简 PNG 读取 + 像素采样（系统 python 没有 PIL，只能自己解）。

支持 8-bit RGB / RGBA、非隔行（Chrome 截图与 numpy 写出的 PNG 都是这种）。
用法：
    py tools/png_read.py out.png 700 700 700 200      # 采样若干点
    py tools/png_read.py out.png --row 700 0 1400 20  # 沿一行每 20 px 取样
"""
import sys
import zlib
import struct


def read_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', '不是 PNG'
    pos = 8
    w = h = bd = ct = None
    idat = bytearray()
    while pos < len(data):
        ln, typ = struct.unpack('>I4s', data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b'IHDR':
            w, h, bd, ct, comp, filt, inter = struct.unpack('>IIBBBBB', body)
            assert bd == 8 and inter == 0, f'只支持 8bit 非隔行（{bd}bit inter={inter}）'
        elif typ == b'IDAT':
            idat += body
        elif typ == b'IEND':
            break
    raw = zlib.decompress(bytes(idat))
    nch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]
    stride = w * nch
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if f == 1:
            for i in range(nch, stride):
                line[i] = (line[i] + line[i - nch]) & 0xFF
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                b = prev[i]
                c = prev[i - nch] if i >= nch else 0
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, nch, bytes(out)


def px(buf, w, nch, x, y):
    o = (y * w + x) * nch
    return buf[o], buf[o + 1], buf[o + 2]


if __name__ == '__main__':
    path = sys.argv[1]
    w, h, nch, buf = read_png(path)
    print(f'# {path} {w}x{h} ch={nch}')
    if sys.argv[2] == '--row':
        y = int(sys.argv[3]); x0 = int(sys.argv[4]); x1 = int(sys.argv[5]); st = int(sys.argv[6])
        for x in range(x0, x1, st):
            print(x, y, px(buf, w, nch, x, y))
    else:
        args = [int(v) for v in sys.argv[2:]]
        for i in range(0, len(args), 2):
            x, y = args[i], args[i + 1]
            print(f'({x},{y}) ->', px(buf, w, nch, x, y))