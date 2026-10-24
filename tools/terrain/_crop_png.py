import struct, zlib
import numpy as np

def read_png(path):
    d = open(path, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n'
    i = 8; idat = b''; w = h = nch = 0
    while i < len(d):
        ln = struct.unpack('>I', d[i:i+4])[0]; typ = d[i+4:i+8]; data = d[i+8:i+8+ln]
        if typ == b'IHDR':
            w, h, bd, ct = struct.unpack('>IIBB', data[:10])
            nch = {0:1,2:3,3:1,4:2,6:4}[ct]
        elif typ == b'IDAT': idat += data
        elif typ == b'IEND': break
        i += 12 + ln
    raw = zlib.decompress(idat)
    stride = w * nch
    out = np.zeros((h, w, nch), np.uint8)
    prev = np.zeros(stride, np.int32)
    pos = 0
    for y in range(h):
        f = raw[pos]; pos += 1
        line = np.frombuffer(raw[pos:pos+stride], np.uint8).astype(np.int32); pos += stride
        if f == 0: cur = line
        elif f == 2: cur = (line + prev) & 0xff
        elif f == 1:
            cur = line.copy()
            for k in range(nch, stride): cur[k] = (cur[k] + cur[k-nch]) & 0xff
        else:
            cur = line.copy()
            for k in range(stride):
                a = cur[k-nch] if k >= nch else 0
                b = prev[k]; c = prev[k-nch] if k >= nch else 0
                p = a + b - c
                pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                cur[k] = (cur[k] + pr) & 0xff
        out[y] = cur.reshape(w, nch)
        prev = cur
    return out

img = read_png('web/diag_above.png')[:, :, :3]
crop = img[440:580, 0:340]
# 放大 3 倍
up = np.repeat(np.repeat(crop, 3, axis=0), 3, axis=1)
h, w = up.shape[:2]
raw = b''.join(b'\x00' + up[y].tobytes() for y in range(h))
def chunk(t, dd):
    return struct.pack('>I', len(dd)) + t + dd + struct.pack('>I', zlib.crc32(t + dd) & 0xffffffff)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
png += chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b'')
open('web/diag_above_crop.png', 'wb').write(png)
print('wrote', w, h)
