# -*-coding:utf-8 -*-
# python 3.9
# 给future projection这一章绘制3个case的图
# flooded area


"""
# @File       : 11.1_Cases_projection_flooded.py
# @software   : PyCharm  
# @Time       ：2025/6/19 10:10
# @Author     ：Wei Lyu
"""

import rasterio
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors
import numpy as np
import geopandas as gpd
import matplotlib.ticker as mticker

# 设置全局字体为 Arial
plt.rcParams['font.family'] = 'Arial'
plt.rcParams['pdf.fonttype'] = 42


if __name__ == '__main__':
    # === 1. 文件路径 ===
    path = r"D:\LW\ABM\OutputData"
    tif_path = path + r"\cities_21\哈尔滨市\haerbinshi_ws_drown_wgs84.tif"
    # tif_path = path + r"\cities_21\哈尔滨市\haerbinshi_ws_drown_ssp585_wgs84.tif"
    shp_path = path + r"\cities_21\哈尔滨市\哈尔滨市.shp"

    # ===== 1. 读取边界（可选，仅用于绘轮廓） =====
    gdf = gpd.read_file(shp_path)

    # ===== 2. 打开tif，直接读取整个栅格 =====
    with rasterio.open(tif_path) as src:
        img = src.read(1)
        raster_crs = src.crs

    # ===== 3. 构建颜色映射 =====
    # 0: gray, 1: #8B97C1, 255: white
    cmap = mcolors.ListedColormap(['#F2F2F2', '#A0C6D9', 'white'])
    bounds = [-0.5, 0.5, 1.5, 255.5]
    norm = mcolors.BoundaryNorm(bounds, cmap.N)

    # ===== 4. 绘图 =====
    fig, ax = plt.subplots(figsize=(10, 8))

    # 正确设置 raster 的 extent（坐标范围）
    extent = [
        src.bounds.left,
        src.bounds.right,
        src.bounds.bottom,
        src.bounds.top
    ]

    im = ax.imshow(img, cmap=cmap, norm=norm, extent=extent)

    # 添加矢量边界轮廓
    gdf.boundary.plot(ax=ax, color='black', linewidth=1)

    # 5. 设置经纬网范围和间隔
    minx, miny, maxx, maxy = gdf.total_bounds
    x_ticks = np.arange(np.floor(minx), np.ceil(maxx), 1)  # 经度间隔 0.5
    y_ticks = np.arange(np.floor(miny), np.ceil(maxy), 0.5)  # 纬度间隔 0.5

    ax.set_xticks(x_ticks)
    ax.set_yticks(y_ticks)
    ax.grid(which='both', color='#CFCFCF', linestyle='--', linewidth=0.5)

    # 6. 限定显示范围
    offset = 0.3
    ax.set_xlim(minx-offset, maxx+offset)
    ax.set_ylim(miny-offset, maxy+offset)

    # 设置刻度字体大小和格式
    ax.tick_params(axis='both', labelsize=25)
    ax.xaxis.set_major_formatter(mticker.FormatStrFormatter('%.1f'))
    ax.yaxis.set_major_formatter(mticker.FormatStrFormatter('%.1f'))

    # 设置坐标轴标签字体
    ax.set_xlabel('Longitude', fontsize=27, labelpad=15, fontname='Arial')
    ax.set_ylabel('Latitude', fontsize=27, labelpad=15, fontname='Arial')

    for spine in ax.spines.values():
        spine.set_linewidth(2)  # 设置为你想要的粗度，例如 2

    plt.tight_layout()
    plt.savefig(path + r'\Result_SSP585_pop2\pic\sigma=1\cases_projection\Harbin_drown_current.png', dpi=300)
    # plt.savefig(path + r'\Result_SSP585_pop2\pic\sigma=1\cases_projection\Harbin_drown_ssp585.png', dpi=300)
    plt.show()






