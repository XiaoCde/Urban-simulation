"""直读 height.i16 + bed.i16 + landcover.u8，还原 three 里的最终地形高度，
定位岸边那块「平坦浅色平台」到底是哪些格子、被谁改的。"""
import json, numpy as np, struct, os

W = os.path.join(os.path.dirname(__file__), '..', '..', 'web', 'assets')
meta = json.load(open(os.path.join(W, 'terrain', 'terrain.json'), encoding='utf-8'))
g = meta['grid']
COLS, ROWS = g['cols'], g['rows']
STEP = g['step_m']; X0 = g['x0']; Y1 = g['y1']

h = np.fromfile(os.path.join(W, 'terrain', 'height.i16'), dtype='<i2').reshape(ROWS, COLS).astype(np.float64) / 100.0
lc = np.fromfile(os.path.join(W, 'terrain', 'landcover.u8'), dtype='u1').reshape(ROWS, COLS)
bed = np.fromfile(os.path.join(W, 'water', 'bed.i16'), dtype='<i2').reshape(ROWS, COLS)
dug = bed != 32767
final = np.where(dug, bed.astype(np.float64) / 100.0, h)

def rc(x, y):
    return int(round((Y1 - y) / STEP - 0.5)), int(round((x - X0) / STEP - 0.5))

print('=== 沿 z=90 横断面（x -360..-120，步长 6 m）===')
for x in range(-360, -114, 6):
    r, c = rc(x, 90)
    print(f'x={x:5d} dtm={h[r,c]:7.2f} final={final[r,c]:7.2f} lc={lc[r,c]} bed={"dug" if dug[r,c] else "   "}')

print('\n=== 平坦区统计：final 在 [-0.4, 1.2] 之间且 bed 挖过的格子 ===')
m = (final > -0.4) & (final < 1.2) & dug
print('数量', int(m.sum()))
rr, cc = np.nonzero(m)
if len(rr):
    xs = X0 + (cc + 0.5) * STEP
    ys = Y1 - (rr + 0.5) * STEP
    print('x 范围', xs.min(), xs.max(), ' y 范围', ys.min(), ys.max())
    # 该区域的 dtm 原值分布
    print('这些格子的 dtm 原值分位', np.percentile(h[m], [1, 25, 50, 75, 99]).round(2))
    print('这些格子的 lc 分布', np.bincount(lc[m].ravel(), minlength=6))

print('\n=== 全图：final 与原 dtm 的差（fill 多少）===')
d = final - h
print('抬高的格数', int((d > 0.05).sum()), '降低的格数', int((d < -0.05).sum()))
print('抬高 >2 m 的格数', int((d > 2).sum()), ' >6 m', int((d > 6).sum()))
mi = (d > 2)
if mi.any():
    rr, cc = np.nonzero(mi)
    xs = X0 + (cc + 0.5) * STEP; ys = Y1 - (rr + 0.5) * STEP
    print('抬高 >2m 位置 x', xs.min(), xs.max(), 'y', ys.min(), ys.max())
