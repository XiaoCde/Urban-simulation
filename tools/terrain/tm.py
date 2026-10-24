# -*- coding: utf-8 -*-
r"""blosm 球面横轴墨卡托（场景本地米制坐标）—— 正/反算，纯 numpy，不依赖 bpy。

为什么要自己写：
    out\dc_real3_clean.blend 里所有物体的 x/y 都是 blosm 用
    C:\Users\asus\AppData\Roaming\Blender Foundation\Blender\5.2\scripts\addons\blosm\util\transverse_mercator.py
    算出来的。那不是 UTM，是「半径 6378137 m 的球面 TM，k=1，原点在场景 lat/lon」。
    如果直接用 pyproj 的 UTM 18N 去套，会差出几十米，地形和建筑就错位了。
    所以这里 1:1 复刻那 10 行公式，并用 numpy 向量化（30M 像素要算）。

契约（与 §5.5 一致）：
    +X 向东，+Y 向北，单位米；原点 lat0=38.89038015, lon0=-77.04975645（读自 blend 场景属性）。
"""
import numpy as np

R = 6378137.0
LAT0 = 38.89038015
LON0 = -77.04975644999999
LAT0_RAD = np.radians(LAT0)


def from_geographic(lat, lon):
    """(lat, lon) 度 -> (x, y) 米。输入可为标量或 np.ndarray（度）。"""
    lat = np.radians(np.asarray(lat, dtype=np.float64))
    lon = np.radians(np.asarray(lon, dtype=np.float64) - LON0)
    B = np.sin(lon) * np.cos(lat)
    x = 0.5 * R * np.log((1.0 + B) / (1.0 - B))
    y = R * (np.arctan(np.tan(lat) / np.cos(lon)) - LAT0_RAD)
    return x, y


def to_geographic(x, y):
    """(x, y) 米 -> (lat, lon) 度。"""
    x = np.asarray(x, dtype=np.float64) / R
    y = np.asarray(y, dtype=np.float64) / R
    D = y + LAT0_RAD
    lon = np.arctan(np.sinh(x) / np.cos(D))
    lat = np.arcsin(np.sin(D) / np.cosh(x))
    return np.degrees(lat), LON0 + np.degrees(lon)


# ---------------------------------------------------------------- 场景网格契约
# ground 平面（blend 内实测）：x -1276.96 .. 4700.72，y -930.97 .. 4188.47
GROUND_BBOX = (-1276.96, -930.97, 4700.72, 4188.47)

# 栅格网格：向外对齐到整米，留 1 m 余量，保证覆盖整个 ground
GRID_X0 = -1277.0
GRID_Y0 = -931.0
GRID_X1 = 4701.0
GRID_Y1 = 4189.0      # 5978 x 5120 像素，1 m
WIDTH = int(round(GRID_X1 - GRID_X0))     # 5978
HEIGHT = int(round(GRID_Y1 - GRID_Y0))    # 5120


def grid_transform():
    """affine: 像素(i,j) 左上角 -> (x, y)，y 向上（与 rasterio 的 north-up 一致）。"""
    return dict(
        x0=GRID_X0, y1=GRID_Y1, res=1.0,
        width=WIDTH, height=HEIGHT,
        xres=1.0, yres=-1.0,
    )


if __name__ == "__main__":
    # 自检：与 blosm 原实现逐点比对（标量路径）
    import math

    class Ref:
        radius = 6378137.0
        lat = LAT0
        lon = LON0
        k = 1.0
        latInRadians = math.radians(LAT0)

        def fromGeographic(self, lat, lon):
            lat = math.radians(lat)
            lon = math.radians(lon - self.lon)
            B = math.sin(lon) * math.cos(lat)
            x = 0.5 * self.k * self.radius * math.log((1. + B) / (1. - B))
            y = self.k * self.radius * (math.atan(math.tan(lat) / math.cos(lon)) - self.latInRadians)
            return (x, y, 0.)

    ref = Ref()
    pts = [(38.882005, -77.064502), (38.927993, -76.995475), (38.89038015, -77.04975645),
           (38.9001, -77.0302), (38.875, -77.02)]
    worst = 0.0
    for la, lo in pts:
        rx, ry, _ = ref.fromGeographic(la, lo)
        mx, my = from_geographic(la, lo)
        d = math.hypot(float(mx) - rx, float(my) - ry)
        worst = max(worst, d)
        print("[tm] (%10.6f,%11.6f) ref=(%14.4f,%14.4f) mine=(%14.4f,%14.4f) d=%.6f m"
              % (la, lo, rx, ry, float(mx), float(my), d))
    print("[tm] 与 blosm 原实现最大偏差 %.9f m" % worst)

    # 反算自检（往返）
    for la, lo in pts:
        x, y = from_geographic(la, lo)
        la2, lo2 = to_geographic(x, y)
        print("[tm] 往返 %.3e, %.3e 度" % (abs(la2 - la), abs(lo2 - lo)))
    print("[tm] 网格 %d x %d = %.2f km2" % (WIDTH, HEIGHT, WIDTH * HEIGHT / 1e6))
