import rasterio, numpy as np
from rasterio.windows import from_bounds

"""
检查国家广场（x 1250..3450, y -380..80）在 landcover.tif 里的类别构成，
以及 terrain 顶点色实际采样到的类别。
"""
T = rasterio.open(r'D:\Users\asus\Desktop\项目\data\derived\landcover.tif')
NAMES = {0:'water',1:'building',2:'paved',3:'grass',4:'forest',5:'bare'}
win = from_bounds(1250, -380, 3450, 80, T.transform)
lc = T.read(1, window=win)
u, c = np.unique(lc, return_counts=True)
tot = lc.size
print('Mall bbox landcover (1 m px):', tot)
for k, v in zip(u, c):
    print(f'  {NAMES.get(int(k),k):9s} {v:9d}  {100*v/tot:5.1f}%')

# 更小的核心草坪（Mall 中段，实际草地）
win2 = from_bounds(1500, -400, 3200, -150, T.transform)
lc2 = T.read(1, window=win2)
u2, c2 = np.unique(lc2, return_counts=True)
print('\nMall core (x1500..3200, y-400..-150):', lc2.size)
for k, v in zip(u2, c2):
    print(f'  {NAMES.get(int(k),k):9s} {v:9d}  {100*v/lc2.size:5.1f}%')
